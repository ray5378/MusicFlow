#!/usr/bin/env bash
# ============================================================================
# GitHub Actions 里的「多拓扑混合群组 → 切歌 → 基线不变量体检」（ubuntu-latest）
#
# 为什么这里要模拟真实接收端：
#   基准文档的 A 层指标分两种真值：
#     * 含 AirPlay 成员的组 → backend/src/services/airplay/bridgeSession.ts 产出
#       tick / ring-diag（deltaUs / inQueueMs），需要真实 RAOP 握手 + UDP 收流；
#     * 纯 sendspin 组 → 不经过桥，根本没有 tick。等价真值是服务端推出来的
#       音频帧，由 sendspin_frame_probe.py 用 aiosendspin 拨入播放器逐帧采。
#   因此两种接收端都必须起，缺一种就有一种拓扑永远采不到 A 层证据。
#
# 五种拓扑（MF_TOPO）：
#   mixed     = airplay1 + airplay2 + sendspin  （混合组，v4.9.3 方向 A 强制走桥）
#   ap-only   = airplay1 + airplay2             （纯 AirPlay 组）
#   ap1-only  = airplay1                        （单 AirPlay 成员）
#   ap2-only  = airplay2                        （单 AirPlay 成员，验证设备身份不串）
#   ss-only   = sendspin                        （纯 sendspin 组，无桥 tick）
#
# 每种拓扑都：建组 → 起播 10 首 → 切歌 5 次（每次确认 songId 真变了）→
# 全程采样（tick/ring/prog + sendspin 帧 + 切歌证据）→ 分拓扑判读。
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
TOPO=${MF_TOPO:-mixed}
SWITCH_COUNT=${MF_SWITCH_COUNT:-5}
# 先跑一段无切歌稳态（A 层绝对阈值判据只用这段），再开始切歌功能验证。
# 稳态段 60s ≈ 30 条 tick（2s/条），满足 guard 的 samplesSteady>=15。
STEADY_SEC=${MF_STEADY_SEC:-90}
SWITCH_INTERVAL=${MF_SWITCH_INTERVAL:-60}   # 5 次 = 300s，8 分钟采样仍留余量
# 长跑（nightly）才有意义：短跑里容器 RSS/FD 还没稳定，采了也是噪声。
RESOURCE_SAMPLE=0
[ "$MINUTES" -ge 20 ] && RESOURCE_SAMPLE=1
CI_USER=ci-probe
CI_PASS=ci-probe
CONTAINER=musicflow
mkdir -p "$WORK/data" "$WORK/music" "$WORK/logs"
REPO=${GITHUB_WORKSPACE:-$(pwd)}
: > "$WORK/aux.pids"
: > "$WORK/switch_log.jsonl"
: > "$WORK/sendspin_frames.jsonl"

say() { printf '\n=== %s ===\n' "$*"; }
die() { printf '::error::%s\n' "$*" >&2; exit 2; }

case "$TOPO" in
  mixed)    AP_NAMES=(MF-CI-AP1 MF-CI-AP2); SS_NAMES=(MF-CI-SPIN1); TICK_EXPECT=2; TICK_TOPO=mixed ;;
  ap-only)  AP_NAMES=(MF-CI-AP1 MF-CI-AP2); SS_NAMES=();             TICK_EXPECT=2; TICK_TOPO=airplay ;;
  ap1-only) AP_NAMES=(MF-CI-AP1);            SS_NAMES=();             TICK_EXPECT=1; TICK_TOPO=airplay ;;
  ap2-only) AP_NAMES=(MF-CI-AP2);            SS_NAMES=();             TICK_EXPECT=1; TICK_TOPO=airplay ;;
  ss-only)  AP_NAMES=();                     SS_NAMES=(MF-CI-SPIN1); TICK_EXPECT=0; TICK_TOPO=sendspin ;;
  *) die "未知 MF_TOPO=$TOPO（可选 mixed/ap-only/ap1-only/ap2-only/ss-only）" ;;
esac
say "拓扑 $TOPO：airplay=${#AP_NAMES[@]} sendspin=${#SS_NAMES[@]} tickExpect=$TICK_EXPECT"

cleanup() {
  local rc=$?
  say "清理（保留证据到 $WORK）"
  docker logs "$CONTAINER" > "$WORK/logs/container.log" 2>&1 || true
  [ -f "$WORK/sampler.pid" ] && kill "$(cat "$WORK/sampler.pid")" >/dev/null 2>&1 || true
  if [ -f "$WORK/aux.pids" ]; then
    while read -r p; do [ -n "$p" ] && kill "$p" >/dev/null 2>&1 || true; done < "$WORK/aux.pids"
  fi
  sudo pkill -x shairport-sync >/dev/null 2>&1 || true
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  exit "$rc"
}
trap cleanup EXIT

api() {
  # api METHOD PATH [BODY]。必须显式 -X：curl 只有带 -d 时才自动 POST，
  # 无 body 的 POST（如 /sources/:id/scan）会被当 GET → 404。
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

# 递归找 /peers 里 name 含指定串、peerId 带指定前缀的设备。
# shairport 的 mDNS name 是 "MF-CI-AP1@xx:xx"，sendspin 是 client_name，
# 而 peerId 分别是 airplay:<mac> / sendspin:<clientId> —— 两者不能混用。
find_peer() {
  local want=$1 prefix=$2
  api GET /peers 2>/dev/null | python3 -c '
import json,sys
want,prefix=sys.argv[1].lower(),sys.argv[2]
try: d=json.load(sys.stdin)
except Exception: raise SystemExit
out=[]
def walk(x):
    if isinstance(x,dict):
        pid=x.get("peerId") or x.get("id") or ""
        nm=str(x.get("name") or "")
        if isinstance(pid,str) and pid.startswith(prefix) and (want in pid.lower() or want in nm.lower()):
            out.append(pid)
        for v in x.values(): walk(v)
    elif isinstance(x,list):
        for v in x: walk(v)
walk(d)
for v in dict.fromkeys(out): print(v)
' "$want" "$prefix" | head -1
}

status_song() {
  # 切歌判据必须看「歌曲真的换了」，不能只看 POST /next 返回 200。
  api GET "/peers/group%3A${GID}/status" 2>/dev/null | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: print(""); raise SystemExit
m=d.get("media") or {}
# group.media 在换曲窗口可能为 null（基准文档已知缺陷），退回 duration：
# CI 的 10 首测试音时长各不相同（46~55s），duration 变化同样是「真换曲」证据。
print(m.get("songId") or m.get("id") or m.get("title") or d.get("duration") or "")
' 2>/dev/null || true
}

frame_count() {
  wc -l < "$WORK/sendspin_frames.jsonl" 2>/dev/null | tr -d ' ' || echo 0
}

say "0/8 环境：shairport-sync + avahi + ffmpeg + aiosendspin"
sudo apt-get update -qq >/dev/null
sudo apt-get install -y -qq shairport-sync avahi-daemon avahi-utils ffmpeg jq python3-venv >/dev/null
shairport-sync -h > "$WORK/logs/shairport-help.txt" 2>&1 || true
if [ "${#AP_NAMES[@]}" -gt 0 ]; then
  grep -qi pipe "$WORK/logs/shairport-help.txt" || die "shairport-sync 未编译 pipe 输出后端"
  grep -qi avahi "$WORK/logs/shairport-help.txt" || die "shairport-sync 未编译 avahi mDNS 后端"
fi
# apt 会顺手拉起系统自带的 shairport-sync（占 5000 端口 + 广播另一个名字），先停掉。
sudo systemctl stop shairport-sync >/dev/null 2>&1 || true
sudo systemctl disable shairport-sync >/dev/null 2>&1 || true
sudo pkill -x shairport-sync >/dev/null 2>&1 || true
sudo avahi-daemon -D >/dev/null 2>&1 || sudo service avahi-daemon start >/dev/null 2>&1 || true
avahi-browse -at >/dev/null 2>&1 || true

# 每个 AirPlay 接收端独立 FIFO（必须有读者，否则 shairport 阻塞在写端）+ 独立 RAOP 端口。
for i in "${!AP_NAMES[@]}"; do
  idx=$((i + 1)); name=${AP_NAMES[$i]}; fifo="$WORK/ap${idx}.pipe"
  rm -f "$fifo"; mkfifo "$fifo"
  (dd if="$fifo" of=/dev/null bs=4096 >/dev/null 2>&1 & echo $! >> "$WORK/aux.pids")
  cat > "$WORK/shairport${idx}.conf" <<EOF
general =
{
  name = "${name}";
  output_backend = "pipe";
  mdns_backend = "avahi";
  regtype = "_raop._tcp";
  port = $((5100 + i));
  interpolation = "basic";
};
pipe =
{
  name = "${fifo}";
};
EOF
  sudo shairport-sync -vvv -c "$WORK/shairport${idx}.conf" \
    > "$WORK/logs/shairport${idx}.log" 2>&1 &
  echo $! >> "$WORK/aux.pids"
done

# 纯 sendspin / 混合组都要拨入播放器。注意 9.x 才带 Noise 加密握手，
# 6.x 前加密时代版本连不上合规服务端（docs/archive/sendspin/sendspin-sim-player.md）。
# 这里只装依赖，**不能在这里启动探针**：sendspin 服务要等容器起来 + 插件
# toggle 之后才监听 :38927（历史上先起探针 → ClientConnectorError → 0 帧）。
if [ "${#SS_NAMES[@]}" -gt 0 ]; then
  python3 -m venv "$WORK/venv" >/dev/null
  "$WORK/venv/bin/pip" install -q 'aiosendspin==9.1.1' >/dev/null
fi
sleep 3
say "环境就绪：airplay=[${AP_NAMES[*]:-}] sendspin=[${SS_NAMES[*]:-}]（探针待插件启动后再拨入）"

say "1/8 启动被测镜像（空库）"
chmod -R a+rwX "$WORK/data" "$WORK/music"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" --network host \
  -e TZ=Asia/Shanghai -e UV_USE_IO_URING=0 -e LOG_LEVEL=debug \
  -v "$WORK/data:/app/backend/data" \
  -v "$WORK/music:/local/music:ro" \
  "$IMAGE" >/dev/null
for i in $(seq 1 90); do
  curl -fsS --max-time 3 "${BASE}/ping" >/dev/null 2>&1 && break
  sleep 1
  [ "$i" -eq 90 ] && { docker logs "$CONTAINER" --tail 80 >&2; die "容器 90s 内未响应 /ping"; }
done

say "2/8 建测试用户（admin 首次登录带 must_change_password，不用它）"
docker stop "$CONTAINER" >/dev/null
# 容器写出的 db 属主是容器内 uid，runner 用户可能只有读权限。
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

say "3/8 启用接收插件并等待设备上线"
PLUGINS=$(api GET /plugins) || die "GET /plugins 失败"
# /v1/plugins 返回的 id 是 DB 行 id（UUID），name 才是 airplay-renderer 这类稳定标识。
plugin_id() {
  printf '%s' "$PLUGINS" | python3 -c '
import json,sys
d=json.load(sys.stdin); key=sys.argv[1].lower()
rows=d if isinstance(d,list) else (d.get("plugins") or [])
for p in rows:
    if key in str(p.get("name","")).lower(): print(p.get("id") or p.get("name")); break
' "$1"
}
APID=$(plugin_id airplay)
if [ -n "$APID" ]; then api PUT /plugins/"$APID" '{"enabled":true}' >/dev/null || \
  echo "警告：启用 airplay 插件返回错误，继续等设备上线（以 peer 为准）"; fi
# 纯 AirPlay 桥组的 PCM 源是 sendspin 组泵：sendspin 服务没起 ⇒ 桥 prepare 后立刻 stop。
# 空库里该插件默认不启用，必须显式 toggle（toggle 才会 startSendspinService）。
SPID=$(plugin_id sendspin)
if [ -n "$SPID" ]; then
  SEN=$(printf '%s' "$PLUGINS" | python3 -c '
import json,sys
d=json.load(sys.stdin); rows=d if isinstance(d,list) else (d.get("plugins") or [])
for p in rows:
    if "sendspin" in str(p.get("name","")).lower(): print(int(bool(p.get("enabled")))); break
' || echo 0)
  [ "$SEN" = "1" ] || { api PUT /plugins/"$SPID"/toggle '{}' >/dev/null || die "启用 sendspin 服务失败"; sleep 3; }
fi
# 服务已监听后再拨入。探针自身带 30 次/2s 重连，覆盖插件冷启动时间。
for name in "${SS_NAMES[@]}"; do
    # 探针连前用 admin 凭据把自己标记为 approved（见 sendspin_frame_probe.py），
    # 绕过 aiosendspin 9.x 与本仓服务端不兼容的 PAKE（pin_mismatch）。
    MF_USER="$CI_USER" MF_PASS="$CI_PASS" MF_BASE_URL="$BASE" \
    MF_SS_NAME="$name" MF_SS_FRAME_OUT="$WORK/sendspin_frames.jsonl" \
      "$WORK/venv/bin/python" "$REPO/backend/scripts/baseline/sendspin_frame_probe.py" \
      "ws://127.0.0.1:38927/sendspin" "12345678" \
      > "$WORK/logs/sendspin-${name}.log" 2>&1 &
  echo $! >> "$WORK/aux.pids"
done
sleep 3   # 给探针 self-approve + Noise 握手一点时间

PEERS=(); AP_MACS=()
for name in "${AP_NAMES[@]}"; do
  peer=""
  for i in $(seq 1 90); do
    peer=$(find_peer "$name" "airplay:" || true)
    [ -n "$peer" ] && break
    sleep 1
  done
  [ -n "$peer" ] || { docker logs "$CONTAINER" --tail 80 >&2; tail -60 "$WORK/logs/shairport1.log" >&2; die "90s 内未发现 $name"; }
  PEERS+=("$peer"); AP_MACS+=("${peer#airplay:}")
  echo "$name -> $peer"
done
for name in "${SS_NAMES[@]}"; do
  peer=""
  for i in $(seq 1 90); do
    # sendspin peerId 是 clientId 派生 hash，name 来自 client/hello；SDK 的
    # client_name 未必映射成它（实测连上后按 name 找不到）。CI 里只有一台
    # 拨入播放器，取第一个 available 的 sendspin peer 即可（采样器同口径）。
    peer=$(api GET /peers 2>/dev/null | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: raise SystemExit
def walk(x):
    if isinstance(x,dict):
        pid=x.get("peerId") or x.get("id") or ""
        if isinstance(pid,str) and pid.startswith("sendspin:") and x.get("available", True):
            return pid
        for v in x.values():
            r=walk(v)
            if r: return r
    elif isinstance(x,list):
        for v in x:
            r=walk(v)
            if r: return r
    return None
print(walk(d) or "")
' 2>/dev/null || true)
    [ -n "$peer" ] && break
    sleep 1
  done
  [ -n "$peer" ] || { api GET /peers >&2 || true; docker logs "$CONTAINER" --tail 160 >&2 || true; tail -60 "$WORK/logs/sendspin-${name}.log" >&2; die "90s 内未发现可用 sendspin peer（$name）"; }
  PEERS+=("$peer")
  echo "$name -> $peer"
done
[ "${#PEERS[@]}" -gt 0 ] || die "拓扑 $TOPO 没有任何成员 peer"

say "4/8 本地媒体源 + 10 首（切歌 5 次后仍有余量）"
# 不同频率 + 不同时长：切歌后 songId / dur 双口径都能看出真的换了。
for i in $(seq 1 10); do
  # 时长必须 > 稳态预热(90s)+首段切歌间隔(60s)，否则稳态采样期发生
  # 自然换曲，其暂态会混进本该纯净的稳态判据段（第五轮实测踩坑）。
  freq=$((380 + i * 45)); dur=$((180 + i))
  ffmpeg -hide_banner -loglevel error -f lavfi -i "sine=frequency=${freq}:duration=${dur}" \
    -ar 48000 -ac 2 -c:a flac -y "$WORK/music/ci_tone_${i}.flac" >/dev/null
done
api POST /sources "{\"name\":\"mf-ci-${TOPO}\",\"type\":\"local\",\"config\":{\"path\":\"/local/music\"}}" \
  > "$WORK/logs/source-create.json" || die "创建 media source 失败"
api GET /sources > "$WORK/logs/sources-list.json" || die "列出 media source 失败"
SRC=$(python3 -c '
import json,sys
d=json.load(open(sys.argv[1],encoding="utf-8"))
rows=d if isinstance(d,list) else (d.get("sources") or [])
for s in rows:
    if s.get("name")=="mf-ci-"+sys.argv[2]: print(s["id"]); break
' "$WORK/logs/sources-list.json" "$TOPO")
[ -n "$SRC" ] || die "sources 列表里找不到 mf-ci-${TOPO}"
api POST /sources/"$SRC"/scan >/dev/null || die "触发扫描失败"
SONGS=""
for i in $(seq 1 60); do
  if api GET '/songs?limit=20' > "$WORK/logs/songs.json" 2>/dev/null; then
    SONGS=$(python3 -c '
import json,sys
d=json.load(open(sys.argv[1],encoding="utf-8"))
rows=d if isinstance(d,list) else (d.get("songs") or d.get("items") or [])
print(" ".join(str(x["id"]) for x in rows[:10]))
' "$WORK/logs/songs.json" 2>/dev/null || true)
  fi
  # 扫描是异步的：拿到第一首就 break 会让队列只剩 2 首，第 3 次切歌就空了。
  N=$(echo "$SONGS" | wc -w | tr -d ' ')
  [ "${N:-0}" -ge 6 ] && break
  sleep 1
done
read -r -a SONG_ARR <<< "$SONGS"
[ "${#SONG_ARR[@]}" -ge 6 ] || die "扫描 60s 后只有 ${#SONG_ARR[@]} 首（需要 >=6 撑起 5 次切歌）"
echo "source=$SRC songs=${#SONG_ARR[@]}"

say "5/8 建组并起播（10 首全入队）"
BODY=$(python3 -c 'import json,sys; print(json.dumps({"name":"mf-ci-"+sys.argv[1],"memberIds":sys.argv[2:]}))' \
       "$TOPO" "${PEERS[@]}")
GROUP_JSON=$(api POST /groups "$BODY") || die "建组失败"
printf '%s' "$GROUP_JSON" > "$WORK/logs/group-create.json"
GID=$(python3 -c '
import json,sys
d=json.load(open(sys.argv[1],encoding="utf-8"))
g=d.get("group") if isinstance(d,dict) else d
print((g or {}).get("id") or "")
' "$WORK/logs/group-create.json")
[ -n "$GID" ] || die "建组响应里没有 id: $GROUP_JSON"
ITEMS=$(python3 -c '
import json,sys
print(json.dumps([{"songId":s,"title":"CI Tone "+str(i+1),"mime":"audio/flac"} for i,s in enumerate(sys.argv[1:])]))
' "${SONG_ARR[@]}")
api POST "/peers/group%3A${GID}/queue/play" "{\"items\":${ITEMS},\"startIndex\":0}" \
  >/dev/null || die "起播失败"

say "6/8 等起流稳态（含桥拓扑看 tick，纯 sendspin 看帧）"
if [ "$TICK_TOPO" = "sendspin" ]; then
  for i in $(seq 1 90); do
    n=$(frame_count); [ "${n:-0}" -ge 20 ] && break
    sleep 2
  done
  n=$(frame_count); [ "${n:-0}" -ge 20 ] || {
    docker logs "$CONTAINER" --tail 100 >&2; tail -60 "$WORK/logs/sendspin-${SS_NAMES[0]}.log" >&2
    die "起播后 180s 内 sendspin 帧不足 20（推流未启动）"; }
else
  TICK_READY=0
  for i in $(seq 1 45); do
    if docker logs "$CONTAINER" 2>&1 | grep -aq '"ev":"tick"'; then TICK_READY=1; break; fi
    sleep 2
  done
  if [ "$TICK_READY" -ne 1 ]; then
    echo "::error::起播后 90s 内无 ev:tick，桥接未起流"
    docker logs "$CONTAINER" 2>&1 | tail -120 >&2
    for f in "$WORK"/logs/shairport*.log; do tail -40 "$f" >&2; done
    die "bridge 未产出 tick"
  fi
fi
sleep 12

say "7/8 采样 ${MINUTES} 分钟 + 切歌 ${SWITCH_COUNT} 次（每次确认 songId 真变化）"
export MF_USER="$CI_USER" MF_PASS="$CI_PASS" MF_GROUP_ID="$GID" \
       MF_DEVICES="$(IFS=,; echo "${AP_MACS[*]:-}")" MF_OUTDIR="$WORK" \
       MF_CONTAINER="$CONTAINER" MF_BASE_URL="$BASE"
# 采样预算 = 稳态 + 全部切歌间隔 + 余量。不要用 MINUTES*60 硬顶：
# 长跑里 MINUTES 只是标签/回看窗口，采样该在最后一次切歌确认后收尾，
# 否则 wait 会空转到 timeout 白等几分钟。
SAMPLER_BUDGET=$(( STEADY_SEC + SWITCH_COUNT * SWITCH_INTERVAL + 120 ))
timeout "$SAMPLER_BUDGET" python3 \
  "$REPO/docs/examples/baseline_sampler.example.py" > "$WORK/logs/sampler.log" 2>&1 &
echo $! > "$WORK/sampler.pid"

# 容器资源采样：长跑专用。只写文件不做断言，阈值判读交给 longrun_trend.py。
# 全部失败都吞掉——docker stats / exec 偶发超时不该让体检脚本 die。
RES_PID=""
if [ "$RESOURCE_SAMPLE" -eq 1 ]; then
  (
    while :; do
      now=$(date +%s%3N)
      rss=$(docker exec "$CONTAINER" grep -E '^VmRSS' /proc/1/status 2>/dev/null \
              | awk '{print $2}' || true)
      fd=$(docker exec "$CONTAINER" sh -c 'ls /proc/1/fd 2>/dev/null | wc -l' || true)
      mem=$(docker stats --no-stream --format '{{.MemUsage}}' "$CONTAINER" 2>/dev/null || true)
      printf '{"t":%s,"rssKb":%s,"fd":%s,"mem":"%s"}\n' \
        "$now" "${rss:-0}" "${fd:-0}" "${mem}" >> "$WORK/resource.jsonl"
      sleep 30
    done
  ) &
  RES_PID=$!
  echo "$RES_PID" >> "$WORK/aux.pids"
  say "资源采样已启动（30s/次 → resource.jsonl）"
fi

say "稳态采样 ${STEADY_SEC}s（这段才参与绝对阈值判读）"
sleep "$STEADY_SEC"

for k in $(seq 1 "$SWITCH_COUNT"); do
  before=$(status_song)
  t0=$(date +%s%3N); fb=$(frame_count)
  api POST "/peers/group%3A${GID}/next" '{}' >/dev/null || die "第 $k 次 next 调用失败"
  after="$before"; changed=false; settle=-1
  for j in $(seq 1 50); do
    after=$(status_song)
    if [ -n "$after" ] && [ "$after" != "$before" ]; then
      changed=true
      now=$(date +%s%3N)
      # NTP 回拨时 now 可能小于 t0；钳到 0，真实回拨仍可从 t0/t1 原值看出。
      if [ "$now" -gt "$t0" ]; then settle=$(( now - t0 )); else settle=0; fi
      break
    fi
    sleep 0.5
  done
  t1=$(date +%s%3N); fa=$(frame_count)
  python3 - "$WORK/switch_log.jsonl" "$t0" "$t1" "$k" "$before" "$after" \
    "$changed" "$settle" "$fb" "$fa" <<'PY'
import json,sys
p,*a=sys.argv[1:]
rec={"at":int(a[0]),"t0":int(a[0]),"t1":int(a[1]),"index":int(a[2]),
     "before":a[3],"after":a[4],"changed":a[5]=="true",
     "settleMs":int(a[6]),"framesBefore":int(a[7] or 0),"framesAfter":int(a[8] or 0)}
with open(p,"a",encoding="utf-8") as f: f.write(json.dumps(rec)+"\n")
PY
  echo "切歌 $k: $before -> $after changed=$changed settle=${settle}ms"
  [ "$changed" = "true" ] || { echo "::error::第 $k 次切歌 25s 内 songId 未变化"; }
  [ "$k" -lt "$SWITCH_COUNT" ] && sleep "$SWITCH_INTERVAL"
done
CHANGED=$(python3 -c '
import json,sys
n=0
for l in open(sys.argv[1],encoding="utf-8"):
    try: n+=bool(json.loads(l).get("changed"))
    except Exception: pass
print(n)
' "$WORK/switch_log.jsonl")
echo "成功切歌 $CHANGED / $SWITCH_COUNT"
[ "$CHANGED" -ge "$SWITCH_COUNT" ] || die "切歌成功数不足（$CHANGED < $SWITCH_COUNT）"

# 先停资源采样再等 sampler，避免资源循环一直挂到 timeout。
if [ -n "$RES_PID" ]; then
  kill "$RES_PID" 2>/dev/null || true
  wait "$RES_PID" 2>/dev/null || true
fi
wait "$(cat "$WORK/sampler.pid")" 2>/dev/null || true
TICKS=$(grep -ac '"type": *"tick"' "$WORK/base.jsonl" 2>/dev/null || echo 0)
echo "采样 tick 行数=$TICKS  sendspin 帧行数=$(frame_count)"
[ "$TICK_TOPO" = "sendspin" ] || [ "$TICKS" -ge 20 ] || die "tick 不足 20 条"
[ "$TICK_TOPO" != "sendspin" ] || [ "$(frame_count)" -ge 100 ] || die "sendspin 帧不足 100"

say "8/8 汇总 + 分拓扑不变量判读"
export MF_WATCH_DIR="$WORK" MF_SWITCH_LOG="$WORK/switch_log.jsonl" \
       MF_SS_FRAME_LOG="$WORK/sendspin_frames.jsonl"
python3 "$REPO/backend/scripts/baseline/baseline_cap.py" \
  --window "$MINUTES" --label "ci-sim-${TOPO}-$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)" \
  --out "$WORK/cap.json" || die "baseline_cap 失败"
python3 - "$WORK/cap.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1],encoding="utf-8"))
for dev,v in (d.get("A_tick") or {}).items():
    print("SEGMENT tick dev=%s total=%s steady=%s switchPhase=%s" %
          (dev, v.get("samplesTotal"), v.get("samplesSteady"),
           (v.get("switchWindow") or {}).get("samples")))
f=d.get("A_ssFrame") or {}
print("SEGMENT ss total=%s steady=%s switchPhase=%s" %
      (f.get("chunks"), f.get("steadyChunks"), f.get("switchWindowChunks")))
PY
EXTRA=()
[ "$TICK_EXPECT" -gt 0 ] && EXTRA+=(--expect-tick-devices "$TICK_EXPECT")
[ "$TICK_TOPO" = "sendspin" ] && EXTRA+=(--min-ticks 0)
python3 "$REPO/backend/scripts/baseline/invariant_guard.py" \
  --input "$WORK/cap.json" --topo "$TICK_TOPO" --require-switch "${EXTRA[@]}"

# 长跑增量判据：全局分位数抓不到「前段健康、后段劣化」，这里按 5 分钟分桶看斜率。
# 非零退出即 job 失败（set -e），与短跑判据同等对待。
if [ "$RESOURCE_SAMPLE" -eq 1 ]; then
  say "9/9 长跑趋势判读（分桶斜率 + 资源增长）"
  python3 "$REPO/backend/scripts/baseline/longrun_trend.py" \
    --input "$WORK/base.jsonl" \
    --ss-input "$WORK/sendspin_frames.jsonl" \
    --resource "$WORK/resource.jsonl" \
    --topo "$TICK_TOPO"
fi
