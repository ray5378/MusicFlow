#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""基准判读器自检（CI blocking，不需要真机）

为什么需要它
------------
真机基准只能在能出声的环境里采（240 上的容器 + HiVi/iEAST 真实播放），
GitHub 托管 runner 没有设备、也进不了内网，**采不出 A 层数据**。
但「判读器本身有没有被改软」完全可以离线回归 —— 否则守卫被悄悄放宽阈值、
删掉某条判据、或把设备失配从 FAIL 降级，线上会永久假绿，等于没有守卫。

本文件用仓库内固化的三份真实样本（fixtures/）做四层断言：
  1. fixture 完整性   —— 设备集合、关键字段都在（防止 fixture 被截断后"看起来 PASS"）
  2. 正样本必须 PASS  —— v4.15.8 基准自比；v4.15.3 前版样本对 v4.15.8 基准
  3. 反样本必须 FAIL  —— v4.15.9 坏样本（真实回归，见文档 §7.3）命中 >=7 条，
                         且必须覆盖 deltaUs.negPct / deltaUs.p50 / inQueueMs.p95 /
                         inQueueMs.overCapPct / realigned 五类判据
  4. 阈值有牙齿        —— 把两项容差放大 1e3 倍后对应 FAIL 必须消失（证明红是阈值判出来的，
                         不是别的原因碰巧红）；同时断言 7 个容差常量未被静默改写
  5. 设备失配不可假绿  —— strict 模式下基准里没有的设备必须 FAIL（CI 发版体检用）

退出码：0=全部通过；1=有断言失败
用法：python3 backend/scripts/baseline/selftest.py [-v]
"""
import argparse
import copy
import importlib.util
import json
import os
import sys

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
                "inQueueMs.overCapPct", "realigned/min")


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

    return c.summary()


if __name__ == "__main__":
    sys.exit(main())
