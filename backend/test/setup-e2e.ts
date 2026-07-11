/**
 * Jest `setupFiles` entry for the e2e suite (see jest-e2e.json). Runs before
 * any spec file is required, and therefore before `AppModule`/`ConfigModule`
 * is imported anywhere — which is what matters, since `ConfigModule.forRoot()`
 * validates `process.env` against `env.validation.ts`'s schema the moment
 * `AppModule` is first imported, and `@nestjs/config`'s dotenv loading never
 * overwrites a variable that is already set.
 *
 * Goal: `docker compose up -d postgres` + `pnpm --filter backend test:e2e`
 * should work out of the box, without requiring a fully-populated
 * `backend/.env` (a local, gitignored, dev-convenience file that may be
 * absent, stale, or mid-edit depending on who/what last touched it).
 */

// Any sufficiently long secret works for these — only used to sign/verify
// tokens within this test process's own lifetime.
process.env.JWT_ACCESS_SECRET ??= 'e2e-test-access-secret-do-not-use-in-prod';
process.env.JWT_REFRESH_SECRET ??= 'e2e-test-refresh-secret-do-not-use-in-prod';
// 32 raw bytes, base64-encoded — satisfies isAes256Key() in env.validation.ts.
process.env.API_KEY_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
// Deliberately unreachable (nothing listens on this port): OllamaProvider's
// fetch() fails fast with ECONNREFUSED instead of waiting out the 10s
// connect-timeout. Tests that exercise the "Ollama unavailable" path (see
// websocket.e2e-spec.ts) depend on this being unreachable, not just wrong.
process.env.OLLAMA_BASE_URL ??= 'http://127.0.0.1:39997';
process.env.CORS_ORIGIN ??= '';
process.env.NODE_ENV = 'test';
// Keeps pino-http's per-request info logs out of the way while running the
// suite locally; still surfaces warnings/errors that matter for debugging a
// failure. Set LOG_LEVEL explicitly before running the suite to override.
process.env.LOG_LEVEL ??= 'warn';

// backend/.env (if present) is local dev-convenience only and may point at a
// stale Postgres password from a previously-provisioned container; the
// repo-root docker-compose stack is also independently started/stopped/
// reconfigured by other work happening in this repo (Docker/deployment
// config is someone else's active territory), so depending on it being up —
// on a stable host port, with the schema migrated — makes this suite flaky
// through no fault of its own. e2e tests instead default to a small,
// dedicated Postgres container started independently of docker-compose,
// specifically for this suite, on a port docker-compose never uses:
//   docker run -d --name zextream-e2e-test-postgres \
//     -e POSTGRES_USER=chatapp -e POSTGRES_PASSWORD=e2etestpassword -e POSTGRES_DB=chatapp \
//     -p 5455:5432 postgres:18.4-alpine
//   DATABASE_URL="postgresql://chatapp:e2etestpassword@127.0.0.1:5455/chatapp" \
//     pnpm --filter backend exec prisma migrate deploy
// Override unconditionally so a stale backend/.env can't silently point
// tests at the wrong database; set TEST_DATABASE_URL to opt into a different
// target (e.g. the docker-compose Postgres, or a CI-provisioned one) without
// editing this file.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://chatapp:e2etestpassword@127.0.0.1:5455/chatapp';
