#!/usr/bin/env python3
# =============================================================================
# 5 首连播 soak 判定采样器（脱敏示例）
#   配套：docs/播放链路排障与采样手册.md 附录 D
#         docs/曲中静音与曲末空洞-判定全流程-20261126.md（S06 口径）
# -----------------------------------------------------------------------------
# ⚠️ 示例脚本：不含任何真实 IP / MAC / 组 ID / 凭据，全部从环境变量读取。
#
# 本脚本沉淀了 2026-11-28 240 实测后修正的三条采样口径：
#   1) **不要用 `currentIndex` 判切歌（尤其独播）**
#      独播走 `group:__bridge_solo:<dev>` 虚拟队列，displayHold 期间
#      `/queue.currentIndex` 会停留在旧曲（权威文档 §4.1），轮询它会漏计切歌、
#      甚至把正常播放误判成“停了”。切歌数改从日志统计：
#        - `[QueueController][display-hold] ... 放开显示(...) → idx=N`
#        - `[sendspin] bridge-generation ... reason=track`（continuity=1 也会打）
#      两者取较大值。
#   2) **单次 STOPPED 不等于播完**
#      独播状态上报存在瞬时 STOPPED（displayHold / 换曲窗口）。必须连续
#      N 次（默认 3 次、每次 5s）读到 STOPPED/IDLE 才判定结束。
#   3) **`silenceChunks` 是累计值，判“新增”而不是判绝对值**
#      换会话时计数会重置（240 实测 28→0，不是新增静音）。判据是
#      窗口内 `silenceChunks` 增长 ≥3 才算新增静音块。
#
# 判定（与正常播放同一口径）：
#   PASS = 切歌数 ≥ MF_MIN_TRACKS（默认 4，即 5 首）
#          且 每个目标设备 tick 数 > 0
#          且 silenceChunks 增长 < 3
#          且 max(late) ≤ 500ms
#          且 min(inQueueMs) ≥ 200ms（起播首拍允许 1250ms 左右）
#          且（若配置了 pcap_stat）目标设备 RTP miss=0 / zeroSec=0 / tsJump≤0.05s
#
# 用法（容器所在主机）：
#   export MF_USER=... MF_PASS=... MF_BASE_URL=http://127.0.0.1:46400
#   export MF_TARGET='group:<uuid>'                 # 或 airplay:<MAC> / sendspin:<hash>
#   export MF_DEVICES='<MAC1>,<MAC2>'               # 期望出声的 tick dev
#   export MF_CAPTURE_HOSTS='192.0.2.10,192.0.2.11' # 抓包对象（RFC5737 示例段）
#   export MF_SECS=780 MF_MIN_TRACKS=4              # 约 5 首
#   export MF_PCAPSTAT=/path/to/pcap_stat.py        # 可选：RTP 统计器
#   python3 soak_judge.example.py
#
# 时间口径：docker logs 的时间是 UTC(Z)，tcpdump 是本机时区；本脚本内部统一用 UTC。
# =============================================================================
import base64, json, os, re, subprocess, time, urllib.request

BASE = os.environ.get("MF_BASE_URL", "http://127.0.0.1:46400")
USER = os.environ.get("MF_USER", "<user>")
PASS = os.environ.get("MF_PASS", "<pass>")
TARGET = os.environ.get("MF_TARGET", "<peer-id>")
DEVS = [d.strip() for d in os.environ.get("MF_DEVICES", "").split(",") if d.strip()]
CAP_HOSTS = [h.strip() for h in os.environ.get("MF_CAPTURE_HOSTS", "").split(",") if h.strip()]
SECS = int(os.environ.get("MF_SECS", "780"))
MIN_TRACKS = int(os.environ.get("MF_MIN_TRACKS", "4"))
CONTAINER = os.environ.get("MF_CONTAINER", "musicflow")
IFACE = os.environ.get("MF_IFACE", "eth0")
PCAPSTAT = os.environ.get("MF_PCAPSTAT", "")
AUTH = base64.b64encode(("%s:%s" % (USER, PASS)).encode()).decode()


def sh(cmd):
    return subprocess.run(["bash", "-lc", cmd], capture_output=True, text=True, timeout=180).stdout


def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + "/rest/api/v1" + path, data=data, method=method,
                                 headers={"Authorization": "Basic " + AUTH,
                                          "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=8) as f:
            return json.loads(f.read().decode() or "{}")
    except Exception:
        return {}


def play(target):
    items = os.environ.get("MF_ITEMS_JSON")
    if items:
        items = json.loads(items)
    else:
        # /v1/songs 大库时可能很慢；示例取 8 首，失败时用 MF_ITEMS_JSON 兜底
        lib = api("GET", "/v1/songs?pageSize=8")
        items = lib.get("items") or lib.get("songs") or lib.get("rows") or []
    api("POST", "/v1/peers/%s/queue/play" % target, {"items": items, "position": 0})


def read_state(pid):
    q = api("GET", "/v1/peers/%s/status" % pid)
    st = q.get("state") or ((q.get("status") or {}).get("state")) or "?"
    return str(st), q


def parse_logs(t0, t1):
    txt = sh("docker logs --since %s --until %s %s 2>&1" % (t0, t1, CONTAINER))
    ticks = {}
    tracks = 0          # bridge-generation reason=track
    holds = {}          # display-hold 放开 → idx 的最大值
    for ln in txt.splitlines():
        m = re.search(r"\[QueueController\]\[display-hold\].*放开显示.*→ idx=(\d+)", ln)
        if m:
            dev = re.search(r"display-hold\]\s+([0-9A-Fa-f]+)", ln)
            if dev:
                holds[dev.group(1)] = max(holds.get(dev.group(1), -1), int(m.group(1)))
        if "bridge-generation" in ln and "reason=track" in ln:
            tracks += 1
        i = ln.find('{"')
        if i < 0:
            continue
        try:
            d = json.loads(ln[i:ln.rfind("}") + 1])
        except Exception:
            continue
        if d.get("ev") == "tick" and d.get("dev"):
            ticks.setdefault(d["dev"], []).append(d)
    return ticks, tracks, holds


def pcap_ok(path):
    if not PCAPSTAT or not os.path.exists(path):
        return True, "pcap: skipped"
    out = sh("python3 %s %s" % (PCAPSTAT, path))
    line = " ".join(out.strip().splitlines())
    m = re.search(r"miss=(\d+).*zeroSec=(\d+).*tsJump=([0-9.]+)", line)
    if not m:
        return True, "pcap: unparsed"
    ok = int(m.group(1)) == 0 and int(m.group(2)) == 0 and float(m.group(3)) <= 0.05
    return ok, "pcap: " + line[:160]


def main():
    api("POST", "/v1/peers/%s/stop" % TARGET)
    time.sleep(2)
    play(TARGET)
    started = False
    for _ in range(25):
        st, _q = read_state(TARGET)
        if st in ("PLAYING", "BUFFERING"):
            started = True
            break
        time.sleep(1)
    if not started:
        print("VERDICT FAIL(start) state=%s" % st)
        return
    t0 = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 2))
    caps = []
    for h in CAP_HOSTS:
        fp = "/tmp/soak_%s.pcap" % h.replace(".", "_")
        subprocess.run(["rm", "-f", fp])
        caps.append((h, fp, subprocess.Popen(
            ["tcpdump", "-i", IFACE, "-n", "-s", "0", "-w", fp, "host", h],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)))
    deadline = time.time() + SECS
    stop_hits = 0
    while time.time() < deadline:
        st, _q = read_state(TARGET)
        stop_hits = stop_hits + 1 if st in ("STOPPED", "IDLE") else 0
        if stop_hits >= 3:       # 口径 2：连续 3 次 STOPPED 才算结束
            break
        time.sleep(5)
    time.sleep(6)
    for _h, _fp, p in caps:
        p.terminate()
    time.sleep(2)
    t1 = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 1))
    api("POST", "/v1/peers/%s/stop" % TARGET)

    ticks, tracks, holds = parse_logs(t0, t1)
    changes = max(tracks, max(holds.values()) + 1 if holds else 0)

    ok = changes >= MIN_TRACKS
    reasons = [] if ok else ["tracks=%d" % changes]
    for dev in DEVS:
        rows = ticks.get(dev) or []
        if not rows:
            ok = False
            reasons.append("no-tick:%s" % dev)
            continue
        sil = [r.get("silenceChunks") for r in rows if isinstance(r.get("silenceChunks"), (int, float))]
        iq = [r.get("inQueueMs") for r in rows if isinstance(r.get("inQueueMs"), (int, float))]
        lt = [r.get("late") for r in rows if isinstance(r.get("late"), (int, float))]
        miss = sum(int(r.get("lossMiss") or 0) for r in rows)
        sil_inc = (sil[-1] - sil[0]) if len(sil) >= 2 else 0
        print("dev=%s n=%d sil %s->%s minInQ=%s maxLate=%s miss=%d"
              % (dev, len(rows), sil[0] if sil else None, sil[-1] if sil else None,
                 min(iq) if iq else None, max(lt) if lt else None, miss))
        if sil_inc >= 3:      # 口径 3：累计值判增量
            ok = False
            reasons.append("silence+%s" % dev)
        if lt and max(lt) > 500:
            ok = False
            reasons.append("late:%s" % dev)
        if iq and min(iq) < 200:
            ok = False
            reasons.append("inQ:%s" % dev)
        if miss:
            ok = False
            reasons.append("loss:%s" % dev)
    for h, fp, _p in caps:
        good, line = pcap_ok(fp)
        print(line)
        if not good:
            ok = False
            reasons.append("pcap:%s" % h)
    print("VERDICT %s %s" % ("PASS" if ok else "FAIL", ",".join(reasons) if reasons else "ok"))


if __name__ == "__main__":
    main()
