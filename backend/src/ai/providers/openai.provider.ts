import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AiChatRequest,
  AiProvider,
  AiStreamEvent,
} from '../ai-provider.interface';
import { CircuitBreakerService } from '../circuit-breaker.service';
import { fetchWithRetry } from './fetch-with-retry';
import { readBridgeEvents } from './host-bridge-client';

/**
 * Despite the provider key staying `openai` (kept for minimal blast radius against the
 * existing schema/enum/UI), this no longer calls OpenAI's Chat Completions API — it
 * calls the host-bridge's `/codex/chat`, which spawns the host's already-logged-in
 * `codex.exe` CLI. See docs/deployment.md for the full rationale.
 */
@Injectable()
export class OpenAiProvider implements AiProvider {
  readonly key = 'openai' as const;
  private readonly bridgeUrl?: string;
  private readonly bridgeToken?: string;

  constructor(
    configService: ConfigService,
    private readonly circuitBreaker: CircuitBreakerService,
  ) {
    this.bridgeUrl = configService.get<string>('CODEX_BRIDGE_URL');
    this.bridgeToken = configService.get<string>('HOST_BRIDGE_TOKEN');
  }

  async *streamChat(request: AiChatRequest): AsyncIterable<AiStreamEvent> {
    if (!this.bridgeUrl || !this.bridgeToken) {
      yield { type: 'error', message: 'Codex host-bridge is not configured' };
      return;
    }

    if (this.circuitBreaker.isOpen(this.key)) {
      const retryInSeconds = Math.ceil(
        this.circuitBreaker.cooldownRemainingMs(this.key) / 1000,
      );
      yield {
        type: 'error',
        message: `Codex is temporarily unavailable after repeated failures; retrying in ~${retryInSeconds}s`,
      };
      return;
    }

    let response: Response;
    try {
      response = await fetchWithRetry(
        () =>
          fetch(`${this.bridgeUrl}/codex/chat`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-bridge-token': this.bridgeToken!,
            },
            body: JSON.stringify({
              messages: request.messages,
              model: request.model,
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
        message: `Could not reach the Codex host-bridge: ${(err as Error).message}`,
      };
      return;
    }

    if (!response.ok || !response.body) {
      this.circuitBreaker.recordFailure(this.key);
      yield {
        type: 'error',
        message: `Codex host-bridge returned HTTP ${response.status}`,
      };
      return;
    }

    this.circuitBreaker.recordSuccess(this.key);
    yield* readBridgeEvents(response.body, request.abortSignal);
  }
}
