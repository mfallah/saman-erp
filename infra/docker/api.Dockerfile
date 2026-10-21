# syntax=docker/dockerfile:1.7
# =============================================================================
# Saman ERP — API/worker image (multi-stage)
#   build -> prod : runtime image (api + worker share this image)
#   build -> dev  : development image used by docker-compose.dev.yml
#
# Contract prerequisites (owned by backend implementation):
#   * pnpm-lock.yaml at repo root (frozen-lockfile install)
#   * package.json manifests for apps/api, apps/web, packages/shared
#   * `build` scripts producing apps/api/dist/{main.js,worker.js}
#   * migrations in apps/api/drizzle (copied for db:migrate)
# Builds fail fast with a clear missing-file error until those exist.
# =============================================================================

ARG NODE_VERSION=22.18.0
ARG PNPM_VERSION=11.6.0

FROM node:${NODE_VERSION}-alpine AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable \
 && corepack prepare pnpm@${PNPM_VERSION} --activate \
 && apk add --no-cache tini
WORKDIR /app

# -----------------------------------------------------------------------------
# deps: full workspace install (cache-friendly, lockfile enforced)
# -----------------------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/
COPY packages/db/package.json ./packages/db/
RUN --mount=type=cache,id=saman-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# -----------------------------------------------------------------------------
# build: compile api + shared
# -----------------------------------------------------------------------------
FROM deps AS build
COPY packages/shared ./packages/shared
COPY packages/db ./packages/db
COPY apps/api ./apps/api
RUN pnpm --filter @saman/shared build \
 && pnpm --filter @saman/db build \
 && pnpm --filter @saman/api build

# -----------------------------------------------------------------------------
# prod: minimal runtime, production dependencies only, non-root
# -----------------------------------------------------------------------------
FROM base AS prod
ENV NODE_ENV=production
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/
COPY packages/db/package.json ./packages/db/
RUN --mount=type=cache,id=saman-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "@saman/api..."
COPY --from=build /app/packages/shared ./packages/shared
RUN rm -rf ./packages/shared/node_modules ./packages/shared/src
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/packages/db/drizzle ./packages/db/drizzle
COPY --from=build /app/packages/db/package.json ./packages/db/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY infra/docker/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh
RUN mkdir -p /app/apps/api/tmp && chown -R node:node /app
USER 1000:1000
WORKDIR /app/apps/api
EXPOSE 3000
LABEL org.opencontainers.image.title="saman-erp-api" \
      org.opencontainers.image.description="Saman ERP API and worker (NestJS + Fastify)" \
      org.opencontainers.image.licenses="UNLICENSED"
ENTRYPOINT ["/sbin/tini", "--", "/app/entrypoint.sh"]

# -----------------------------------------------------------------------------
# dev: hot-reload target for docker-compose.dev.yml (source is bind-mounted)
# -----------------------------------------------------------------------------
FROM build AS dev
ENV NODE_ENV=development
USER 1000:1000
WORKDIR /app
EXPOSE 4000 9229
CMD ["pnpm", "dev:api"]
