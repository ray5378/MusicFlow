#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""基准判读器自检（CI blocking，不需要真机）

为什么需要它
------------
真机基准只能在能出声的环境里采（240 上的容器 + HiVi/iEAST 真实播放），
GitHub 托管 runner 没有设备、也进不了内网，**采不出 A 层数据**。
但「判读器本身有没有被改软」完全可以离线回归 —— 否则守卫被悄悄放宽阈值、
删掉某条判据、或把设备失配从 FAIL 降级，线上会永久假绿，等于没有守卫。

本文件用仓库内固化的三份真实样本（fixtures/）做九节断言：
  1. fixture 完整性   —— 设备集合、关键字段都在（防止 fixture 被截断后"看起来 PASS"）
  2. 正样本必须 PASS  —— v4.15.8 基准自比；v4.15.3 前版样本对 v4.15.8 基准
  3. 反样本必须 FAIL  —— v4.15.9 坏样本（真实回归，见文档 §7.3）命中 >=7 条，
                         且必须覆盖 deltaUs.negPct / deltaUs.p50 / inQueueMs.p95 /
                         inQueueMs.overCapPct / realigned 五类判据
  4. 阈值有牙齿        —— 把两项容差放大 1e3 倍后对应 FAIL 必须消失（证明红是阈值判出来的，
                         不是别的原因碰巧红）；同时断言 7 个容差常量未被静默改写
  5. 设备失配不可假绿  —— strict 模式下基准里没有的设备必须 FAIL（CI 发版体检用）
  9. CI 模拟播放判据  —— invariant_guard.py 用绝对阈值（不依赖真机基准），
                          正样本 PASS / v4.15.9 反样本 FAIL / 阈值被放宽后失去牙齿
 11. 播放侧硬判据      —— playback_side_guard.py 从服务端事件判泵冻结/首投 seek/
                          曲末非零间隙/灌静音/fatal stall/预取复活，逐个反样本必红

退出码：0=全部通过；1=有断言失败
用法：python3 backend/scripts/baseline/selftest.py [-v]
"""
import argparse
import contextlib
import copy
import importlib.util
import io
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "fixtures")
GUARD = os.path.join(HERE, "baseline_guard.py")

# 容差常量指纹。改这里之前先看基线文档 §4 的推导 —— 这不是"顺手调大一点"的地方：
# 每一项都对应「正常波动」与「结构性塌陷」之间 1~3 个数量级的间隔。
PINS = {
    "TOL_DELTA_P50_US": 800_000,
    "TOL_INQ_P95_MS": 1200,
    "TOL_REALIGN_PER_MIN": 30.0,
    "TOL_LATE_PER_MIN_FACTOR": 3.0,
    "TOL_LATE_PER_MIN_ABS": 3.0,
    "TOL_ADVANCE_RATE": 0.02,
    "TOL_BACKWARDS": 3,
}

# 坏样本必须命中的判据类别（少一类就说明某条判据被删或失效）
BAD_MUST_HIT = ("deltaUs.negPct", "deltaUs.p50", "inQueueMs.p95",
                "inQueueMs.overCapPct", "realigned/min", "insertedFrames")


def load_guard():
    spec = importlib.util.spec_from_file_location("baseline_guard", GUARD)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)      # import 期不跑 main（有 __main__ 保护）
    return mod


def load_fix(name):
    with open(os.path.join(FIX, name), encoding="utf-8") as f:
        return json.load(f)


class Checker:
    def __init__(self, verbose=False):
        self.verbose = verbose
        self.failed = 0
        self.total = 0

    def check(self, title, cond, detail=""):
        self.total += 1
        if cond:
            print("  PASS  %s" % title)
            if self.verbose and detail:
                print("        %s" % detail)
        else:
            self.failed += 1
            print("  FAIL  %s" % title)
            if detail:
                print("        %s" % detail)
        return cond

    def summary(self):
        print("")
        print("%d/%d 断言通过%s" % (self.total - self.failed, self.total,
                                 "" if not self.failed else "，%d 条失败" % self.failed))
        return 0 if self.failed == 0 else 1


def metrics_of(res, level="FAIL"):
    return sorted({r[2] for r in res if r[0] == level})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args()
    c = Checker(a.verbose)

    print("== 0. 载入判读器与 fixture ==")
    g = load_guard()
    good = load_fix("base_v4.15.8.json")            # 基准（正常态）
    prev = load_fix("base_v4.15.3_prepatch.json")   # 热补丁前正常态
    bad = load_fix("base_v4.15.9_bad.json")         # 真实回归反例

    good_devs = set((good.get("A_tick") or {}).keys())
    print("  基准设备=%d 台  fixtures=%d 份" % (len(good_devs), 3))

    print("== 1. fixture 完整性 ==")
    c.check("基准 A_tick 非空且设备数与另外两份一致",
            bool(good_devs) and good_devs == set((bad.get("A_tick") or {}).keys())
            == set((prev.get("A_tick") or {}).keys()),
            "devs=%s" % sorted(good_devs))
    need = ("deltaUs", "inQueueMs", "perMin", "totals", "state")
    for name, fx in (("v4.15.8", good), ("v4.15.3", prev), ("v4.15.9_bad", bad)):
        for dev, rec in (fx.get("A_tick") or {}).items():
            missing = [k for k in need if k not in rec]
            c.check("%s/%s 字段齐全" % (name, dev[-6:]), not missing, "missing=%s" % missing)
    c.check("基准含 A_prog.advanceRate", isinstance((good.get("A_prog") or {}).get("advanceRate"), float),
            str((good.get("A_prog") or {}).get("advanceRate")))
    c.check("基准含 codeFingerprint.dist_sha256_16（可追溯是哪份代码跑的）",
            bool(((good.get("meta") or {}).get("codeFingerprint") or {}).get("dist_sha256_16")),
            str((((good.get("meta") or {}).get("codeFingerprint") or {}).get("dist_sha256_16") or {})))
    # 真实设备 key 是 12 位十六进制设备 MAC（内网设备标识），绝不入仓；
    # fixtures 一律用 DEVICE_* 占位。A_tick 与 A_ring 两段都带设备 key，两段都要查。
    leak = sorted({k for fx in (good, prev, bad)
                   for sect in ("A_tick", "A_ring")
                   for k in (fx.get(sect) or {})
                   if not k.startswith("DEVICE_")})
    c.check("fixture 设备 key 全部为脱敏占位（A_tick + A_ring）", not leak,
            "疑似真实设备 key=%s" % leak)

    print("== 2. 正样本必须 PASS ==")
    r_self = g.judge(good, copy.deepcopy(good))
    c.check("基准自比无任何告警", r_self == [], "got=%s" % (r_self or "[]"))
    r_prev = g.judge(good, prev)
    fails_prev = [r for r in r_prev if r[0] == "FAIL"]
    c.check("v4.15.3 前版样本判 PASS（热补丁前的正常态也必须在容忍带内）",
            not fails_prev, "FAIL=%s" % fails_prev)

    print("== 3. 反样本必须 FAIL（v4.15.9 真实回归）==")
    r_bad = g.judge(good, bad)
    fails = [r for r in r_bad if r[0] == "FAIL"]
    hit = set(metrics_of(r_bad))
    c.check("坏样本 FAIL 条数 >= 7", len(fails) >= 7, "got=%d: %s" % (len(fails), metrics_of(r_bad)))
    for m in BAD_MUST_HIT:
        c.check("命中判据 %s" % m, m in hit,
                "实际命中=%s" % sorted(hit))
    # 两台设备都必须在 inQueueMs.p95 上报红（单台只红说明是设备侧链路问题，不是版本问题）
    per_dev_inq = {r[1] for r in fails if r[2] == "inQueueMs.p95"}
    c.check("两台设备的 inQueueMs.p95 同时超限（对称=服务端问题）",
            per_dev_inq == good_devs, "red devs=%s" % sorted(per_dev_inq))

    print("== 4. 阈值有牙齿（放大容差后红必须消失）==")
    old_delta, old_inq = g.TOL_DELTA_P50_US, g.TOL_INQ_P95_MS
    try:
        g.TOL_DELTA_P50_US = 10 ** 9
        g.TOL_INQ_P95_MS = 10 ** 9
        r_mut = g.judge(good, bad)
        mut = set(metrics_of(r_mut))
        c.check("放宽 deltaUs 容差后 deltaUs.p50 不再报红（证明红来自阈值判据）",
                "deltaUs.p50" not in mut, "remaining=%s" % sorted(mut))
        c.check("放宽 inQueueMs 容差后 inQueueMs.p95 不再报红",
                "inQueueMs.p95" not in mut, "remaining=%s" % sorted(mut))
        c.check("容量溢出判据不受容差影响，仍报红（overCapPct 用固定 5% 余量）",
                "inQueueMs.overCapPct" in mut, "remaining=%s" % sorted(mut))
    finally:
        g.TOL_DELTA_P50_US, g.TOL_INQ_P95_MS = old_delta, old_inq

    print("== 5. 容差常量指纹（防止被静默放宽）==")
    for k, v in PINS.items():
        cur = getattr(g, k, None)
        c.check("%s == %s" % (k, v), cur == v,
                "实际=%s；确需调整请同步改 docs/播放基线-基准值与判读-20261126.md §4 与本文件 PINS" % cur)

    print("== 6. 设备失配不可假绿 ==")
    r_default = g.judge(good, good)
    unknown = copy.deepcopy(good)
    unknown["A_tick"]["ZZZZZZZZZZZZ"] = copy.deepcopy(good["A_tick"][sorted(good_devs)[0]])
    r_unk_default = g.judge(good, unknown)
    unk_default = [r for r in r_unk_default if r[1] == "ZZZZZZZZZZZZ"]
    c.check("默认模式：基准里没有的设备只 WARN（常驻守卫不该天天喊 FAIL）",
            bool(unk_default) and all(r[0] == "WARN" for r in unk_default) and r_default == [],
            "got=%s" % unk_default)
    r_unk_strict = g.judge(good, unknown, strict_devices=True)
    unk_strict = [r for r in r_unk_strict if r[1] == "ZZZZZZZZZZZZ"]
    c.check("strict 模式（CI）：基准里没有的设备必须 FAIL",
            bool(unk_strict) and any(r[0] == "FAIL" and r[2] == "baseline" for r in unk_strict),
            "got=%s" % unk_strict)
    empty = copy.deepcopy(good)
    empty["A_tick"] = {}
    r_empty = g.judge(good, empty, strict_devices=True)
    c.check("strict 模式：样本里完全没有 tick 必须 FAIL（不能静默 PASS）",
            any(r[0] == "FAIL" and r[2] == "A_tick.empty" for r in r_empty), "got=%s" % r_empty)

    print("== 7. CLI 与退出码契约（CI 真正依赖的就是这个）==")
    # CI 里走的是 `baseline_guard.py --input <采集文件>` 这条命令行，不是 import judge。
    # 退出码一旦语义漂移（比如把 FAIL 也返回 0），workflow 会静默全绿，故在此钉死。
    import subprocess
    import tempfile

    tmp = tempfile.mkdtemp(prefix="mf-selftest-")
    env = dict(os.environ, MF_WATCH_DIR=tmp)      # 让告警日志写到临时目录，别碰真实部署

    def run_guard(sample, extra=()):
        cmd = [sys.executable, GUARD,
               "--input", os.path.join(FIX, sample),
               "--baseline", os.path.join(FIX, "base_v4.15.8.json"),
               "--quiet"] + list(extra)
        return subprocess.run(cmd, capture_output=True, text=True, timeout=180, env=env)

    p_ok = run_guard("base_v4.15.8.json")
    c.check("CLI 正常样本 exit=0", p_ok.returncode == 0,
            "rc=%s stdout=%r stderr=%r" % (p_ok.returncode, p_ok.stdout[-200:], p_ok.stderr[-200:]))
    p_bad = run_guard("base_v4.15.9_bad.json")
    c.check("CLI 坏样本 exit=1 且打印 FAIL", p_bad.returncode == 1 and "FAIL" in p_bad.stdout,
            "rc=%s stdout=%r" % (p_bad.returncode, p_bad.stdout[-300:]))
    p_missing = run_guard("no_such_file.json")
    c.check("CLI 样本缺失 exit=2（与环境问题区分开，不冒充 FAIL）",
            p_missing.returncode == 2, "rc=%s stdout=%r" % (p_missing.returncode, p_missing.stdout[-200:]))

    print("== 8. Step Summary 渲染 ==")
    # CI 的 Job Summary 由 summary_md.py 渲染（内联在 workflow 里会踩 YAML 缩进规则）
    spec2 = importlib.util.spec_from_file_location(
        "summary_md", os.path.join(HERE, "summary_md.py"))
    sm = importlib.util.module_from_spec(spec2)
    spec2.loader.exec_module(sm)
    md = "\n".join(sm.render(os.path.join(FIX, "base_v4.15.8.json")))
    c.check("渲染出 markdown 表格且含设备数", "| 设备数 | 2" in md, md[:160].replace("\n", " / "))
    c.check("渲染含 dist 指纹（可追溯代码来源）", "dist/" in md and "`" in md, "")
    c.check("渲染含每台设备关键量", md.count("deltaUs p50=") == len(good_devs), "")
    md_bad = "\n".join(sm.render("/nonexistent/x.json"))
    c.check("采样文件缺失时降级为一行说明，不抛异常", "读取失败" in md_bad, md_bad)

    print("== 9. CI 模拟播放判据（invariant_guard）==")
    # GitHub 托管 runner 没有真设备，CI 里的模拟接收端走 absolute invariants，
    # 不能和真机基准逐项比。这条链路同样要钉死，否则 CI 会永久假绿。
    inv_path = os.path.join(HERE, "invariant_guard.py")
    spec3 = importlib.util.spec_from_file_location("invariant_guard", inv_path)
    iv = importlib.util.module_from_spec(spec3)
    spec3.loader.exec_module(iv)

    def run_inv(sample):
        cmd = [sys.executable, inv_path, "--input", os.path.join(FIX, sample)]
        return subprocess.run(cmd, capture_output=True, text=True, timeout=180, env=env)

    p_iv_good = run_inv("base_v4.15.8.json")
    c.check("模拟判据：正常样本 exit=0 且 VERDICT PASS",
            p_iv_good.returncode == 0 and "VERDICT PASS" in p_iv_good.stdout,
            "rc=%s out=%r" % (p_iv_good.returncode, p_iv_good.stdout[-160:]))
    p_iv_bad = run_inv("base_v4.15.9_bad.json")
    iv_bad_lines = [l for l in p_iv_bad.stdout.splitlines() if l.startswith("  FAIL")]
    c.check("模拟判据：v4.15.9 反样本 exit=1 且 FAIL>=5 条",
            p_iv_bad.returncode == 1 and len(iv_bad_lines) >= 5,
            "rc=%s fails=%d" % (p_iv_bad.returncode, len(iv_bad_lines)))
    c.check("模拟判据：反样本命中 negPct 与 inQueueMs.p95（可听缺口两种形态）",
            any("deltaUs.negPct" in l for l in iv_bad_lines)
            and any("inQueueMs.p95" in l for l in iv_bad_lines),
            "fails=%s" % [l.strip() for l in iv_bad_lines][:6])
    c.check("模拟判据：反样本命中补帧型缺口与 ring 预算塌陷（新增判据有牙齿）",
            any("A_tick.insertedFrames" in l for l in iv_bad_lines)
            and any("A_ring.budgetMs.p50" in l for l in iv_bad_lines),
            "fails=%s" % [l.strip() for l in iv_bad_lines][:10])
    p_iv_missing = subprocess.run(
        [sys.executable, inv_path, "--input", os.path.join(FIX, "no_such.json")],
        capture_output=True, text=True, timeout=60, env=env)
    c.check("模拟判据：样本缺失 exit=2（环境失败不冒充指标 FAIL）",
            p_iv_missing.returncode == 2, "rc=%s" % p_iv_missing.returncode)
    c.check("模拟判据：容量常量 4163ms 未被改软",
            iv.DEVICE_QUEUE_CAP_MS == 4163, "got=%s" % iv.DEVICE_QUEUE_CAP_MS)
    # 2026-11-26 对齐真机口径收紧；放宽回设备容量会让 3925~4163ms 的劣化漏判。
    c.check("模拟判据：inQ p95 上限为真机口径 3925ms（不再等于设备容量）",
            iv.INQ_P95_MAX_MS == 3925, "got=%s" % iv.INQ_P95_MAX_MS)
    c.check("模拟判据：deltaUs p50 下限收紧为 1200000us",
            iv.DELTA_P50_MIN_US == 1_200_000, "got=%s" % iv.DELTA_P50_MIN_US)
    old_lo = iv.DELTA_P50_MIN_US
    try:
        iv.DELTA_P50_MIN_US = -10 ** 9
        loosened = iv.judge(good, min_ticks=20)
        c.check("模拟判据：把 deltaUs 下限放宽后 deltaUs.p50 不再报红（证明红来自阈值）",
                not any(r[0] == "FAIL" and r[2] == "deltaUs.p50" for r in loosened),
                "fails=%s" % [r for r in loosened if r[0] == "FAIL"])
    finally:
        iv.DELTA_P50_MIN_US = old_lo

    print("== 10. 多拓扑切歌/音频帧判据（5 种拓扑共用）==")
    # CI 现在跑 mixed / ap-only / ap1-only / ap2-only / ss-only 五种组型，
    # 每种都必须切歌 >=5 次；纯 sendspin 无桥 tick，靠 A_ssFrame 判。
    # 这里用 fixture 的 prog 数值 + 合成证据钉死判据，不需要真机。
    sw_ok = {"count": 5, "changed": 5, "failed": 0,
             "maxSettleMs": 3200, "minFramesPerSwitch": 40}
    fr_ok = {"chunks": 800, "maxGapMs": 60, "minPerSwitch": 40}
    multi = copy.deepcopy(good)
    multi["A_switch"] = copy.deepcopy(sw_ok)
    multi["A_ssFrame"] = copy.deepcopy(fr_ok)

    def inv_fails(sample, **kw):
        args = dict(min_ticks=20, topo="mixed", expect_tick_devices=2,
                    require_switch=True)
        args.update(kw)
        return {r[2] for r in iv.judge(sample, **args) if r[0] == "FAIL"}

    c.check("混合组：切歌5次+帧正常无 FAIL", not inv_fails(multi),
            str(inv_fails(multi)))
    few = copy.deepcopy(multi); few["A_switch"]["count"] = 4
    c.check("只切歌4次必须 FAIL（A_switch.count）",
            "A_switch.count" in inv_fails(few), str(inv_fails(few)))
    failed_sw = copy.deepcopy(multi); failed_sw["A_switch"]["failed"] = 1
    c.check("有一次切歌没真正换曲必须 FAIL",
            "A_switch.failed" in inv_fails(failed_sw), str(inv_fails(failed_sw)))
    slow = copy.deepcopy(multi); slow["A_switch"]["maxSettleMs"] = 26000
    c.check("切歌确认超过 25s 必须 FAIL",
            "A_switch.maxSettleMs" in inv_fails(slow), str(inv_fails(slow)))
    c.check("开了 --require-switch 却没有切歌证据必须 FAIL",
            "A_switch.missing" in inv_fails(good), str(inv_fails(good)))
    c.check("显式不要求切歌时老样本不误报",
            not inv_fails(good, require_switch=False),
            str(inv_fails(good, require_switch=False)))

    ss = {"A_tick": {}, "A_prog": copy.deepcopy(good["A_prog"]),
          "A_switch": copy.deepcopy(sw_ok), "A_ssFrame": copy.deepcopy(fr_ok)}
    ss_fails = inv_fails(ss, min_ticks=0, topo="sendspin", expect_tick_devices=0)
    c.check("纯 sendspin：无 tick 但帧正常判 PASS", not ss_fails, str(ss_fails))
    no_fr = copy.deepcopy(ss); no_fr["A_ssFrame"] = None
    c.check("纯 sendspin：没有帧证据必须 FAIL（不能静默 PASS）",
            "A_ssFrame.missing" in inv_fails(no_fr, min_ticks=0, topo="sendspin",
                                             expect_tick_devices=0),
            str(inv_fails(no_fr, min_ticks=0, topo="sendspin", expect_tick_devices=0)))
    gap = copy.deepcopy(ss); gap["A_ssFrame"]["maxGapMs"] = 800
    c.check("音频帧出现 800ms 静音缺口必须 FAIL",
            "A_ssFrame.maxGapMs" in inv_fails(gap, min_ticks=0, topo="sendspin",
                                              expect_tick_devices=0))
    few_fr = copy.deepcopy(ss); few_fr["A_ssFrame"]["chunks"] = 20
    c.check("音频帧不足 200 帧必须 FAIL",
            "A_ssFrame.chunks" in inv_fails(few_fr, min_ticks=0, topo="sendspin",
                                            expect_tick_devices=0))
    c.check("切歌5次常量未被改软", iv.SWITCH_MIN == 5, "got=%s" % iv.SWITCH_MIN)
    c.check("帧间隔 500ms 常量未被改软",
            iv.SS_FRAME_GAP_MAX_MS == 500, "got=%s" % iv.SS_FRAME_GAP_MAX_MS)

    print("== 11. 切歌暂态 / 稳态分段 ==")
    # 4.15.8 正常态在切歌窗口也会 realign 阶跃 + inQ 拉高（lead 5s + 预填充 10s）。
    # 分段后顶层指标只代表稳态，暂态只判「桥还活着」，避免正常版本被自己的切歌判红。
    seg = copy.deepcopy(good)
    seg["A_switch"] = copy.deepcopy(sw_ok)
    bad_window = copy.deepcopy(good["A_tick"][sorted(good_devs)[0]])
    bad_window.update({"samples": 40,
                       "deltaUs": {"negPct": 6.0, "p50": -100000},
                       "inQueueMs": {"p95": 5900, "overCapPct": 20.0},
                       "perMin": {"realigned": 80.0}})
    for dev in seg["A_tick"]:
        seg["A_tick"][dev]["switchWindow"] = copy.deepcopy(bad_window)
    seg_fails = inv_fails(seg, require_switch=False)
    c.check("切歌窗口的坏水位不污染稳态判定", not seg_fails, str(seg_fails))
    dead = copy.deepcopy(seg)
    for dev in dead["A_tick"]:
        dead["A_tick"][dev]["switchWindow"]["samples"] = 0
    dead_fails = inv_fails(dead, require_switch=False)
    c.check("切歌窗口完全无 tick（桥死了）必须 FAIL",
            any("switchWindow.samples" in m for m in dead_fails), str(dead_fails))
    thin = copy.deepcopy(seg)
    for dev in thin["A_tick"]:
        thin["A_tick"][dev]["samplesSteady"] = 3
    thin_fails = inv_fails(thin, require_switch=False)
    c.check("稳态段样本不足 15 条必须 FAIL（不能拿切歌暂态凑数）",
            any("samplesSteady" in m for m in thin_fails), str(thin_fails))
    spec_cap = importlib.util.spec_from_file_location(
        "baseline_cap", os.path.join(HERE, "baseline_cap.py"))
    capmod = importlib.util.module_from_spec(spec_cap)
    spec_cap.loader.exec_module(capmod)
    c.check("切歌暂态窗口常量 15000ms 未被改软",
            capmod.SWITCH_WINDOW_MS == 15000, "got=%s" % capmod.SWITCH_WINDOW_MS)

    print("== 12. 帧证据抗时钟回拨 / 排除连接预热 ==")
    b = 1700000000000
    # 首帧握手预热 4042ms，其后稳定 25ms 一帧（约 40fps）。
    rows = [{"t": b, "bytes": 480}, {"t": b + 4042, "bytes": 480}]
    for i in range(2, 1500):
        rows.append({"t": b + 4042 + (i - 1) * 25, "bytes": 480})
    # 切歌 settle 只有 80ms 且墙钟回拨(t1<t0)；短窗内不足 20 帧，
    # 必须靠切歌后 5s 观察窗判「切完有声」。
    sw_clock_back = [{"t0": b + 30000, "t1": b + 29920,
                      "framesBefore": 10, "framesAfter": 10}]
    frame_stat = capmod.analyze_ss_frames(rows, sw_clock_back)
    c.check("连接预热 4042ms 不计入稳态静音缺口",
            frame_stat["warmupGapMs"] == 4042 and frame_stat["maxGapMs"] == 25,
            str(frame_stat))
    c.check("切歌窗时钟回拨但 5s 内有帧，仍判有帧",
            frame_stat["minPerSwitch"] >= 20, str(frame_stat))
    mid_gap = copy.deepcopy(rows)
    for r in mid_gap[100:]:
        r["t"] += 3975
    mid_stat = capmod.analyze_ss_frames(mid_gap, sw_clock_back)
    c.check("稳态中段 4000ms 静音缺口必须暴露",
            mid_stat["maxGapMs"] == 4000, str(mid_stat))
    silent = [{"t0": b + 100000, "t1": b + 100080,
               "framesBefore": 10, "framesAfter": 10}]
    silent_stat = capmod.analyze_ss_frames(rows, silent)
    c.check("切歌后 5s 观察窗完全无帧必须 FAIL",
            silent_stat["minPerSwitch"] == 0, str(silent_stat))
    c.check("切歌后 5s 观察窗常量未被改软",
            capmod.SWITCH_FRAME_TAIL_MS == 5000,
            "got=%s" % capmod.SWITCH_FRAME_TAIL_MS)

    print("== 13. 补齐 A 层判据：补帧/丢包/存活/设备水位 ==")
    pins13 = {
        "SILENCE_CHUNKS_MAX": 0, "INSERTED_FRAMES_MAX": 0,
        "NEWGEN_SKIP_MAX": 0, "LATE_PER_MIN_MAX": 30.0,
        "LOSS_PER_MIN_MAX": 0.05, "LIVE_PCT_MIN": 99.0,
        "RING_SAMPLES_MIN": 10, "RING_BUDGET_P50_MIN_MS": 200,
        "RING_BUFFERED_ZERO_MIN_PCT": 50.0, "RING_DROP_OLD_MAX_PER_MIN": 0.1,
    }
    for k, v in pins13.items():
        c.check("补齐常量 %s 未被改软" % k, getattr(iv, k) == v,
                "got=%s" % getattr(iv, k))

    sample13 = copy.deepcopy(good)

    def full_fails(sample):
        return {r[2] for r in iv.judge(sample, min_ticks=0, topo="mixed",
                                       expect_tick_devices=2) if r[0] == "FAIL"}

    c.check("正常样本含 ring/补帧/丢包判据仍全 PASS",
            not full_fails(sample13), str(full_fails(sample13)))

    ins = copy.deepcopy(sample13)
    for d in ins["A_tick"]:
        ins["A_tick"][d]["totals"]["insertedFrames"] = 2108
    c.check("补帧 2108（4.15.9 形态）必须 FAIL",
            any("insertedFrames" in m for m in full_fails(ins)), str(full_fails(ins)))

    sil = copy.deepcopy(sample13)
    for d in sil["A_tick"]:
        sil["A_tick"][d]["totals"]["silenceChunks"] = 3
    c.check("补静音块必须 FAIL",
            any("silenceChunks" in m for m in full_fails(sil)), str(full_fails(sil)))

    loss = copy.deepcopy(sample13)
    for d in loss["A_tick"]:
        loss["A_tick"][d]["perMin"]["lossMiss"] = 0.9
        loss["A_tick"][d]["perMin"]["lossStale"] = 0.9
    lf = full_fails(loss)
    c.check("lossMiss/lossStale 暴涨必须 FAIL",
            any("lossMiss" in m for m in lf) and any("lossStale" in m for m in lf),
            str(lf))

    dead = copy.deepcopy(sample13)
    for d in dead["A_tick"]:
        dead["A_tick"][d]["state"]["live"] = 95.0
    c.check("设备 live<99% 必须 FAIL",
            any("live%" in m for m in full_fails(dead)), str(full_fails(dead)))

    ringbad = copy.deepcopy(sample13)
    for d in ringbad["A_ring"]:
        ringbad["A_ring"][d]["bufferedZeroPct"] = 0.0
        ringbad["A_ring"][d]["budgetMs"]["p50"] = 105
    rf = full_fails(ringbad)
    c.check("ring 预算塌陷+bufferedZero 归零必须 FAIL",
            any("bufferedZeroPct" in m for m in rf)
            and any("budgetMs.p50" in m for m in rf), str(rf))

    nor = copy.deepcopy(sample13)
    nor.pop("A_ring", None)
    c.check("含 AirPlay 拓扑缺 ring 数据必须 FAIL",
            "A_ring.missing" in full_fails(nor), str(full_fails(nor)))

    ss13 = copy.deepcopy(sample13)
    ss13.pop("A_ring", None)
    # sendspin 拓扑没有 ring 也没有 tick，必须靠帧证据判；补一个正常帧段，
    # 否则 A_ssFrame.missing 会盖住本条要验证的「无 ring 不算 FAIL」。
    ss13["A_ssFrame"] = {"chunks": 800, "maxGapMs": 60, "minPerSwitch": 40}
    ss13_fails = {r[2] for r in iv.judge(ss13, min_ticks=0, topo="sendspin",
                                         expect_tick_devices=0) if r[0] == "FAIL"}
    c.check("纯 sendspin 无 ring 不算 FAIL", not ss13_fails, str(ss13_fails))

    ng = copy.deepcopy(sample13)
    for d in ng["A_tick"]:
        ng["A_tick"][d]["totals"]["newgenSkipFrames"] = 100
    ng_res = iv.judge(ng, min_ticks=0, topo="mixed", expect_tick_devices=2)
    c.check("换代跳帧记 WARN 但不误判 FAIL",
            any(r[0] == "WARN" and r[2] == "A_tick.newgenSkipFrames" for r in ng_res)
            and not [r for r in ng_res if r[0] == "FAIL"], str(ng_res))

    inter_res = copy.deepcopy(sample13)
    for d in inter_res["A_tick"]:
        inter_res["A_tick"][d]["stream"] = {"gens": 2, "genFlips": 300,
                                           "genFlipsPerMin": 30.0, "interleaved": True}
    ir = iv.judge(inter_res, min_ticks=0, topo="mixed", expect_tick_devices=2)
    c.check("CI 采样流交错必须 FAIL",
            any(r[0] == "FAIL" and r[2] == "A_tick.stream.interleaved" for r in ir),
            str([r for r in ir if r[0] == "FAIL"]))

    print("== 14. 采样流完整性（累计量按 gen 断开）==")
    cap_spec = importlib.util.spec_from_file_location(
        "baseline_cap", os.path.join(HERE, "baseline_cap.py"))
    cap = importlib.util.module_from_spec(cap_spec)
    cap_spec.loader.exec_module(cap)

    # 14.1 240 实测形态：同设备两条流按秒交替，各自 realigned 恒定 →
    #      旧实现每对记 +51（10min 窗口算出 244.8/min），新实现必须是 0。
    inter = []
    for i in range(60):
        gv = 2000006 if i % 2 == 0 else 0
        inter.append((1000 + i, {"gen": gv, "realigned": 18 if gv else 69}))
    c.check("交错流不产生伪 realigned 增量",
            cap.delta_of(inter, "realigned") == 0,
            "got=%s 旧实现会算成 %d" % (cap.delta_of(inter, "realigned"), 51 * (len(inter) // 2)))

    sh = cap._stream_health(inter)
    c.check("交错流被识别为 interleaved", sh["interleaved"] is True, str(sh))

    # 14.2 单写入者随换曲单调换代，不得误判成交错
    mono = [(1000 + i, {"gen": 100 * (i // 20), "realigned": i}) for i in range(60)]
    c.check("单调换代不误判交错", cap._stream_health(mono)["interleaved"] is False,
            str(cap._stream_health(mono)))

    # 14.3 换代重置语义不变：每个 gen 段内累加，跨段的回落不算负增量
    reset = [(1000 + i, {"gen": 1, "silenceChunks": i}) for i in range(10)]
    reset += [(1010 + i, {"gen": 2, "silenceChunks": i}) for i in range(10)]
    c.check("跨 gen 重置仍按段累加（9+9=18）",
            cap.delta_of(reset, "silenceChunks") == 18,
            "got=%s" % cap.delta_of(reset, "silenceChunks"))

    # 14.4 计数器按 gen 重置（实测：gen 切换处 insertedFrames 归 0），
    #      故跨 gen 的 9→10 不是增量；新实现给 18 正确，旧实现多算 1。
    keep = [(1000 + i, {"gen": 1 + i // 10, "late": i}) for i in range(20)]
    c.check("跨 gen 不把重置后的差值算成增量（0..19 段内合计=18）",
            cap.delta_of(keep, "late") == 18, "got=%s" % cap.delta_of(keep, "late"))

    # 14.5 守卫：交错只报 WARN，不升级成播放回归
    st_bad = copy.deepcopy(good)
    for d in st_bad["A_tick"]:
        st_bad["A_tick"][d]["stream"] = {"gens": 2, "genFlips": 300,
                                        "genFlipsPerMin": 30.0, "interleaved": True}
    st_res = g.judge(good, st_bad)
    c.check("真机守卫对交错记 WARN 且不误判 FAIL",
            any(r[0] == "WARN" and r[2] == "stream.interleaved" for r in st_res)
            and not [r for r in st_res if r[0] == "FAIL"], str(st_res))

    # 14.6 边界：3 gen 单调 vs 2 gen 交替
    c.check("交错判据边界 flips>2*(gens-1) 未被放宽",
            cap._stream_health([(i, {"gen": [1, 2, 3][i // 10]}) for i in range(30)])["interleaved"] is False
            and cap._stream_health([(i, {"gen": [1, 2][i % 2]}) for i in range(30)])["interleaved"] is True)

    print("== 15. 可听缺口证据必须覆盖补帧型（insertedFrames）==")
    # v4.15.9 的真实形态是 silenceChunks=0 + insertedFrames=2108：
    # 如果 audibleGapEvidence 只看 silence/negPct，这台设备会被报成「无证据」。
    def mk_ticks(ins_last):
        rows = []
        for i in range(24):
            rows.append((i * 2, {
                "dev": "DEVICE_T", "gen": 1, "state": "live", "clock": "local-rtp-ntp",
                "queueMs": 100, "inQueueMs": 2500, "maxQueueMs": 150,
                "late": 0, "lossReq": 0, "lossResent": 0, "lossMiss": 0,
                "lossFuture": 0, "lossDedup": 0, "lossStale": 0,
                "realigned": 1, "samples": 1, "deltaUs": 2060000,
                "driftUs": 0, "timingAgeMs": 10,
                "silenceChunks": 0,
                "insertedFrames": (ins_last if i == 23 else 0),
                "newgenSkipFrames": 0, "skippedFrames": 0, "droppedFrames": 0,
            }))
        return rows

    clean = capmod.analyze_tick("DEVICE_T", mk_ticks(0))
    gap = capmod.analyze_tick("DEVICE_T", mk_ticks(2108))
    c.check("正常 tick 的 audibleGapEvidence 必须为 False",
            bool(clean) and clean["audibleGapEvidence"] is False,
            "got=%s" % (clean or {}).get("audibleGapEvidence"))
    c.check("insertedFrames=2108 必须被 audibleGapEvidence 捕获",
            bool(gap) and gap["audibleGapEvidence"] is True,
            "got=%s totals=%s" % ((gap or {}).get("audibleGapEvidence"),
                                  (gap or {}).get("totals")))

    print("== 16. 长跑分桶趋势判据（longrun_trend）==")
    # 长跑特有盲区：全局 p95 会被占多数的正常样本稀释，前段健康、后段劣化
    # 在短跑判据里可能整体通过。这一节钉住「分桶斜率」判据的行为与阈值。
    spec = importlib.util.spec_from_file_location(
        "longrun_trend", os.path.join(HERE, "longrun_trend.py"))
    lt = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(lt)

    pins_lt = {
        "BUCKET_SEC": 300, "MIN_BUCKETS": 3,
        "TICK_PER_BUCKET_RATIO": 0.6, "DELTA_P50_DRIFT_MAX_US": 400_000,
        "INQ_P50_RISE_MAX_MS": 800, "REALIGN_PER_MIN_MAX": 30,
        "SS_FRAME_PER_BUCKET_RATIO": 0.6,
        "RSS_GROWTH_MAX_PCT": 100, "FD_GROWTH_MAX": 200,
    }
    drift_pins = {k: [getattr(lt, k, None), v] for k, v in pins_lt.items()
                  if getattr(lt, k, None) != v}
    c.check("长跑阈值常量指纹未被放宽（9 项）", not drift_pins, "diff=%s" % drift_pins)

    TPM = 30  # 每设备 tick/min，与真机一致

    def gen_ticks(minutes=30, devs=("DEVICE_A", "DEVICE_B"), tpm=TPM,
                  inq=None, delta=None, realign=None, inserted=None,
                  silence=None, drop=None):
        rows, step = [], 60.0 / tpm
        for dev in devs:
            for i in range(int(minutes * tpm)):
                t = i * step
                mi = int(t // 60)
                if drop and drop(dev, mi, i):
                    continue
                rec = {"dev": dev, "gen": 1, "samples": 1, "state": "live",
                       "inQueueMs": 2550.0, "deltaUs": 2_060_000.0,
                       "realigned": 0, "silenceChunks": 0, "insertedFrames": 0,
                       "newgenSkipFrames": 0, "late": 0, "lossMiss": 0, "lossStale": 0,
                       "_wall": 1_700_000_000_000 + int(t * 1000)}
                if inq:
                    rec["inQueueMs"] = inq(dev, mi, i)
                if delta:
                    rec["deltaUs"] = delta(dev, mi, i)
                if realign:
                    rec["realigned"] = realign(dev, mi, i)
                if inserted:
                    rec["insertedFrames"] = inserted(dev, mi, i)
                if silence:
                    rec["silenceChunks"] = silence(dev, mi, i)
                rows.append((t, rec))
        return rows

    def write_lt(ticks, ss_times=None, res=None):
        d = tempfile.mkdtemp(prefix="mf-lt-")
        bp = os.path.join(d, "base.jsonl")
        with open(bp, "w", encoding="utf-8") as f:
            for _t, rec in ticks:
                f.write(json.dumps({"type": "tick", "data": rec}) + "\n")
        sp = rp = ""
        if ss_times:
            sp = os.path.join(d, "ss.jsonl")
            with open(sp, "w", encoding="utf-8") as f:
                for t in ss_times:
                    f.write(json.dumps({"t": int(t * 1000), "ts_us": 0,
                                        "bytes": 960}) + "\n")
        if res:
            rp = os.path.join(d, "res.jsonl")
            with open(rp, "w", encoding="utf-8") as f:
                for r in res:
                    f.write(json.dumps(r) + "\n")
        return bp, sp, rp

    def run_lt(bp, sp="", rp="", topo="airplay"):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = lt.main(["--input", bp, "--ss-input", sp, "--resource", rp,
                          "--topo", topo])
        return rc, buf.getvalue()

    def tail(out):
        lines = [ln for ln in out.strip().splitlines() if ln.strip()]
        return lines[-1] if lines else "(no output)"

    rc, out = run_lt(*write_lt(gen_ticks()))
    c.check("30min 正常长跑样本判 PASS", rc == 0 and "VERDICT PASS" in out, tail(out))

    # ① 后段缓冲持续上涨：全局 p95 可能仍绿，必须靠桶间斜率抓
    rc, out = run_lt(*write_lt(gen_ticks(
        inq=lambda d, mi, i: 2550 + max(0, mi - 20) * 150)))
    c.check("后段缓冲持续上涨必须 FAIL（inqRise）",
            rc == 1 and "FAIL - A_longrun.DEVICE_A.inqRise" in out, tail(out))

    # ② 补帧起始落在桶边界上也要抓到（prev 跨桶保留的意义）
    rc, out = run_lt(*write_lt(gen_ticks(
        inserted=lambda d, mi, i: 2108 if mi >= 22 else 0)))
    c.check("桶边界起始的补帧必须 FAIL 且能定位桶号（20~25min 桶）",
            rc == 1 and "FAIL - A_longrun.DEVICE_A.insertedInBucket" in out
            and "(4, 2108)" in out, tail(out))

    # ③ 补静音
    rc, out = run_lt(*write_lt(gen_ticks(
        silence=lambda d, mi, i: 3 if mi >= 8 else 0)))
    c.check("桶内补静音必须 FAIL", rc == 1 and "silenceInBucket" in out, tail(out))

    # ④ 提前量整体搬移：500ms 漂移超过 400ms 上限
    rc, out = run_lt(*write_lt(gen_ticks(
        delta=lambda d, mi, i: 2_060_000 if mi < 25 else 1_560_000)))
    c.check("桶间 deltaUs.p50 漂移必须 FAIL（deltaP50Drift）",
            rc == 1 and "deltaP50Drift" in out, tail(out))

    # ⑤ 采样断流（设备假死 / 采集掉线）
    rc, out = run_lt(*write_lt(gen_ticks(
        drop=lambda d, mi, i: 10 <= mi < 15 and i % 10 != 0)))
    c.check("某桶 tick 稀疏必须 FAIL（tickPerBucket）",
            rc == 1 and "tickPerBucket" in out, tail(out))

    # ⑥ 局部对齐器空转：30/min 阈值按桶算，不能被全局均值稀释
    rc, out = run_lt(*write_lt(gen_ticks(
        realign=lambda d, mi, i: 0 if mi < 12 else
        (4 * (i - 12 * TPM) if mi < 14 else 8 * TPM))))
    c.check("桶内对齐器空转必须 FAIL（realignPerBucket）",
            rc == 1 and "realignPerBucket" in out, tail(out))

    # ⑦ sendspin 帧率衰减（纯帧通路的长会话劣化）
    ss_decay = ([float(t) for t in range(0, 900)] +
                [900.0 + t * 4 for t in range(0, 225)])
    rc, out = run_lt(*write_lt([], ss_times=ss_decay), topo="sendspin")
    c.check("sendspin 后段帧率衰减必须 FAIL", rc == 1 and "ssFrame" in out, tail(out))

    # ⑧ 纯 sendspin 无 tick 是设计如此，不能判红
    ss_flat = [t * 0.25 for t in range(0, 7200)]
    rc, out = run_lt(*write_lt([], ss_times=ss_flat), topo="sendspin")
    c.check("纯 sendspin 跳过 tick 判据且帧正常 PASS",
            rc == 0 and "A_longrun.tick.skipped" in out, tail(out))

    # ⑨ RSS 翻倍只 WARN：长跑没有自己的基线前不设 FAIL，避免误报打断夜间
    res = [{"t": 1_700_000_000_000 + i * 30_000,
            "rssKb": 300_000 if i < 30 else 700_000,
            "fd": 60 if i < 30 else 70} for i in range(60)]
    rc, out = run_lt(*write_lt(gen_ticks(), res=res))
    c.check("RSS 翻倍只 WARN 不 FAIL", rc == 0 and "WARN - A_longrun.resource.rss" in out,
            tail(out))

    # ⑩ 样本太短不能给假绿
    rc, out = run_lt(*write_lt(gen_ticks(minutes=8)))
    c.check("桶数 < 3 必须 FAIL（不足以看趋势）",
            rc == 1 and "A_longrun.DEVICE_A.buckets" in out, tail(out))

    # ------------------------------------------------------------------
    # 11. 播放侧硬判据（v4.15.11）：A 层水位全绿也可能有曲末空洞，
    #     判据必须直接从服务端事件取，且每条反样本都能把对应指标判红。
    def ps_metrics(res, level="FAIL"):
        """播放侧 guard 返回 (level, metric, detail) 三元组，取第 2 位。"""
        return sorted({r[1] for r in res if r[0] == level})

    print("== 11. 播放侧硬判据 ==")
    import datetime
    import importlib.util as _ilu
    _spec = _ilu.spec_from_file_location(
        "playback_side_guard", os.path.join(HERE, "playback_side_guard.py"))
    psg = _ilu.module_from_spec(_spec)
    _spec.loader.exec_module(psg)

    def _iso(ep):
        return datetime.datetime.fromtimestamp(
            ep, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")

    def ps_lines(n=40, gap_at=-1, seeks=(), flushes=0, cold=1,
                 join_delta=0, bad_fill=False, silence=False,
                 prefetch=False, fatal=False, skip_drain=False):
        """构造带 UTC 时间戳的容器关键行；默认一份完全健康的样本。"""
        out, t0 = [], 1_795_700_000.0
        for i in range(n):
            ep = t0 + i * 2.0
            if i == gap_at:                       # 该点相对上一条跳 6s
                ep = t0 + (i - 1) * 2.0 + 6.0
            out.append("%s [sendspin] bridge-servo dev=D cursorVsNow=5800ms" % _iso(ep))
        for i in range(cold):
            out.append("%s [airplay-bridge] warm=false start=0s" % _iso(t0 + 1))
        for reason in seeks:
            out.append("%s [sendspin] bridge-start-seek dev=D reason=%s" %
                       (_iso(t0 + 2), reason))
        for i in range(flushes):
            out.append("%s [airplay] RAOP FLUSH dev=D" % _iso(t0 + 3 + i))
        if join_delta is not None:
            out.append("%s [sendspin] sendspin 曲末排空跳过:接续下一首 continuity=1 next=abcdef12 endUs=477000000000" % _iso(t0 + 4))
            out.append("%s [sendspin] sendspin timeline anchored: base=%d contig=477000000000 continuity=true" %
                       (_iso(t0 + 5), 477000000000 + join_delta))
        if bad_fill:
            out.append("%s [sendspin] sendspin 曲末排空:桥续静音跳过 ev=bridge-drain-fill-skip reason=other bridges=1" % _iso(t0 + 6))
        if silence:
            out.append('%s [airplay-bridge] {"ev":"tick","silenceChunks":3}' % _iso(t0 + 7))
        if prefetch:
            out.append("%s [sendspin] next-prefetch song=abcdef12" % _iso(t0 + 8))
        if fatal:
            out.append("%s [airplay-supervisor] link stall dev=D fatal" % _iso(t0 + 9))
        if skip_drain:
            out.append("%s [sendspin] sendspin 曲末排空跳过:下一首预取已就绪 next=abcdef12 startTsUs=477000000000" % _iso(t0 + 10))
        return out

    healthy = ps_lines()
    r_healthy = psg.judge(healthy)
    c.check("播放侧：健康样本全 PASS", not ps_metrics(r_healthy), str(ps_metrics(r_healthy)))

    r_frozen = psg.judge(ps_lines(gap_at=10))
    c.check("泵冻结 6s 必须 FAIL（servo.maxGapMs）",
            "servo.maxGapMs" in ps_metrics(r_frozen), str(ps_metrics(r_frozen)))

    r_seek = psg.judge(ps_lines(seeks=[psg.COLD_START_REASON] * 4))
    c.check("切歌中 start-seek 洪水必须 FAIL（>1 次）",
            "startSeek.count" in ps_metrics(r_seek), str(ps_metrics(r_seek)))

    r_reason = psg.judge(ps_lines(seeks=["prefetch-handoff"]))
    c.check("非冷启动 reason 的 start-seek 必须 FAIL",
            "startSeek.reason" in ps_metrics(r_reason), str(ps_metrics(r_reason)))

    r_flush = psg.judge(ps_lines(flushes=4))
    c.check("FLUSH 超过冷启动次数必须 FAIL",
            "bridgeFlush.count" in ps_metrics(r_flush), str(ps_metrics(r_flush)))
    # 真机冷启动一次 warm=false + 一次首投 seek ⇒ 两次 FLUSH 都合法，不能判红。
    r_cold2 = psg.judge(ps_lines(flushes=2, cold=1, seeks=[psg.COLD_START_REASON]))
    c.check("冷启动起播+首投 seek 两次 FLUSH 必须 PASS",
            not ps_metrics(r_cold2), str(ps_metrics(r_cold2)))
    r_flush_excess = psg.judge(ps_lines(flushes=3, cold=1, seeks=[psg.COLD_START_REASON]))
    c.check("冷启动两次合法 FLUSH 之外的第三次必须 FAIL",
            "bridgeFlush.count" in ps_metrics(r_flush_excess), str(ps_metrics(r_flush_excess)))

    r_gap = psg.judge(ps_lines(join_delta=300_000))
    c.check("曲末接续 Δ=300000us 必须 FAIL（零间隙）",
            "trackJoin.zeroGap" in ps_metrics(r_gap), str(ps_metrics(r_gap)))

    r_nojoin = psg.judge(ps_lines(join_delta=None))
    c.check("无接续证据必须留 WARN 覆盖缺口（不冒充 PASS）",
            any(r[0] == "WARN" and r[1] == "trackJoin.coverage" for r in r_nojoin),
            str(r_nojoin))

    r_fill = psg.judge(ps_lines(bad_fill=True, silence=True))
    c.check("非 covered 灌静音 + silenceChunks>0 必须 FAIL",
            "audibleGap.count" in ps_metrics(r_fill), str(ps_metrics(r_fill)))

    r_pre = psg.judge(ps_lines(prefetch=True))
    c.check("预取链复活必须 FAIL（v4.15.11 已整链删除）",
            "prefetch.removed" in ps_metrics(r_pre), str(ps_metrics(r_pre)))

    r_stall = psg.judge(ps_lines(fatal=True))
    c.check("fatal stall 必须 FAIL（非致命告警不判）",
            "stall.fatal" in ps_metrics(r_stall), str(ps_metrics(r_stall)))

    r_skip = psg.judge(ps_lines(skip_drain=True))
    c.check("曲末跳过排空赌预取捷径必须 FAIL（D5 血案根因）",
            "drainSkip.removed" in ps_metrics(r_skip), str(ps_metrics(r_skip)))

    r_short = psg.judge(ps_lines(n=5), mode="short")
    c.check("短跑样本不足 20 条 servo 必须 FAIL",
            "servo.count" in ps_metrics(r_short), str(ps_metrics(r_short)))
    r_long = psg.judge(ps_lines(n=40), mode="long")
    c.check("长跑样本下限 100 条 servo 必须 FAIL（短/长口径不同）",
            "servo.count" in ps_metrics(r_long), str(ps_metrics(r_long)))

    c.check("servo 3s 上限常量未被改软", psg.SERVO_GAP_MAX_MS == 3000,
            "got=%s" % psg.SERVO_GAP_MAX_MS)
    c.check("冷启动 seek 上限常量未被改软", psg.COLD_START_SEEK_MAX == 1,
            "got=%s" % psg.COLD_START_SEEK_MAX)

    return c.summary()


if __name__ == "__main__":
    sys.exit(main())
