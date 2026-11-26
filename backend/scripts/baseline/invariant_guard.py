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

拓扑分叉（--topo）
------------------
tick / ring 只有**含 AirPlay 成员**的组才有（bridgeSession 产出）。纯 sendspin
组不经过桥，等价 A 层真值是 sendspin_frame_probe.py 采到的音频帧（A_ssFrame）：
  * airplay / mixed  → 判 A_tick + A_prog + A_switch（+ A_ssFrame 若存在）
  * sendspin         → 跳过 A_tick，判 A_ssFrame + A_prog + A_switch
所有拓扑都必须有 A_switch.count >= 5（用户定稿：每次发版至少切歌 5 次）。
"""
import argparse
import json
import os
import sys

# 与 docs/播放基线-基准值与判读-20261126.md §4 同源；改动需同步文档 + selftest。
DEVICE_QUEUE_CAP_MS = 4163
# 2026-11-26 收紧：CI 模拟端实测 deltaUs p50≈2061ms（与真机 iEAST 2060.8ms 几乎一致），
# 原 500ms 下限允许提前量塌到 600ms 仍判绿；真机口径是 base-800ms≈1261ms，故取 1200ms。
DELTA_P50_MIN_US = 1_200_000
DELTA_P50_MAX_US = 4_000_000
DELTA_NEG_PCT_MAX = 1.0
# 真机口径 = base_p95(2725ms) + 1200ms = 3925ms。原值直接取设备容量 4163ms，宽了 238ms。
INQ_P95_MAX_MS = 3925
INQ_OVER_CAP_PCT_MAX = 5.0
REALIGN_PER_MIN_MAX = 30.0
ADVANCE_RATE_MIN = 0.98
ADVANCE_RATE_MAX = 1.02
BACKWARDS_MAX = 3

# 多拓扑切歌/帧判据。阈值理由见 docs/播放基线-基准值与判读-20261126.md §4b：
#   - 切歌确认 25s：混合组锚点 lead 5s + 预填充 10s + 两轮 /status 轮询的余量；
#   - 帧间隔 500ms：正常 25ms/帧，500ms 已经是 20 帧的静音，远超任何抖动；
#   - 单次切歌后至少 20 帧：只要求「确实恢复出声」，不苛求满窗口帧数。
SWITCH_MIN = 5
SWITCH_SETTLE_MAX_MS = 25_000
SS_FRAME_MIN = 200
SS_FRAME_GAP_MAX_MS = 500
SS_FRAME_MIN_PER_SWITCH = 20

# 补齐审计（2026-11-26）：baseline_cap 早已汇总这些 A 层字段，旧判读器完全没用。
# 阈值依据 = v4.15.8 正常 fixture 与 v4.15.9_bad 反样本之间 1~3 个数量级的
# 实测间隔，WARN 级与真机 baseline_guard.py 同源。第十轮正常 CI 样本里
# 这些字段全为 0（ring bufferedZeroPct=95.83~100），故不会误报正常版。
SILENCE_CHUNKS_MAX = 0
INSERTED_FRAMES_MAX = 0             # 正常 0；v4.15.9 2108/设备（补帧型可听缺口）
NEWGEN_SKIP_MAX = 0                 # 换代跳帧：真机守卫是 WARN 级，不能判 FAIL
LATE_PER_MIN_MAX = 30.0             # 正常 CI 0 / 真机 ~1；抓 late 暴涨型回归
LOSS_PER_MIN_MAX = 0.05             # 真机守卫 WARN 阈值；v4.15.9 lossMiss/Stale 0.82~1.02
LIVE_PCT_MIN = 99.0                 # 真机守卫 FAIL 阈值
RING_SAMPLES_MIN = 10
RING_INQ_P50_MAX_MS = DEVICE_QUEUE_CAP_MS
RING_BUDGET_P50_MIN_MS = 200        # 正常 450~475；v4.15.9 105（预算塌陷）
RING_BUFFERED_ZERO_MIN_PCT = 50.0   # 正常 95.83~100；v4.15.9 0
RING_DROP_OLD_MAX_PER_MIN = 0.1


def _num(v, default=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def judge(data, min_ticks=20, topo="airplay", expect_tick_devices=0,
          require_switch=False):
    """返回 [(level, dev, metric, detail), ...]；level 为 PASS/FAIL。"""
    out = []
    ticks = data.get("A_tick") or {}
    if topo == "sendspin":
        # 纯 sendspin 不建 RAOP 会话 ⇒ bridgeSession 不可能产出 tick。
        # 这里显式记一条 PASS，防止有人把「跳过的判据」误当成漏判。
        out.append(("PASS", "-", "A_tick.skipped",
                    "pure-sendspin: no bridge; judge by A_ssFrame"))
    else:
        # samples 是**稳态段**条数；全程样本量看 samplesTotal（有分段时用）。
        # 拿稳态条数去比 min-ticks 会把正常的长切歌测试误判成样本不足。
        total = sum(int(_num((d or {}).get("samplesTotal", (d or {}).get("samples"))))
                    for d in ticks.values())
        out.append(("PASS" if total >= min_ticks and ticks else "FAIL", "-", "A_tick.samples",
                    "ticks=%d devices=%d min=%d" % (total, len(ticks), min_ticks)))
        if expect_tick_devices > 0:
            out.append(("PASS" if len(ticks) >= expect_tick_devices else "FAIL",
                        "-", "A_tick.devices",
                        "devices=%d expect>=%d" % (len(ticks), expect_tick_devices)))

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
        # 补齐：可听缺口的另一种形态。v4.15.9 反样本 silenceChunks=0 但
        # insertedFrames=2108，只判 deltaUs 会漏掉「补帧型」缺口。
        tot = d.get("totals") or {}
        sc = _num(tot.get("silenceChunks"))
        ins = _num(tot.get("insertedFrames"))
        ng = _num(tot.get("newgenSkipFrames"))
        out.append(("PASS" if sc <= SILENCE_CHUNKS_MAX else "FAIL", dev,
                    "A_tick.silenceChunks", "%.0f max=%d" % (sc, SILENCE_CHUNKS_MAX)))
        out.append(("PASS" if ins <= INSERTED_FRAMES_MAX else "FAIL", dev,
                    "A_tick.insertedFrames", "%.0f max=%d" % (ins, INSERTED_FRAMES_MAX)))
        # 换代跳帧沿用真机守卫的 WARN 级：换代时确实会出现，判 FAIL 会误报。
        out.append(("PASS" if ng <= NEWGEN_SKIP_MAX else "WARN", dev,
                    "A_tick.newgenSkipFrames", "%.0f max=%d" % (ng, NEWGEN_SKIP_MAX)))
        late = _num(pm.get("late"))
        out.append(("PASS" if late <= LATE_PER_MIN_MAX else "FAIL", dev,
                    "A_tick.late/min", "%.3f max=%.1f" % (late, LATE_PER_MIN_MAX)))
        for k in ("lossMiss", "lossStale"):
            lv = _num(pm.get(k))
            out.append(("PASS" if lv <= LOSS_PER_MIN_MAX else "FAIL", dev,
                        "A_tick.%s/min" % k, "%.3f max=%.3f" % (lv, LOSS_PER_MIN_MAX)))
        live = _num((d.get("state") or {}).get("live"))
        out.append(("PASS" if live >= LIVE_PCT_MIN else "FAIL", dev,
                    "A_tick.live%", "%.2f min=%.1f" % (live, LIVE_PCT_MIN)))
        # 采样流完整性：CI 只有一个写入者，出现交错说明采样脚本自己重放/双开。
        # 此时 perMin/totals 虽已按 gen 断开，但样本本身不可信 —— 必须判红，
        # 否则「脏数据算成 0」会变成永久假绿。
        sh = d.get("stream")
        if sh is not None:
            out.append(("PASS" if not sh.get("interleaved") else "FAIL", dev,
                        "A_tick.stream.interleaved",
                        "genFlips=%s gens=%s" % (sh.get("genFlips"), sh.get("gens"))))
        # 切歌窗口只用「桥还在出 tick」判活性，不拿稳态水位要求它
        # （5s lead + 10s 预填充期间 inQ 必然高、realign 必然阶跃）。
        n_steady = int(_num(d.get("samplesSteady"), -1))
        if n_steady >= 0:
            out.append(("PASS" if n_steady >= 15 else "FAIL", dev,
                        "A_tick.samplesSteady", "samples=%d min=15" % n_steady))
        swin = d.get("switchWindow")
        if swin is not None:
            nsw = int(_num(swin.get("samples")))
            out.append(("PASS" if nsw >= 3 else "FAIL", dev, "A_tick.switchWindow.samples",
                        "samples=%d min=3" % nsw))

    # 补齐：A_ring 是设备侧真实水位，cap 一直在产，旧判读器完全没用。
    # 纯 sendspin 组不建 RAOP 会话 ⇒ 没有设备 ring，显式跳过防误报。
    rings = data.get("A_ring") or {}
    if topo == "sendspin":
        out.append(("PASS", "-", "A_ring.skipped",
                    "pure-sendspin: no AirPlay device ring"))
    elif not rings:
        out.append(("FAIL", "-", "A_ring.missing", "no device ring samples"))
    else:
        for dev, g in sorted(rings.items()):
            n_ring = int(_num(g.get("samples")))
            out.append(("PASS" if n_ring >= RING_SAMPLES_MIN else "FAIL", dev,
                        "A_ring.samples", "samples=%d min=%d" % (n_ring, RING_SAMPLES_MIN)))
            rq = _num((g.get("inQMs") or {}).get("p50"))
            out.append(("PASS" if rq <= RING_INQ_P50_MAX_MS else "FAIL", dev,
                        "A_ring.inQMs.p50", "%.0fms cap=%dms" % (rq, RING_INQ_P50_MAX_MS)))
            bud = _num((g.get("budgetMs") or {}).get("p50"))
            out.append(("PASS" if bud >= RING_BUDGET_P50_MIN_MS else "FAIL", dev,
                        "A_ring.budgetMs.p50", "%.0fms min=%dms" % (bud, RING_BUDGET_P50_MIN_MS)))
            bz = _num(g.get("bufferedZeroPct"))
            out.append(("PASS" if bz >= RING_BUFFERED_ZERO_MIN_PCT else "FAIL", dev,
                        "A_ring.bufferedZeroPct",
                        "%.2f%% min=%.1f%%" % (bz, RING_BUFFERED_ZERO_MIN_PCT)))
            drop = _num((g.get("perMin") or {}).get("dropOld"))
            out.append(("PASS" if drop <= RING_DROP_OLD_MAX_PER_MIN else "FAIL", dev,
                        "A_ring.dropOld/min", "%.3f max=%.3f" % (drop, RING_DROP_OLD_MAX_PER_MIN)))

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

    sw = data.get("A_switch")
    if sw is None:
        # 老样本（真机基准 / fixtures）没有切歌证据，默认不判；
        # CI 用 --require-switch 强制必须有，防止「没切歌也 PASS」的假绿。
        if require_switch:
            out.append(("FAIL", "-", "A_switch.missing",
                        "CI 必须采到切歌证据（>=%d 次）" % SWITCH_MIN))
    else:
        cnt = int(_num(sw.get("count")))
        failed = int(_num(sw.get("failed")))
        settle = _num(sw.get("maxSettleMs"), -1)
        out.append(("PASS" if cnt >= SWITCH_MIN else "FAIL", "-", "A_switch.count",
                    "count=%d min=%d" % (cnt, SWITCH_MIN)))
        out.append(("PASS" if failed == 0 else "FAIL", "-", "A_switch.failed",
                    "failed=%d" % failed))
        out.append(("PASS" if 0 <= settle <= SWITCH_SETTLE_MAX_MS else "FAIL",
                    "-", "A_switch.maxSettleMs",
                    "%.0fms max=%dms" % (settle, SWITCH_SETTLE_MAX_MS)))

    fr = data.get("A_ssFrame")
    if fr is None and topo == "sendspin":
        out.append(("FAIL", "-", "A_ssFrame.missing",
                    "纯 sendspin 组没有桥 tick，必须采音频帧"))
    elif fr is not None:
        chunks = int(_num(fr.get("chunks")))
        gap = _num(fr.get("maxGapMs"), float("inf"))
        per = fr.get("minPerSwitch")
        out.append(("PASS" if chunks >= SS_FRAME_MIN else "FAIL", "-", "A_ssFrame.chunks",
                    "chunks=%d min=%d" % (chunks, SS_FRAME_MIN)))
        out.append(("PASS" if gap <= SS_FRAME_GAP_MAX_MS else "FAIL", "-", "A_ssFrame.maxGapMs",
                    "%.0fms max=%dms" % (gap, SS_FRAME_GAP_MAX_MS)))
        out.append(("PASS" if per is not None and per >= SS_FRAME_MIN_PER_SWITCH else "FAIL",
                    "-", "A_ssFrame.minPerSwitch",
                    "%s min=%d" % (per, SS_FRAME_MIN_PER_SWITCH)))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--input", required=True, help="baseline_cap.py 产出的 JSON")
    ap.add_argument("--min-ticks", type=int, default=20)
    ap.add_argument("--topo", choices=("airplay", "mixed", "sendspin"), default="airplay",
                    help="airplay/mixed 判 tick；sendspin 跳过 tick 改判音频帧")
    ap.add_argument("--expect-tick-devices", type=int, default=0,
                    help="含 AirPlay 成员的拓扑应看到多少台 tick 设备")
    ap.add_argument("--require-switch", action="store_true",
                    help="CI 专用：必须采到 >=5 次成功切歌证据")
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

    res = judge(data, a.min_ticks, topo=a.topo,
                expect_tick_devices=a.expect_tick_devices,
                require_switch=a.require_switch)
    fails = [r for r in res if r[0] == "FAIL"]
    warns = [r for r in res if r[0] == "WARN"]
    if not a.quiet:
        print("== CI 模拟播放不变量判读 ==")
        print("  样本=%s" % os.path.basename(a.input))
        for level, dev, metric, detail in res:
            print("  %s  %-22s %-24s %s" % (level, dev[-12:], metric, detail))
    print("VERDICT %s  FAIL=%d/%d  WARN=%d" %
          ("FAIL" if fails else "PASS", len(fails), len(res), len(warns)))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
