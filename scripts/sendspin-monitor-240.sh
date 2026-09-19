#!/bin/bash
# ==================== sendspin 播放卡顿持续监控(跑在 240 本机) ====================
#
# 抓什么:
#   1) 资源:容器 CPU/MEM + 主进程/子进程 RSS + ffmpeg 进程数(5s 采样进 CSV)
#   2) 服务端卡顿指纹(增量扫容器日志):
#      - "sendspin pushFrame 中断"        → 推流循环被异常打断
#      - "sendspin 编码器疑似失效"        → 连续 500ms 零产出,时间线降级
#      - "stream/end" / "stream/start"   → 流起停抖动(正常切歌也有,看频率)
#      - "client/hello" / "goodbye"      → 设备重连(ESPHome 断线重连常伴随卡顿)
#      - "playFailed" / "announceStream" → 起播失败 / 播报打断
#   3) 进度停滞:pollDBG 里某客户端 PLAYING 但 position 连续 3 个采样(15s)不动
#      → STALL 事件(真卡顿最直接的服务端证据)
#   4) 位置跳变:后退>5s(非切歌回零)疑似重播/重缓冲;前进>15s 疑似跳歌
#
# 注意:设备侧 Lost sync/underrun 只在 ESPHome 端,不进容器日志,此处抓不到;
#      若服务端全绿但体感仍卡,下一步去设备串口日志对时间戳。
#
# 用法:
#   部署: scp -i /root/mykey -P 35320 scripts/sendspin-monitor-240.sh root@192.168.10.240:/root/sendspin-monitor/
#   单次: ./sendspin-monitor-240.sh --once
#   常驻: nohup ./sendspin-monitor-240.sh >/root/sendspin-monitor/monitor.out 2>&1 &
#   停止: pkill -f sendspin-monitor-240.sh
#   看结果: tail -f /root/sendspin-monitor/events.log
#           awk -F, 'NR>1{print $1,$2,$3,$4,$5,$6}' /root/sendspin-monitor/monitor.csv | tail
set -u

CONTAINER="${CONTAINER:-musicflow}"
INTERVAL="${INTERVAL:-5}"
OUTDIR="${OUTDIR:-/root/sendspin-monitor}"
CSV="$OUTDIR/monitor.csv"
EVENTS="$OUTDIR/events.log"
STALL_SAMPLES=3          # 连续几个采样不动判 STALL
JUMP_BACK_S=5            # 后退超此判重播/重缓冲(切歌回零除外)
JUMP_FWD_S=15            # 前进超此判跳歌

mkdir -p "$OUTDIR"
[ -f "$CSV" ] || echo "ts,cpu_pct,mem_mib,main_rss_mb,child_rss_mb,ffmpeg_n,playing,stall" > "$CSV"

log_event() { # $1=类型 $2=详情
  echo "$(date '+%F %T') [$1] $2" | tee -a "$EVENTS"
}

# ---- 单次资源采样 ----
sample_res() {
  local stats rss
  stats=$(docker stats "$CONTAINER" --no-stream --format '{{.CPUPerc}} {{.MemUsage}}' 2>/dev/null) || { echo "0 0MiB"; return 1; }
  local cpu mem
  cpu=$(echo "$stats" | awk '{print $1}' | tr -d '%')
  mem=$(echo "$stats" | awk '{print $2}' | sed 's/MiB//;s/GiB/*1024/' )
  # shellcheck disable=SC2001
  mem=$(echo "$mem" | awk '{if ($0 ~ /\*/) {split($0,a,"\\*"); print a[1]*a[2]} else print $0}')
  local main_rss=0 child_rss=0 ff_n=0
  rss=$(docker top "$CONTAINER" -o pid,rss,args 2>/dev/null | grep -E "dist/index|sendspin/child|ffmpeg" ) || true
  if [ -n "$rss" ]; then
    main_rss=$(echo "$rss" | grep "dist/index" | awk '{s+=$2} END {printf "%.0f", s/1024}')
    child_rss=$(echo "$rss" | grep "sendspin/child" | awk '{s+=$2} END {printf "%.0f", s/1024}')
    ff_n=$(echo "$rss" | grep -c ffmpeg || true)
  fi
  echo "$cpu $mem $main_rss $child_rss $ff_n"
}

# ---- 增量日志(注意:必须直接调、用全局 NEWLOG 传回;$(...) 子 shell 会丢 LAST_TS) ----
NEWLOG=""
fetch_new_logs() {
  local now
  now=$(date +%s)
  NEWLOG=$(docker logs --since "$LAST_TS" "$CONTAINER" 2>&1 | grep -v "^$" | tail -3000 || true)
  LAST_TS=$now
}

declare -A LAST_POS LAST_SEEN STALL_FLAG

# pollDBG 行: ...[pollDBG] t=... <client>: state=PLAYING pos=165.05 dur=227
handle_positions() { # $1=日志文本 $2=当前epoch
  local logtext="$1" now="$2"
  local line cid st pos
  while IFS= read -r line; do
    [[ "$line" == *"pollDBG"* ]] || continue
    # shellcheck disable=SC2001
    cid=$(echo "$line" | sed -n 's/.*pollDBG] t=[0-9]* \([^:]*\):.*/\1/p')
    st=$(echo "$line" | sed -n 's/.*state=\([A-Z_]*\).*/\1/p')
    pos=$(echo "$line" | sed -n 's/.*pos=\([0-9.]*\).*/\1/p')
    [ -n "$cid" ] || continue
    [ -n "$pos" ] || continue
    if [ "$st" = "PLAYING" ]; then
      if [ "${LAST_POS[$cid]:-}" = "$pos" ]; then
        local n=${LAST_SEEN[$cid]:-0}; n=$((n+1)); LAST_SEEN[$cid]=$n
        if [ "$n" -ge "$STALL_SAMPLES" ] && [ "${STALL_FLAG[$cid]:-0}" != "1" ]; then
          STALL_FLAG[$cid]=1
          log_event "STALL" "$cid PLAYING 但 position=${pos}s 已连续 ${n} 个采样不动(>${STALL_SAMPLES}*${INTERVAL}s)"
        fi
      else
        # 位置动了:判跳变(排除切歌回零:新 pos<2s 视为切歌)
        if [ -n "${LAST_POS[$cid]:-}" ]; then
          local jumped
          jumped=$(awk -v a="$pos" -v b="${LAST_POS[$cid]}" 'BEGIN{print (a-b)}')
          local back fwd
          back=$(awk -v d="$jumped" 'BEGIN{print (d < -'"$JUMP_BACK_S"')}')
          fwd=$(awk -v d="$jumped" 'BEGIN{print (d > '"$JUMP_FWD_S"')}')
          if [ "$back" = "1" ]; then
            local isnew
            isnew=$(awk -v a="$pos" 'BEGIN{print (a < 2.0)}')
            if [ "$isnew" = "1" ]; then
              log_event "TRACK" "$cid 切歌 pos ${LAST_POS[$cid]}s → ${pos}s"
              STALL_FLAG[$cid]=0
            else
              log_event "REWIND" "$cid 位置后退 ${LAST_POS[$cid]}s → ${pos}s(疑似重播/重缓冲)"
            fi
          elif [ "$fwd" = "1" ]; then
            log_event "SKIPFWD" "$cid 位置前跳 ${LAST_POS[$cid]}s → ${pos}s(疑似跳歌/seek)"
          fi
        fi
        LAST_POS[$cid]="$pos"; LAST_SEEN[$cid]=0; STALL_FLAG[$cid]=0
      fi
    else
      LAST_POS[$cid]="$pos"; LAST_SEEN[$cid]=0; STALL_FLAG[$cid]=0
    fi
  done <<< "$logtext"
}

PATTERNS=(
  "PUSHBREAK|sendspin pushFrame 中断"
  "ENCSTALL|sendspin 编码器疑似失效"
  "PLAYFAIL|playFailed|failed\(client"
  "RECONNECT|client/hello|goodbye|dialed|等激活"
  "STREAMFLAP|stream/end|stream/start|announceStream"
  # 坏源追踪(预探测是否提前跳过):judge 判死 / 宽容放行 / pump播到才失败
  "JUDGE_DEAD|judge.*确定无源|judge.*无可播行"
  "JUDGE_SKIP|judge.*跳过|整队无源"
  "PUMP_DEADFAIL|no playable stream"
)

ONESAMPLE=0
[ "${1:-}" = "--once" ] && ONESAMPLE=1

sample_once() {
  local ts res cpu mem main child ff newlog
  ts=$(date '+%F %T')
  res=$(sample_res) || { log_event "ERROR" "容器 $CONTAINER stats 失败(没在跑?)"; return 1; }
  read -r cpu mem main child ff <<< "$res"
  fetch_new_logs
  newlog="$NEWLOG"
  local playing
  playing=$(echo "$newlog" | grep -c "state=PLAYING" || true)
  local stall=0
  handle_positions "$newlog" "$(date +%s)"
  # 指纹计数
  local desc pat name
  for desc in "${PATTERNS[@]}"; do
    name="${desc%%|*}"; pat="${desc#*|}"
    local c
    c=$(echo "$newlog" | grep -cE "$pat" || true)
    [ "$c" -gt 0 ] && log_event "$name" "最近${INTERVAL}s出现 ${c} 次" && stall=1
  done
  # resolve 慢探测(>10s):源半死不活的征兆,单列
  local slow
  slow=$(echo "$newlog" | grep -aoE "resolve\] [^ ]+ -> null \([a-z-]+\) ms=[0-9]+" | awk -F'ms=' '$2+0>10000' | head -3 || true)
  [ -n "$slow" ] && log_event "SLOWRESOLVE" "$(echo "$slow" | tr '\n' ';')" && stall=1
  for cid in "${!STALL_FLAG[@]}"; do
    [ "${STALL_FLAG[$cid]}" = "1" ] && stall=1
  done
  echo "$ts,$cpu,$mem,$main,$child,$ff,$playing,$stall" >> "$CSV"
}

log_event "START" "监控启动 interval=${INTERVAL}s container=$CONTAINER out=$OUTDIR"
if [ "$ONESAMPLE" = "1" ]; then
  sample_once
  echo "--- events.log tail ---"; tail -5 "$EVENTS"
  echo "--- monitor.csv tail ---"; tail -3 "$CSV"
  exit 0
fi
while true; do
  sample_once || true
  sleep "$INTERVAL"
done
