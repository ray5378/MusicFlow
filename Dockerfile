# syntax=docker/dockerfile:1
# MusicFlow - single container: backend (Hono) + built frontend (Vite)
#
# Multi-stage:
#   stage 1 backend-build : tsc compile (+ toolchain to build better-sqlite3
#                           if no musl prebuilt binary is available)
#   stage 2 frontend-build: vite build
#   stage 3 preload       : 预装外置插件种子
#   stage 4 airplay-cli   : 拉取统一 AirPlay 发送端二进制(AP1 + AP2)
#   stage 5 runtime       : node:22-alpine, prod deps only, non-root

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

# ---------- stage 4: fetch unified AirPlay sender binary ----------
# 统一发送端(music-assistant/airplay-cli 的官方 release):同一个 cliairplay 二进制
# 既走 RAOP(AirPlay 1)也走原生 AirPlay 2,取代原先分别维护的 cliraop + cliap2。
# 后端在 services/airplay/ap2/binary.ts 里按 AIRPLAY_CLI_PATH → /app/backend/bin 探测。
#
# 为什么不把二进制签进仓库:6MB 的第三方产物,按「版本号 + 官方 SHA256SUMS」在构建期取,
# 升级只改下面的 ARG。
#
# 注意它**不是**静态二进制:ldd 显示依赖 libc/libm/libstdc++/libgcc(其余库,含
# curl/sodium/confuse/plist/gcrypt/avfilter 全部静态链入)。运行阶段是 alpine/musl,
# 靠 gcompat 提供 glibc 兼容层 —— runtime 阶段有一条 `--check` 冒烟,不兼容会当场构建失败,
# 不会把坏掉的功能发出去。
FROM alpine:3.22 AS airplay-cli
ARG AIRPLAY_CLI_VERSION=0.5.9
ARG TARGETARCH
# 文件名里的 arch 段和 docker 的 TARGETARCH 不同名(x86_64 / aarch64);
# 校验统一走 release 附带的 SHA256SUMS,按文件名精确摘那一行,避免维护多套常量。
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) A=x86_64 ;; \
      arm64) A=aarch64 ;; \
      *) echo "unsupported TARGETARCH=$TARGETARCH" >&2; exit 1 ;; \
    esac; \
    apk add --no-cache curl ca-certificates; \
    B="https://github.com/music-assistant/airplay-cli/releases/download/v${AIRPLAY_CLI_VERSION}"; \
    mkdir -p /out; \
    curl -fsSL --retry 3 -o "/out/cliairplay-linux-$A" "$B/cliairplay-linux-$A"; \
    curl -fsSL --retry 3 -o /out/SHA256SUMS "$B/SHA256SUMS"; \
    cd /out; \
    LINE=$(grep -E "[[:space:]]cliairplay-linux-$A\$" SHA256SUMS || true); \
    [ -n "$LINE" ] || { echo "SHA256SUMS 里找不到 cliairplay-linux-$A" >&2; exit 1; }; \
    echo "$LINE" | sha256sum -c -; \
    mv "cliairplay-linux-$A" /out/cliairplay; \
    chmod 0755 /out/cliairplay; \
    ls -l /out/cliairplay

# ---------- stage 5: runtime ----------
FROM node:22-alpine AS runtime
# 由 CI 从 git tag / commit 注入; 经 /ping(APP_VERSION/APP_COMMIT) 暴露给前端系统信息,
# 让用户确认当前跑的到底是哪个版本和哪次提交。
ARG APP_VERSION=dev
ARG GIT_COMMIT=unknown
# ffmpeg 输入硬性只允许回环 token URL / 本地路径(见 SPEC §1.8 与
# services/dlna/control.ts 注释),域名与 302 全部由 Node 侧处理,
# 故运行时用 ffmpeg-static 即可,无需系统 ffmpeg。
ENV NODE_ENV=production \
    PORT=46400 \
    TZ=Asia/Shanghai \
    UV_USE_IO_URING=0 \
    APP_VERSION=${APP_VERSION} \
    APP_COMMIT=${GIT_COMMIT}
WORKDIR /app/backend
# gcompat/libstdc++ 供 bin/cliairplay 使用(它是 glibc 动态链接的;见 stage 4 注释)。
RUN apk add --no-cache su-exec gcompat libstdc++ \
 && addgroup -S musicflow && adduser -S musicflow -G musicflow
COPY --from=backend-build /app/backend/package.json /app/backend/package-lock.json ./
COPY --from=backend-build /app/backend/node_modules ./node_modules
COPY --from=backend-build /app/backend/dist ./dist
COPY --from=frontend-build /app/frontend/dist ./public
COPY --from=preload /preloaded /app/backend/preloaded-plugins
COPY --from=airplay-cli /out/cliairplay ./bin/cliairplay
COPY backend/entrypoint.sh ./entrypoint.sh
# bin/cliairplay 在这里立刻自检:gcompat 一旦撑不住 glibc ABI,构建当场红掉,
# 而不是发出去之后才在用户机器上表现为「AirPlay 设备列表是空的」。
RUN chmod +x entrypoint.sh \
 && mkdir -p /app/backend/data \
 && ./bin/cliairplay --check \
 && chown -R musicflow:musicflow /app/backend
EXPOSE 46400
ENTRYPOINT ["/app/backend/entrypoint.sh"]
