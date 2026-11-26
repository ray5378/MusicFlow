#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""播放链路基准采集器 (baseline capture)

设计原则（2026-11-26 用户明确要求）：
  /status 出口本身存在明显缺陷 —— position 整秒量化、group 与成员口径差 2s、
  换曲窗口两组描述不同曲目、updatedAt 每次 poll 刷成 now（时间戳无信息量）。
  故 **基准只锚在内部真值上**：
    A 层（硬基准 / 可判死）：tick（桥投递 + 设备实收）+ ring（设备水位）+ prog（内部播放位置）
    B 层（出口偏差 / 只记录不判死）：media（/status 出口值）相对 A 层的偏差、uaAge、回退次数
  以后凡「改坏了」的判定只看 A 层；B 层用于追踪「用户看见的」与「实际发生的」差多少。

用法：
  python3 baseline_cap.py --window 60 --out baseline/base_v4.15.8.json
  python3 baseline_cap.py --window 0            # 0 = 全文件
  MF_WATCH_DIR 可覆盖部署根目录（默认 /root/mf_watch，即 240 现网布局）
"""
import argparse
import datetime
import hashlib
import json
import os
import subprocess
import sys
from collections import defaultdict

# 部署根目录可覆盖（默认即 240 现网布局 /root/mf_watch）。入仓版本与原脚本行为等价：
# 不设 MF_WATCH_DIR 时所有路径与硬编码时期完全一致。
ROOT = os.environ.get("MF_WATCH_DIR", "/root/mf_watch")
JSONL = os.path.join(ROOT, "base.jsonl")
# CI 多拓扑补充证据（切歌确认 + sendspin 帧级真值）。真机常驻采样不产这两份文件，
# 缺失时对应段留空，老基准 / 老守卫行为完全不变。
SWITCH_LOG = os.environ.get("MF_SWITCH_LOG", os.path.join(ROOT, "switch_log.jsonl"))
SS_FRAME_LOG = os.environ.get("MF_SS_FRAME_LOG", os.path.join(ROOT, "sendspin_frames.jsonl"))
DEFAULT_OUT_DIR = os.path.join(ROOT, "baseline")
CONTAINER = os.environ.get("MF_CONTAINER", "musicflow")      # 容器名（指纹用）
IMAGE = os.environ.get("MF_IMAGE", "ray5378/musicflow:latest")  # 镜像名（指纹用）
# 设备名义容量（AirPlay 接收端缓冲上限, ms）。手册 C-6b / 实测 inQMs 溢出判据用此值。
DEV_CAP_MS = 4163
# 切歌后「暂态」窗口 ms：混合组锚点 lead 5s + 预填充 ~10s 的覆盖。
# 窗口内的水位/阶跃不算稳态病态，但仍必须有 tick / 音频帧证明链路活着。
SWITCH_WINDOW_MS = int(os.environ.get("MF_SWITCH_WINDOW_MS", "15000"))

tick_by_dev = defaultdict(list)      # dev -> [(sec, data)]
ring_by_dev = defaultdict(list)      # dev -> [(sec, data)]
prog = []                            # [(sec, state, pos, dur)]
media = []                           # [{sec, group, devs, ss}]


def secs(t):
    """'HH:MM:SS' -> 当日秒（float）。"""
    try:
        h, m, s = t.split(":")
        return int(h) * 3600 + int(m) * 60 + float(s)
    except Exception:
        return None


def pct(vals, q):
    if not vals:
        return None
    a = sorted(vals)
    if len(a) == 1:
        return a[0]
    k = (len(a) - 1) * q
    f = int(k)
    c = min(f + 1, len(a) - 1)
    return a[f] + (a[c] - a[f]) * (k - f)


def r(v, nd=1):
    return None if v is None else round(v, nd)


def sh(cmd):
    try:
        return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=30).stdout.strip()
    except Exception:
        return ""


def code_fingerprint():
    """代码指纹：热补丁不改 APP_VERSION（/ping 会骗人），故用 dist 关键文件的 sha256。
    以后看基准 JSON 就能确认它是哪一份代码跑出来的。"""
    fp = {}
    for f in ("services/sendspin/streamEngine.js", "services/sendspin/playerCore.js",
              "services/player/QueueController.js", "services/airplay/protocolPlayer.js"):
        out = sh("docker exec %s sha256sum /app/backend/dist/%s 2>/dev/null" % (CONTAINER, f))
        if out:
            fp[f.split("/")[-1]] = out.split()[0][:16]
    img = sh("docker image inspect %s --format '{{index .RepoDigests 0}}' 2>/dev/null" % IMAGE)
    return {"dist_sha256_16": fp, "image": img or None}


def _tail_lines(path, max_bytes):
    """从文件尾部读取（最多 max_bytes）。base.jsonl 会长到 GB 级，
    全量扫描会让每 5 分钟一次的 guard 越来越慢并吃满 IO。
    max_bytes<=0 表示全文件。"""
    size = os.path.getsize(path)
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        if max_bytes and max_bytes > 0 and size > max_bytes:
            f.seek(size - max_bytes)
            f.readline()          # 丢弃 seek 落点处的半行
        for line in f:
            yield line


def load(window_min, end_at=None, max_bytes=60 * 1024 * 1024):
    last_sec = None
    rows = 0
    if window_min <= 0 or end_at:
        max_bytes = 0        # 人工回看历史区间时读全文件（频率低，不走 guard 路径）
    for line in _tail_lines(JSONL, max_bytes):
        if '"type": "media"' in line or '"type": "tick"' in line:
            try:
                d = json.loads(line)
            except Exception:
                continue
            t = d.get("t") if d.get("type") == "media" else (d.get("data") or {}).get("_t")
            s = secs(t) if t else None
            if s is not None:
                last_sec = s
    if last_sec is None:
        sys.exit("no usable timestamp in %s" % JSONL)
    if end_at:
        e = secs(end_at)
        if e is None:
            sys.exit("bad --end, want HH:MM:SS")
        last_sec = e

    win = 86400.0 if window_min <= 0 else window_min * 60.0

    def keep(t):
        s = secs(t) if t else None
        if s is None:
            return None
        age = (last_sec - s) % 86400.0
        return s if age <= win else None

    for line in _tail_lines(JSONL, max_bytes):
            if '"type": "tick"' in line:
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                dd = d.get("data") or {}
                s = keep(dd.get("_t"))
                if s is None:
                    continue
                tick_by_dev[dd.get("dev") or "?"].append((s, dd))
                rows += 1
            elif '"type": "ring"' in line:
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                dd = d.get("data") or {}
                s = keep(d.get("t"))
                if s is None:
                    continue
                ring_by_dev[dd.get("dev") or "?"].append((s, dd))
                rows += 1
            elif '"type": "prog"' in line:
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                s = keep(d.get("t"))
                if s is None:
                    continue
                prog.append((s, d.get("state"), d.get("pos"), d.get("dur")))
                rows += 1
            elif '"type": "media"' in line:
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                s = keep(d.get("t"))
                if s is None:
                    continue
                d["_sec"] = s
                media.append(d)
                rows += 1
    return rows, last_sec


def delta_of(series, field):
    """累计量增量（跨重启会回落，故只累加非负差）。"""
    tot = 0
    prev = None
    for _, d in series:
        v = d.get(field)
        if not isinstance(v, (int, float)):
            continue
        if prev is not None and v >= prev:
            tot += v - prev
        prev = v
    return tot


def _tick_metrics(series):
    """一段 tick 的原始统计（稳态段 / 切歌段共用同一套口径）。"""
    if len(series) < 10:
        return None
    series = sorted(series, key=lambda x: x[0])
    span_min = max(1e-6, (series[-1][0] - series[0][0]) / 60.0)

    def col(k):
        return [d.get(k) for _, d in series if isinstance(d.get(k), (int, float))]

    dU = col("deltaUs")
    inQ = col("inQueueMs")
    qMs = col("queueMs")
    drift = col("driftUs")
    tAge = col("timingAgeMs")
    states = defaultdict(int)
    for _, d in series:
        states[d.get("state") or "?"] += 1
    n = float(len(series))

    out = {
        "samples": len(series),
        "spanMin": r(span_min),
        "tickPerMin": r(len(series) / span_min),
        "state": {k: r(v / n * 100, 2) for k, v in states.items()},
        # deltaUs: 设备出音前沿相对锚点的提前量。负值 = 该出声的位置没声（真缺口）
        "deltaUs": {"p5": r(pct(dU, .05), 0), "p50": r(pct(dU, .5), 0),
                    "p95": r(pct(dU, .95), 0), "min": r(min(dU), 0) if dU else None,
                    "negPct": r(sum(1 for v in dU if v < 0) / len(dU) * 100, 2) if dU else None},
        "inQueueMs": {"p5": r(pct(inQ, .05), 0), "p50": r(pct(inQ, .5), 0),
                      "p95": r(pct(inQ, .95), 0), "max": r(max(inQ), 0) if inQ else None,
                      "overCapPct": r(sum(1 for v in inQ if v > DEV_CAP_MS) / len(inQ) * 100, 2) if inQ else None},
        "queueMs": {"p50": r(pct(qMs, .5), 0), "p95": r(pct(qMs, .95), 0)},
        "driftUs": {"p50": r(pct(drift, .5), 0), "p95Abs": r(pct([abs(v) for v in drift], .95), 0) if drift else None},
        "timingAgeMs": {"p50": r(pct(tAge, .5), 0), "p95": r(pct(tAge, .95), 0)},
        # 每项都是「累计计数器的增量 / 分钟」——稳态应接近 0
        "perMin": {
            "realigned": r(delta_of(series, "realigned") / span_min, 3),
            "late": r(delta_of(series, "late") / span_min, 3),
            "lossReq": r(delta_of(series, "lossReq") / span_min, 3),
            "lossResent": r(delta_of(series, "lossResent") / span_min, 3),
            "lossMiss": r(delta_of(series, "lossMiss") / span_min, 3),
            "lossStale": r(delta_of(series, "lossStale") / span_min, 3),
            "lossFuture": r(delta_of(series, "lossFuture") / span_min, 3),
            "ap2LateSkips": r(delta_of(series, "ap2LateSkips") / span_min, 3),
        },
        # 静音块 / 丢帧 / 插入帧：可听缺口的直接证据
        "totals": {
            "silenceChunks": r(delta_of(series, "silenceChunks"), 0),
            "newgenSkipFrames": r(delta_of(series, "newgenSkipFrames"), 0),
            "skippedFrames": r(delta_of(series, "skippedFrames"), 0),
            "droppedFrames": r(delta_of(series, "droppedFrames"), 0),
            "insertedFrames": r(delta_of(series, "insertedFrames"), 0),
        },
    }
    # 用户最关心的「有没有可听缺口」一票否决项
    out["audibleGapEvidence"] = bool(out["totals"]["silenceChunks"]) or bool(
        out["deltaUs"]["negPct"] and out["deltaUs"]["negPct"] > 1.0)
    return out


def analyze_tick(dev, series, switch_rows=None):
    """稳态判据 + 切歌暂态分段证据。

    ★ 为什么必须分段：v4.15.8 正常态在**切歌窗口**同样会出现
    inQueueMs 拉高、deltaUs 下降、realigned 阶跃（混合组锚点 lead 5s +
    预填充 ~10s）。把 5 次切歌的暂态混进全局 p95，正常版本也会被判红 ——
    这不是「放宽阈值」，而是把两种物理状态分开：稳态用原绝对阈值判死，
    切歌窗口只要求桥仍在出 tick（能恢复），不拿稳态水位要求它。
    """
    series = sorted(series, key=lambda x: x[0])
    if len(series) < 10:
        return None
    windows = [(int(sw["t0"]), int(sw["t0"]) + SWITCH_WINDOW_MS)
               for sw in (switch_rows or [])
               if isinstance(sw.get("t0"), (int, float))]
    steady, trans = series, []
    if windows:
        def in_window(item):
            w = (item[1] or {}).get("_wall") if isinstance(item[1], dict) else None
            return isinstance(w, (int, float)) and any(a <= w <= b for a, b in windows)
        steady = [x for x in series if not in_window(x)]
        trans = [x for x in series if in_window(x)]
    out = _tick_metrics(steady)
    if out is None:
        return None
    out["samplesTotal"] = len(series)
    out["samplesSteady"] = len(steady)
    if trans:
        tm = _tick_metrics(trans)
        if tm:
            out["switchWindow"] = tm
    return out


def analyze_ring(dev, series):
    if len(series) < 5:
        return None
    series = sorted(series, key=lambda x: x[0])
    span_min = max(1e-6, (series[-1][0] - series[0][0]) / 60.0)
    inQ = [d.get("inQMs") for _, d in series if isinstance(d.get("inQMs"), (int, float))]
    bud = [d.get("budgetMs") for _, d in series if isinstance(d.get("budgetMs"), (int, float))]
    buffered = [d.get("buffered") for _, d in series if isinstance(d.get("buffered"), (int, float))]
    return {
        "samples": len(series),
        "inQMs": {"p5": r(pct(inQ, .05), 0), "p50": r(pct(inQ, .5), 0),
                  "min": r(min(inQ), 0) if inQ else None},
        "budgetMs": {"p50": r(pct(bud, .5), 0), "p95": r(pct(bud, .95), 0)},
        "bufferedZeroPct": r(sum(1 for v in buffered if v == 0) / len(buffered) * 100, 2) if buffered else None,
        "perMin": {"dropOld": r(delta_of(series, "dropOld") / span_min, 3)},
    }


def analyze_prog():
    """内部播放位置真值：曲中推进速率 / 回退事件。"""
    if len(prog) < 10:
        return None
    ps = sorted(prog, key=lambda x: x[0])
    sp = 0.0
    sd = 0.0
    backwards = []
    states = defaultdict(int)
    for s, st, p, du in ps:
        states[st or "?"] += 1
    for i in range(1, len(ps)):
        s0, st0, p0, d0 = ps[i - 1]
        s1, st1, p1, d1 = ps[i]
        if None in (p0, p1, d0, d1):
            continue
        dt = s1 - s0
        if dt <= 0 or dt > 15:
            continue
        same = abs(d1 - d0) < 0.5 and d1 > 1
        dp = p1 - p0
        if same and st0 == "PLAYING" and st1 == "PLAYING":
            if -0.3 <= dp <= dt * 4 + 1:      # 排除 seek / 换曲
                sp += dp
                sd += dt
            if dp < -0.5:
                backwards.append({"t": ps[i][0], "dpos": r(dp, 2),
                                  "pos": r(p1, 2), "dur": r(d1, 1)})
    return {
        "samples": len(ps),
        "state": {k: r(v / len(ps) * 100, 2) for k, v in states.items()},
        "advanceRate": r(sp / sd, 4) if sd > 0 else None,
        "curvedSamples": r(sd, 0),
        "backwardsCount": len(backwards),
        "backwardsSamples": backwards[-10:],
    }


def _load_aux(path):
    """读补充证据 jsonl。缺文件 / 坏行一律跳过：老采样目录没有这些文件。"""
    rows = []
    if not path or not os.path.exists(path):
        return rows
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except Exception:
                continue
    return rows


def analyze_switch(rows, window_min):
    """切歌证据：CI 每次 POST next 后轮询 /status 确认 songId 真的换了才落一行。

    只数 API 调用次数没有意义 —— 队列空 / 切歌没生效时调用照样返回 200。
    这里同时记 settleMs（从按 next 到 songId 变化），超长说明切歌卡住。
    """
    if not rows:
        return None
    rows = sorted(rows, key=lambda x: x.get("at", 0))
    if window_min > 0 and rows:
        end = max(r.get("at", 0) for r in rows)
        cut = end - window_min * 60 * 1000
        rows = [r for r in rows if r.get("at", 0) >= cut]
    if not rows:
        return None
    settles = [r.get("settleMs") for r in rows
               if isinstance(r.get("settleMs"), (int, float))]
    per_sw = [r.get("framesAfter", 0) - r.get("framesBefore", 0) for r in rows
              if isinstance(r.get("framesAfter"), (int, float))
              and isinstance(r.get("framesBefore"), (int, float))]
    return {
        "count": len(rows),
        "changed": sum(1 for r in rows if r.get("changed") is True),
        "failed": sum(1 for r in rows if r.get("changed") is not True),
        "maxSettleMs": r(max(settles), 0) if settles else None,
        "minFramesPerSwitch": min(per_sw) if per_sw else None,
        "switches": rows[-12:],
    }


def analyze_ss_frames(rows, switch_rows):
    """sendspin 音频帧真值。纯 sendspin 组没有桥 tick，这一层替代 A_tick。

    和 tick 一样按切歌窗口分段：切歌等待期的帧间隔不参与 maxGapMs 判据，
    但仍要求每个切歌窗口确实收到帧（perSwitch），否则就是「切完没声」。
    """
    if not rows:
        return None
    rows = sorted(rows, key=lambda x: x.get("t", 0))
    ts = [int(r["t"]) for r in rows if isinstance(r.get("t"), (int, float))]
    windows = [(int(sw["t0"]), int(sw["t0"]) + SWITCH_WINDOW_MS)
               for sw in (switch_rows or [])
               if isinstance(sw.get("t0"), (int, float))]

    def in_window(t):
        return any(a <= t <= b for a, b in windows)

    if len(ts) < 2:
        return {"chunks": len(rows), "maxGapMs": None, "minPerSwitch": None}
    # 只比较同一相位内的相邻帧：跨切歌边界的大间隔是设计好的等待，不是静音缺口。
    gaps = [b - a for a, b in zip(ts, ts[1:])
            if b >= a and not in_window(a) and not in_window(b)]
    per_sw = []
    for sw in switch_rows or []:
        a, b = sw.get("t0"), sw.get("t1")
        if isinstance(a, (int, float)) and isinstance(b, (int, float)):
            per_sw.append(sum(1 for t in ts if a <= t <= b))
    span_min = max(1e-6, (ts[-1] - ts[0]) / 60000.0)
    return {
        "chunks": len(rows),
        "steadyChunks": sum(1 for t in ts if not in_window(t)),
        "switchWindowChunks": sum(1 for t in ts if in_window(t)),
        "bytes": sum(int(r.get("bytes") or 0) for r in rows),
        "spanMin": r(span_min, 2),
        "chunksPerMin": r(len(rows) / span_min, 1),
        "maxGapMs": max(gaps) if gaps else None,
        "gapOver500Count": sum(1 for g in gaps if g > 500),
        "minPerSwitch": min(per_sw) if per_sw else None,
        "perSwitch": per_sw,
    }


def analyze_media():
    """B 层：出口偏差。只记录，不参与健康判定。"""
    if len(media) < 10:
        return None
    ua_age = []
    diffs_g_ap = []
    diffs_g_ss = []
    buf_pct = 0
    media_null = 0
    back = 0
    prev = {}
    for m in sorted(media, key=lambda x: x["_sec"]):
        g = m.get("group") or {}
        if g.get("uaAge") is not None:
            ua_age.append(g["uaAge"])
        if g.get("bu"):
            buf_pct += 1
        if g and g.get("media") is None:
            media_null += 1
        devs = m.get("devs") or {}
        if g.get("position") is not None and devs:
            for k, v in devs.items():
                if v.get("position") is not None:
                    diffs_g_ap.append(g["position"] - v["position"])
                    # 曲中回退（同曲、位置下降）
                    pk = "ap:" + k
                    pv = prev.get(pk)
                    if pv is not None and pv[1] == v.get("duration") and v["position"] < pv[0]:
                        back += 1
                    prev[pk] = (v["position"], v.get("duration"))
        ss = m.get("ss") or {}
        if g.get("position") is not None and ss.get("position") is not None:
            diffs_g_ss.append(g["position"] - ss["position"])
    n = float(len(media))
    return {
        "samples": len(media),
        "note": "本段全部是 /status 出口缺陷的量化，不是健康判据",
        "uaAgeMs": {"p50": r(pct(ua_age, .5), 1), "p95": r(pct(ua_age, .95), 1),
                    "min": r(min(ua_age), 1) if ua_age else None,
                    "max": r(max(ua_age), 1) if ua_age else None,
                    "gt1000Pct": r(sum(1 for v in ua_age if v > 1000) / len(ua_age) * 100, 2) if ua_age else None},
        "groupMinusAirplaySec": {"p5": r(pct(diffs_g_ap, .05), 2), "p50": r(pct(diffs_g_ap, .5), 2),
                                 "p95": r(pct(diffs_g_ap, .95), 2),
                                 "zeroPct": r(sum(1 for v in diffs_g_ap if abs(v) < 0.5) / len(diffs_g_ap) * 100, 2) if diffs_g_ap else None},
        "groupMinusSendspinSec": {"p50": r(pct(diffs_g_ss, .5), 2)} if diffs_g_ss else None,
        "bufferingPct": r(buf_pct / n * 100, 2),
        "groupMediaNullPct": r(media_null / n * 100, 2),
        "positionBackwards": back,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--window", type=float, default=60, help="回看分钟数；0=全文件")
    ap.add_argument("--end", default=None, help="窗口末尾时刻 HH:MM:SS（默认取文件最后一条）；用于回看历史区间做对照样本")
    ap.add_argument("--out", default=None)
    ap.add_argument("--label", default="", help="基准标签，如 v4.15.8 / v4.15.9-cand")
    a = ap.parse_args()

    rows, last_sec = load(a.window, a.end)
    switch_rows = _load_aux(SWITCH_LOG)
    frame_rows = _load_aux(SS_FRAME_LOG)
    now = datetime.datetime.now()
    doc = {
        "meta": {
            "label": a.label or "unnamed",
            "capturedAt": now.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "windowMin": a.window,
            "windowEnd": a.end or "file-tail",
            "rowsParsed": rows,
            "source": JSONL,
            "sampler": "base_sampler v3",
            "codeFingerprint": code_fingerprint(),
            "devCapMsAssumed": DEV_CAP_MS,
            "principle": "A层(tick/ring/prog)=判定; B层(status/media)=仅记录出口偏差",
        },
        "A_tick": {}, "A_ring": {}, "A_prog": None,
        "A_switch": None, "A_ssFrame": None, "B_status": None,
    }
    for dev, series in sorted(tick_by_dev.items()):
        res = analyze_tick(dev, series, switch_rows)
        if res:
            doc["A_tick"][dev] = res
    for dev, series in sorted(ring_by_dev.items()):
        res = analyze_ring(dev, series)
        if res:
            doc["A_ring"][dev] = res
    doc["A_prog"] = analyze_prog()
    doc["A_switch"] = analyze_switch(switch_rows, a.window)
    doc["A_ssFrame"] = analyze_ss_frames(frame_rows, switch_rows)
    doc["B_status"] = analyze_media()

    out = a.out or os.path.join(DEFAULT_OUT_DIR, "base_%s.json" % now.strftime("%Y%m%d_%H%M"))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)

    # 终端摘要
    print("== A层 tick（判定口径）==")
    for dev, t in doc["A_tick"].items():
        print("  %s n=%d span=%smin live=%s%%" % (dev, t["samples"], t["spanMin"],
                                                  t["state"].get("live")))
        print("    deltaUs  p5=%s p50=%s min=%s  neg=%s%%" %
              (t["deltaUs"]["p5"], t["deltaUs"]["p50"], t["deltaUs"]["min"], t["deltaUs"]["negPct"]))
        print("    inQueueMs p50=%s p95=%s max=%s overCap=%s%%" %
              (t["inQueueMs"]["p50"], t["inQueueMs"]["p95"], t["inQueueMs"]["max"],
               t["inQueueMs"]["overCapPct"]))
        print("    /min realign=%s late=%s lossMiss=%s lossStale=%s | silenceChunks=%s" %
              (t["perMin"]["realigned"], t["perMin"]["late"], t["perMin"]["lossMiss"],
               t["perMin"]["lossStale"], t["totals"]["silenceChunks"]))
        print("    可听缺口证据: %s" % ("YES" if t["audibleGapEvidence"] else "no"))
    print("== A层 prog ==")
    pp = doc["A_prog"]
    if pp:
        print("  推进速率=%s 曲中样本=%s 回退=%d" %
              (pp["advanceRate"], pp["curvedSamples"], pp["backwardsCount"]))
    sw = doc["A_switch"]
    if sw:
        print("== A层 切歌 ==")
        print("  次数=%d 成功=%d 失败=%d 最长确认=%sms" %
              (sw["count"], sw["changed"], sw["failed"], sw["maxSettleMs"]))
    fr = doc["A_ssFrame"]
    if fr:
        print("== A层 sendspin 音频帧 ==")
        print("  帧数=%s 最大间隔=%sms 超500ms次数=%s 每次切歌最少帧=%s" %
              (fr["chunks"], fr["maxGapMs"], fr["gapOver500Count"], fr["minPerSwitch"]))
    print("== B层 status（仅供参考）==")
    bs = doc["B_status"]
    if bs:
        print("  uaAge p50=%s p95=%s | group-airplay p50=%s zero=%s%% | buffering=%s%% | mediaNull=%s%%" %
              (bs["uaAgeMs"]["p50"], bs["uaAgeMs"]["p95"], bs["groupMinusAirplaySec"]["p50"],
               bs["groupMinusAirplaySec"]["zeroPct"], bs["bufferingPct"], bs["groupMediaNullPct"]))
    print("\n写入: %s" % out)


if __name__ == "__main__":
    main()
