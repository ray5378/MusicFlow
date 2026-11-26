#!/usr/bin/env python3
# =============================================================================
# 播放链路基线采样器 v3（脱敏示例，配套《播放链路排障与采样手册》附录 C）
#                         与《播放基线-基准值与判读》§7.1
# -----------------------------------------------------------------------------
# ⚠️ 这是**示例**：用户名、口令、组 ID、设备 ID 全部从环境变量读取，
#    仓库内不含任何真实值。切勿把真实凭据写进本文件或提交到仓库。
#    240 现网实例的取值放在 /root/mf_watch/mf.env（0600），由 systemd 注入。
#
# 采集面：
#   服务端  tick（每 250ms 全字段） / anchor（锚点命令） / bridge-servo（投递诊断）
#   设备侧  ring-diag（设备真实水位 inQMs / 预算 / 已推块数 / 丢弃）
#   媒体    group + 各 available airplay + sendspin 的
#           state / position / duration / volume / speed / queueRevision / media
#           以及 bu(是否 BUFFERING) / ua(updatedAt 原值) / uaAge(采样 RTT 中点 − updatedAt)
#           / rtt(本次 /status 往返) / songId
#   事件    换代 / 游标跳转 / start-seek / newgen-skip / backlog-reset / timing-rate / ack
# 输出：<MF_OUTDIR>/base_raw.log（原始行） base.jsonl（结构化） base_evt.log（事件+心跳）
#
# ★ v3 增量说明（2026-11-26）：
#   - 卡片的位置投影 = 上报 position + (now − 采样时刻)，采样时刻取 reportedAt ?? updatedAt。
#     但 /status **不返回 reportedAt**（已核实 v4.15.8 出口字段只有 9 个），所以卡片实际
#     只用 updatedAt 外推 ⇒ uaAge 就是「卡片会额外外推多少毫秒」的真值。
#   - /status **不返回 buffering / displayPosition**：bu 由 state 推导；displayPosition 目前
#     只存在于 group 出口的 position 合并口径里，无法单独采到 ⇒ 见基准文档「已知盲区」。
#   - sendspin 的 peerId 是 psk 派生 hash，重配会变 ⇒ 不硬编码，启动时 + 每 60s 动态解析。
#   - 重启水位 .last_run_cst：重启会清空 seen 去重集合，仍用固定 --tail 会把历史行重复写进
#     jsonl 污染基准统计，故用上次退出时刻做 --since。
#   - 滚动窗口 --since now-3s：否则起点固定会让每轮扫描行数随时间线性增长。
#
# 运行方式（在容器所在主机上）：
#   export MF_USER='<你的用户名>' MF_PASS='<你的密码>'
#   export MF_GROUP_ID='<你的组 UUID>'
#   export MF_DEVICES='<AirPlay设备MAC1>,<AirPlay设备MAC2>'
#   export MF_OUTDIR='/your/log/dir' MF_CONTAINER='musicflow'
#   export MF_BASE_URL='http://127.0.0.1:46400'
#   python3 baseline_sampler.example.py
#
# 时间口径：docker logs -t 的前缀由 Docker daemon 打成 UTC(Z)，与容器时区无关；
#           本脚本在写盘前把它转成 CST(+08:00)，详见手册 C-4c。
#           ⚠ 混用口径会得出相反结论：`docker logs -t` 是 UTC，`tcpdump -r` 是本地 CST。
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
from datetime import timedelta, timezone

# ---- 环境配置（无真实值）----------------------------------------------------
BASE_URL = os.environ.get("MF_BASE_URL", "http://127.0.0.1:46400")
USER = os.environ.get("MF_USER", "<your-user>")
PASS = os.environ.get("MF_PASS", "<your-password>")
GID = os.environ.get("MF_GROUP_ID", "<group-uuid>")
# AirPlay 设备 id 是设备固件 MAC（稳定）；sendspin 不在这里配，运行时动态解析
DEVS = [d.strip() for d in os.environ.get("MF_DEVICES", "").split(",") if d.strip()]
OUTDIR = os.environ.get("MF_OUTDIR", "/tmp/mf_watch")
CONTAINER = os.environ.get("MF_CONTAINER", "musicflow")
AUTH = base64.b64encode(("%s:%s" % (USER, PASS)).encode()).decode()

RAW = os.path.join(OUTDIR, "base_raw.log")
JSONL = os.path.join(OUTDIR, "base.jsonl")
EVT = os.path.join(OUTDIR, "base_evt.log")
STAMP = os.path.join(OUTDIR, ".last_run_cst")   # 重启水位：避免 seen 集合丢失后重复写历史行

CST = timezone(timedelta(hours=8))
TZ_MARK = '=== TZ CHANGE: ISO prefix is CST +08:00 from this line (was UTC Z) ==='

PAT = (r'"ev":"tick"|"ev":"anchor"|ring-diag|bridge-generation|bridge-cursor-jump|'
       r'bridge-start-seek|newgen-skip|backlog-reset|timing-rate|bridge-servo|bridge-ack|'
       r'clearPlayback|bridge-sched|PlayerController\]\[report|anchor-content')

seen = set()
seen_order = []

ISO_HEAD = re.compile(r"^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?Z")


def to_cst(line):
    """把 docker logs -t 行首 UTC(Z) 时间转成 CST(+08:00), 保留小数秒。
    只改行首前缀; JSON 内容体内的时间戳(tsUs/anchorUs)是墙钟无关的内容时间线, 绝不动。"""
    m = ISO_HEAD.match(line)
    if not m:
        return line
    dt = datetime.datetime.strptime(m.group(1), "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
    cst = dt.astimezone(CST).strftime("%Y-%m-%dT%H:%M:%S")
    return cst + (m.group(2) or "") + "+08:00" + line[m.end():]


def sh(cmd):
    try:
        return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=30).stdout
    except Exception:
        return ""


def api(path):
    try:
        r = urllib.request.Request(BASE_URL + "/rest/api/v1" + path,
                                   headers={"Authorization": "Basic " + AUTH})
        with urllib.request.urlopen(r, timeout=6) as f:
            return json.loads(f.read().decode() or "{}")
    except Exception:
        return None


def initial_window():
    """确定 docker logs 的初始读取窗口。
    重启会清空 seen 去重集合；若仍用 --tail 3000 就会把历史行重复写进 jsonl（污染基准统计）。
    故用上次退出时刻做 --since；若停机过久（>30min）则回退 --tail 500，避免补采海量历史。"""
    try:
        with open(STAMP) as f:
            s = f.read().strip()
        dt = datetime.datetime.strptime(s, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=CST)
        age = (datetime.datetime.now(CST) - dt).total_seconds()
        if 0 < age < 1800:
            return "--since " + dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except Exception:
        pass
    return "--tail 500"


def locate_sendspin():
    """动态解析 sendspin peerId（psk 派生 hash，重配会变）。取第一个 available 的。"""
    d = api("/peers")
    if not d:
        return None
    lst = d.get("peers") or d.get("data") or (d if isinstance(d, list) else [])
    for p in lst:
        pid = p.get("peerId") or p.get("id") or ""
        if pid.startswith("sendspin:") and p.get("available"):
            return pid
    return None


def slim_media(m):
    if not isinstance(m, dict):
        return m
    out = {}
    for k in ("title", "artist", "album", "uri", "id", "durationMs", "duration",
              "songId", "name"):
        if k in m:
            out[k] = m[k]
    if not out:
        out = {"_keys": sorted(m.keys())[:12]}
    return out


def peer_sample(pid, kind):
    """采一个 peer 的 /status，并就地算出「卡片会额外外推多少」。
    uaAge 用 RTT 中点做采样时刻（与 HA 卡片 _projectStatusPosition 的三档口径一致），
    故 uaAge ≈ 卡片实际外推量；为正且大 = 位置会被多推，为负 = 上报时间在未来（时钟偏）。"""
    t0 = time.time() * 1000
    s = api("/peers/%s/status" % urllib.parse.quote(pid, safe=":%"))
    t1 = time.time() * 1000
    if not s:
        return None
    mid = (t0 + t1) / 2.0
    ua = s.get("updatedAt")
    try:
        ua_int = int(ua) if ua is not None else None
    except Exception:
        ua_int = None
    state = s.get("state")
    out = {
        "state": state,
        "position": s.get("position"),
        "duration": s.get("duration"),
        "volume": s.get("volume"),
        "speed": s.get("speed"),
        "qrev": s.get("queueRevision"),
        # v3 新增
        "bu": state == "BUFFERING",                                     # 出口不返回 buffering，由 state 推导
        "ua": ua_int,                                                   # 设备/组上报时间戳（墙钟 ms）
        "uaAge": (None if ua_int is None else round(mid - ua_int, 1)),    # ≈ 卡片外推量(ms)
        "rtt": round(t1 - t0, 1),                                       # 本次 /status 往返
    }
    # 前向兼容：若某版本出口新增了这两个字段，直接采下来（当前 v4.15.8 不存在）
    for src, dst in (("displayPosition", "dpos"), ("reportedAt", "rat")):
        if s.get(src) is not None:
            out[dst] = s[src]
    if s.get("muted") is not None:
        out["muted"] = s.get("muted")
    if kind == "airplay":
        out["uri"] = (s.get("trackUri") or "")[-40:]
    md = s.get("media")
    if isinstance(md, dict):
        out["songId"] = md.get("songId")
    return out


def media_sample(ss_id):
    # 必须和 tick/ring/prog 的 `_t` 同口径(CST)：docker logs -t 前缀被本脚本转成 CST，
    # 而 runner 本地时区通常是 UTC（GitHub Actions），混用会让 baseline_cap 的窗口
    # 把全部 tick 判成「窗口外」——表面上采到了，汇总却是 0 设备。
    rec = {"type": "media", "t": datetime.datetime.now(CST).strftime("%H:%M:%S"),
           "wall": int(time.time() * 1000),
           "group": None, "devs": {}, "ss": None}
    g = peer_sample("group:" + GID, "group")
    if g:
        # group 出口的 media 单独取一次（peer_sample 里为了省字段没带全）
        gs = api("/peers/%s/status" % urllib.parse.quote("group:" + GID, safe=":%"))
        if gs:
            g["media"] = slim_media(gs.get("media"))
        rec["group"] = g
    for d in DEVS:
        s = peer_sample("airplay:" + d, "airplay")
        if s:
            rec["devs"][d[-6:]] = s
    if ss_id:
        s = peer_sample(ss_id, "sendspin")
        if s:
            rec["ss"] = s
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


def main():
    if not os.path.isdir(OUTDIR):
        os.makedirs(OUTDIR, exist_ok=True)

    jf = open(JSONL, "a")
    ef = open(EVT, "a")
    rf = open(RAW, "a")
    rf.write(TZ_MARK + "\n")
    ef.write(TZ_MARK + "\n")
    ef.write("=== baseline sampler v3 start %s (local CST) ===\n" % datetime.datetime.now())
    ef.flush()

    ss_id = locate_sendspin()
    ef.write("--- v3 targets: airplay=%s sendspin=%s ---\n" % (DEVS, ss_id))
    ef.flush()

    hb_last = 0.0
    hb_ticks = 0
    media_last = 0.0
    ss_last = 0.0
    log_win = initial_window()
    ef.write("--- v3 log window: %s ---\n" % log_win)
    ef.flush()

    while True:
        out = sh("docker logs -t %s --tail 2000 %s 2>&1 | grep -aE '%s'"
                 % (log_win, CONTAINER, PAT))
        for line in out.splitlines():
            h = hashlib.md5(line.encode("utf-8", "replace")).hexdigest()
            if h in seen:
                continue
            seen.add(h)
            seen_order.append(h)
            if len(seen_order) > 20000:
                seen.discard(seen_order.pop(0))

            # 注意: hash 用原始 UTC 行去重(重启后 docker logs 仍返回 UTC 原文, 若用转换后的行
            # 会因 TZ_MARK 切换点前后口径不同而重复写入); 写盘与 _t 提取一律用 CST 行。
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
                    # 墙钟 ms：切歌证据 switch_log.jsonl 用 epoch ms，
                    # baseline_cap 靠它把「切歌暂态」从稳态阈值判据里剥离。
                    # _t 只有 HH:MM:SS，跨日/换曲窗口对不齐。
                    d["_wall"] = int(time.time() * 1000)
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
        # sendspin peerId 每 60s 复核一次：设备重连/重配后 hash 会变，采不到就等于盲区
        if nowt - ss_last >= 60:
            ss_last = nowt
            newid = locate_sendspin()
            if newid != ss_id:
                ef.write("--- sendspin target changed: %s -> %s ---\n" % (ss_id, newid))
                ss_id = newid

        if nowt - media_last >= 2:
            media_last = nowt
            try:
                jf.write(json.dumps(media_sample(ss_id), ensure_ascii=False) + "\n")
            except Exception as e:
                ef.write("media err: %s\n" % e)

        if '"ev":"tick"' in out:
            hb_ticks += out.count('"ev":"tick"')
        if nowt - hb_last >= 30:
            st = ""
            try:
                gg = api("/peers/%s/status" % urllib.parse.quote("group:" + GID, safe=":%"))
                if gg:
                    st = " state=%s pos=%s/%s" % (gg.get("state"), gg.get("position"),
                                                  gg.get("duration"))
            except Exception:
                pass
            ef.write("--- alive %s newTicksInWindow=%d%s ---\n"
                     % (datetime.datetime.now().strftime("%H:%M:%S"), hb_ticks, st))
            hb_ticks = 0
            hb_last = nowt

        rf.flush()
        jf.flush()
        ef.flush()

        # 滚动窗口：下一轮只读最近 3 秒（配合 seen 去重，既不重复也不漏），
        # 否则 --since 起点固定会让每轮扫描的行数随时间线性增长。
        now_cst = datetime.datetime.now(CST)
        log_win = "--since " + (now_cst - timedelta(seconds=3)).astimezone(
            timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        try:
            with open(STAMP, "w") as f:
                f.write(now_cst.strftime("%Y-%m-%dT%H:%M:%S"))
        except Exception:
            pass

        time.sleep(0.7)


if __name__ == "__main__":
    main()
