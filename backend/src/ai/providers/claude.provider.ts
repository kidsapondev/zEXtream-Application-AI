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

@Injectable()
export class ClaudeProvider implements AiProvider {
  readonly key = 'claude' as const;
  private readonly bridgeUrl?: string;
  private readonly bridgeToken?: string;

  constructor(
    configService: ConfigService,
    private readonly circuitBreaker: CircuitBreakerService,
  ) {
    this.bridgeUrl = configService.get<string>('CLAUDE_BRIDGE_URL');
    this.bridgeToken = configService.get<string>('HOST_BRIDGE_TOKEN');
  }

  async *streamChat(request: AiChatRequest): AsyncIterable<AiStreamEvent> {
    if (!this.bridgeUrl || !this.bridgeToken) {
      yield { type: 'error', message: 'Claude host-bridge is not configured' };
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

    let response: Response;
    try {
      response = await fetchWithRetry(
        () =>
          fetch(`${this.bridgeUrl}/claude/chat`, {
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
        message: `Could not reach the Claude host-bridge: ${(err as Error).message}`,
      };
      return;
    }

    if (!response.ok || !response.body) {
      this.circuitBreaker.recordFailure(this.key);
      yield {
        type: 'error',
        message: `Claude host-bridge returned HTTP ${response.status}`,
      };
      return;
    }

    this.circuitBreaker.recordSuccess(this.key);
    yield* readBridgeEvents(response.body, request.abortSignal);
  }
}
