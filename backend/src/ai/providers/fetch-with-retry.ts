/** Total attempts including the first (i.e. up to 2 retries after the initial try). */
export const RETRY_MAX_ATTEMPTS = 3;

/** Base delay for exponential backoff between attempts (300ms, 600ms, ...). */
export const RETRY_BASE_DELAY_MS = 300;

/** A response status worth retrying: transient overload/rate-limit, not a client error. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * A thrown fetch error worth retrying: a real network failure, not an
 * intentional abort. Deliberately does not require `instanceof Error` —
 * fetch's own abort errors surface as `DOMException`, which does not extend
 * `Error` in the spec, so that check would silently treat every abort as
 * retryable instead of stopping immediately.
 */
export function isRetryableError(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && 'name' in error) {
    if (error.name === 'AbortError') return false;
  }
  return true;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason as Error);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Retries a fetch attempt with exponential backoff for transient failures
 * (network errors, 429, 5xx) only — a non-retryable response (e.g. 401) is
 * returned immediately on the first attempt so the caller's existing error
 * mapping runs unchanged. Only the initial connection is retried; once a
 * response's body starts streaming, retrying would mean replaying partial
 * output to the client, so callers must not use this once reading has begun.
 * The provided `signal` both cancels an in-flight attempt (already true of
 * whatever the caller passes to fetch()) and interrupts a pending backoff
 * delay immediately, so a user-initiated Stop during a retry wait doesn't
 * have to wait out the delay.
 */
export async function fetchWithRetry(
  attempt: () => Promise<Response>,
  signal: AbortSignal,
): Promise<Response> {
  let lastError: unknown;

  for (let i = 0; i < RETRY_MAX_ATTEMPTS; i += 1) {
    try {
      const response = await attempt();
      if (response.ok || !isRetryableStatus(response.status)) {
        return response;
      }
      if (i === RETRY_MAX_ATTEMPTS - 1) {
        return response;
      }
    } catch (error) {
      if (!isRetryableError(error) || i === RETRY_MAX_ATTEMPTS - 1) {
        throw error;
      }
      lastError = error;
    }
    await delay(RETRY_BASE_DELAY_MS * 2 ** i, signal);
  }

  // Unreachable: the loop above always returns or throws on its final
  // iteration. This satisfies the compiler without an unsound assertion.
  throw lastError;
}
