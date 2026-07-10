FROM node:24-alpine AS base
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

FROM nginx:alpine AS prod
COPY --from=build /app/frontend/dist/frontend/browser /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
