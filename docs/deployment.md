# Deployment & rollback runbook

This covers deploying the stack (`postgres`, `migrate`, `backend`, `frontend`)
from a clean checkout with `docker-compose.yml` + `docker-compose.prod.yml`,
and how to roll back, plus the optional file-based secrets overlay and error
reporting (see below). It does **not** provision TLS certificates or pick a
specific secret-manager/error-reporting *vendor* — those still need the
project owner to choose a provider (Vault vs. AWS Secrets Manager, Sentry vs.
Datadog, etc.); what's here is vendor-agnostic plumbing that works with
whichever one gets chosen.

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

## Exposing the stack on a public domain (Cloudflare Tunnel)

The base setup above only serves the app on `http://<host>` (port 80, no
TLS) — fine for a LAN, not for a real domain. For a **home server** without a
public/static IP or open router ports (including behind CGNAT),
`docker-compose.cloudflare.yml` adds a `cloudflared` container that opens an
outbound-only connection to Cloudflare's edge; Cloudflare terminates TLS and
routes traffic for your domain into the tunnel, so nothing needs to be
forwarded on the router and no certificate is managed on this host.

One-time setup in the Cloudflare dashboard (not scriptable from here — needs
your account):

1. Add the domain to a Cloudflare account and repoint its nameservers at
   Cloudflare via the domain's registrar.
2. Zero Trust dashboard > **Networks > Tunnels** > Create a tunnel
   (Cloudflared) > copy the token it shows.
3. In the tunnel's **Public Hostname** tab, add a hostname (e.g. the bare
   domain) routed to service `http://frontend:8080` — the same origin
   `docker-compose.prod.yml` already publishes on host port 80, just reached
   through the tunnel instead of a published port.
4. Put the token in `.env` as `CLOUDFLARE_TUNNEL_TOKEN` (see
   `.env.example`).

Then bring the stack up with the extra overlay:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  -f docker-compose.cloudflare.yml up -d --build
```

No other app config changes are needed: `frontend/nginx.conf` already
redirects to HTTPS off `X-Forwarded-Proto` (which Cloudflare sets), and
`CORS_ORIGIN`/`TRUST_PROXY` from the "Required `.env` values" table above
still apply unchanged — frontend and backend remain same-origin behind
nginx, cloudflared just replaces the published host port as the entry point.
Verify `req.ip` in backend logs reflects real client IPs (not the
`cloudflared`/nginx container) after switching this on, since it's an extra
hop that wasn't present when this was tested.

If the domain later moves to a VPS with a real public IP instead of a home
server, drop this overlay and terminate TLS with a conventional
reverse proxy/load balancer in front of the published port 80 instead.

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
`backend`, `frontend`, and `postgres` (backend/postgres 512MB reserved / 1GB
capped, 0.25 CPU reserved / 1.0 capped; frontend nginx 128MB reserved / 256MB
capped, 0.1 CPU reserved / 0.5 capped). `limits` are enforced by the
container runtime even under plain `docker compose up` (confirmed via
`docker inspect` — no Swarm needed); `reservations` are accepted by compose
but only actually used for scheduling decisions under Swarm, so they're a
no-op today beyond documentation intent.

### Load test results

Ran a basic load test against the real `target: prod` backend image (built
and run exactly as this runbook describes, limits actively enforced —
confirmed via `docker inspect`) with the current dev Postgres data volume
attached, using a small Node script driving concurrent `fetch()` calls
against `localhost:3000` (not a dedicated tool like k6/autocannon, since this
was a quick sanity check rather than a formal capacity-planning exercise —
treat these as directional, not a guarantee):

- **Burst load** (40 concurrent clients hammering `GET /api/health` as fast
  as possible, each spoofing a distinct `X-Forwarded-For` so `TRUST_PROXY=1`
  attributes them to different IPs): ~5,500 attempted req/s, about half
  rejected with 429 — this is the default REST throttle (100 req/min per IP,
  see `app.module.ts`) correctly kicking in once a single simulated client
  blew through its own quota in about a second, not a capacity problem.
  Successful requests: p50 11ms, p95 26ms, p99 58ms. Backend CPU pinned at
  ~98% of its configured 1.0-core cap throughout; memory stayed in the
  130–230MB range, well under the 1GB cap. Postgres barely registered (peak
  ~7.6% CPU, ~45MB memory) since `/api/health` is a trivial `SELECT 1`.
- **Sustained legitimate load** (150 concurrent simulated clients, each
  paced to stay under the per-IP throttle, ~66 req/min/IP): 0 errors,
  ~160 req/s sustained for 20s, p50 25ms, p95 76ms, p99 154ms, max 171ms.
  Backend CPU only 7–14% of its 1.0-core cap; memory flat around 175MB.

**Takeaway**: at the traffic levels tested, the backend's memory limit has
substantial headroom (never exceeded ~230MB against a 1GB cap, including
under the throttle-saturated burst case) — the CPU limit is the first thing
that would need raising under real sustained load well above what was
exercised here, not memory. These numbers only cover `GET /api/health` and
an authenticated `GET /api/chat/sessions` read (ad hoc script, not committed
to the repo — describes its own methodology above, worth redoing with a
proper tool like k6/autocannon if this needs to be repeatable) — they say
nothing about AI-streaming load (which is bounded by the upstream provider,
not this service's own CPU) or write-heavy paths. Revisit with a
production-realistic traffic mix before trusting these limits at real scale.

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

## Secrets: file-based instead of plain environment variables

`docker-compose.secrets.yml` is an optional overlay demonstrating
Docker Compose's native `secrets:` support for `DATABASE_URL`,
`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, and `API_KEY_ENCRYPTION_KEY`.
Instead of the plain env vars in `.env`, the backend reads a
`<KEY>_FILE` variable pointing at a file and uses that file's (trimmed)
contents — see `backend/src/config/env.validation.ts`. A `_FILE` value
always wins over a plain value of the same key if both are set.

```bash
mkdir -p secrets
# real values, not the placeholders below — this directory is gitignored
echo -n "postgresql://user:pass@postgres:5432/db" > secrets/database_url.txt
echo -n "$(openssl rand -base64 48)" > secrets/jwt_access_secret.txt
echo -n "$(openssl rand -base64 48)" > secrets/jwt_refresh_secret.txt
echo -n "$(openssl rand -base64 32)" > secrets/api_key_encryption_key.txt

docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  -f docker-compose.secrets.yml up -d --build
```

Verified while writing this: with the overlay active, `docker exec`
into the backend container shows the secrets mounted at
`/run/secrets/*`, and the app boots and reports `{"database":"connected"}`
from `/api/health` using the file-supplied values.

This is deliberately vendor-agnostic — Docker Compose secrets, Kubernetes
Secrets mounted as files, a Vault agent template, and an AWS Secrets
Manager sidecar all boil down to "a secret manager renders a value to a
file on disk"; point the `file:` entries in `docker-compose.secrets.yml`
at wherever your chosen manager writes instead of `./secrets/*.txt` and
the same mechanism applies without any app code changes.

## Error reporting (optional, off by default)

Set `SENTRY_DSN` in `.env` to enable Sentry error reporting in both the
backend (`backend/src/common/sentry.ts`, initialized in `main.ts` before
anything else) and the frontend (`frontend/src/app/core/sentry.ts`,
initialized in `main.ts`). Leaving `SENTRY_DSN` unset disables it
entirely — no Sentry SDK network calls happen, nothing is sent anywhere.
`SENTRY_ENVIRONMENT` (defaults to `NODE_ENV`) tags events so dev/staging/
prod errors don't mix in one Sentry project. Swap in a different
provider's SDK the same way if Sentry isn't the vendor you land on —
both initializers are small, isolated, and only wired in behind the
"is a DSN configured" check.

## Known gaps (not covered by this runbook)

- **Zero-downtime deploys**: `docker compose up -d --build` stops and
  recreates containers; there's a brief window where `backend`/`frontend`
  are down between old and new. A blue/green or rolling-update setup would
  need an orchestrator this repo doesn't use.
- **CI image scanning** now runs (`.github/workflows/ci.yml`, Trivy against
  both built images) but only reports findings in the Actions log/Security
  tab — it doesn't block a merge on vulnerabilities found, since deciding
  a severity threshold that fails CI is a policy call for the project owner.
