#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""播放链路基准回归守卫 (baseline guard)

只判 A 层（播放分析状态：tick / ring / prog）——这是能真正判死「有没有缺口、有没有漂移、
有没有断粮」的物理量。/status 出口不参与判定（它自身有已知缺陷：整秒量化、口径分叉、
换曲窗口串曲、updatedAt 恒为 now），B 层偏差只在 --verbose 时打印。

用法：
  python3 baseline_guard.py --window 10
  python3 baseline_guard.py --baseline baseline/base_v4.15.8.json --window 10
  python3 baseline_guard.py ... --quiet         # 只在异常时输出（给 systemd 用）
  python3 baseline_guard.py ... --strict-devices  # 基准里没有的设备也算 FAIL（CI 用）
退出码：0=全部通过；1=有 FAIL；2=无数据/配置问题

环境变量（均可选，默认值 = 240 现网布局，行为与硬编码时期完全一致）：
  MF_WATCH_DIR   部署根目录，默认 /root/mf_watch
  MF_PYTHON      采集器解释器，默认 python3

判读器本身由 CI 回归（backend/scripts/baseline/selftest.py）：
真机样本只能在内网采，但「判定逻辑有没有被改软」可以在托管 runner 上用固定 fixture 钉死。
"""
import argparse
import datetime
import json
import os
import subprocess
import sys

ROOT = os.environ.get("MF_WATCH_DIR", "/root/mf_watch")
CAP = os.path.join(ROOT, "baseline_cap.py")
ALERT = os.path.join(ROOT, "GUARD_ALERT.log")
DEFAULT_BASELINE = os.path.join(ROOT, "baseline", "base_v4.15.8.json")
PY = os.environ.get("MF_PYTHON", "python3")

# 容忍带（不是拍脑袋，见 docs/播放基线-基准值与判读-20261126.md §4 的推导）
# ⚠ 这 7 个常量是守卫的牙齿，CI 里 selftest.py 会对字面量做指纹断言：
#    确需调整时必须同步改文档 §4 并更新 selftest 里的 PINS，否则 CI 红。
TOL_DELTA_P50_US = 800_000      # 正常波动 ~5ms，800ms = 160 倍，越过必是结构性塌陷
TOL_INQ_P95_MS = 1200           # 闸目标 2500ms，正常 p95≈2700，+1200=3900 仍 < 容量 4163
TOL_REALIGN_PER_MIN = 30.0      # 正常恒 0；30/min ≈ 每秒 0.5 次对齐动作
TOL_LATE_PER_MIN_FACTOR = 3.0   # 正常 <1 帧/min
TOL_LATE_PER_MIN_ABS = 3.0
TOL_ADVANCE_RATE = 0.02         # prog 推进速率应恒等 1.0
TOL_BACKWARDS = 3               # 15 分钟内曲中回退次数上限（正常 0）


def sh(cmd):
    try:
        return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=180)
    except Exception as e:
        return type("R", (), {"stdout": "", "stderr": str(e), "returncode": 99})()


def capture(window, end=None):
    # 固定输出路径：guard 每 5 分钟跑一次，若每次都往 baseline/ 写新文件会迅速堆积
    out = "/tmp/mf_guard_cur.json"
    cmd = "%s %s --window %s --out %s --label guard" % (PY, CAP, window, out)
    if end:
        cmd += " --end %s" % end     # 回归自测用：拿历史坏样本检验守卫本身
    p = sh(cmd)
    if p.returncode != 0 or not os.path.exists(out):
        return None, (p.stderr or p.stdout or "")[-500:]
    try:
        with open(out, encoding="utf-8") as f:
            return json.load(f), out
    except Exception as e:
        return None, str(e)


def num(v):
    return v if isinstance(v, (int, float)) else None


def judge(base, cur, strict_devices=False):
    """返回 [(level, dev, metric, got, expect, note)]

    strict_devices=False（默认，240 常驻）：基准里没有该设备只 WARN —— 换了设备/重配 psk
      不应让常驻守卫天天喊 FAIL。
    strict_devices=True（CI 发版体检）：升级为 FAIL —— 否则设备 key 一变，所有指标都比不了，
      守卫会永久假绿。这是「基准设备集合」本身的漂移告警。
    """
    out = []
    bt = base.get("A_tick") or {}
    ct = cur.get("A_tick") or {}
    if strict_devices and not ct:
        out.append(("FAIL", "-", "A_tick.empty", 0, ">0", "样本里没有任何设备 tick，无法判定"))
    for dev, c in ct.items():
        b = bt.get(dev)
        if not b:
            out.append(("FAIL" if strict_devices else "WARN", dev, "baseline", "-", "-",
                        "基准里没有该设备，无法比较（strict 模式下视为基准失配）"))
            continue

        # 1) 可听缺口铁证：静音块 / newgenSkip / 负 deltaUs
        sc = num((c.get("totals") or {}).get("silenceChunks"))
        if sc:
            out.append(("FAIL", dev, "silenceChunks", sc, 0, "出现补静音块 = 已发生可听缺口"))
        ng = num((c.get("totals") or {}).get("newgenSkipFrames"))
        if ng:
            out.append(("WARN", dev, "newgenSkipFrames", ng, 0, "换代跳帧"))

        neg = num((c.get("deltaUs") or {}).get("negPct"))
        if neg is not None and neg > 1.0:
            out.append(("FAIL", dev, "deltaUs.negPct", neg, "<=1.0",
                        "设备出音前沿落后锚点 = 该出声处没声"))

        # 2) 出音提前量塌陷
        cp50 = num((c.get("deltaUs") or {}).get("p50"))
        bp50 = num((b.get("deltaUs") or {}).get("p50"))
        if cp50 is not None and bp50 is not None and cp50 < bp50 - TOL_DELTA_P50_US:
            out.append(("FAIL", dev, "deltaUs.p50", cp50, ">=%d" % (bp50 - TOL_DELTA_P50_US),
                        "提前量较基准塌 %.0fms" % ((bp50 - cp50) / 1000.0)))

        # 3) 队列溢出（投递闸失效）
        cp95 = num((c.get("inQueueMs") or {}).get("p95"))
        bp95 = num((b.get("inQueueMs") or {}).get("p95"))
        if cp95 is not None and bp95 is not None and cp95 > bp95 + TOL_INQ_P95_MS:
            out.append(("FAIL", dev, "inQueueMs.p95", cp95, "<=%d" % (bp95 + TOL_INQ_P95_MS),
                        "设备待播队列超基准 %dms" % (cp95 - bp95)))
        cov = num((c.get("inQueueMs") or {}).get("overCapPct"))
        bov = num((b.get("inQueueMs") or {}).get("overCapPct")) or 0.0
        if cov is not None and cov > bov + 5.0:
            out.append(("FAIL", dev, "inQueueMs.overCapPct", cov, "<=%.1f" % (bov + 5.0),
                        "超出设备容量 %.0fms 的样本占比异常" % 4163))

        # 4) 对齐器空转
        cr = num((c.get("perMin") or {}).get("realigned"))
        br = num((b.get("perMin") or {}).get("realigned")) or 0.0
        if cr is not None and cr > br + TOL_REALIGN_PER_MIN:
            out.append(("FAIL", dev, "realigned/min", cr, "<=%.1f" % (br + TOL_REALIGN_PER_MIN),
                        "对齐器持续重排（时间线不稳）"))

        # 5) 丢包
        for k in ("lossMiss", "lossStale"):
            cv = num((c.get("perMin") or {}).get(k))
            if cv is not None and cv > 0.05:
                out.append(("WARN", dev, k + "/min", cv, "~0", "重传未命中/陈旧请求"))

        # 6) 心跳速率（采集中断或设备掉线）
        live = num((c.get("state") or {}).get("live"))
        if live is not None and live < 99.0:
            out.append(("FAIL", dev, "state.live%", live, ">=99",
                        "tick 非 live，链路处于异常态"))
        tpm = num(c.get("tickPerMin"))
        if tpm is not None and tpm < 20:       # 实测 ~30/min（2s 一条日志，内部 250ms 采样聚合）
            out.append(("WARN", dev, "tick/min", tpm, "~30", "tick 稀疏，可能采样缺口"))

    # 7) prog 推进速率 / 回退
    cp = cur.get("A_prog") or {}
    bp = base.get("A_prog") or {}
    ar = num(cp.get("advanceRate"))
    if ar is not None and abs(ar - 1.0) > TOL_ADVANCE_RATE:
        out.append(("FAIL", "-", "prog.advanceRate", ar, "1.0±%.2f" % TOL_ADVANCE_RATE,
                    "内部播放位置推进速率异常（快进/慢放/卡住）"))
    bk = num(cp.get("backwardsCount"))
    if bk is not None and bk > TOL_BACKWARDS:
        out.append(("WARN", "-", "prog.backwards", bk, "<=%d" % TOL_BACKWARDS,
                    "曲中位置回退，检查 seek/重锚路径"))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--baseline", default=DEFAULT_BASELINE)
    ap.add_argument("--window", type=float, default=10)
    ap.add_argument("--end", default=None, help="窗口末尾 HH:MM:SS（回归自测用；默认取最新数据）")
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--verbose", action="store_true", help="额外打印 B 层 status 偏差")
    ap.add_argument("--strict-devices", action="store_true",
                    help="基准里没有的设备也判 FAIL（CI 发版体检用；常驻守卫不要开）")
    ap.add_argument("--input", default=None,
                    help="直接判读已采好的样本 JSON（不再现场采集）。CI 用：采集一次 → 判读 → "
                         "同一份 JSON 直接做 artifact，避免重复采两份数据")
    a = ap.parse_args()

    if not os.path.exists(a.baseline):
        print("BASELINE_MISSING %s" % a.baseline)
        return 2
    with open(a.baseline, encoding="utf-8") as f:
        base = json.load(f)
    if a.input:
        if not os.path.exists(a.input):
            print("SAMPLE_MISSING %s" % a.input)
            return 2
        try:
            with open(a.input, encoding="utf-8") as f:
                cur = json.load(f)
        except Exception as e:
            print("SAMPLE_BAD_JSON %s: %s" % (a.input, e))
            return 2
        src = a.input
    else:
        cur, src = capture(a.window, a.end)
        if not cur:
            print("CAPTURE_FAILED %s" % src)
            return 2

    res = judge(base, cur, strict_devices=a.strict_devices)
    fails = [x for x in res if x[0] == "FAIL"]
    warns = [x for x in res if x[0] == "WARN"]

    if not a.quiet or fails or warns:
        ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        # --input 模式下 --window 无意义（样本是别人采好的），别把 CLI 默认值 10 当成真实窗口打印
        win_desc = ((cur.get("meta") or {}).get("windowMin") if a.input else a.window)
        print("[%s] window=%smin baseline=%s" % (ts, win_desc, os.path.basename(a.baseline)))
        for lv, dev, metric, got, expect, note in res:
            print("  %-4s %-14s %-22s got=%-12s expect=%-10s %s" %
                  (lv, dev[-6:] if dev != "-" else "-", metric, got, expect, note))
        if not res:
            print("  PASS  全部 A 层指标在容忍带内")

    if a.verbose and cur.get("B_status"):
        bs = cur["B_status"]
        print("  [B层/仅参考] uaAge p50=%s p95=%s | group-ap p50=%s | buffering=%s%%" %
              (bs["uaAgeMs"]["p50"], bs["uaAgeMs"]["p95"],
               bs["groupMinusAirplaySec"]["p50"], bs["bufferingPct"]))

    if fails or warns:
        try:
            with open(ALERT, "a", encoding="utf-8") as f:
                f.write("[%s] FAIL=%d WARN=%d window=%smin src=%s\n" %
                        (datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                         len(fails), len(warns), a.window, src))
                for lv, dev, metric, got, expect, note in res:
                    f.write("   %-4s %s %s got=%s expect=%s %s\n" %
                            (lv, dev, metric, got, expect, note))
        except OSError as e:
            # 只读部署（例如 CI 里把 ROOT 指向只读目录）不该因为写不了告警日志而改变退出码
            print("  [warn] 告警日志写入失败: %s" % e)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
