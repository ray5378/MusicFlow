#!/usr/bin/env bash
# CI 中在 backend 执行 npm ci 会触发 ffmpeg-static 的 postinstall:
# 它从 github.com/eugeneware/ffmpeg-static/releases 下载 ffmpeg 二进制,
# GitHub 偶发 504/5xx 会让整个 job 在依赖安装阶段直接失败(与代码无关)。
# 统一入口 + 有限次重试,避免一次网络抖动把发版链路打挂。
set -u

attempts="${NPM_CI_ATTEMPTS:-4}"
delay="${NPM_CI_RETRY_DELAY:-20}"

for i in $(seq 1 "$attempts"); do
  if ( cd backend && npm ci --no-audit --no-fund ); then
    exit 0
  fi
  echo "npm ci 第 $i/$attempts 次失败,${delay} 秒后重试" >&2
  sleep "$delay"
done

echo "npm ci 连续 $attempts 次失败,放弃" >&2
exit 1
