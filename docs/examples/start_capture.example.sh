#!/usr/bin/env bash
# 常驻环形 pcap 抓包 —— 脱敏启动模板（网络面取证层）
# ---------------------------------------------------------------------------
# 定位：与日志面采样（mf-status / mf-base）互补，不进 playback_side_guard 判据。
#      日志面证伪「服务端有没有给货」，pcap 证伪「网络丢包 / 设备有没有真收到」。
# 方法论：docs/播放链路排障与采样手册.md §1.5；docs/播放基线-基准值与判读-20261126.md §8。
#
# 脱敏说明：本模板不含任何真实 IP / MAC / 网卡名 / 设备标识 / 部署路径。
#          示例 IP 用 RFC 5737 文档保留段 192.0.2.x；实际使用前按现场覆盖环境变量。
#
# 用法：
#   CAP_IFACE=eth0 CAP_FILTER='host 192.0.2.10' CAP_DIR=/tmp/pcap \
#     bash start_capture.example.sh start|stop|status
#   - start  : 后台常驻抓包（环形覆盖，窗口≈ RING_MB × RING_COUNT / 平均码率）
#   - stop   : 按 pid 文件停止，保留已抓文件
#   - status : 查看进程与环形文件
# 收工纪律：取证结束应立即 stop 并清理 CAP_DIR，pcap 是临时证据、非常驻服务。
# ---------------------------------------------------------------------------
set -euo pipefail

# ---- 可按现场覆盖的参数（以下均为脱敏默认值）----
IFACE="${CAP_IFACE:-eth0}"                    # 抓包网卡
FILTER="${CAP_FILTER:-host 192.0.2.10}"       # tcpdump 过滤表达式（示例 IP，按现场替换）
OUT_DIR="${CAP_DIR:-/tmp/pcap_rotate}"        # 输出目录
RING_MB="${CAP_RING_MB:-50}"                  # 单分片 MB
RING_COUNT="${CAP_RING_COUNT:-12}"            # 分片数
BASE="${CAP_BASE:-capture}"                   # 文件名前缀

PID_FILE="$OUT_DIR/capture.pid"
LOG_FILE="$OUT_DIR/tcpdump.log"

cmd="${1:-status}"

case "$cmd" in
  start)
    mkdir -p "$OUT_DIR"
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "ALREADY_RUNNING pid=$(cat "$PID_FILE")"; exit 0
    fi
    # -C/-W 环形：写满一个分片自动滚动，保留最近 RING_COUNT 个
    setsid nohup tcpdump -i "$IFACE" -n -s 0 -U \
      -C "$RING_MB" -W "$RING_COUNT" \
      -w "$OUT_DIR/$BASE.pcap" "$FILTER" \
      >"$LOG_FILE" 2>&1 < /dev/null &
    echo $! > "$PID_FILE"
    echo "STARTED pid=$(cat "$PID_FILE") iface=$IFACE filter='$FILTER'"
    echo "window≈$((RING_MB * RING_COUNT))MB  out=$OUT_DIR/$BASE.pcap*"
    echo "NOTE: docker logs -t = UTC; tcpdump -r = 本机时区(CST). 对账先统一口径."
    ;;
  stop)
    if [ ! -f "$PID_FILE" ]; then echo "NO_PID_FILE"; exit 0; fi
    pid="$(cat "$PID_FILE")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" && echo "STOPPED pid=$pid (产物保留在 $OUT_DIR)"
    else
      echo "NOT_RUNNING pid=$pid"
    fi
    rm -f "$PID_FILE"
    ;;
  status)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "RUNNING pid=$(cat "$PID_FILE") iface=$IFACE filter='$FILTER'"
    else
      echo "STOPPED (or no pid file)"
    fi
    echo "--- files in $OUT_DIR ---"
    ls -lh "$OUT_DIR" 2>/dev/null | head -20 || true
    echo "--- tcpdump.log head ---"
    head -3 "$LOG_FILE" 2>/dev/null || true
    ;;
  *)
    echo "usage: $0 start|stop|status" >&2; exit 2
    ;;
esac
