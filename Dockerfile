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
# 由 CI 注入; 转为 VITE_APP_VERSION 环境变量, Vite 在构建时把前端版本号内联进
# 前端 bundle(前端经 import.meta.env.VITE_APP_VERSION 读取)。git commit 哈希走后端
# APP_COMMIT + /ping, 前端运行时拉取, 不在前端重复注入。
ARG APP_VERSION=dev
ARG GIT_COMMIT=unknown
ENV VITE_APP_VERSION=${APP_VERSION}
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build && npm cache clean --force

# ---------- stage 3: preload external plugins ----------
# 镜像内置「预装外置插件」种子(go-music-dl 等):构建期从插件仓库拉取**固定版本**,
# 插件代码不进主仓库(核心/插件代码隔离);entrypoint.sh 在容器首次启动时落盘到
# data/plugins/。市场更新 installPlugin 会覆盖 data/plugins 里的预装版本——预装
# 只保证「开箱可用」,不阻止用户升级到市场新版本。
# 升级预装插件版本:改下方 ARG GMDL_VERSION 后重新发版。
FROM node:22-alpine AS preload
ARG GMDL_VERSION=1.2.40
COPY backend/scripts/preload-plugin.mjs /preload-plugin.mjs
RUN node /preload-plugin.mjs go-music-dl ${GMDL_VERSION} /preloaded

# ---------- stage 4: runtime ----------
FROM node:22-alpine AS runtime
# 由 CI 从 git tag / commit 注入; 经 /ping(APP_VERSION/APP_COMMIT) 暴露给前端系统信息,
# 让用户确认当前跑的到底是哪个版本和哪次提交。
ARG APP_VERSION=dev
ARG GIT_COMMIT=unknown
ENV NODE_ENV=production \
    PORT=46400 \
    TZ=Asia/Shanghai \
    UV_USE_IO_URING=0 \
    APP_VERSION=${APP_VERSION} \
    APP_COMMIT=${GIT_COMMIT}
WORKDIR /app/backend
RUN apk add --no-cache su-exec \
 && addgroup -S musicflow && adduser -S musicflow -G musicflow
COPY --from=backend-build /app/backend/package.json /app/backend/package-lock.json ./
COPY --from=backend-build /app/backend/node_modules ./node_modules
COPY --from=backend-build /app/backend/dist ./dist
COPY --from=frontend-build /app/frontend/dist ./public
COPY --from=preload /preloaded /app/backend/preloaded-plugins
COPY backend/entrypoint.sh ./entrypoint.sh
RUN chmod +x entrypoint.sh \
 && mkdir -p /app/backend/data && chown -R musicflow:musicflow /app/backend
EXPOSE 46400
ENTRYPOINT ["/app/backend/entrypoint.sh"]
