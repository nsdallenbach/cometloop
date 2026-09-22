# syntax=docker/dockerfile:1.7
# Cometloop console — portable runtime image (docs/platform-architecture.md,
# section 7). One image, two commands:
#   default                  node dist/main.js    (the api)
#   node dist/worker.js      the worker (a stub until phase 4 splits the loops out)
#
# Build:  docker build -t cometloop .
# Run:    docker run -e DATABASE_URL=postgres://... -p 8000:8000 cometloop
# Local:  docker compose up   (Postgres 17 + the api; see docs/local-dev.md)

# ---- build: full toolchain, client + server bundles -------------------------
FROM node:22-alpine AS build
WORKDIR /app
ENV CI=1
# postinstall runs `appkit generate-types`, which is fine without a workspace
# (it skips query types and writes the serving stub).
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# prebuild runs `appkit plugin sync` + typegen; build:server -> dist/,
# build:client -> client/dist/.
RUN npm run build

# ---- deps: production node_modules only -------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
ENV CI=1
COPY package.json package-lock.json ./
# --ignore-scripts: skip postinstall typegen (dev-only) and native rebuilds
# (sharp ships prebuilt binaries for linux-musl).
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# ---- runtime ----------------------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8000 \
    FILES_DIR=/data/files
WORKDIR /app
# The api needs wget for the health check only; node:22-alpine has busybox wget.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY --from=build /app/client/dist ./client/dist
# Local-disk files volume (SOW uploads, context files, attachments) until
# object storage lands in phase 5. Owned by the non-root user.
RUN mkdir -p /data/files && chown -R node:node /data /app
USER node
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1
CMD ["node", "dist/main.js"]
