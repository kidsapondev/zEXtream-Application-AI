# PostgreSQL backup & restore runbook

This project's only stateful service is the `postgres` container defined in
`docker-compose.yml` (image `postgres:18.4-alpine`, data in the named volume
`pgdata`). Everything else (backend, frontend) is stateless and can be rebuilt
from source + migrations.

## Prerequisites

- The stack is running (`docker compose ... up -d`), or at least the
  `postgres` service/volume is available.
- You know the compose file combination in use, e.g. for production:
  `docker compose -f docker-compose.yml -f docker-compose.prod.yml`.
- `POSTGRES_USER` / `POSTGRES_DB` match whatever is in your `.env` (defaults
  from `.env.example`: `chatapp` / `chatapp`).

The examples below assume the base `docker-compose.yml` (dev); swap in
`-f docker-compose.yml -f docker-compose.prod.yml` for a production stack.

## Backup

Run `pg_dump` **inside** the running `postgres` container so it always
matches the server version, and stream the output to a file on the host.
Custom format (`-Fc`) is used because it's compressed and lets `pg_restore`
do selective/parallel restores later — a plain SQL dump can't.

```bash
# Windows PowerShell / bash both work with this form since it's all inside `docker compose exec`
docker compose exec -T postgres pg_dump \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc \
  > "backup_$(date +%Y%m%d_%H%M%S).dump"
```

PowerShell equivalent (no `$(date ...)` command substitution):

```powershell
$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
docker compose exec -T postgres pg_dump -U $env:POSTGRES_USER -d $env:POSTGRES_DB -Fc | `
  Out-File -Encoding byte "backup_$stamp.dump"
```

Verify the dump isn't empty/corrupt before trusting it:

```bash
pg_restore --list backup_20260711_030000.dump | head
```

### What this does and doesn't cover

- Covers: all tables (`users`, `refresh_tokens`, `chat_sessions`, `messages`,
  `code_artifacts`, `provider_credentials`), including encrypted
  provider API keys (still encrypted at rest — the dump doesn't decrypt them).
- Does **not** cover: the `API_KEY_ENCRYPTION_KEY` env var itself. Losing that
  key makes any dumped `provider_credentials` rows permanently
  undecryptable even after a successful restore — back up the encryption key
  separately, through whatever secret-management process you use for
  secrets in general (this repo doesn't provision one — see plan.md's
  Deployment section).

### Scheduling

There's no cron/automation for this in the repo today (out of scope for this
pass — it's an infra/ops decision, similar to picking a secret manager). The
commands above are meant to be wired into whatever scheduler the deployment
environment already has (host cron, a Kubernetes CronJob, the cloud
provider's managed-Postgres backup feature, etc.) rather than reinvented here.

## Restore

**Stop the backend first** (or at least be ready for it to error against a
half-restored database) — the running app will otherwise see i/o errors or
transiently inconsistent data mid-restore.

```bash
docker compose stop backend
```

Restore into a **fresh** database (recommended) rather than on top of a live
one, to avoid constraint conflicts with existing rows:

```bash
# Drop and recreate the target database (DESTRUCTIVE — double check $POSTGRES_DB)
docker compose exec -T postgres dropdb -U "$POSTGRES_USER" "$POSTGRES_DB"
docker compose exec -T postgres createdb -U "$POSTGRES_USER" -O "$POSTGRES_USER" "$POSTGRES_DB"

# Restore from the dump (copy it into the container first, then run pg_restore there)
docker compose cp backup_20260711_030000.dump postgres:/tmp/restore.dump
docker compose exec -T postgres pg_restore \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --clean --if-exists /tmp/restore.dump
```

Then bring the backend back up — it will run `prisma migrate deploy` (via the
`migrate` one-shot service) before starting, so a dump taken on an older
schema version gets migrated forward automatically as part of normal startup:

```bash
docker compose up -d migrate backend
```

### Sanity-check after restore

```bash
docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "\dt"
docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT count(*) FROM users;"
curl -f http://localhost:3000/api/health/ready
```

The last command hits the readiness endpoint added alongside this doc (see
`backend/src/health/health.controller.ts`), which pings the database with
`SELECT 1` — a quick way to confirm the app can actually talk to the
restored database, not just that the container is up.

## Restore testing

This runbook was exercised end-to-end against the project's `postgres`
service during the Phase 7 security-hardening pass: `pg_dump -Fc` produced a
working dump of the real schema (7 tables incl. `users`, `chat_sessions`,
`messages`, `code_artifacts`, `refresh_tokens`, `provider_credentials`,
`_prisma_migrations`), and `pg_restore` successfully rebuilt that schema plus
a seeded test row into a separate database from the dump file. The
drop/recreate step against the live `chatapp` database itself was
**intentionally not repeated in that test** (it would have destroyed
whatever pre-existing dev data was in the shared volume at the time) — the
restore-into-a-fresh-target mechanics were validated instead by restoring
into a throwaway database name, which exercises the same `pg_restore`
codepath the "Restore" section above documents.

One Windows-specific gotcha found during that test: running these commands
from Git Bash (MSYS), plain in-container paths like `/tmp/restore.dump`
passed as a `docker compose exec` argument get silently mangled into a
Windows host path before reaching Docker. Work around it by doubling the
leading slash (`//tmp/restore.dump`) on that specific argument, or run the
commands from PowerShell/cmd instead where this doesn't happen.

Before relying on this in production, additionally run the full destructive
cycle once against a disposable (not shared) dev stack:

1. `docker compose up -d` against a fresh/disposable volume.
2. Create a user, a session, a message via the app.
3. Take a backup per the steps above.
4. `docker compose down -v` (wipes the volume) then `docker compose up -d`.
5. Restore per the steps above, including the `dropdb`/`createdb` step this
   time (safe because the volume is disposable).
6. Confirm the user/session/message from step 2 are back.
