# syntax=docker/dockerfile:1.7
# ---------------------------------------------------------------------------
# Enterprise MSP Service Management Platform
# Multi-stage build: all dependencies are downloaded and compiled inside Docker.
# The runtime image contains the API server, background worker and the compiled
# web application (served by the API).
# ---------------------------------------------------------------------------

FROM node:22-bookworm-slim AS base
ENV NODE_ENV=development
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# ---- dependencies ---------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund

# ---- build ----------------------------------------------------------------
FROM deps AS build
COPY . .
RUN npm run build

# ---- prune to production dependencies -------------------------------------
FROM build AS prune
RUN npm prune --omit=dev --no-audit --no-fund \
 && mkdir -p packages/shared/node_modules apps/api/node_modules

# ---- runtime --------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl tini \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data/storage && chown -R node:node /data

COPY --from=prune --chown=node:node /app/node_modules ./node_modules
COPY --from=prune --chown=node:node /app/package.json ./package.json
COPY --from=prune --chown=node:node /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=prune --chown=node:node /app/packages/shared/dist ./packages/shared/dist
COPY --from=prune --chown=node:node /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=prune --chown=node:node /app/apps/api/package.json ./apps/api/package.json
COPY --from=prune --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=prune --chown=node:node /app/apps/api/drizzle ./apps/api/drizzle
COPY --from=prune --chown=node:node /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=prune --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --chown=node:node deploy/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

USER node
EXPOSE 8080
VOLUME ["/data/storage"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=5 \
  CMD curl -fsS http://localhost:8080/api/health || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker-entrypoint.sh"]
CMD ["server"]
