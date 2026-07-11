# Pinned to the exact patch/alpine combination `node:24-alpine` currently resolves to
# (verified via digest match at pin time) so builds are reproducible without the
# maintenance overhead of full digest pinning. Bump deliberately, not automatically.
FROM node:24.18.0-alpine3.24 AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared-types/package.json ./packages/shared-types/package.json
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS dev
COPY packages/shared-types ./packages/shared-types
COPY backend ./backend
WORKDIR /app/backend
RUN pnpm exec prisma generate
EXPOSE 3000
CMD ["pnpm", "start:dev"]

FROM deps AS build
COPY packages/shared-types ./packages/shared-types
COPY backend ./backend
WORKDIR /app/backend
RUN pnpm exec prisma generate
RUN pnpm run build

FROM base AS prod
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared-types/package.json ./packages/shared-types/package.json
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
COPY backend/prisma ./backend/prisma
# Prisma 7's config file (not schema.prisma) is where this repo's datasource.url is
# declared (see backend/prisma.config.ts — it reads DATABASE_URL from the environment).
# `prisma migrate deploy` (run by the `migrate` service, which also builds from this
# stage) fails outright without it: "The datasource.url property is required in your
# Prisma config file". Easy to miss because `prisma generate` above still succeeds
# without it — only `migrate deploy`'s actual DB connection needs it.
COPY backend/prisma.config.ts ./backend/prisma.config.ts
RUN pnpm install --frozen-lockfile --prod --filter=backend...
COPY packages/shared-types ./packages/shared-types
COPY --from=build /app/backend/dist ./backend/dist
WORKDIR /app/backend
RUN pnpm exec prisma generate
# Run as the non-root `node` user baked into the official Node image (uid 1000) rather
# than root. Everything above this line still runs as root (installs, prisma generate)
# so file ownership is root:root, but the default permissions COPY/RUN leave in place are
# world-readable/executable, which is all the CMD below needs — it never writes to the
# filesystem at runtime (no local uploads/cache; Postgres and stdout logging only).
USER node
EXPOSE 3000
# Not "dist/main.js": tsc's rootDir now spans both backend/prisma.config.ts and
# backend/src/** (two sibling roots under backend/), so `nest build` mirrors that
# structure under dist/ instead of flattening src/ into dist/ directly — the real
# entrypoint is dist/src/main.js (confirmed by inspecting the built image directly,
# not assumed). package.json's own `start:prod` script has the same stale
# `node dist/main` path and needs the same fix, but that file is outside this task's
# scope (backend/src territory another in-progress agent owns) — flagged in
# docs/deployment.md and plan.md for a follow-up there.
CMD ["node", "dist/src/main.js"]
