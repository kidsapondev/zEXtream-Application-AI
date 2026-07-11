import {
  CircuitBreakerService,
  CIRCUIT_BREAKER_COOLDOWN_MS,
  CIRCUIT_BREAKER_FAILURE_THRESHOLD,
} from './circuit-breaker.service';

describe('CircuitBreakerService', () => {
  let breaker: CircuitBreakerService;

  beforeEach(() => {
    breaker = new CircuitBreakerService();
  });

  it('starts closed', () => {
    expect(breaker.isOpen('ollama')).toBe(false);
  });

  it('stays closed for failures under the threshold', () => {
    for (let i = 0; i < CIRCUIT_BREAKER_FAILURE_THRESHOLD - 1; i += 1) {
      breaker.recordFailure('ollama');
    }

    expect(breaker.isOpen('ollama')).toBe(false);
  });

  it('opens once consecutive failures reach the threshold', () => {
    for (let i = 0; i < CIRCUIT_BREAKER_FAILURE_THRESHOLD; i += 1) {
      breaker.recordFailure('claude');
    }

    expect(breaker.isOpen('claude')).toBe(true);
  });

  it('a success resets the consecutive-failure count', () => {
    for (let i = 0; i < CIRCUIT_BREAKER_FAILURE_THRESHOLD - 1; i += 1) {
      breaker.recordFailure('openai');
    }
    breaker.recordSuccess('openai');
    breaker.recordFailure('openai');

    expect(breaker.isOpen('openai')).toBe(false);
  });

  it('tracks each provider independently', () => {
    for (let i = 0; i < CIRCUIT_BREAKER_FAILURE_THRESHOLD; i += 1) {
      breaker.recordFailure('claude');
    }

    expect(breaker.isOpen('claude')).toBe(true);
    expect(breaker.isOpen('openai')).toBe(false);
    expect(breaker.isOpen('ollama')).toBe(false);
  });

  it('closes again automatically once the cooldown elapses', () => {
    const nowSpy = jest.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(0);
      for (let i = 0; i < CIRCUIT_BREAKER_FAILURE_THRESHOLD; i += 1) {
        breaker.recordFailure('ollama');
      }
      expect(breaker.isOpen('ollama')).toBe(true);

      nowSpy.mockReturnValue(CIRCUIT_BREAKER_COOLDOWN_MS - 1);
      expect(breaker.isOpen('ollama')).toBe(true);

      nowSpy.mockReturnValue(CIRCUIT_BREAKER_COOLDOWN_MS + 1);
      expect(breaker.isOpen('ollama')).toBe(false);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('cooldownRemainingMs is 0 when closed and positive when open', () => {
    expect(breaker.cooldownRemainingMs('ollama')).toBe(0);

    for (let i = 0; i < CIRCUIT_BREAKER_FAILURE_THRESHOLD; i += 1) {
      breaker.recordFailure('ollama');
    }

    expect(breaker.cooldownRemainingMs('ollama')).toBeGreaterThan(0);
    expect(breaker.cooldownRemainingMs('ollama')).toBeLessThanOrEqual(
      CIRCUIT_BREAKER_COOLDOWN_MS,
    );
  });
});
