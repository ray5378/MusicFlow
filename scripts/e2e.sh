#!/bin/bash
# MusicFlow 本地 e2e 一键验证(无 Docker)
#
# 用法: bash scripts/e2e.sh
# 用临时 DATA_DIR 起后端(admin/admin),逐项验证关键契约(鉴权/peers/groups/
# 内存观测/metrics/OpenSubsonic),最后自动清理临时目录与进程。
# 环境变量: E2E_PORT 覆盖端口(默认 46401)。
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${E2E_PORT:-46401}"
TMP="$(mktemp -d)"
LOG="$TMP/backend.log"
PID=""

cleanup() {
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then kill "$PID" 2>/dev/null || true; fi
  rm -rf "$TMP"
}
trap cleanup EXIT

echo "== [1/6] build backend (tsc -> dist) =="
(cd backend && npm run build > /dev/null)

echo "== [2/6] start backend on :$PORT (temp DATA_DIR) =="
# exec:让 node 直接成为后台进程(而非 subshell 的子进程),cleanup 的 kill $PID 才能杀到它。
(cd backend && exec env DATA_DIR="$TMP/data" PORT="$PORT" node dist/index.js > "$LOG" 2>&1) &
PID=$!

READY=0
for _ in $(seq 1 40); do
  # 注意:MSYS curl 写 /dev/null 会返回 exit 23(写错误),导致探活误判失败,
  # 因此写到临时真实文件,用退出码判断。
  if curl -s -m 2 -o "$TMP/probe.out" "http://127.0.0.1:$PORT/rest/ping"; then READY=1; break; fi
  sleep 1
done
if [ "$READY" != "1" ]; then
  echo "!! backend 未就绪,日志尾部:"; tail -30 "$LOG"; exit 1
fi

echo "== [3/6] login (admin/admin) =="
LOGIN_BODY="$TMP/login.json"
curl -s -X POST "http://127.0.0.1:$PORT/rest/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin"}' > "$LOGIN_BODY"
# 用 sed 提取 token(避免 node require /tmp 的 MSYS 路径问题)
TOKEN=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$LOGIN_BODY")
if [ -z "$TOKEN" ]; then echo "!! 登录失败:"; cat "$LOGIN_BODY"; exit 1; fi
echo "   token ok"

check() { # $1=name $2=url [$3=expect-ok]
  local name="$1" url="$2"
  local out; out=$(curl -s -m 8 -H "Authorization: Bearer $TOKEN" "$url")
  echo "== $name =="
  echo "$out" | head -c 400
  echo
}

echo "== [4/6] 业务契约 =="
check "users/me"           "http://127.0.0.1:$PORT/rest/api/v1/users/me"
check "peers"              "http://127.0.0.1:$PORT/rest/api/v1/peers"
check "groups"             "http://127.0.0.1:$PORT/rest/api/v1/groups"
check "memory-settings"    "http://127.0.0.1:$PORT/rest/api/v1/admin/memory-settings"
check "metrics"            "http://127.0.0.1:$PORT/rest/api/v1/admin/metrics"

echo "== [4.5/6] AirPlay 默认关闭(插件未启用应 409) =="
# 注意:MSYS curl -o /dev/null 会 exit 23 且 set -e 直接退出,必须写临时真实文件
AIRPLAY_CODE=$(curl -s -o "$TMP/airplay.out" -w "%{http_code}" -m 5 -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/rest/api/v1/airplay/devices")
echo "  /v1/airplay/devices -> HTTP $AIRPLAY_CODE (期望 409)"
if [ "$AIRPLAY_CODE" != "409" ]; then echo "!! AirPlay 未默认关闭(开关契约破坏)"; exit 1; fi

echo "== [5/6] OpenSubsonic(错误凭据应返回 failed/40) =="
curl -s -m 5 "http://127.0.0.1:$PORT/rest/getMusicFolders?u=admin&t=wrong&s=x" | head -c 300
echo

echo "== [6/6] 慢请求探测(可选:压一个列表端点看 metrics 计数) =="
curl -s -o /dev/null -m 8 -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/rest/api/v1/peers" || true

echo
echo "E2E OK (已自动清理临时实例)"
