import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiChatRequest, AiProvider, AiStreamEvent } from '../ai-provider.interface';

interface OllamaChatChunk {
  message?: { role: string; content: string };
  done: boolean;
  done_reason?: string;
}

@Injectable()
export class OllamaProvider implements AiProvider {
  readonly key = 'ollama' as const;
  private readonly baseUrl: string;

  constructor(configService: ConfigService) {
    this.baseUrl = configService.getOrThrow<string>('OLLAMA_BASE_URL');
  }

  async *streamChat(request: AiChatRequest): AsyncIterable<AiStreamEvent> {
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
        signal: request.abortSignal,
      });
    } catch (err) {
      yield { type: 'error', message: `Could not reach Ollama: ${(err as Error).message}` };
      return;
    }

    if (!response.ok || !response.body) {
      yield { type: 'error', message: `Ollama returned HTTP ${response.status}` };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          const chunk: OllamaChatChunk = JSON.parse(line);
          if (chunk.message?.content) {
            yield { type: 'token', delta: chunk.message.content };
          }
          if (chunk.done) {
            yield { type: 'done', finishReason: chunk.done_reason ?? 'stop' };
            return;
          }
        }
      }
      yield { type: 'done', finishReason: 'stop' };
    } catch (err) {
      if (request.abortSignal.aborted) {
        yield { type: 'done', finishReason: 'stopped' };
      } else {
        yield { type: 'error', message: `Ollama stream error: ${(err as Error).message}` };
      }
    }
  }
}
