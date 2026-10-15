#!/bin/sh
set -e

# Bind-mounted data dirs come from the host with arbitrary ownership. Ensure the
# runtime user can write before dropping privileges —— 但只在**确实有错属主条目**时
# 才做全量递归 chown。
#
# 为什么要改：`chown -R` 会走完整棵树（生产实测 20GB / 87895 个条目，其中 covers
# 一个目录就占 17.8GB / 87855 项），每次容器重建要花 ~29s，是容器起来后 ~45s 内
# 完全无法服务的头号原因（2026-10-15 实测）。data 目录里的内容都是运行时用户自己
# 写的，属主不会漂移，所以只探 data 根 + 一级子项就足以发现「绑定挂载属主配错」；
# 更深层的文件即便属主不对也只影响读权限位，不影响启动。
# 探测失败（stat 不可用 / musicflow 用户查不到等）会退化为 old 行为（仍做全量
# chown），不会漏修——探测本身不做任何「跳过 chown」之外的事。
if [ -d /app/backend/data ]; then
  want_uid=$(id -u musicflow 2>/dev/null || echo -1)
  misowned=0
  for p in /app/backend/data /app/backend/data/*; do
    [ -e "$p" ] || continue
    [ "$(stat -c %u "$p" 2>/dev/null || echo -1)" = "$want_uid" ] || { misowned=1; break; }
  done
  if [ "$misowned" = 1 ]; then
    chown -R musicflow:musicflow /app/backend/data
  fi
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
