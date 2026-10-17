#!/bin/sh
set -e

# ---------- 运行身份（PUID / PGID）----------
# 默认完全维持历史行为：以镜像内 musicflow 用户（uid=100 / gid=101）运行。
# 传入 PUID=0 / PGID=0 时，应用以 root 运行。
#
# 为什么需要这个开关（2026-10-17 生产实证）：
#   音乐库是**多身份共享写入**的目录树（qBittorrent / 迅雷 / 手动 root 操作 / 应用
#   自己都会往同一棵树里写），所以库里必然出现「属主不是应用 uid」的目录；而「写标签」
#   要在同目录建临时文件再 rename，需要的是**目录写权限**，于是这类目录一出现，标签
#   修复就报 `ffmpeg 写标签失败(exit=243) ... Permission denied`。
#   本机 /vol3 是 btrfs 且挂载选项含厂商自定义的 `trimacl` —— ACL 能存成 xattr 但
#   不参与权限判定（setfacl 写入成功、getfacl 可回读，但 uid 100 实测仍 EACCES），
#   因此「用 ACL 精细授权」这条上游方案也不通。
#   结论：只要「应用 uid」与「库内条目属主」可能不一致，chown / cron / ACL 都只是治标；
#   让应用以 root 运行才能真正消除这个结构性矛盾（root 可写任何属主的条目，永不复发）。
#   不传 PUID/PGID 时行为与历史完全一致（向后兼容）。
PUID="${PUID:-$(id -u musicflow 2>/dev/null || echo 100)}"
PGID="${PGID:-$(id -g musicflow 2>/dev/null || echo 101)}"

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
# root 运行（PUID=0）无需这一步：root 可写任何属主的条目，直接跳过以缩短启动时间。
if [ "$PUID" != "0" ] && [ -d /app/backend/data ]; then
  want_uid="$PUID"
  misowned=0
  for p in /app/backend/data /app/backend/data/*; do
    [ -e "$p" ] || continue
    [ "$(stat -c %u "$p" 2>/dev/null || echo -1)" = "$want_uid" ] || { misowned=1; break; }
  done
  if [ "$misowned" = 1 ]; then
    chown -R "$PUID:$PGID" /app/backend/data
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
  if [ "$PUID" != "0" ]; then
    chown -R "$PUID:$PGID" /app/backend/data/plugins
  fi
fi

# root 运行时不降权；否则切到 PUID/PGID 再执行。
if [ "$PUID" = "0" ]; then
  exec node dist/index.js
fi
exec su-exec "$PUID:$PGID" node dist/index.js
