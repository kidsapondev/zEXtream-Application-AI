import { Injectable } from '@nestjs/common';
import {
  AiChatRequest,
  AiMessage,
  AiProvider,
  AiStreamEvent,
} from '../ai-provider.interface';
import { CircuitBreakerService } from '../circuit-breaker.service';
import { fetchWithRetry } from './fetch-with-retry';

const CLAUDE_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_API_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

interface AnthropicTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Anthropic takes `system` as a top-level field, not a message role. */
function splitSystemAndTurns(messages: AiMessage[]): {
  system: string;
  turns: AnthropicTurn[];
} {
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  const turns = messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role as 'user' | 'assistant',
      content: message.content,
    }));
  return { system, turns };
}

async function mapUpstreamError(response: Response): Promise<string> {
  let upstreamMessage: string | undefined;
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    upstreamMessage = body?.error?.message;
  } catch {
    // Response body wasn't JSON (or already consumed) — fall back to status.
  }
  if (response.status === 401 || response.status === 403) {
    return upstreamMessage ?? 'Invalid or revoked API key';
  }
  if (response.status === 429) {
    return 'Rate limited by Claude';
  }
  if (response.status >= 500) {
    return 'Claude is temporarily unavailable';
  }
  return upstreamMessage ?? `Claude returned HTTP ${response.status}`;
}

@Injectable()
export class ClaudeProvider implements AiProvider {
  readonly key = 'claude' as const;

  constructor(private readonly circuitBreaker: CircuitBreakerService) {}

  async *streamChat(request: AiChatRequest): AsyncIterable<AiStreamEvent> {
    if (!request.apiKey) {
      yield { type: 'error', message: 'No Claude API key configured' };
      return;
    }

    if (this.circuitBreaker.isOpen(this.key)) {
      const retryInSeconds = Math.ceil(
        this.circuitBreaker.cooldownRemainingMs(this.key) / 1000,
      );
      yield {
        type: 'error',
        message: `Claude is temporarily unavailable after repeated failures; retrying in ~${retryInSeconds}s`,
      };
      return;
    }

    const { system, turns } = splitSystemAndTurns(request.messages);

    let response: Response;
    try {
      response = await fetchWithRetry(
        () =>
          fetch(CLAUDE_MESSAGES_URL, {
            method: 'POST',
            headers: {
              'x-api-key': request.apiKey!,
              'anthropic-version': CLAUDE_API_VERSION,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              model: request.model,
              max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
              messages: turns,
              ...(system ? { system } : {}),
              stream: true,
              temperature: request.temperature,
            }),
            signal: request.abortSignal,
          }),
        request.abortSignal,
      );
    } catch (err) {
      if (request.abortSignal.aborted) {
        yield { type: 'done', finishReason: 'stopped' };
        return;
      }
      this.circuitBreaker.recordFailure(this.key);
      yield {
        type: 'error',
        message: `Could not reach Claude: ${(err as Error).message}`,
      };
      return;
    }

    if (!response.ok || !response.body) {
      if (response.status >= 500) {
        this.circuitBreaker.recordFailure(this.key);
      }
      yield { type: 'error', message: await mapUpstreamError(response) };
      return;
    }

    this.circuitBreaker.recordSuccess(this.key);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let doneEmitted = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line; each frame carries one or
        // more `field: value` lines, of which we only need `data:`.
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          const dataLine = frame
            .split('\n')
            .find((line) => line.startsWith('data:'));
          if (!dataLine) continue;
          const jsonText = dataLine.slice('data:'.length).trim();
          if (!jsonText) continue;

          let payload: Record<string, unknown>;
          try {
            payload = JSON.parse(jsonText) as Record<string, unknown>;
          } catch {
            // Skip a single malformed/truncated SSE frame instead of failing
            // the whole stream.
            continue;
          }

          const type = payload['type'];
          if (type === 'content_block_delta') {
            const delta = (payload['delta'] as { text?: string } | undefined)
              ?.text;
            if (delta) yield { type: 'token', delta };
          } else if (type === 'message_delta') {
            const stopReason = (
              payload['delta'] as { stop_reason?: string } | undefined
            )?.stop_reason;
            if (stopReason) {
              doneEmitted = true;
              yield { type: 'done', finishReason: stopReason };
            }
          } else if (type === 'message_stop') {
            if (!doneEmitted) {
              doneEmitted = true;
              yield { type: 'done', finishReason: 'stop' };
            }
            return;
          } else if (type === 'error') {
            const message =
              (payload['error'] as { message?: string } | undefined)?.message ??
              'Claude stream error';
            yield { type: 'error', message };
            return;
          }
        }
      }
      if (!doneEmitted) {
        yield { type: 'done', finishReason: 'stop' };
      }
    } catch (err) {
      if (request.abortSignal.aborted) {
        yield { type: 'done', finishReason: 'stopped' };
      } else {
        yield {
          type: 'error',
          message: `Claude stream error: ${(err as Error).message}`,
        };
      }
    }
  }
}
