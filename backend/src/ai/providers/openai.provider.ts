import { Injectable } from '@nestjs/common';
import {
  AiChatRequest,
  AiProvider,
  AiStreamEvent,
} from '../ai-provider.interface';

const OPENAI_CHAT_COMPLETIONS_URL =
  'https://api.openai.com/v1/chat/completions';

interface OpenAiChunk {
  choices?: Array<{
    delta?: { content?: string };
    finish_reason?: string | null;
  }>;
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
    return 'Rate limited by OpenAI';
  }
  if (response.status >= 500) {
    return 'OpenAI is temporarily unavailable';
  }
  return upstreamMessage ?? `OpenAI returned HTTP ${response.status}`;
}

@Injectable()
export class OpenAiProvider implements AiProvider {
  readonly key = 'openai' as const;

  async *streamChat(request: AiChatRequest): AsyncIterable<AiStreamEvent> {
    if (!request.apiKey) {
      yield { type: 'error', message: 'No OpenAI API key configured' };
      return;
    }

    let response: Response;
    try {
      response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${request.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          stream: true,
          temperature: request.temperature,
          max_tokens: request.maxTokens,
        }),
        signal: request.abortSignal,
      });
    } catch (err) {
      if (request.abortSignal.aborted) {
        yield { type: 'done', finishReason: 'stopped' };
        return;
      }
      yield {
        type: 'error',
        message: `Could not reach OpenAI: ${(err as Error).message}`,
      };
      return;
    }

    if (!response.ok || !response.body) {
      yield { type: 'error', message: await mapUpstreamError(response) };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let doneEmitted = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const jsonText = line.slice('data:'.length).trim();
          if (!jsonText) continue;
          if (jsonText === '[DONE]') {
            if (!doneEmitted) {
              doneEmitted = true;
              yield { type: 'done', finishReason: 'stop' };
            }
            return;
          }

          let chunk: OpenAiChunk;
          try {
            chunk = JSON.parse(jsonText) as OpenAiChunk;
          } catch {
            // Skip a single malformed/truncated SSE line instead of failing
            // the whole stream.
            continue;
          }

          const choice = chunk.choices?.[0];
          const delta = choice?.delta?.content;
          if (delta) yield { type: 'token', delta };
          if (choice?.finish_reason) {
            doneEmitted = true;
            yield { type: 'done', finishReason: choice.finish_reason };
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
          message: `OpenAI stream error: ${(err as Error).message}`,
        };
      }
    }
  }
}
