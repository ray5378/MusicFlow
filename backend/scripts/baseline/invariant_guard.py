#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CI 模拟播放体检：不依赖真机基线的绝对不变量判据。

为什么单独要这一层
------------------
baseline_guard.py 是「和真机基准比」，必须有真实设备（MAC key、真实缓冲行为），
GitHub 托管 runner 做不到。但它守的是**相对量**；CI 里由一个模拟 AirPlay
接收端跑出来的数值不能拿去和 HiVi/iEAST 的基准逐项比。

这里改判**绝对不变量**——这些量在 v4.15.8 正常态与 v4.15.9 回归态之间
相差 1~3 个数量级，且由服务端自己记账（bridgeSession 的 tick/ring-diag），
与接收端是不是真音箱无关：

  * deltaUs 必须为正、落在可听余量带内（塌陷 → 可听缺口）
  * inQueueMs 不超过设备容量 4163ms（溢出 → 纯滞后无静音记录）
  * realigned 阶跃不许在稳态段爆发
  * 进度速率 ~1.0、无回退（进度条变快/变慢/回退）

输入是 baseline_cap.py 产出的 JSON。退出码 0=PASS / 1=指标 FAIL / 2=样本或环境问题。
"""
import argparse
import json
import os
import sys

# 与 docs/播放基线-基准值与判读-20261126.md §4 同源；改动需同步文档 + selftest。
DEVICE_QUEUE_CAP_MS = 4163
DELTA_P50_MIN_US = 500_000
DELTA_P50_MAX_US = 4_000_000
DELTA_NEG_PCT_MAX = 1.0
INQ_P95_MAX_MS = DEVICE_QUEUE_CAP_MS
INQ_OVER_CAP_PCT_MAX = 5.0
REALIGN_PER_MIN_MAX = 30.0
ADVANCE_RATE_MIN = 0.98
ADVANCE_RATE_MAX = 1.02
BACKWARDS_MAX = 3


def _num(v, default=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def judge(data, min_ticks=20):
    """返回 [(level, dev, metric, detail), ...]；level 为 PASS/FAIL。"""
    out = []
    ticks = data.get("A_tick") or {}
    total = sum(int(_num((d or {}).get("samples"))) for d in ticks.values())
    out.append(("PASS" if total >= min_ticks and ticks else "FAIL", "-", "A_tick.samples",
                "ticks=%d devices=%d min=%d" % (total, len(ticks), min_ticks)))

    for dev, d in sorted(ticks.items()):
        du = d.get("deltaUs") or {}
        iq = d.get("inQueueMs") or {}
        pm = d.get("perMin") or {}
        n = int(_num(d.get("samples")))
        if n < 5:
            out.append(("FAIL", dev, "A_tick.sparse", "device samples=%d" % n))
            continue
        p50 = _num(du.get("p50"))
        neg = _num(du.get("negPct"))
        p95 = _num(iq.get("p95"))
        over = _num(iq.get("overCapPct"))
        realign = _num(pm.get("realigned"))
        out.append(("PASS" if DELTA_P50_MIN_US <= p50 <= DELTA_P50_MAX_US else "FAIL",
                    dev, "deltaUs.p50", "%.0fus band=[%d,%d]" % (p50, DELTA_P50_MIN_US, DELTA_P50_MAX_US)))
        out.append(("PASS" if neg <= DELTA_NEG_PCT_MAX else "FAIL",
                    dev, "deltaUs.negPct", "%.2f%% max=%.2f%%" % (neg, DELTA_NEG_PCT_MAX)))
        out.append(("PASS" if p95 <= INQ_P95_MAX_MS else "FAIL",
                    dev, "inQueueMs.p95", "%.0fms cap=%dms" % (p95, INQ_P95_MAX_MS)))
        out.append(("PASS" if over <= INQ_OVER_CAP_PCT_MAX else "FAIL",
                    dev, "inQueueMs.overCapPct", "%.2f%% max=%.2f%%" % (over, INQ_OVER_CAP_PCT_MAX)))
        out.append(("PASS" if realign <= REALIGN_PER_MIN_MAX else "FAIL",
                    dev, "realigned/min", "%.2f max=%.2f" % (realign, REALIGN_PER_MIN_MAX)))

    prog = data.get("A_prog") or {}
    rate = prog.get("advanceRate")
    back = _num(prog.get("backwardsCount"))
    if rate is None:
        out.append(("FAIL", "-", "A_prog.missing", "no advanceRate; 采样期没有进度可判"))
    else:
        r = _num(rate)
        out.append(("PASS" if ADVANCE_RATE_MIN <= r <= ADVANCE_RATE_MAX else "FAIL",
                    "-", "advanceRate", "%.4f band=[%.2f,%.2f]" % (r, ADVANCE_RATE_MIN, ADVANCE_RATE_MAX)))
        out.append(("PASS" if back <= BACKWARDS_MAX else "FAIL",
                    "-", "backwardsCount", "%.0f max=%d" % (back, BACKWARDS_MAX)))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--input", required=True, help="baseline_cap.py 产出的 JSON")
    ap.add_argument("--min-ticks", type=int, default=20)
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args(argv)

    if not os.path.exists(a.input):
        print("SAMPLE_MISSING %s" % a.input)
        return 2
    try:
        with open(a.input, encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        print("SAMPLE_INVALID %s: %s" % (a.input, e))
        return 2

    res = judge(data, a.min_ticks)
    fails = [r for r in res if r[0] == "FAIL"]
    if not a.quiet:
        print("== CI 模拟播放不变量判读 ==")
        print("  样本=%s" % os.path.basename(a.input))
        for level, dev, metric, detail in res:
            print("  %s  %-22s %-24s %s" % (level, dev[-12:], metric, detail))
    print("VERDICT %s  FAIL=%d/%d" % ("FAIL" if fails else "PASS", len(fails), len(res)))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
