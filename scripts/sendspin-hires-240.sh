#!/bin/bash
# 1s 高分辨率进程 CPU 采样(跑在 240 本机):定位 5s 采样抓不到的瞬时 CPU 尖峰是谁烧的
# (主进程 node / sendspin 子进程 / 窗口 ffmpeg / 其他)。输出 highs.csv:
#   ts,main_cpu,child_cpu,ff_cpu,ff_n,cont_cpu
# 用法: nohup ./sendspin-hires-240.sh >/root/sendspin-monitor/hires.out 2>&1 &
set -u
CONTAINER="${CONTAINER:-musicflow}"
OUTDIR="${OUTDIR:-/root/sendspin-monitor}"
CSV="$OUTDIR/highs.csv"
[ -f "$CSV" ] || echo "ts,main_cpu,child_cpu,ff_cpu,ff_n,cont_cpu" > "$CSV"
echo "$(date '+%F %T') [START] 高分辨率采样启动 interval=1s" | tee -a "$OUTDIR/hires.out"
while true; do
  ts=$(date '+%F %T')
  top=$(docker top "$CONTAINER" -o pid,pcpu,args 2>/dev/null || true)
  main=$(echo "$top" | grep "dist/index" | awk '{s+=$2} END {printf "%.1f", s+0}')
  child=$(echo "$top" | grep "sendspin/child" | awk '{s+=$2} END {printf "%.1f", s+0}')
  ff=$(echo "$top" | grep -E "ffmpeg" | awk '{s+=$2} END {printf "%.1f", s+0}')
  ffn=$(echo "$top" | grep -cE "ffmpeg" || true)
  cc=$(docker stats "$CONTAINER" --no-stream --format '{{.CPUPerc}}' 2>/dev/null | tr -d '%' || echo 0)
  echo "$ts,${main:-0},${child:-0},${ff:-0},$ffn,${cc:-0}" >> "$CSV"
  sleep 1
done
