import { Injectable, Logger } from '@nestjs/common';
import { AiProviderKey } from './ai-provider.interface';

/** Consecutive upstream failures before a provider's circuit opens. */
export const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 5;

/** How long the circuit stays open (failing fast) before allowing another attempt. */
export const CIRCUIT_BREAKER_COOLDOWN_MS = 30_000;

interface CircuitState {
  consecutiveFailures: number;
  openedAt: number | null;
}

/**
 * Per-provider circuit breaker shared across every user of this backend
 * instance (one breaker per AiProviderKey, not per user). Only upstream-
 * health signals should ever be recorded here: network errors, 5xx
 * responses, and connect/inactivity timeouts. A specific user's bad or
 * revoked API key (401/403) or a per-key rate limit (429) must never be
 * recorded as a circuit-breaker failure — those are that one user's
 * problem, not a sign the provider itself is down, and counting them
 * would let one bad key trip the breaker and lock every other user of
 * that provider out.
 */
@Injectable()
export class CircuitBreakerService {
  private readonly logger = new Logger(CircuitBreakerService.name);
  private readonly state = new Map<AiProviderKey, CircuitState>();

  private getState(provider: AiProviderKey): CircuitState {
    let entry = this.state.get(provider);
    if (!entry) {
      entry = { consecutiveFailures: 0, openedAt: null };
      this.state.set(provider, entry);
    }
    return entry;
  }

  /** True if the circuit is currently open (still within its cooldown window). */
  isOpen(provider: AiProviderKey): boolean {
    const entry = this.getState(provider);
    if (entry.openedAt === null) return false;
    if (Date.now() - entry.openedAt >= CIRCUIT_BREAKER_COOLDOWN_MS) {
      // Cooldown elapsed: allow the next attempt through (half-open). It
      // decides the outcome via recordSuccess/recordFailure below, rather
      // than needing a separate half-open state machine.
      entry.openedAt = null;
      entry.consecutiveFailures = 0;
      return false;
    }
    return true;
  }

  recordSuccess(provider: AiProviderKey): void {
    const entry = this.getState(provider);
    entry.consecutiveFailures = 0;
    entry.openedAt = null;
  }

  recordFailure(provider: AiProviderKey): void {
    const entry = this.getState(provider);
    entry.consecutiveFailures += 1;
    if (
      entry.consecutiveFailures >= CIRCUIT_BREAKER_FAILURE_THRESHOLD &&
      entry.openedAt === null
    ) {
      entry.openedAt = Date.now();
      this.logger.warn(
        `Circuit opened for provider "${provider}" after ${entry.consecutiveFailures} consecutive upstream failures`,
      );
    }
  }

  /** Milliseconds remaining in the current cooldown, or 0 if the circuit isn't open. */
  cooldownRemainingMs(provider: AiProviderKey): number {
    const entry = this.getState(provider);
    if (entry.openedAt === null) return 0;
    return Math.max(
      0,
      CIRCUIT_BREAKER_COOLDOWN_MS - (Date.now() - entry.openedAt),
    );
  }
}
