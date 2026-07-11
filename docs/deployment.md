# Deployment & rollback runbook

This covers deploying the stack (`postgres`, `migrate`, `backend`, `frontend`)
from a clean checkout with `docker-compose.yml` + `docker-compose.prod.yml`,
and how to roll back. It does **not** cover provisioning TLS, a secret
manager, or CI image scanning — those need an infra/vendor decision only the
project owner can make (see plan.md's Phase 7 → Deployment section for why
they're deliberately left unchecked).

## Prerequisites

- Docker Engine with Compose v2 (`docker compose`, not the old `docker-compose`).
- A `.env` file at the repo root (copy `.env.example` and fill in real
  values — never commit it; it's gitignored).
- The target host can reach whatever `OLLAMA_BASE_URL` points at, and
  outbound HTTPS to `api.anthropic.com`/`api.openai.com` if users will
  configure Claude/OpenAI keys.

### Required `.env` values for a real deployment

Copy `.env.example` and change **at least** these from their placeholder
values — the app will run with the placeholders, but they're insecure:

| Variable                 | Why it matters                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`      | Placeholder is a known dev password.                                                                        |
| `DATABASE_URL`           | Must match `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB` above.                                          |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | Placeholders are known dev secrets — anyone with the repo could forge tokens.               |
| `API_KEY_ENCRYPTION_KEY` | 32-byte base64 key used to encrypt stored Claude/OpenAI API keys at rest; generate with e.g. `openssl rand -base64 32`. |
| `NODE_ENV`               | **Must be `production`** for the prod image — see "NODE_ENV must be production" below.                      |
| `CORS_ORIGIN`            | Leave empty/unset in prod (frontend+backend are same-origin behind nginx) rather than pointing at `localhost:4200`. |
| `TRUST_PROXY`            | `1` in prod (nginx is one hop in front of the backend) so `req.ip` reflects the real client, not the nginx container. |

### NODE_ENV must be `production`

The backend's production image is built with only `dependencies` installed
(`pnpm install --prod`), not `devDependencies`. The logger
(`backend/src/common/logger.config.ts`) uses the pretty-printing `pino-pretty`
transport — a devDependency — whenever `NODE_ENV !== 'production'`. Running
the prod image with `NODE_ENV=development` crashes the process on startup
(`Error: unable to determine transport target for "pino-pretty"`, confirmed
while verifying this runbook). With `NODE_ENV=production` the backend emits
structured JSON logs instead, which is also what you want in production
regardless of this crash — pretty-printed logs aren't worth parsing at
runtime.

## Deploy from a clean checkout

```bash
git clone <repo-url>
cd zEXtream-Application-AI
cp .env.example .env
# edit .env — see table above

docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

What this does, in order (via `depends_on` conditions already wired in
`docker-compose.yml`):

1. **`postgres`** starts; compose waits for its healthcheck (`pg_isready`) before continuing.
2. **`migrate`** runs `prisma migrate deploy` once and exits — applies any
   migration in `backend/prisma/migrations` not yet recorded in the
   `_prisma_migrations` table. Safe to re-run on every deploy: already-applied
   migrations are skipped, not reapplied.
3. **`backend`** starts only after `migrate` exits successfully
   (`condition: service_completed_successfully`). It's healthy once
   `GET /api/health` responds (liveness only — see
   `backend/src/health/health.controller.ts` for the separate `/api/health/ready`
   readiness check, which additionally pings Postgres).
4. **`frontend`** starts only once `backend` is healthy. It serves the built
   Angular app and reverse-proxies `/api/` and `/ws/` to `backend:3000`
   (`frontend/nginx.conf`) — the two containers are otherwise not reachable
   from outside the compose network (no host port published for `backend`
   in `docker-compose.prod.yml`).

The published port is `80` on the host, forwarded to the frontend
container's `8080` (see "Why 8080, not 80" below).

### Verifying a deploy succeeded

```bash
curl -f http://<host>/api/health/ready   # {"status":"ok","database":"ok"}
curl -f http://<host>/                   # 200, serves the Angular SPA
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
# all four services should show "healthy" (postgres, backend, frontend) or
# "Exited (0)" (migrate — it's a one-shot job, not a long-running service)
```

### Why 8080, not 80

The production frontend image is `nginxinc/nginx-unprivileged`
(`frontend/Dockerfile`), nginx's official non-root variant — it runs as uid
101 (`nginx`), which can't bind privileged ports (<1024), so it listens on
8080 internally. `docker-compose.prod.yml` maps host `80` → container `8080`
so this is invisible from outside; it only matters if you're editing
`frontend/nginx.conf` or debugging inside the container directly.

## Rollback

There is no automated one-command rollback — this is a plain
`docker compose` deployment, not an orchestrator with built-in revision
history (Kubernetes, ECS, etc.). Rolling back means re-deploying an older
known-good state by hand:

```bash
git checkout <previous-known-good-tag-or-commit>
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

This rebuilds and restarts `backend`/`frontend`/`migrate` from the older
source. `migrate` will run `prisma migrate deploy` again on startup — which
brings up the important limitation below.

### Prisma migrations are not automatically reversible

`prisma migrate deploy` only ever applies migrations **forward**. If the
commit/tag you're rolling back to predates a migration that's already been
applied to the production database, rolling back the *code* does **not**
roll back the *schema* — the older backend code will run against a newer
database schema than it expects, which can range from harmless (an added,
nullable column the old code just ignores) to broken (a renamed/dropped
column the old code still queries).

This repo does not currently have any hand-written "down" migrations. Prisma
can generate a rough down-migration skeleton
(`prisma migrate diff` between the target and current schema, applied with
`prisma db execute`), but it has to be reviewed and usually hand-edited
before running — Prisma does not generate or verify down-migrations
automatically, and blindly running a generated one against production data
can be destructive (e.g. dropping a column that had real data in it). There
is no "just roll it back" button here; treat a rollback that requires an
actual schema downgrade as a manual, case-by-case operation:

1. Diff the schema between the two commits/tags to see exactly what changed.
2. Write and review a down-migration by hand for anything that isn't purely
   additive (new nullable column/table).
3. Take a backup first (`docs/backup-restore.md`) — a schema downgrade is
   exactly the kind of operation you want a fallback for if step 2 was wrong.
4. Only then apply it and roll back the code.

If the rollback target predates no schema-affecting migration (the common
case — most rollbacks are "last deploy had a bug in application logic, not a
schema change"), none of the above applies: just redeploy the older code as
shown above and `migrate` running again is a no-op.

### Rolling back to a previous image instead of rebuilding

If you tag/push images to a registry as part of your deploy process (this
repo's compose files build locally and don't push anywhere by default), the
equivalent rollback is retagging/pulling the previous image tag and running
`docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d`
without `--build` (so compose uses the already-pulled older tag) — same
schema caveat above applies regardless of which way the old code gets onto
the host.

## Resource limits

`docker-compose.prod.yml` sets `deploy.resources.limits`/`reservations` for
`backend`, `frontend`, and `postgres`. These were chosen as reasonable
starting points for a small-to-medium deployment (backend/postgres 512MB
reserved / 1GB capped, 0.25 CPU reserved / 1.0 capped; frontend nginx 128MB
reserved / 256MB capped, 0.1 CPU reserved / 0.5 capped) — **not** measured
production requirements, since no real traffic has been load-tested against
this stack. `limits` are enforced by the container runtime even under plain
`docker compose up` (confirmed via `docker inspect` while verifying this
runbook — no Swarm needed); `reservations` are accepted by compose but only
actually used for scheduling decisions under Swarm, so they're a no-op today
beyond documentation intent. Revisit these once you have real `docker stats`
(or equivalent) data from production load.

## Health checks

`docker-compose.yml` defines a `healthcheck` for `backend` (works identically
in dev and prod — both listen on container port 3000) hitting
`GET /api/health` (liveness). `docker-compose.prod.yml` adds one for
`frontend` hitting `GET /` on its production-only port 8080 — it's only
defined there because the frontend's internal port differs between the dev
target (`ng serve` on 4200) and prod target (nginx on 8080), so a single
shared healthcheck definition in the base file wouldn't be correct for both.
`postgres`'s healthcheck (`pg_isready`) was already in place before this pass
and is the pattern the other two follow.

## Known gaps (not covered by this runbook)

- **Zero-downtime deploys**: `docker compose up -d --build` stops and
  recreates containers; there's a brief window where `backend`/`frontend`
  are down between old and new. A blue/green or rolling-update setup would
  need an orchestrator this repo doesn't use.
- **`backend/package.json`'s `start:prod` script** (`node dist/main`) has the
  same stale path this runbook's Dockerfile fix addressed
  (`backend/Dockerfile`'s prod-stage `CMD` now correctly points at
  `dist/src/main.js` — `nest build`'s output mirrors `backend/`'s two
  sibling TS roots, `src/` and `prisma.config.ts`, rather than flattening
  `src/` into `dist/` directly). The Dockerfile is fixed; the npm script is
  not, since `backend/package.json` was outside this pass's scope (owned by
  another in-progress change). Anyone running `pnpm start:prod` directly
  (outside Docker) will hit the same `Cannot find module 'dist/main.js'`
  error until that script is corrected too.
