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
# Injected by CI from the git tag; surfaces in /ping and the settings page so
# users can tell which build they are actually running.
ARG APP_VERSION=dev
ENV NODE_ENV=production \
    PORT=46400 \
    TZ=Asia/Shanghai \
    UV_USE_IO_URING=0 \
    APP_VERSION=${APP_VERSION}
WORKDIR /app/backend
RUN apk add --no-cache su-exec \
 && addgroup -S musicflow && adduser -S musicflow -G musicflow
COPY --from=backend-build /app/backend/package.json /app/backend/package-lock.json ./
COPY --from=backend-build /app/backend/node_modules ./node_modules
COPY --from=backend-build /app/backend/dist ./dist
COPY --from=frontend-build /app/frontend/dist ./public
COPY backend/entrypoint.sh ./entrypoint.sh
RUN chmod +x entrypoint.sh \
 && mkdir -p /app/backend/data && chown -R musicflow:musicflow /app/backend
EXPOSE 46400
ENTRYPOINT ["/app/backend/entrypoint.sh"]
