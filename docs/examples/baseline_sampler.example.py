#!/usr/bin/env python3
# =============================================================================
# 播放链路基线采样器（脱敏示例，配套《播放链路排障与采样手册》附录 C）
# -----------------------------------------------------------------------------
# ⚠️ 这是**示例**：凭据、组 ID、设备 ID 均从环境变量读取，仓库内不含任何真实值。
#    切勿把真实凭据写进本文件或提交到仓库。
#
# 采集面：
#   服务端  tick（每 250ms 全字段） / anchor（锚点命令） / bridge-servo（投递诊断）
#   设备侧  ring-diag（设备真实水位 inQMs / 预算 / 已推块数 / 丢弃）
#   媒体    group 与若干 AirPlay 设备的 state / position / duration / volume / media
#   事件    换代 / 游标跳转 / start-seek / newgen-skip / backlog-reset / timing-rate / ack
# 输出：<OUTDIR>/base_raw.log（原始行） base.jsonl（结构化） base_evt.log（事件+心跳）
#
# 运行方式（在容器所在主机上）：
#   export MF_USER='<你的用户名>' MF_PASS='<你的密码>'
#   export MF_GROUP_ID='<你的组 UUID>' MF_DEVICES='<设备ID1>,<设备ID2>'
#   export MF_OUTDIR='/your/log/dir' MF_CONTAINER='musicflow'
#   python3 baseline_sampler.example.py
#
# 时间口径：docker logs -t 的前缀由 Docker daemon 打成 UTC(Z)，与容器时区无关；
#           本脚本在写盘前把它转成 CST(+08:00)，详见手册 C-4c。
# =============================================================================
import base64
import datetime
import hashlib
import json
import os
import re
import subprocess
import time
import urllib.parse
import urllib.request

# ---- 环境配置（无真实值）----------------------------------------------------
BASE_URL  = os.environ.get("MF_BASE_URL", "http://127.0.0.1:46400")
USER      = os.environ.get("MF_USER", "<your-user>")
PASS      = os.environ.get("MF_PASS", "<your-password>")
GID       = os.environ.get("MF_GROUP_ID", "<group-uuid>")
DEVS      = [d.strip() for d in os.environ.get("MF_DEVICES", "").split(",") if d.strip()]
OUTDIR    = os.environ.get("MF_OUTDIR", "/tmp/mf_watch")
CONTAINER = os.environ.get("MF_CONTAINER", "musicflow")
AUTH      = base64.b64encode(("%s:%s" % (USER, PASS)).encode()).decode()

RAW   = os.path.join(OUTDIR, "base_raw.log")
JSONL = os.path.join(OUTDIR, "base.jsonl")
EVT   = os.path.join(OUTDIR, "base_evt.log")

PAT = (r'"ev":"tick"|"ev":"anchor"|ring-diag|bridge-generation|bridge-cursor-jump|'
       r'bridge-start-seek|newgen-skip|backlog-reset|timing-rate|bridge-servo|bridge-ack|'
       r'clearPlayback|bridge-sched|PlayerController\]\[report|anchor-content')

# docker logs -t 行首 UTC 时间戳：2026-11-25T09:03:58.263222216Z
ISO_HEAD = re.compile(r"^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?Z")
TZ_MARK = '=== TZ CHANGE: ISO prefix is CST +08:00 from this line (was UTC Z) ==='
CST = datetime.timezone(datetime.timedelta(hours=8))

seen = set()
seen_order = []


def to_cst(line):
    """行首 UTC(Z) -> CST(+08:00)，保留小数秒。
    只改日志行首前缀；JSON 内的 tsUs/anchorUs 是内容时间线，绝不改动。"""
    m = ISO_HEAD.match(line)
    if not m:
        return line
    dt = datetime.datetime.strptime(m.group(1), "%Y-%m-%dT%H:%M:%S").replace(
        tzinfo=datetime.timezone.utc)
    cst = dt.astimezone(CST).strftime("%Y-%m-%dT%H:%M:%S")
    return cst + (m.group(2) or "") + "+08:00" + line[m.end():]


def sh(cmd):
    try:
        return subprocess.run(cmd, shell=True, capture_output=True, text=True,
                              timeout=30).stdout
    except Exception:
        return ""


def api(path):
    try:
        req = urllib.request.Request(BASE_URL + "/rest/api/v1" + path,
                                     headers={"Authorization": "Basic " + AUTH})
        with urllib.request.urlopen(req, timeout=6) as r:
            return json.loads(r.read().decode() or "{}")
    except Exception:
        return None


def slim_media(m):
    if not isinstance(m, dict):
        return m
    out = {}
    for k in ("title", "artist", "album", "uri", "id", "durationMs", "duration",
              "songId", "name"):
        if k in m:
            out[k] = m[k]
    return out or {"_keys": sorted(m.keys())[:12]}


def media_sample():
    rec = {"type": "media", "t": datetime.datetime.now().strftime("%H:%M:%S"),
           "group": None, "devs": {}}
    if GID != "<group-uuid>":
        g = api("/peers/%s/status" % urllib.parse.quote("group:" + GID, safe=":%"))
        if g:
            rec["group"] = {
                "state": g.get("state"), "position": g.get("position"),
                "duration": g.get("duration"), "volume": g.get("volume"),
                "speed": g.get("speed"), "qrev": g.get("queueRevision"),
                "media": slim_media(g.get("media")),
            }
    for d in DEVS:
        s = api("/peers/%s/status" % urllib.parse.quote("airplay:" + d, safe=":%"))
        if s:
            rec["devs"][d[-6:]] = {
                "state": s.get("state"), "position": s.get("position"),
                "duration": s.get("duration"), "volume": s.get("volume"),
                "qrev": s.get("queueRevision"),
                "uri": (s.get("trackUri") or "")[-40:],
            }
    return rec


def ring_fields(line):
    out = {}
    for k in ("n", "buffered", "bufferedMs", "inQMs", "budgetMs", "pushed", "dropOld"):
        m = re.search(k + r"=(\d+)", line)
        if m:
            out[k] = int(m.group(1))
    m = re.search(r"pull#(\d+)", line)
    if m:
        out["pull"] = int(m.group(1))
    m = re.search(r"dev=([0-9A-Fa-f]+)", line)
    if m:
        out["dev"] = m.group(1)
    m = re.search(r"prefilled=(\w+)", line)
    if m:
        out["prefilled"] = m.group(1)
    return out


os.makedirs(OUTDIR, exist_ok=True)
jf = open(JSONL, "a")
ef = open(EVT, "a")
rf = open(RAW, "a")
rf.write(TZ_MARK + "\n")
ef.write(TZ_MARK + "\n")
ef.write("=== baseline sampler (example) start %s (local CST) ===\n"
         % datetime.datetime.now())
ef.flush()

hb_last = 0.0
hb_ticks = 0
media_last = 0.0

while True:
    out = sh("docker logs -t --tail 3000 %s 2>&1 | grep -aE '%s'" % (CONTAINER, PAT))
    for line in out.splitlines():
        # 去重 hash 基于**原始行**：重启后 docker logs 仍给出 UTC 原文，
        # 若用转换后的行会因切换点前后口径不同而重复写入。
        h = hashlib.md5(line.encode("utf-8", "replace")).hexdigest()
        if h in seen:
            continue
        seen.add(h)
        seen_order.append(h)
        if len(seen_order) > 20000:
            seen.discard(seen_order.pop(0))

        line = to_cst(line)
        ts = ""
        m = re.match(r"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)", line)
        if m:
            ts = m.group(1)[11:]

        rf.write(line + "\n")

        if '"ev":"tick"' in line:
            try:
                d = json.loads(line[line.find("{"):])
                d["_t"] = ts
                jf.write(json.dumps({"type": "tick", "data": d}, ensure_ascii=False) + "\n")
            except Exception:
                pass
        elif '"ev":"anchor"' in line:
            try:
                d = json.loads(line[line.find("{"):])
                d["_t"] = ts
                jf.write(json.dumps({"type": "anchor", "data": d}, ensure_ascii=False) + "\n")
            except Exception:
                pass
        elif "PlayerController][report]" in line:
            mm = re.search(r"(PLAYING|PAUSED|IDLE|BUFFERING)\s+pos=([\d.]+)\s+dur=([\d.]+)", line)
            if mm:
                jf.write(json.dumps({"type": "prog", "t": ts, "state": mm.group(1),
                                     "pos": float(mm.group(2)), "dur": float(mm.group(3))},
                                    ensure_ascii=False) + "\n")
        elif "ring-diag" in line:
            jf.write(json.dumps({"type": "ring", "t": ts, "data": ring_fields(line)},
                                ensure_ascii=False) + "\n")
        else:
            ef.write("%s %s\n" % (ts, line[-260:]))

    nowt = time.time()
    if nowt - media_last >= 2:
        media_last = nowt
        try:
            jf.write(json.dumps(media_sample(), ensure_ascii=False) + "\n")
        except Exception as e:
            ef.write("media err: %s\n" % e)

    if '"ev":"tick"' in out:
        hb_ticks += out.count('"ev":"tick"')
    if nowt - hb_last >= 30:
        ef.write("--- alive %s newTicksInWindow=%d ---\n"
                 % (datetime.datetime.now().strftime("%H:%M:%S"), hb_ticks))
        hb_ticks = 0
        hb_last = nowt

    rf.flush()
    jf.flush()
    ef.flush()
    time.sleep(0.7)
