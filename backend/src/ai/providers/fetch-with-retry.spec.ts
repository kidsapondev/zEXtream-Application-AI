import {
  fetchWithRetry,
  isRetryableError,
  isRetryableStatus,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_ATTEMPTS,
} from './fetch-with-retry';

function response(status: number, ok = status < 300): Response {
  return { ok, status } as Response;
}

describe('isRetryableStatus', () => {
  it('treats 429 and 5xx as retryable', () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
  });

  it('treats other 4xx as non-retryable', () => {
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(403)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
  });

  it('treats 2xx/3xx as non-retryable', () => {
    expect(isRetryableStatus(200)).toBe(false);
    expect(isRetryableStatus(304)).toBe(false);
  });
});

describe('isRetryableError', () => {
  it('treats a generic network error as retryable', () => {
    expect(isRetryableError(new TypeError('fetch failed'))).toBe(true);
  });

  it('treats an AbortError as non-retryable', () => {
    expect(isRetryableError(new DOMException('Aborted', 'AbortError'))).toBe(
      false,
    );
  });

  it('treats a non-Error thrown value as retryable', () => {
    expect(isRetryableError('boom')).toBe(true);
  });
});

describe('fetchWithRetry', () => {
  it('returns immediately on a successful first attempt without waiting', async () => {
    const attempt = jest.fn().mockResolvedValue(response(200));

    const result = await fetchWithRetry(attempt, new AbortController().signal);

    expect(result.status).toBe(200);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('returns immediately on a non-retryable error status (e.g. 401) without retrying', async () => {
    const attempt = jest.fn().mockResolvedValue(response(401, false));

    const result = await fetchWithRetry(attempt, new AbortController().signal);

    expect(result.status).toBe(401);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('retries a retryable status (429) and returns the eventual success', async () => {
    jest.useFakeTimers();
    try {
      const attempt = jest
        .fn()
        .mockResolvedValueOnce(response(429, false))
        .mockResolvedValueOnce(response(429, false))
        .mockResolvedValueOnce(response(200));

      const promise = fetchWithRetry(attempt, new AbortController().signal);
      await jest.runAllTimersAsync();
      const result = await promise;

      expect(result.status).toBe(200);
      expect(attempt).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it('retries a thrown network error and returns the eventual success', async () => {
    jest.useFakeTimers();
    try {
      const attempt = jest
        .fn()
        .mockRejectedValueOnce(new TypeError('network down'))
        .mockResolvedValueOnce(response(200));

      const promise = fetchWithRetry(attempt, new AbortController().signal);
      await jest.runAllTimersAsync();
      const result = await promise;

      expect(result.status).toBe(200);
      expect(attempt).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it(`gives up and returns the last response after ${RETRY_MAX_ATTEMPTS} attempts`, async () => {
    jest.useFakeTimers();
    try {
      const attempt = jest.fn().mockResolvedValue(response(503, false));

      const promise = fetchWithRetry(attempt, new AbortController().signal);
      await jest.runAllTimersAsync();
      const result = await promise;

      expect(result.status).toBe(503);
      expect(attempt).toHaveBeenCalledTimes(RETRY_MAX_ATTEMPTS);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not retry an AbortError and rejects immediately', async () => {
    const attempt = jest
      .fn()
      .mockRejectedValue(new DOMException('Aborted', 'AbortError'));

    await expect(
      fetchWithRetry(attempt, new AbortController().signal),
    ).rejects.toThrow('Aborted');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('interrupts a pending backoff delay as soon as the signal aborts', async () => {
    const controller = new AbortController();
    const attempt = jest
      .fn()
      .mockResolvedValueOnce(response(503, false))
      .mockResolvedValue(response(200));

    const promise = fetchWithRetry(attempt, controller.signal);
    // Abort during what would be the backoff wait between attempt 1 and 2,
    // well before RETRY_BASE_DELAY_MS would naturally elapse.
    controller.abort(new DOMException('Aborted', 'AbortError'));

    await expect(promise).rejects.toThrow('Aborted');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('uses exponential backoff between attempts', async () => {
    jest.useFakeTimers();
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    try {
      const attempt = jest
        .fn()
        .mockResolvedValueOnce(response(500, false))
        .mockResolvedValueOnce(response(500, false))
        .mockResolvedValueOnce(response(200));

      const promise = fetchWithRetry(attempt, new AbortController().signal);
      await jest.runAllTimersAsync();
      await promise;

      const delays = setTimeoutSpy.mock.calls.map((call) => call[1]);
      expect(delays).toEqual([RETRY_BASE_DELAY_MS, RETRY_BASE_DELAY_MS * 2]);
    } finally {
      setTimeoutSpy.mockRestore();
      jest.useRealTimers();
    }
  });
});
