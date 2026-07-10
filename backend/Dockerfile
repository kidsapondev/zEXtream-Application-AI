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
RUN pnpm install --frozen-lockfile --prod --filter=backend...
COPY packages/shared-types ./packages/shared-types
COPY --from=build /app/backend/dist ./backend/dist
WORKDIR /app/backend
RUN pnpm exec prisma generate
EXPOSE 3000
CMD ["node", "dist/main.js"]
