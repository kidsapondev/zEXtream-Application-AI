import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AiChatRequest,
  AiProvider,
  AiStreamEvent,
} from '../ai-provider.interface';
import { CircuitBreakerService } from '../circuit-breaker.service';
import { fetchWithRetry } from './fetch-with-retry';

interface OllamaChatChunk {
  message?: { role: string; content: string };
  done: boolean;
  done_reason?: string;
  /** Only present on the final (`done: true`) chunk. */
  prompt_eval_count?: number;
  eval_count?: number;
}

/**
 * Time allowed to establish the connection (fetch resolving with a response).
 * Generous on purpose: Ollama only loads a model into RAM/VRAM on its first
 * request (or after it's been idle long enough to unload) — for a large
 * local model that cold load alone can take well over 10s before Ollama
 * even starts responding, which a short timeout would misreport as
 * "unreachable" on every first message of a session. Confirmed by hand: a
 * 14B Q4 model (~14.6GB) reproducibly missed a 10s connect timeout on cold
 * load, then answered normally once warm.
 */
export const OLLAMA_CONNECT_TIMEOUT_MS = 90_000;

/** Time allowed between successive stream chunks before the stream is considered stalled. */
export const OLLAMA_STREAM_INACTIVITY_TIMEOUT_MS = 30_000;

@Injectable()
export class OllamaProvider implements AiProvider {
  readonly key = 'ollama' as const;
  private readonly baseUrl: string;
  private readonly logger = new Logger(OllamaProvider.name);

  constructor(
    configService: ConfigService,
    private readonly circuitBreaker: CircuitBreakerService,
  ) {
    this.baseUrl = configService.getOrThrow<string>('OLLAMA_BASE_URL');
  }

  async *streamChat(request: AiChatRequest): AsyncIterable<AiStreamEvent> {
    if (this.circuitBreaker.isOpen(this.key)) {
      const retryInSeconds = Math.ceil(
        this.circuitBreaker.cooldownRemainingMs(this.key) / 1000,
      );
      yield {
        type: 'error',
        message: `Ollama is temporarily unavailable after repeated failures; retrying in ~${retryInSeconds}s`,
      };
      return;
    }

    // A single combined signal governs the whole request (connect + body
    // read): either the caller's own abort, a connect-timeout abort, or a
    // stream-inactivity abort ends it. The connect timer is cleared as soon
    // as a response is received so it can never misfire mid-stream; the
    // inactivity timer is (re)armed on every chunk received so a healthy,
    // merely slow stream is never killed, only a stalled one.
    //
    // Deliberately NOT armed yet at this point: Ollama doesn't send response
    // headers until it's ready to start streaming, so a cold model load (see
    // OLLAMA_CONNECT_TIMEOUT_MS above) happens entirely before fetch()
    // resolves — that whole window belongs to the connect timeout. Arming
    // the (much shorter) inactivity timer this early would race the connect
    // timeout and misreport a slow cold load as "stream timed out due to
    // inactivity" instead of "still connecting". It's armed for real right
    // after the connection succeeds, below.
    const connectController = new AbortController();
    const connectTimer = setTimeout(
      () => connectController.abort(),
      OLLAMA_CONNECT_TIMEOUT_MS,
    );
    const inactivityController = new AbortController();
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
    const armInactivityTimer = () => {
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(
        () => inactivityController.abort(),
        OLLAMA_STREAM_INACTIVITY_TIMEOUT_MS,
      );
    };

    const combinedSignal = AbortSignal.any([
      request.abortSignal,
      connectController.signal,
      inactivityController.signal,
    ]);

    let response: Response;
    try {
      response = await fetchWithRetry(
        () =>
          fetch(`${this.baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: request.model,
              messages: request.messages,
              stream: true,
              options: {
                temperature: request.temperature,
              },
            }),
            signal: combinedSignal,
          }),
        combinedSignal,
      );
    } catch (err) {
      clearTimeout(connectTimer);
      // inactivityController can't be the cause here: its timer isn't armed
      // until after the connection succeeds (see below), which by
      // definition hasn't happened if this fetch attempt just threw.
      if (request.abortSignal.aborted) {
        yield { type: 'done', finishReason: 'stopped' };
      } else if (connectController.signal.aborted) {
        this.circuitBreaker.recordFailure(this.key);
        yield {
          type: 'error',
          message: `Connecting to Ollama timed out after ${OLLAMA_CONNECT_TIMEOUT_MS}ms`,
        };
      } else {
        this.circuitBreaker.recordFailure(this.key);
        yield {
          type: 'error',
          message: `Could not reach Ollama: ${(err as Error).message}`,
        };
      }
      return;
    }
    clearTimeout(connectTimer);

    if (!response.ok || !response.body) {
      // Ollama has no per-user API keys, so unlike Claude/OpenAI every non-2xx
      // status here reflects the shared local instance's own health (a bad
      // model name is the one common exception, hence excluding 4xx here too
      // to avoid opening the circuit over a client-side typo repeated by one
      // session) rather than one user's credentials.
      if (response.status >= 500) {
        this.circuitBreaker.recordFailure(this.key);
      }
      yield {
        type: 'error',
        message: `Ollama returned HTTP ${response.status}`,
      };
      return;
    }

    this.circuitBreaker.recordSuccess(this.key);

    // The connection succeeded and headers are in — now, and only now, does
    // "no data for N seconds" mean a stalled stream rather than a slow/cold
    // connection. See the comment where inactivityController is created.
    armInactivityTimer();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        armInactivityTimer();

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          let chunk: OllamaChatChunk;
          try {
            chunk = JSON.parse(line) as OllamaChatChunk;
          } catch {
            // A single malformed/non-JSON line does not fail the whole
            // response: Ollama's NDJSON framing means one corrupt line is
            // very unlikely to indicate the rest of the stream is bad, and
            // dropping the whole in-flight assistant message over one bad
            // line is worse UX than silently skipping it and continuing.
            this.logger.warn(`Skipping malformed Ollama stream line: ${line}`);
            continue;
          }
          if (chunk.message?.content) {
            yield { type: 'token', delta: chunk.message.content };
          }
          if (chunk.done) {
            clearTimeout(inactivityTimer);
            yield {
              type: 'done',
              finishReason: chunk.done_reason ?? 'stop',
              usage:
                chunk.prompt_eval_count != null && chunk.eval_count != null
                  ? {
                      inputTokens: chunk.prompt_eval_count,
                      outputTokens: chunk.eval_count,
                    }
                  : undefined,
            };
            return;
          }
        }
      }
      clearTimeout(inactivityTimer);
      yield { type: 'done', finishReason: 'stop' };
    } catch (err) {
      clearTimeout(inactivityTimer);
      if (request.abortSignal.aborted) {
        yield { type: 'done', finishReason: 'stopped' };
      } else if (inactivityController.signal.aborted) {
        yield {
          type: 'error',
          message: `Ollama stream timed out after ${OLLAMA_STREAM_INACTIVITY_TIMEOUT_MS}ms of inactivity`,
        };
      } else {
        yield {
          type: 'error',
          message: `Ollama stream error: ${(err as Error).message}`,
        };
      }
    }
  }
}
