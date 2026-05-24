# =============================================================================
# XC / Hike & Fly League Platform — Dockerfile
#
# Multi-stage build:
#   1. Install all deps + compile TypeScript server
#   2. Build Vite frontend
#   3. Minimal production image with only runtime deps
# =============================================================================

# ── Stage 1: Build server ─────────────────────────────────────────────────────
FROM node:20-alpine AS server-builder

WORKDIR /build

COPY package*.json ./
RUN npm ci

COPY tsconfig.server.json ./
COPY src/ ./src/

RUN npm run build:server
# Output: /build/dist/*.js  (server code, no frontend)


# ── Stage 2: Build frontend ───────────────────────────────────────────────────
FROM node:20-alpine AS client-builder

ARG VITE_MAPTILER_KEY
ARG VITE_OPENAIP_KEY

# Root deps install at /build first. The frontend bundle reaches into
# src/shared/ (pipeline.ts, task-engine.ts) for shared scoring code, and
# pipeline.ts imports `igc-parser`. tsc/vite resolve that module via Node's
# parent-directory walk from the importing file's location — pipeline.ts at
# /build/src/shared/pipeline.ts must see node_modules at /build, not just
# /build/frontend (a sibling, not an ancestor). --ignore-scripts skips
# better-sqlite3's native build, which isn't needed for the frontend bundle.
WORKDIR /build
COPY package*.json ./
RUN npm ci --ignore-scripts

WORKDIR /build/frontend

COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./
# Shared code imported by frontend components via relative path.
COPY src/shared/ ../src/shared/

RUN npm run build
# Output: /build/frontend/dist/  (index.html + assets/)


# ── Stage 3: Production image ─────────────────────────────────────────────────
FROM node:20-alpine AS runner

RUN apk add --no-cache python3 make g++

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=server-builder /build/dist         ./dist
COPY --from=client-builder /build/frontend/dist ./dist/client
COPY src/schema.sql                             ./dist/schema.sql
COPY src/migrations/                            ./dist/migrations/

RUN mkdir -p /data

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
RUN chown -R appuser:appgroup /app /data
USER appuser

EXPOSE 8080

CMD ["sh", "-c", "node dist/migrate.js && node dist/server.js"]
