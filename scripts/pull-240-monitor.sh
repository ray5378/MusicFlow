#!/bin/bash
# ==================== 240 监控结果本地收集器 ====================
#
# 从 240 拉回两类结果,存本地 logs/monitor-240/(gitignored,不进提交):
#   1) 卡顿监控:monitor.csv 新增行 + events.log 新增行
#   2) 死链跳过:容器新鲜日志里的 JUDGE_DEAD/SKIP/PUMP_DEADFAIL、
#      PreProbe deadRun>0、SLOWRESOLVE,按次 append,附拉取时间
#
# 用法:
#   ./scripts/pull-240-monitor.sh --once     # 拉一次(默认拉最近30分钟死链证据)
#   INTERVAL=120 ./scripts/pull-240-monitor.sh  # 每120s循环拉(常驻请 nohup)
set -u

SSH="ssh -i /root/mykey -p 35320 -o StrictHostKeyChecking=no -o ConnectTimeout=20 root@192.168.10.240"
REMOTE_OUT="/root/sendspin-monitor"
LOCAL_DIR="logs/monitor-240"
INTERVAL="${INTERVAL:-120}"
STATE="$LOCAL_DIR/.cursor"

mkdir -p "$LOCAL_DIR"
touch "$LOCAL_DIR/monitor.csv" "$LOCAL_DIR/events.log" "$LOCAL_DIR/deadlink.log"
[ -f "$STATE" ] || echo "0" > "$STATE"

remote() { $SSH "$@" 2>/dev/null; }

pull_csv() {
  # monitor.csv 首列时间戳,只追加比本地新的行
  local last local_tmp
  last=$(tail -1 "$LOCAL_DIR/monitor.csv" 2>/dev/null | cut -d, -f1 || true)
  local_tmp=$(remote "tail -60 $REMOTE_OUT/monitor.csv")
  [ -z "$local_tmp" ] && return 0
  if [ -z "$last" ] || [ "$last" = "ts" ]; then
    echo "$local_tmp" | grep -v "^ts," >> "$LOCAL_DIR/monitor.csv"
  else
    echo "$local_tmp" | grep -v "^ts," | awk -F, -v last="$last" '$1 > last' >> "$LOCAL_DIR/monitor.csv"
  fi
}

pull_events() {
  # events.log 行首时间戳精确到秒:取远端后 100 行,本地没有的行才 append
  local fetched line found=0
  fetched=$(remote "tail -100 $REMOTE_OUT/events.log")
  [ -z "$fetched" ] && return 0
  local known
  known=$(tail -100 "$LOCAL_DIR/events.log" 2>/dev/null || true)
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    if [ "$found" = "0" ]; then
      # 还没定位到上次位置:本地见过就跳过,第一行没见过就从这里开始收
      if echo "$known" | grep -qxF "$line"; then
        continue
      else
        found=1
      fi
    fi
    echo "$line" >> "$LOCAL_DIR/events.log"
  done <<< "$fetched"
}

pull_deadlink() {
  # 死链证据:自上次拉取以来的容器日志指纹
  local since now
  since=$(cat "$STATE")
  if [ "$since" = "0" ]; then
    since=$(($(date +%s) - 1800))
  fi
  now=$(date +%s)
  local ev
  ev=$(remote "docker logs --since $since musicflow 2>&1 | grep -aE 'judge.*(确定无源|无可播行|跳过)|整队无源|no playable stream|PreProbe.*(deadRun=[1-9]|exhausted=true)|resolve\] .* ms=' | grep -aE 'judge|no playable|deadRun=[1-9]|exhausted=true|ms=(1[0-9]{4}|[2-9][0-9]{4})' | tail -40")
  {
    echo "===== pull $(date '+%F %T') (since epoch $since) ====="
    if [ -z "$ev" ]; then
      echo "(本轮无死链/慢探测指纹)"
    else
      echo "$ev"
      # 小结:判死 / 跳过 / 播到才失败 各几条
      local dead skip fail
      dead=$(echo "$ev" | grep -ac "确定无源\|无可播行" || true)
      skip=$(echo "$ev" | grep -ac "跳过\|整队无源" || true)
      fail=$(echo "$ev" | grep -ac "no playable stream" || true)
      echo "--- 小结: 判死=$dead 跳过=$skip 播到才失败=$fail"
    fi
  } >> "$LOCAL_DIR/deadlink.log"
  echo "$now" > "$STATE"
}

pull_summary() {
  # 卡顿事件小结(本轮远端 events 新增)
  local n
  n=$(remote "tail -20 $REMOTE_OUT/events.log | grep -acE 'STALL|REWIND|ENCSTALL|PUSHBREAK' " || true)
  echo "卡顿类事件(远端近20行): $n"
}

do_pull() {
  pull_csv
  pull_events
  pull_deadlink
  echo "[$(date '+%F %T')] 拉取完成: csv=$(wc -l < "$LOCAL_DIR/monitor.csv")行 events=$(wc -l < "$LOCAL_DIR/events.log")行 deadlink=$(wc -l < "$LOCAL_DIR/deadlink.log")行"
  pull_summary
}

if [ "${1:-}" = "--once" ]; then
  do_pull
  exit 0
fi
echo "循环拉取中 interval=${INTERVAL}s,目录=$LOCAL_DIR (Ctrl-C 停)"
while true; do
  do_pull || true
  sleep "$INTERVAL"
done
