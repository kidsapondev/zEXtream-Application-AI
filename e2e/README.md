# Browser E2E suite (Playwright)

Drives the real Angular frontend (`ng serve`) against a real NestJS backend
and a real Postgres — no mocked layers. Complements `backend/test/*.e2e-spec.ts`
(HTTP/WebSocket integration tests without a browser).

## Why a standalone stack instead of `docker compose up`

The repo's docker-compose stack is independently started/stopped/rebuilt by
other work in this repo, which would make this suite flaky through no fault
of its own, and its default ports (3000, 4200) may already be in use by a
running dev stack. This suite instead runs its own backend (port 3130) and
`ng serve` (port 4300) via Playwright's `webServer` option, and talks to a
small standalone Postgres container dedicated to E2E testing.

## One-time setup

```bash
# From the repo root:
pnpm install
pnpm --filter e2e exec playwright install chromium

# A standalone Postgres for both this suite and backend/test/*.e2e-spec.ts:
docker run -d --name zextream-e2e-test-postgres \
  -e POSTGRES_USER=chatapp -e POSTGRES_PASSWORD=e2etestpassword -e POSTGRES_DB=chatapp \
  -p 5455:5432 postgres:18.4-alpine

DATABASE_URL="postgresql://chatapp:e2etestpassword@127.0.0.1:5455/chatapp" \
  pnpm --filter backend exec prisma migrate deploy
```

## Running

```bash
pnpm --filter e2e test:e2e:browser
```

Playwright starts the backend and frontend dev servers itself (see
`playwright.config.ts`'s `webServer` entries) and tears them down after the
run. `reuseExistingServer` is on outside CI, so if you already have both
running on ports 3130/4300 (e.g. for debugging), it reuses them instead of
starting new ones.

View the HTML report after a run:

```bash
pnpm --filter e2e test:e2e:browser:report
```

## What's covered vs. what needs a real Ollama

`OLLAMA_BASE_URL` is pointed at an always-unreachable port for this entire
suite (no real Ollama is available in this environment). Covered for real:

- Register → login → create chat (`tests/auth-and-chat.spec.ts`)
- Reload → session/messages persist (`tests/auth-and-chat.spec.ts`)
- Logout → login as a different user → UI reflects the new identity, no
  cross-user data leakage (`tests/identity-switch.spec.ts`)
- Multiple tabs racing a refresh-token rotation (`tests/refresh-token-race.spec.ts`)
- Stop generation button / composer recovery, exercised against the same
  deterministic "provider unreachable" error path used elsewhere in this repo's
  test suites (`tests/stop-generation.spec.ts`)

Explicitly **not** run (would require mocking the AI response to fake a pass,
which the task this suite was built for called out as dishonest — see
`tests/ai-dependent.spec.ts` for the two `test.skip()` entries and what each
needs to actually run):

- Token-by-token streaming render
- Progressive Monaco code streaming

To run those for real, point `BACKEND_ENV.OLLAMA_BASE_URL` in
`playwright.config.ts` at a reachable Ollama instance with a pulled model and
remove the `.skip`.
