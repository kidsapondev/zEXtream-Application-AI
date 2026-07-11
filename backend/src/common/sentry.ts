import * as Sentry from '@sentry/node';

/**
 * Off by default: only calls Sentry.init() when SENTRY_DSN is actually set,
 * so nothing is sent anywhere unless the project owner opts in. Must run
 * before NestFactory.create() so Sentry's own instrumentation can hook
 * things (uncaught exceptions, unhandled rejections) as early as possible.
 * tracesSampleRate: 0 — error capture only, no performance tracing, to keep
 * this a minimal "know when something crashed" integration rather than a
 * full APM setup nobody asked for.
 */
export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    tracesSampleRate: 0,
  });
}

/** Whether Sentry.init() actually ran — used to advertise this to the frontend, never a secret. */
export function isSentryEnabled(): boolean {
  return Boolean(process.env.SENTRY_DSN);
}
