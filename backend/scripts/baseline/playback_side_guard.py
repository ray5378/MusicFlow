#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""播放侧硬判据（CI 模拟播放 / 长跑通用）——从容器日志判「曲中空洞 / 曲末空洞」。

为什么单独一层
--------------
baseline_cap.py 采的是 A 层水位/帧（tick/ring/ssFrame），判的是「缓冲是否健康」；
但 v4.15.11 的血案是**泵提前收工**与**首投 seek 丢帧**——水位指标可以全绿，
听感却是曲末 6.5s 空洞。判据只能回到服务端自己打的播放侧事件：

  * bridge-servo        每 ~2s 一条，间隔 >3s 即泵被冻住（唯一硬判据）
  * bridge-start-seek   只允许冷启动 reason=new-session-first-delivery；
                        切歌中出现 = 上一首提前收工 ⇒ 新会话首投丢 ~3.5s
  * bridge-flush        只能由冷启动 / 用户操作触发，切歌自触发 = 清掉设备存量
  * 曲末排空跳过         endUs 必须等于新曲 anchored base（零间隙）；Δ≠0 就是空洞
  * silenceChunks        >0 = 主动灌静音（covered 排空除外，那是设计内）
  * stall               非致命 stall 只告警；fatal 才允许断流重锚
  * 预取三链             v4.15.11 已整链删除，复活即回归

输入是 `docker logs -t` 过滤后的关键行（首列 ISO-8601 UTC 时间戳），
输出 [(level, metric, detail), ...]，退出码 0=PASS / 1=FAIL / 2=样本问题。
与 docs/曲中静音与曲末空洞-判定全流程-20261126.md §6 同源，改动需同步文档+selftest。
"""
import argparse
import datetime
import json
import os
import re
import sys

# 真机实测口径（2026-11-26 23:06:36 CST 重启后 12 分钟）：
# servo median=2.00s / max=2.25s，故 3s 是留出抖动的硬线。
SERVO_GAP_MAX_MS = 3000
# 冷启动首投 seek 每次容器生命周期仅一次；其余 reason 一律判回归。
COLD_START_SEEK_MAX = 1
COLD_START_REASON = "new-session-first-delivery"
# 短跑（8min/5 次切歌）与长跑（180min/60 次切歌）的样本量下限不同。
MODE_MIN_SERVO = {"short": 20, "long": 100}
# 允许出现的预取日志特征（v4.15.11 删除后应恒 0）
PREFETCH_MARKERS = ("next-prefetch", "bridge-prefetch", "bridge-track-keep")
# 非 covered 的灌静音才算缺口；covered 排空是设计内。
DRAIN_FILL_MARKER = "bridge-drain-fill-skip"
# v4.15.10 的「曲末排空跳过：赌预取接住曲末」捷径，v4.15.11 整链删除后必须恒 0。
# 旧版日志用 startTsUs=、新版用 endUs=；无论哪种格式，出现即回归。
SKIP_DRAIN_MARKER = "曲末排空跳过:下一首预取已就绪"


def to_epoch(s):
    s = s.rstrip("Z")
    if "." in s:
        base, frac = s.split(".")
        frac = (frac + "000000000")[:9]
    else:
        base, frac = s, "000000000"
    dt = datetime.datetime.strptime(base, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=datetime.timezone.utc)
    return dt.timestamp() + int(frac) / 1e9


def cst(ep):
    return (datetime.datetime.fromtimestamp(ep, datetime.timezone(datetime.timedelta(hours=8)))
            .strftime("%H:%M:%S"))


def judge(lines, mode="short", max_gap_ms=SERVO_GAP_MAX_MS,
          cold_seek_max=COLD_START_SEEK_MAX):
    """lines: 带时间戳的日志行。返回 [(level, metric, detail), ...]。"""
    out = []
    servos = []
    seeks = []
    flushes = []
    warm_cold = 0
    bad_fill = []
    silence = []
    fatal_stalls = []
    prefetch = []
    skip_drains = []
    pending_end = None
    joins = []
    bad_reason = []

    for line in lines:
        parts = line.split(None, 1)
        if len(parts) != 2:
            continue
        raw_ts, body = parts
        try:
            ep = to_epoch(raw_ts)
        except Exception:
            continue

        if "bridge-servo" in body:
            servos.append(ep)
        if "bridge-start-seek" in body:
            seeks.append((ep, body))
            if COLD_START_REASON not in body:
                bad_reason.append((ep, body))
        if "bridge-flush" in body or "RAOP FLUSH" in body:
            flushes.append((ep, body))
        if "warm=false" in body:
            warm_cold += 1
        if DRAIN_FILL_MARKER in body and "covered" not in body:
            bad_fill.append((ep, body))
        # tick JSON 里是 "silenceChunks":3（带引号），日志文本里是 silenceChunks=3
        if re.search(r'silenceChunks"?\s*[:=]\s*[1-9]', body):
            silence.append((ep, body))
        # 两级 stall：非致命已降级为告警，只有 fatal / 断流重锚算回归。
        if re.search(r"stall.*fatal|fatal.*stall|断流重锚|link stall", body, re.I):
            fatal_stalls.append((ep, body))
        if any(m in body for m in PREFETCH_MARKERS):
            prefetch.append((ep, body))
        if SKIP_DRAIN_MARKER in body:
            skip_drains.append((ep, body))

        m = re.search(r"曲末排空跳过:接续下一首.*next=([0-9a-f-]{8}).*endUs=(\d+)", body)
        if m:
            pending_end = (ep, m.group(1), int(m.group(2)))
            continue
        m2 = re.search(r"timeline anchored: base=(\d+)", body)
        if m2 and pending_end:
            base = int(m2.group(1))
            delta = base - pending_end[2]
            joins.append((pending_end[0], pending_end[1], delta))
            pending_end = None

    # 1. 泵活性
    minimum = MODE_MIN_SERVO.get(mode, MODE_MIN_SERVO["short"])
    out.append(("PASS" if len(servos) >= minimum else "FAIL", "servo.count",
                "n=%d min=%d" % (len(servos), minimum)))
    gaps = [(servos[i] - servos[i - 1]) * 1000.0 for i in range(1, len(servos))]
    max_gap = max(gaps) if gaps else float("inf")
    out.append(("PASS" if max_gap <= max_gap_ms else "FAIL", "servo.maxGapMs",
                "max=%.0fms limit=%.0fms" % (max_gap, max_gap_ms)))

    # 2. 首投 seek：只允许冷启动那一次
    out.append(("PASS" if len(seeks) <= cold_seek_max else "FAIL", "startSeek.count",
                "n=%d max=%d" % (len(seeks), cold_seek_max)))
    out.append(("PASS" if not bad_reason else "FAIL", "startSeek.reason",
                "bad=%d (只允许 %s)" % (len(bad_reason), COLD_START_REASON)))

    # 3. FLUSH：冷启动「起播一次 + 首投 seek 一次」各带一次合法 FLUSH，
    #    用户操作在本 CI 里不存在。上界 = warm=false 次数 + 冷启动 reason 的 seek 数。
    #    真机实测 23:06:50/23:06:53 两次 FLUSH 分别对应这两件事，不能只按 coldStart=1 判红。
    cold_seeks = sum(1 for _, body in seeks if COLD_START_REASON in body)
    flush_budget = warm_cold + cold_seeks
    out.append(("PASS" if len(flushes) <= flush_budget else "FAIL", "bridgeFlush.count",
                "n=%d budget=%d (coldStart=%d+coldSeek=%d)" %
                (len(flushes), flush_budget, warm_cold, cold_seeks)))

    # 4. 曲末零间隙：所有 continuity 接续的 endUs 必须等于新曲 base
    nonzero = [j for j in joins if j[2] != 0]
    detail = "joins=%d nonzero=%d" % (len(joins), len(nonzero))
    if nonzero:
        detail += " first=%s Δ=%dus" % (nonzero[0][1], nonzero[0][2])
    out.append(("PASS" if not nonzero else "FAIL", "trackJoin.zeroGap", detail))
    if not joins:
        # CI 手动 POST /next 不一定走到曲末自然结束，拿不到 continuity 证据。
        # 此时不能把「没有反例」写成「判据生效了」，显式留一条覆盖缺口。
        out.append(("WARN", "trackJoin.coverage",
                    "无 continuity 接续证据（手动 next 不触发曲末自然结束）；本次零间隙判据未生效"))

    # 5~7. 灌静音 / fatal stall / 预取复活
    out.append(("PASS" if not bad_fill and not silence else "FAIL", "audibleGap.count",
                "drainFill=%d silenceChunks=%d" % (len(bad_fill), len(silence))))
    out.append(("PASS" if not fatal_stalls else "FAIL", "stall.fatal",
                "n=%d (非致命告警不计)" % len(fatal_stalls)))
    out.append(("PASS" if not prefetch else "FAIL", "prefetch.removed",
                "n=%d markers=%s" % (len(prefetch), ",".join(PREFETCH_MARKERS))))
    # 跳过排空捷径：D5 曲末空洞直接根因，旧版可见、新版必须恒 0
    out.append(("PASS" if not skip_drains else "FAIL", "drainSkip.removed",
                "n=%d (曲末赌预取捷径复活)" % len(skip_drains)))

    # 明细：失败项附首条上下文，便于 CI summary 直接定位
    evid = {
        "startSeek.count": seeks[:3], "startSeek.reason": bad_reason[:3],
        "bridgeFlush.count": flushes[:3], "audibleGap.count": (bad_fill + silence)[:3],
        "stall.fatal": fatal_stalls[:3], "prefetch.removed": prefetch[:3],
        "drainSkip.removed": skip_drains[:3],
    }
    for level, metric, detail in out:
        if level == "FAIL" and metric in evid:
            for ep, body in evid[metric]:
                out.append(("INFO", "  " + metric + "@" + cst(ep), body[:200]))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--input", required=True, help="docker logs -t 过滤后的关键行文件")
    ap.add_argument("--mode", choices=("short", "long"), default="short")
    ap.add_argument("--max-servo-gap-ms", type=int, default=SERVO_GAP_MAX_MS)
    ap.add_argument("--cold-seek-max", type=int, default=COLD_START_SEEK_MAX)
    ap.add_argument("--out", help="可选：判读 JSON 输出路径")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args(argv)

    if not os.path.exists(a.input):
        print("SAMPLE_MISSING %s" % a.input)
        return 2
    try:
        with open(a.input, encoding="utf-8", errors="replace") as f:
            lines = f.read().splitlines()
    except Exception as e:
        print("SAMPLE_INVALID %s: %s" % (a.input, e))
        return 2

    res = judge(lines, mode=a.mode, max_gap_ms=a.max_servo_gap_ms,
                cold_seek_max=a.cold_seek_max)
    fails = [r for r in res if r[0] == "FAIL"]
    verdict = "FAIL" if fails else "PASS"
    if not a.quiet:
        print("== 播放侧硬判据（%s） ==" % a.mode)
        for level, metric, detail in res:
            print("  %-4s %-24s %s" % (level, metric, detail))
    print("PLAYBACK_SIDE %s FAIL=%d/%d" % (verdict, len(fails), len(res)))
    if a.out:
        with open(a.out, "w", encoding="utf-8") as f:
            json.dump({"verdict": verdict, "mode": a.mode,
                       "checks": [{"level": r[0], "metric": r[1], "detail": r[2]} for r in res]},
                      f, ensure_ascii=False, indent=2)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
