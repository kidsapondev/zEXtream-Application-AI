import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AiChatRequest,
  AiProvider,
  AiStreamEvent,
} from '../ai-provider.interface';

interface OllamaChatChunk {
  message?: { role: string; content: string };
  done: boolean;
  done_reason?: string;
}

/** Time allowed to establish the connection (fetch resolving with a response). */
export const OLLAMA_CONNECT_TIMEOUT_MS = 10_000;

/** Time allowed between successive stream chunks before the stream is considered stalled. */
export const OLLAMA_STREAM_INACTIVITY_TIMEOUT_MS = 30_000;

@Injectable()
export class OllamaProvider implements AiProvider {
  readonly key = 'ollama' as const;
  private readonly baseUrl: string;
  private readonly logger = new Logger(OllamaProvider.name);

  constructor(configService: ConfigService) {
    this.baseUrl = configService.getOrThrow<string>('OLLAMA_BASE_URL');
  }

  async *streamChat(request: AiChatRequest): AsyncIterable<AiStreamEvent> {
    // A single combined signal governs the whole request (connect + body
    // read): either the caller's own abort, a connect-timeout abort, or a
    // stream-inactivity abort ends it. The connect timer is cleared as soon
    // as a response is received so it can never misfire mid-stream; the
    // inactivity timer is (re)armed on every chunk received so a healthy,
    // merely slow stream is never killed, only a stalled one.
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
    armInactivityTimer();

    const combinedSignal = AbortSignal.any([
      request.abortSignal,
      connectController.signal,
      inactivityController.signal,
    ]);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
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
      });
    } catch (err) {
      clearTimeout(connectTimer);
      clearTimeout(inactivityTimer);
      if (request.abortSignal.aborted) {
        yield { type: 'done', finishReason: 'stopped' };
      } else if (connectController.signal.aborted) {
        yield {
          type: 'error',
          message: `Connecting to Ollama timed out after ${OLLAMA_CONNECT_TIMEOUT_MS}ms`,
        };
      } else if (inactivityController.signal.aborted) {
        yield {
          type: 'error',
          message: `Ollama stream timed out after ${OLLAMA_STREAM_INACTIVITY_TIMEOUT_MS}ms of inactivity`,
        };
      } else {
        yield {
          type: 'error',
          message: `Could not reach Ollama: ${(err as Error).message}`,
        };
      }
      return;
    }
    clearTimeout(connectTimer);

    if (!response.ok || !response.body) {
      clearTimeout(inactivityTimer);
      yield {
        type: 'error',
        message: `Ollama returned HTTP ${response.status}`,
      };
      return;
    }

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
            yield { type: 'done', finishReason: chunk.done_reason ?? 'stop' };
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
