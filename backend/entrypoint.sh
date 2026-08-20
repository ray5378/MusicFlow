#!/bin/sh
set -e

# Bind-mounted data dirs come from the host with arbitrary ownership.
# Ensure the runtime user can write before dropping privileges.
if [ -d /app/backend/data ]; then
  chown -R musicflow:musicflow /app/backend/data
fi

# ---------- 预装外置插件(镜像内置种子) ----------
# 镜像 runtime 内含 /app/backend/preloaded-plugins/<id>/ 种子(构建期从插件仓库
# 拉固定版本,见 Dockerfile stage: preload)。首次启动(哨兵 data/.preloaded-plugins
# 不存在)时,把 data/plugins 里缺失的预装插件复制过去,使插件开箱可用(启用+配置
# 后即可用,默认禁用状态由插件 manifest.defaultEnabled 决定)。
#
# 设计要点:
#   - 用户市场更新:installPlugin 先删 data/plugins/<id> 再解压新版并热重载;
#     哨兵已置位 → 重启不覆盖,预装版本不会"复活"压掉用户升级的版本。
#   - 用户卸载插件后重启:哨兵已置位 → 不重新预装(删除即永久删除)。
#   - 更新预装插件版本:改 Dockerfile 的 GMDL_VERSION 等 ARG 后重新发版。
PRELOAD_FLAG=/app/backend/data/.preloaded-plugins
if [ -d /app/backend/preloaded-plugins ] && [ ! -f "$PRELOAD_FLAG" ]; then
  mkdir -p /app/backend/data/plugins
  for src in /app/backend/preloaded-plugins/*; do
    [ -d "$src" ] || continue
    id=$(basename "$src")
    dest=/app/backend/data/plugins/$id
    if [ ! -e "$dest" ]; then
      cp -a "$src" "$dest"
      echo "预装插件 $id 已初始化"
    fi
  done
  touch "$PRELOAD_FLAG"
  chown -R musicflow:musicflow /app/backend/data/plugins
fi

exec su-exec musicflow node dist/index.js
