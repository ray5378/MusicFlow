#!/usr/bin/env bash
# ============================================================================
# GitHub Actions 里的「模拟播放 → 基线不变量体检」全流程（ubuntu-latest）
#
# 为什么这里模拟 AirPlay 而不是 sendspin：
#   基准文档的 A 层指标（ev:"tick" / ring-diag / deltaUs / inQueueMs）
#   全部由 backend/src/services/airplay/bridgeSession.ts 在**服务端**计算，
#   接收端只需要完成 RAOP 握手并持续收 UDP 音频；sendspin 模拟端根本
#   不产生这些字段，拿它判基线只会得到空样本。
#
# 产物：<MF_WORKDIR>/cap.json + 判读 exit code + <MF_WORKDIR>/logs/
# 只读现网无关：容器名固定 musicflow，但跑在 runner 自己的 docker 里。
# ============================================================================
set -euo pipefail

WORK=${MF_WORKDIR:-"${PWD}/.mf-ci"}
IMAGE=${MF_IMAGE:?MF_IMAGE 必填，例如 ghcr.io/ray5378/musicflow:4.15.8}
MINUTES=${MF_MINUTES:-8}
PORT=${MF_PORT:-46400}
BASE="http://127.0.0.1:${PORT}"
CI_USER=ci-probe
CI_PASS=ci-probe
CONTAINER=musicflow
mkdir -p "$WORK/data" "$WORK/music" "$WORK/logs"
REPO=${GITHUB_WORKSPACE:-$(pwd)}

say() { printf '\n=== %s ===\n' "$*"; }
die() { printf '::error::%s\n' "$*" >&2; exit 2; }

cleanup() {
  local rc=$?
  say "清理（保留证据到 $WORK）"
  docker logs "$CONTAINER" > "$WORK/logs/container.log" 2>&1 || true
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  [ -f "$WORK/shairport.pid" ] && kill "$(cat "$WORK/shairport.pid")" >/dev/null 2>&1 || true
  [ -f "$WORK/dd.pid" ] && kill "$(cat "$WORK/dd.pid")" >/dev/null 2>&1 || true
  exit "$rc"
}
trap cleanup EXIT

api() {
  # api METHOD PATH [BODY]。必须显式 -X：curl 只有带 -d 时才自动 POST，
  # 无 body 的 POST（如 /sources/:id/scan）会被当 GET → 404。
  # 同时保留错误响应体，CI 里 curl -f 只报 22 看不出是认证还是服务失败。
  local method=$1 path=$2 body=${3:-} out code
  local args=(-sS --max-time 25 -u "${CI_USER}:${CI_PASS}" -X "$method"
              -H 'Content-Type: application/json' -w '\n%{http_code}')
  [ -n "$body" ] && args+=(-d "$body")
  out=$(curl "${args[@]}" "${BASE}/rest/api/v1${path}") || return 1
  code=$(printf '%s' "$out" | tail -1)
  out=$(printf '%s' "$out" | sed '$d')
  if [ "$code" -lt 200 ] || [ "$code" -ge 400 ]; then
    printf 'HTTP %s %s %s: %s\n' "$code" "$method" "$path" "$out" >&2
    return 1
  fi
  printf '%s' "$out"
}

# 递归找 JSON 里符合条件的值，避免依赖接口的包装层级（可能是裸数组 / {data:[]}）。
json_pick() {
  python3 -c '
import json,sys
mode,needle=sys.argv[1],sys.argv[2]
o=json.load(sys.stdin)
out=[]
def walk(x):
    if isinstance(x,dict):
        for k,v in x.items():
            if mode=="key" and k==needle and isinstance(v,str): out.append(v)
            walk(v)
    elif isinstance(x,list):
        for v in x: walk(v)
    elif isinstance(x,str) and mode=="prefix" and x.startswith(needle): out.append(x)
walk(o)
for v in dict.fromkeys(out): print(v)
' "$1" "$2"
}

say "0/7 环境：shairport-sync + avahi + ffmpeg"
sudo apt-get update -qq >/dev/null
sudo apt-get install -y -qq shairport-sync avahi-daemon avahi-utils ffmpeg jq >/dev/null
shairport-sync -h > "$WORK/logs/shairport-help.txt" 2>&1 || true
grep -qi pipe "$WORK/logs/shairport-help.txt" || die "shairport-sync 未编译 pipe 输出后端（见 help 日志）"
grep -qi avahi "$WORK/logs/shairport-help.txt" || die "shairport-sync 未编译 avahi mDNS 后端（见 help 日志）"
# apt 安装会顺手拉起系统自带的 shairport-sync（占 5000 端口 + 广播另一个名字），
# 必须先停掉，否则我们的实例启动即 fatal: could not establish a service on port 5000。
sudo systemctl stop shairport-sync >/dev/null 2>&1 || true
sudo systemctl disable shairport-sync >/dev/null 2>&1 || true
pkill -x shairport-sync >/dev/null 2>&1 || true
sudo avahi-daemon -D >/dev/null 2>&1 || sudo service avahi-daemon start >/dev/null 2>&1 || true
avahi-browse -at >/dev/null 2>&1 || true

# FIFO 必须有读者，否则 shairport 会阻塞在写端。
rm -f "$WORK/ap.pipe"; mkfifo "$WORK/ap.pipe"
(dd if="$WORK/ap.pipe" of=/dev/null bs=4096 >/dev/null 2>&1 & echo $! > "$WORK/dd.pid")
cat > "$WORK/shairport.conf" <<EOF
general =
{
  name = "MF-CI-Receiver";
  output_backend = "pipe";
  mdns_backend = "avahi";
  regtype = "_raop._tcp";
  port = 5100;
  interpolation = "basic";
};
pipe =
{
  name = "${WORK}/ap.pipe";
};
EOF
sudo shairport-sync -c "$WORK/shairport.conf" > "$WORK/logs/shairport.log" 2>&1 &
echo $! > "$WORK/shairport.pid"
sleep 3
kill -0 "$(cat "$WORK/shairport.pid")" 2>/dev/null || {
  cat "$WORK/logs/shairport.log" >&2
  die "shairport-sync 启动失败"
}
say "接收端已广播 _raop._tcp: MF-CI-Receiver"

say "1/7 启动被测镜像（空库）"
# 容器内进程 uid 与 runner 用户不一定一致，给空库目录开放写权限。
chmod -R a+rwX "$WORK/data" "$WORK/music"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" --network host \
  -e TZ=Asia/Shanghai -e UV_USE_IO_URING=0 \
  -v "$WORK/data:/app/backend/data" \
  -v "$WORK/music:/local/music:ro" \
  "$IMAGE" >/dev/null
for i in $(seq 1 90); do
  curl -fsS --max-time 3 "${BASE}/ping" >/dev/null 2>&1 && break
  sleep 1
  [ "$i" -eq 90 ] && { docker logs "$CONTAINER" --tail 80 >&2; die "容器 90s 内未响应 /ping"; }
done

say "2/7 建测试用户（admin 首次登录带 must_change_password，不用它）"
docker stop "$CONTAINER" >/dev/null
# 容器写出的 db 文件属主是容器内 uid，runner 用户可能只有读权限。
sudo python3 - "$WORK/data/musicflow.db" "$CI_USER" "$CI_PASS" <<'PY'
import hashlib, sqlite3, sys, uuid
db, user, pw = sys.argv[1], sys.argv[2], sys.argv[3]
c = sqlite3.connect(db)
salt, sub = uuid.uuid4().hex, uuid.uuid4().hex
c.execute(
    "INSERT OR REPLACE INTO users (id,username,password,salt,subsonic_salt,is_admin,is_active,email,must_change_password,created_at) "
    "VALUES (?,?,?,?,?,1,1,'',0,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
    (uuid.uuid4().hex, user, hashlib.md5((pw + sub).encode()).hexdigest(), salt, sub),
)
c.commit(); c.close()
PY
docker start "$CONTAINER" >/dev/null
for i in $(seq 1 60); do
  api GET /songs >/dev/null 2>&1 && break
  sleep 1
  [ "$i" -eq 60 ] && die "测试用户认证 60s 内未通过"
done

say "3/7 启用 AirPlay 接收插件并等待模拟设备上线"
PLUGINS=$(api GET /plugins) || die "GET /plugins 失败"
# /v1/plugins 返回的 id 是 DB 行 id（UUID），name 才是 airplay-renderer 这类稳定标识。
PID=$(printf '%s' "$PLUGINS" | python3 -c '
import json,sys
d=json.load(sys.stdin)
rows=d if isinstance(d,list) else (d.get("plugins") or [])
for p in rows:
    if "airplay" in str(p.get("name","")).lower():
        print(p.get("id") or p.get("name")); break
')
[ -n "$PID" ] || die "插件列表里找不到 airplay"
# 启用接口会顺带启动接收服务；即便它返回错误，DB 里的 enabled 也可能已落库。
# 真正的判据是下面「设备是否上线」，不要把中间步骤的 5xx 当死因。
api PUT /plugins/"$PID" '{"enabled":true}' >/dev/null || \
  echo "警告：启用 $PID 返回错误，继续等设备上线（以 peer 是否出现为准）"
PEER=""
for i in $(seq 1 90); do
  PEER=$(api GET /peers 2>/dev/null | json_pick prefix 'airplay:' | head -1 || true)
  [ -n "$PEER" ] && break
  sleep 1
done
[ -n "$PEER" ] || { docker logs "$CONTAINER" --tail 60 >&2; die "90s 内未发现 shairport 模拟设备"; }
echo "peer=$PEER"

say "4/7 本地媒体源 + 3 分钟测试音"
ffmpeg -hide_banner -loglevel error -f lavfi -i 'sine=frequency=440:duration=180' \
  -ar 48000 -ac 2 -c:a flac -y "$WORK/music/ci_tone.flac" >/dev/null
api POST /sources "{\"name\":\"mf-ci\",\"type\":\"local\",\"config\":{\"path\":\"/local/music\"}}" \
  > "$WORK/logs/source-create.json" || die "创建 media source 失败"
cat "$WORK/logs/source-create.json"
api GET /sources > "$WORK/logs/sources-list.json" || die "列出 media source 失败"
# 不信任 create 响应的 id：一律按 name 从列表反查（历史上这里取错过 id 导致 scan 404）。
SRC=$(python3 -c '
import json,sys
d=json.load(open(sys.argv[1],encoding="utf-8"))
rows=d if isinstance(d,list) else (d.get("sources") or [])
for s in rows:
    if s.get("name")=="mf-ci": print(s["id"]); break
' "$WORK/logs/sources-list.json")
[ -n "$SRC" ] || die "sources 列表里找不到 mf-ci：$(head -c 300 "$WORK/logs/sources-list.json")"
echo "source id=$SRC"
api POST /sources/"$SRC"/scan >/dev/null || die "触发扫描失败"
SONG=""
for i in $(seq 1 60); do
  if api GET '/songs?limit=3' > "$WORK/logs/songs.json" 2>/dev/null; then
    SONG=$(python3 -c '
import json,sys
d=json.load(open(sys.argv[1],encoding="utf-8"))
rows=d if isinstance(d,list) else (d.get("songs") or [])
print(rows[0]["id"] if rows else "")
' "$WORK/logs/songs.json" 2>/dev/null || true)
  fi
  [ -n "$SONG" ] && break
  sleep 1
done
[ -n "$SONG" ] || die "扫描 60s 后仍无歌曲：$(head -c 300 "$WORK/logs/songs.json" 2>/dev/null || echo no-file)"
echo "source=$SRC song=$SONG"

say "5/7 建组并起播（采样器按组 /status 取进度）"
GROUP_JSON=$(api POST /groups "{\"name\":\"mf-ci\",\"memberIds\":[\"$PEER\"]}") || die "建组失败"
printf '%s' "$GROUP_JSON" > "$WORK/logs/group-create.json"
GID=$(python3 -c '
import json,sys
d=json.load(open(sys.argv[1],encoding="utf-8"))
g=d.get("group") if isinstance(d,dict) else d
print((g or {}).get("id") or "")
' "$WORK/logs/group-create.json")
[ -n "$GID" ] || die "建组响应里没有 id: $GROUP_JSON"
api POST "/peers/group%3A${GID}/queue/play" \
  "{\"items\":[{\"songId\":\"$SONG\",\"title\":\"CI Tone\",\"mime\":\"audio/flac\"}],\"startIndex\":0}" \
  >/dev/null || die "起播失败"

say "6/7 采样 ${MINUTES} 分钟（tick/ring/prog）"
# 先让桥接跑到稳态（首包 lead + anchor 落定），再开始计数。
sleep 12
export MF_USER="$CI_USER" MF_PASS="$CI_PASS" MF_GROUP_ID="$GID" \
       MF_DEVICES="${PEER#airplay:}" MF_OUTDIR="$WORK" \
       MF_CONTAINER="$CONTAINER" MF_BASE_URL="$BASE"
timeout "$((MINUTES * 60 + 30))" python3 \
  "$REPO/docs/examples/baseline_sampler.example.py" > "$WORK/logs/sampler.log" 2>&1 || true
TICKS=$(grep -ac '"type":"tick"' "$WORK/base.jsonl" 2>/dev/null || echo 0)
echo "采样 tick 行数=$TICKS"
[ "$TICKS" -ge 20 ] || { tail -40 "$WORK/logs/container.log" >&2; die "tick 不足 20 条：桥接没跑起来"; }

say "7/7 汇总 + 不变量判读"
export MF_WATCH_DIR="$WORK"
python3 "$REPO/backend/scripts/baseline/baseline_cap.py" \
  --window "$MINUTES" --label "ci-sim-$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)" \
  --out "$WORK/cap.json" || die "baseline_cap 失败"
python3 "$REPO/backend/scripts/baseline/invariant_guard.py" \
  --input "$WORK/cap.json" --min-ticks 20
