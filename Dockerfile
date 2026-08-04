# syntax=docker/dockerfile:1
# MusicFlow - single container: backend (Hono) + built frontend (Vite)
#
# Multi-stage:
#   stage 1 backend-build : tsc compile (+ toolchain to build better-sqlite3
#                           if no musl prebuilt binary is available)
#   stage 2 frontend-build: vite build
#   stage 3 runtime       : node:22-alpine, prod deps only, non-root

# ---------- stage 1: build backend ----------
FROM node:22-alpine AS backend-build
WORKDIR /app/backend
# Toolchain only needed when better-sqlite3 lacks a musl prebuilt binary
RUN apk add --no-cache python3 make g++
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY backend/src ./src
COPY backend/tsconfig.json ./
RUN npm run build && npm prune --omit=dev --no-audit --no-fund && npm cache clean --force

# ---------- stage 2: build frontend ----------
FROM node:22-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build && npm cache clean --force

# ---------- stage 3: runtime ----------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=46400 \
    TZ=Asia/Shanghai \
    UV_USE_IO_URING=0
WORKDIR /app/backend
RUN addgroup -S musicflow && adduser -S musicflow -G musicflow
COPY --from=backend-build /app/backend/package.json /app/backend/package-lock.json ./
COPY --from=backend-build /app/backend/node_modules ./node_modules
COPY --from=backend-build /app/backend/dist ./dist
COPY --from=frontend-build /app/frontend/dist ./public
RUN mkdir -p /app/backend/data && chown -R musicflow:musicflow /app/backend
USER musicflow
EXPOSE 46400
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:46400/ping || exit 1
CMD ["node", "dist/index.js"]
