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

WORKDIR /build/frontend

COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./

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

RUN mkdir -p /data

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
RUN chown -R appuser:appgroup /app /data
USER appuser

EXPOSE 8080

CMD ["sh", "-c", "node dist/migrate.js && node dist/server.js"]
