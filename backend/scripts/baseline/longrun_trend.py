#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""长跑（nightly）分桶趋势判读。

为什么不能复用 invariant_guard.py
--------------------------------
短跑（8 分钟）判的是「稳态窗口内的分布」：p50 / p95 / negPct 都是全局统计量。
长跑要抓的是**分布随时间劣化**——前 20 分钟健康、后 10 分钟缓冲持续上涨，
全局 p95 仍可能通过，因为坏样本在总量里是少数。

所以这里不判全局分位数，而是把采样切成固定时长的桶，判：

  1. 每桶 tick 数是否衰减（采样断流 / 设备假死）
  2. 桶间 deltaUs.p50 的漂移幅度（提前量整体搬移 = 可听性变化）
  3. 末桶相对首桶的 inQueueMs.p50 抬升（缓冲持续上涨）
  4. 任一桶内出现补静音 / 补帧（4.15.9 型缺口的直接铁证，且能定位到具体时段）
  5. 任一桶内对齐器重排速率超限（局部空转会被全局均值稀释）
  6. 纯 sendspin：每桶帧数相对首桶的衰减
  7. 容器 RSS / FD 增长（只 WARN —— 没有长跑基线前不设 FAIL）

时间口径
--------
优先用 tick 的 `_wall`（epoch ms，采样器写入），缺失时退回 `_t`（HH:MM:SS）。
两者都缺的行直接丢弃并计数，不参与分桶。

输出格式与 invariant_guard.py 一致：
    PASS|FAIL|WARN - <判据名> - <说明>
    VERDICT PASS|FAIL
退出码：0 = 通过（含仅 WARN），1 = 存在 FAIL，2 = 输入不足无法判读。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys

# ---------------------------------------------------------------------------
# 阈值（selftest.py 第 16 节按字面量钉死，改动必须同步断言）
# ---------------------------------------------------------------------------

BUCKET_SEC = 300                  # 分桶宽度：5 分钟
MIN_BUCKETS = 3                   # 少于 3 桶无法看趋势
TICK_PER_BUCKET_RATIO = 0.6       # 每桶 tick 数 ≥ 0.6 × 各桶中位数
DELTA_P50_DRIFT_MAX_US = 400_000  # 桶间 deltaUs.p50 极差 ≤ 400ms
INQ_P50_RISE_MAX_MS = 800         # 末桶 − 首桶 inQueueMs.p50 ≤ 800ms
REALIGN_PER_MIN_MAX = 30          # 与 invariant_guard / 真机守卫同阈值
SS_FRAME_PER_BUCKET_RATIO = 0.6   # 每桶 sendspin 帧数 ≥ 0.6 × 首桶
RSS_GROWTH_MAX_PCT = 100          # RSS 增长 > 100% → WARN
FD_GROWTH_MAX = 200               # FD 增长 > 200 → WARN

_TS_RE = re.compile(r"^(\d\d):(\d\d):(\d\d)$")


def say(msg: str) -> None:
    print(msg, flush=True)


def _num(v, dflt=0.0) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return dflt
    return f


def _pct(values, q):
    """分位数（nearest-rank，与 baseline_cap 口径一致：小样本也不插值）。"""
    if not values:
        return 0.0
    vs = sorted(values)
    if len(vs) == 1:
        return float(vs[0])
    idx = int(round((len(vs) - 1) * q))
    return float(vs[max(0, min(idx, len(vs) - 1))])


def sec_of(rec: dict):
    """tick 的时间戳 → 秒。先 _wall，后 _t。"""
    w = rec.get("_wall")
    if isinstance(w, (int, float)) and w > 0:
        return float(w) / 1000.0
    m = _TS_RE.match(str(rec.get("_t") or ""))
    if m:
        return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + int(m.group(3))
    return None


def load_ticks(path: str):
    """读 base.jsonl 的 tick 行 → [(t, rec)]，按时间排序；返回 (rows, dropped)。"""
    rows, dropped = [], 0
    if not path or not os.path.exists(path):
        return rows, dropped
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line or '"tick"' not in line:
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            if obj.get("type") != "tick":
                continue
            rec = obj.get("data") or {}
            t = sec_of(rec)
            if t is None:
                dropped += 1
                continue
            rows.append((t, rec))
    rows.sort(key=lambda x: x[0])
    return rows, dropped


def load_ss_frames(path: str):
    """读 sendspin_frames.jsonl → [t_sec]。"""
    out = []
    if not path or not os.path.exists(path):
        return out
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            t = _num(obj.get("t"), -1)
            if t > 0:
                out.append(t / 1000.0)
    out.sort()
    return out


def load_resource(path: str):
    out = []
    if not path or not os.path.exists(path):
        return out
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            out.append(obj)
    return out


def bucketize(rows, t0, width):
    """把 (t, rec) 按 floor((t-t0)/width) 分桶。返回 {bucket_idx: [rec]}。"""
    out = {}
    for t, rec in rows:
        idx = int((t - t0) // width)
        if idx < 0:
            idx = 0
        out.setdefault(idx, []).append((t, rec))
    return out


class Checker:
    def __init__(self):
        self.rows = []
        self.fails = 0
        self.warns = 0

    def add(self, level, name, msg):
        if level == "FAIL":
            self.fails += 1
        elif level == "WARN":
            self.warns += 1
        self.rows.append((level, name, msg))
        say("%-4s - %s - %s" % (level, name, msg))

    def verdict(self):
        v = "FAIL" if self.fails else "PASS"
        say("VERDICT %s FAIL=%d WARN=%d" % (v, self.fails, self.warns))
        return 0 if self.fails == 0 else 1


def judge_device(ck: Checker, dev: str, buckets: dict, width: float, expect_per_min: float):
    """单设备的分桶趋势判据。"""
    if not buckets:
        ck.add("FAIL", "A_longrun.%s.buckets" % dev, "no tick rows")
        return
    idxs = sorted(buckets)
    counts = [len(buckets[i]) for i in idxs]
    if len(idxs) < MIN_BUCKETS:
        # 桶太少时斜率全由噪声决定，宁可判入力不足也不给假绿。
        ck.add("FAIL", "A_longrun.%s.buckets" % dev,
               "buckets=%d < %d (sampling too short for trend)" % (len(idxs), MIN_BUCKETS))
        return
    med = _pct(counts, 0.5)
    floor_n = max(1, int(med * TICK_PER_BUCKET_RATIO))

    # ① 每桶 tick 数不衰减（采样断流 / 设备假死会被抓在这）
    thin = [(i, c) for i, c in zip(idxs, counts) if c < floor_n]
    if thin:
        ck.add("FAIL", "A_longrun.%s.tickPerBucket" % dev,
               "thin buckets=%s (bucket,ticks) min=%d median=%.0f"
               % (thin[:4], floor_n, med))
    else:
        ck.add("PASS", "A_longrun.%s.tickPerBucket" % dev,
               "buckets=%d min=%d median=%.0f" % (len(idxs), min(counts), med))

    # ② 桶间 deltaUs.p50 漂移
    p50s = []
    inqs = []
    for i in idxs:
        recs = [r for _, r in buckets[i]]
        p50s.append(_pct([_num(r.get("deltaUs")) for r in recs], 0.5))
        inqs.append(_pct([_num(r.get("inQueueMs")) for r in recs], 0.5))
    drift = max(p50s) - min(p50s)
    ck.add("PASS" if drift <= DELTA_P50_DRIFT_MAX_US else "FAIL",
           "A_longrun.%s.deltaP50Drift" % dev,
           "drift=%.0fus max=%.0f min=%.0f limit=%dus"
           % (drift, max(p50s), min(p50s), DELTA_P50_DRIFT_MAX_US))

    # ③ 缓冲净抬升（首桶 → 末桶）
    rise = inqs[-1] - inqs[0]
    ck.add("PASS" if rise <= INQ_P50_RISE_MAX_MS else "FAIL",
           "A_longrun.%s.inqRise" % dev,
           "first=%.0fms last=%.0fms rise=%.0fms limit=%dms"
           % (inqs[0], inqs[-1], rise, INQ_P50_RISE_MAX_MS))

    # ④⑤ 桶内累计量增量：补静音 / 补帧 / 对齐器重排。
    #   这些计数器按 gen 重置（gen 变化处 delta 不是增量），故按 gen 断开。
    #   prev 跨桶保留：若某次缺口正好起始在桶边界上，用「桶内首条当基线」
    #   会把它算成 0 漏掉；保留上一桶末值才能把跳变归到它发生的那一桶。
    bad_sil, bad_ins, hot_realign = [], [], []
    prev = {}
    for i in idxs:
        recs = sorted(buckets[i], key=lambda x: x[0])
        sil = ins = real = 0.0
        for _, r in recs:
            g = r.get("gen")
            if g != prev.get("gen"):
                prev = {"gen": g}
                for k in ("silenceChunks", "insertedFrames", "realigned"):
                    prev[k] = _num(r.get(k))
                continue
            for k in ("silenceChunks", "insertedFrames"):
                v = _num(r.get(k), prev.get(k, 0))
                if v >= prev.get(k, 0):
                    if k == "silenceChunks":
                        sil += v - prev[k]
                    else:
                        ins += v - prev[k]
                prev[k] = v
            v = _num(r.get("realigned"), prev.get("realigned", 0))
            if v >= prev.get("realigned", 0):
                real += v - prev["realigned"]
            prev["realigned"] = v
        if sil > 0:
            bad_sil.append((i, int(sil)))
        if ins > 0:
            bad_ins.append((i, int(ins)))
        span_min = max(1.0, len(recs) / max(1.0, expect_per_min))
        if real / span_min > REALIGN_PER_MIN_MAX:
            hot_realign.append((i, round(real / span_min, 1)))

    ck.add("PASS" if not bad_sil else "FAIL", "A_longrun.%s.silenceInBucket" % dev,
           "clean" if not bad_sil else "buckets with silenceChunks: %s" % bad_sil[:4])
    ck.add("PASS" if not bad_ins else "FAIL", "A_longrun.%s.insertedInBucket" % dev,
           "clean" if not bad_ins else "buckets with insertedFrames: %s" % bad_ins[:4])
    ck.add("PASS" if not hot_realign else "FAIL", "A_longrun.%s.realignPerBucket" % dev,
           "clean" if not hot_realign else "buckets over %d/min: %s"
           % (REALIGN_PER_MIN_MAX, hot_realign[:4]))


def judge_ss(ck: Checker, frames, t0, width):
    if not frames:
        ck.add("FAIL", "A_longrun.ssFrame.buckets", "no sendspin frames")
        return
    counts = {}
    for t in frames:
        idx = int(max(0, t - t0) // width)
        counts[idx] = counts.get(idx, 0) + 1
    idxs = sorted(counts)
    if len(idxs) < MIN_BUCKETS:
        ck.add("FAIL", "A_longrun.ssFrame.buckets",
               "buckets=%d < %d" % (len(idxs), MIN_BUCKETS))
        return
    first = counts[idxs[0]]
    floor_n = max(1, int(first * SS_FRAME_PER_BUCKET_RATIO))
    thin = [(i, counts[i]) for i in idxs if counts[i] < floor_n]
    ck.add("PASS" if not thin else "FAIL", "A_longrun.ssFrame.tickPerBucket",
           "buckets=%s first=%d floor=%d %s"
           % ([counts[i] for i in idxs], first, floor_n,
              "ok" if not thin else "thin=%s" % thin[:4]))


def judge_resource(ck: Checker, res):
    if len(res) < 3:
        ck.add("WARN", "A_longrun.resource", "samples=%d (need >=3)" % len(res))
        return
    rss = [_num(r.get("rssKb")) for r in res if _num(r.get("rssKb")) > 0]
    fds = [_num(r.get("fd")) for r in res if _num(r.get("fd")) > 0]
    if rss:
        growth = (rss[-1] - rss[0]) / max(1.0, rss[0]) * 100.0
        ck.add("PASS" if growth <= RSS_GROWTH_MAX_PCT else "WARN",
               "A_longrun.resource.rss",
               "first=%.0fMB last=%.0fMB growth=%.1f%% limit=%d%%"
               % (rss[0] / 1024, rss[-1] / 1024, growth, RSS_GROWTH_MAX_PCT))
    else:
        ck.add("WARN", "A_longrun.resource.rss", "no rssKb samples")
    if fds:
        fd_growth = fds[-1] - fds[0]
        ck.add("PASS" if fd_growth <= FD_GROWTH_MAX else "WARN",
               "A_longrun.resource.fd",
               "first=%.0f last=%.0f growth=%.0f limit=%d"
               % (fds[0], fds[-1], fd_growth, FD_GROWTH_MAX))
    else:
        ck.add("WARN", "A_longrun.resource.fd", "no fd samples")


def main(argv=None):
    ap = argparse.ArgumentParser(description="长跑分桶趋势判读")
    ap.add_argument("--input", required=True, help="base.jsonl")
    ap.add_argument("--ss-input", default="", help="sendspin_frames.jsonl（纯 sendspin 必填）")
    ap.add_argument("--resource", default="", help="resource.jsonl（容器 mem/fd）")
    ap.add_argument("--bucket", type=int, default=BUCKET_SEC, help="分桶宽度（秒）")
    ap.add_argument("--topo", choices=("airplay", "mixed", "sendspin"), default="mixed")
    ap.add_argument("--expect-per-min", type=float, default=30.0,
                    help="单设备预期 tick/min（用于桶内 tick 下限诊断）")
    args = ap.parse_args(argv)

    rows, dropped = load_ticks(args.input)
    ss = load_ss_frames(args.ss_input)
    res = load_resource(args.resource)

    ck = Checker()
    say("INPUT ticks=%d dropped=%d ssFrames=%d resource=%d bucket=%ds topo=%s"
        % (len(rows), dropped, len(ss), len(res), args.bucket, args.topo))

    # 时间原点：tick 与帧统一取最早时间，保证桶号可比。
    stamps = [t for t, _ in rows] + list(ss)
    if not stamps:
        ck.add("FAIL", "A_longrun.input", "no timestamped sample at all")
        return ck.verdict()
    t0 = min(stamps)

    if args.topo == "sendspin":
        judge_ss(ck, ss, t0, args.bucket)
        ck.add("PASS", "A_longrun.tick.skipped",
               "pure-sendspin: no bridge tick by design")
    else:
        by_dev = {}
        for t, rec in rows:
            by_dev.setdefault(str(rec.get("dev") or "unknown"), []).append((t, rec))
        if not by_dev:
            ck.add("FAIL", "A_longrun.devices", "no tick device found")
        for dev, rs in sorted(by_dev.items()):
            judge_device(ck, dev, bucketize(rs, t0, args.bucket), args.bucket,
                         args.expect_per_min)
        if args.topo == "mixed" and ss:
            judge_ss(ck, ss, t0, args.bucket)

    judge_resource(ck, res)
    return ck.verdict()


if __name__ == "__main__":
    sys.exit(main())
