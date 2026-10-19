# syntax=docker/dockerfile:1.7
# =============================================================================
# Saman ERP — admin SPA image (build with Vite, serve with unprivileged nginx)
#   build -> prod : static bundle + non-root nginx on :8080
#   build -> dev  : Vite dev server (source bind-mounted by compose dev overlay)
#
# Contract prerequisites (backend/frontend team):
#   * pnpm-lock.yaml + workspace manifests
#   * `pnpm --filter @saman/web build` producing apps/web/dist
# =============================================================================

ARG NODE_VERSION=22.18.0
ARG PNPM_VERSION=11.6.0

FROM node:${NODE_VERSION}-alpine AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable \
 && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app

# -----------------------------------------------------------------------------
# deps
# -----------------------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/
RUN --mount=type=cache,id=saman-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# -----------------------------------------------------------------------------
# build: shared contracts -> web bundle
# -----------------------------------------------------------------------------
FROM deps AS build
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web
ARG VITE_APP_VERSION=1.0.0
ARG VITE_API_BASE_URL=
ENV VITE_APP_VERSION=${VITE_APP_VERSION} \
    VITE_API_BASE_URL=${VITE_API_BASE_URL}
RUN pnpm --filter @saman/shared build || true \
 && pnpm --filter @saman/web build

# -----------------------------------------------------------------------------
# prod: unprivileged nginx, non-root (uid 101), listens 8080, proxies api:4000
# -----------------------------------------------------------------------------
FROM nginxinc/nginx-unprivileged:1.27-alpine AS prod
USER root
COPY infra/nginx/nginx.conf /etc/nginx/nginx.conf
COPY infra/nginx/proxy_params.inc /etc/nginx/conf.d/proxy_params.inc
COPY infra/nginx/saman.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
RUN chown -R nginx:nginx /usr/share/nginx/html /etc/nginx/conf.d
USER 101:101
EXPOSE 8080
LABEL org.opencontainers.image.title="saman-erp-web" \
      org.opencontainers.image.description="Saman ERP Persian RTL admin SPA (nginx)" \
      org.opencontainers.image.licenses="UNLICENSED"
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["nginx", "-g", "daemon off;"]

# -----------------------------------------------------------------------------
# dev: Vite dev server (compose dev overlay supplies the command/ports)
# -----------------------------------------------------------------------------
FROM build AS dev
ENV NODE_ENV=development
USER node
WORKDIR /app
EXPOSE 5173
CMD ["pnpm", "dev:web", "--", "--host", "0.0.0.0"]
