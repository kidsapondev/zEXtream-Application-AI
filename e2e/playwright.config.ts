import { defineConfig, devices } from '@playwright/test';
import path from 'path';

/**
 * Repo-wide browser E2E suite. Drives the real Angular frontend (via `ng
 * serve`, so relative `/api`/`/ws` calls are proxied to a real backend
 * exactly like frontend/proxy.conf.json does inside Docker) against a real
 * NestJS backend + Postgres — no mocking at any layer.
 *
 * Deliberately does NOT reuse the repo's docker-compose stack: that stack is
 * independently started/stopped/reconfigured by other work happening in this
 * repo (see docker-compose.override.yml), which would make this suite flaky
 * through no fault of its own, and its default ports (3000, 4200) may
 * already be bound by a running dev stack. Instead this spins up its own
 * backend (port 3130) and frontend dev server (port 4300) via `webServer`
 * below, pointed at the same standalone Postgres container the backend's
 * `pnpm test:e2e` suite uses (see backend/test/setup-e2e.ts) — bring it up
 * with:
 *
 *   docker run -d --name zextream-e2e-test-postgres \
 *     -e POSTGRES_USER=chatapp -e POSTGRES_PASSWORD=e2etestpassword -e POSTGRES_DB=chatapp \
 *     -p 5455:5432 postgres:18.4-alpine
 *   DATABASE_URL="postgresql://chatapp:e2etestpassword@127.0.0.1:5455/chatapp" \
 *     pnpm --filter backend exec prisma migrate deploy
 *
 * Then from the repo root: `pnpm --filter e2e test:e2e:browser` (installs
 * browsers once first with `pnpm --filter e2e exec playwright install
 * chromium`). See README.md in this directory for the full runbook.
 */

const REPO_ROOT = path.resolve(__dirname, '..');
const BACKEND_PORT = 3130;
// Not 4300/4200: both were found already bound by unrelated, pre-existing
// processes on this machine while developing this suite (4200 by the repo's
// own docker-compose dev stack; 4300 by something else entirely — do not
// assume either is free). Pick a high, unusual port and pass `--host
// 127.0.0.1` explicitly below: `ng serve`'s default `localhost` bind can
// resolve to the IPv6 loopback first, which `baseURL`'s IPv4
// `127.0.0.1` below would then fail to reach with ECONNREFUSED even though
// something is genuinely listening on the port.
const FRONTEND_PORT = 4319;

// Test-only secrets/config — mirrors backend/test/setup-e2e.ts's defaults so
// this suite needs no separate secret management. Never used outside a
// throwaway local Postgres.
const BACKEND_ENV: Record<string, string> = {
  NODE_ENV: 'development',
  PORT: String(BACKEND_PORT),
  DATABASE_URL:
    process.env.TEST_DATABASE_URL ??
    'postgresql://chatapp:e2etestpassword@127.0.0.1:5455/chatapp',
  JWT_ACCESS_SECRET: 'e2e-browser-test-access-secret-do-not-use-in-prod',
  JWT_REFRESH_SECRET: 'e2e-browser-test-refresh-secret-do-not-use-in-prod',
  // 32 raw bytes, base64 — satisfies env.validation.ts's isAes256Key().
  API_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
  // Deliberately unreachable: no real Ollama is available in this
  // environment. Scenarios that need a real model response (token
  // streaming, progressive Monaco code generation) are skipped — see
  // tests/ai-dependent.spec.ts — everything else in this suite is written
  // to exercise the real, deterministic "provider unreachable" error path
  // instead of mocking a response.
  OLLAMA_BASE_URL: 'http://127.0.0.1:39997',
  CORS_ORIGIN: '',
  TRUST_PROXY: '0',
  LOG_LEVEL: 'warn',
};

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // Generous: registerNewUser (see tests/helpers.ts) may back off and retry
  // across a real 60s register-throttle window when the suite as a whole
  // registers more than 3 users within a minute.
  timeout: 150_000,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${FRONTEND_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'pnpm --filter backend start',
      cwd: REPO_ROOT,
      port: BACKEND_PORT,
      env: BACKEND_ENV,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `pnpm --filter frontend exec ng serve --host 127.0.0.1 --port ${FRONTEND_PORT} --proxy-config ../e2e/proxy.local.json`,
      cwd: REPO_ROOT,
      port: FRONTEND_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
