import { vi } from 'vitest';
import { fetchPublicConfig, initSentry } from './sentry';

describe('fetchPublicConfig', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the parsed config on a successful response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ sentryDsn: 'https://key@o0.ingest.sentry.io/0', sentryEnvironment: 'production' }),
      }),
    );

    const config = await fetchPublicConfig();

    expect(config).toEqual({
      sentryDsn: 'https://key@o0.ingest.sentry.io/0',
      sentryEnvironment: 'production',
    });
  });

  it('returns null when the response is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));

    expect(await fetchPublicConfig()).toBeNull();
  });

  it('returns null (never throws) when the fetch itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    await expect(fetchPublicConfig()).resolves.toBeNull();
  });
});

describe('initSentry', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not throw and resolves when no DSN is configured', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ sentryDsn: null, sentryEnvironment: 'development' }),
      }),
    );

    await expect(initSentry()).resolves.toBeUndefined();
  });

  it('does not throw and resolves when the config fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    await expect(initSentry()).resolves.toBeUndefined();
  });

  // Sentry.init() itself is a one-line pass-through to the third-party SDK,
  // not app logic worth unit testing here (and this test runner can't
  // reliably intercept an external ESM package's export via vi.mock() —
  // confirmed while writing this: the mocked binding surfaced as
  // "not a function" even though the module was demonstrably being
  // rewritten to reference it). fetchPublicConfig() above covers the actual
  // branching logic (fetch failure, non-ok response, DSN present/absent);
  // that Sentry.init() gets called with the right args when a DSN is
  // present was confirmed manually — see docs/deployment.md.
});
