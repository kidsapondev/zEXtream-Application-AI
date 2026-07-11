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
COPY frontend ./frontend
WORKDIR /app/frontend
EXPOSE 4200
CMD ["pnpm", "exec", "ng", "serve", "--host", "0.0.0.0", "--proxy-config", "proxy.conf.json"]

FROM deps AS build
COPY packages/shared-types ./packages/shared-types
COPY frontend ./frontend
WORKDIR /app/frontend
RUN pnpm exec ng build

# nginxinc/nginx-unprivileged (pinned to the version/alpine combo `nginx:alpine`
# resolved to at pin time, same rationale as the Node pin above) is nginx's official
# non-root variant: it already runs its worker AND master process as uid 101 (`nginx`),
# listens on 8080 instead of 80 (unprivileged processes can't bind <1024), and ships
# /var/cache/nginx etc. pre-owned by that user — so no manual chown/USER juggling is
# needed here the way plain `nginx:alpine` (root master process) would require.
# frontend/nginx.conf's `listen` directive and docker-compose.prod.yml's port mapping
# both have to agree with the 8080 this image expects.
FROM nginxinc/nginx-unprivileged:1.29.8-alpine AS prod
# --chown so the nginx user actually owns its own config (the base image's entrypoint
# scripts patch default.conf in place, e.g. to add an IPv6 listen directive — a
# root-owned, default-permission file copied in would leave that as a harmless but
# noisy "read-only file system?" log line on every container start).
COPY --from=build --chown=nginx:nginx /app/frontend/dist/frontend/browser /usr/share/nginx/html
COPY --chown=nginx:nginx frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
