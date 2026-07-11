import * as Sentry from '@sentry/angular';

interface PublicConfig {
  sentryDsn: string | null;
  sentryEnvironment: string;
}

/**
 * Fetches /api/config (a small, deliberately non-secret endpoint — see
 * backend/src/common/public-config.controller.ts) and returns it, or null
 * if the request failed for any reason. Kept separate from initSentry() so
 * this — the part with actual branching logic worth unit testing — doesn't
 * require mocking the third-party @sentry/angular SDK to test.
 */
export async function fetchPublicConfig(): Promise<PublicConfig | null> {
  try {
    const response = await fetch('/api/config');
    if (!response.ok) return null;
    return (await response.json()) as PublicConfig;
  } catch {
    return null;
  }
}

/**
 * Off by default: only calls Sentry.init() if the backend reports a DSN
 * configured. Runs after bootstrap rather than blocking it, so a slow/failed
 * config fetch never delays the app's first paint — the tradeoff is that
 * errors during the bootstrap itself (before this resolves) aren't captured,
 * an acceptable gap for an optional, opt-in integration.
 */
export async function initSentry(): Promise<void> {
  const config = await fetchPublicConfig();
  if (!config?.sentryDsn) return;
  Sentry.init({
    dsn: config.sentryDsn,
    environment: config.sentryEnvironment,
    tracesSampleRate: 0,
  });
}
