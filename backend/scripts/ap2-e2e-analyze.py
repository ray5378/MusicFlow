#!/usr/bin/env python3
"""AP2 床端整链路 PCM 比对 / 量化（Phase 6b 批 4 手动工具，CI 不跑）。

用法：
    python3 scripts/ap2-e2e-analyze.py <in.pcm> <out.pcm> --rate 48000 [--spf 352] [--channels 2] [--json]

纯标准库实现（床侧 ap2venv 无 numpy，不引入安装依赖）：
  1. 时长/峰值/RMS：out 帧数换算秒，与 in 比（判断是否被「加速/拉伸」）；
  2. FFT（自实现基-2，65536 点 Hann 窗）：双音 440Hz + 1000Hz 的实测主峰与幅度，
     量化频率偏差（替代过零率 ±几 % 的粗估）；
  3. 包重复检测：out 切 spf 帧块，统计相邻块全同/近同比例 + 首末重复秒位，
     区分「启动期抖动缓冲重复」与「全程持续重复」；
  4. 对齐比对：用 16KB 探针在 in 里做字节级 find（重采样/丢包时找不到），
     命中即做逐字节比较（exact_match）；未命中则退化为能量包络互相关定 lag，
     再在该 lag 上算归一化互相关 ncc 与残差 RMS。

判读（lead 定的容差口径）：
  - escape ALAC 直通（无重采样）：exact_match=true，matched_ratio≈1.0；
  - 44.1k 重采样：exact_match 必为 false，看 ncc（>0.99 视为链路无损）与 rms_diff；
  - 时长比 < 1 说明 bed 侧有丢包/丢帧（另一类问题，不在编码链路）；
  - 重复率高且集中在启动前几秒 = 抖动缓冲启动假象；全程持续 = 我们 seq/ts/pacing 问题。
"""
from __future__ import annotations

import argparse
import array
import json
import math
import sys


def read_pcm(path: str, channels: int):
    """读 s16le 交织 PCM → (左声道 array('h'), 立体声原始 bytes, 帧数)。"""
    with open(path, "rb") as f:
        raw = f.read()
    if not raw:
        raise SystemExit(f"空文件：{path}")
    samples = array.array("h")
    samples.frombytes(raw[: (len(raw) // (2 * channels)) * 2 * channels])
    if sys.byteorder != "little":
        samples.byteswap()
    left = samples[0::channels]
    return left, raw, len(left)


def peak_of(x) -> int:
    if not x:
        return 0
    return max(max(x), -min(x))


def rms_of(x) -> float:
    if not x:
        return 0.0
    acc = 0.0
    for v in x:
        acc += float(v) * float(v)
    return math.sqrt(acc / len(x))


def fft_inplace(re, im) -> None:
    """迭代基-2 FFT（原地）。"""
    n = len(re)
    j = 0
    for i in range(1, n):
        bit = n >> 1
        while j & bit:
            j ^= bit
            bit >>= 1
        j |= bit
        if i < j:
            re[i], re[j] = re[j], re[i]
            im[i], im[j] = im[j], im[i]
    length = 2
    while length <= n:
        ang = -2.0 * math.pi / length
        wr, wi = math.cos(ang), math.sin(ang)
        half = length >> 1
        for start in range(0, n, length):
            cr, ci = 1.0, 0.0
            for k in range(start, start + half):
                ur, ui = re[k], im[k]
                kr = k + half
                vr = re[kr] * cr - im[kr] * ci
                vi = re[kr] * ci + im[kr] * cr
                re[k], im[k] = ur + vr, ui + vi
                re[kr], im[kr] = ur - vr, ui - vi
                cr, ci = cr * wr - ci * wi, cr * wi + ci * wr
        length <<= 1


def analyze_freq(x, rate: int, top: int = 4, n: int = 65536):
    """Hann 窗 + 基-2 FFT，返回主峰（抛物线插值细化）。"""
    if len(x) < n:
        n = 1 << int(math.floor(math.log2(max(1024, len(x)))))
    if n < 1024:
        return {"error": "样本太少，无法做 FFT"}
    start = (len(x) - n) // 2
    re = [0.0] * n
    im = [0.0] * n
    for i in range(n):
        w = 0.5 - 0.5 * math.cos(2.0 * math.pi * i / (n - 1))
        re[i] = float(x[start + i]) * w
    fft_inplace(re, im)
    half = n >> 1
    mag = [0.0] * half
    for i in range(half):
        mag[i] = math.hypot(re[i], im[i])
    bin_hz = rate / n
    peaks = []
    used: list[int] = []
    order = sorted(range(2, half), key=lambda i: mag[i], reverse=True)
    for i in order:
        if any(abs(i - u) <= 3 for u in used):
            continue
        used.append(i)
        a, b, c = mag[i - 1], mag[i], mag[i + 1]
        denom = a - 2.0 * b + c
        delta = 0.5 * (a - c) / denom if denom != 0 else 0.0
        peaks.append({
            "freq": round((i + delta) * bin_hz, 3),
            "mag": round(b, 1),
            "bin": i,
        })
        if len(peaks) >= top:
            break
    return {"window_frames": n, "bin_hz": round(bin_hz, 4), "peaks": peaks}


def dup_blocks(x, rate: int, spf: int):
    """相邻 spf 帧块全同/近同统计（bed 重复包会留下完全相同的块）。"""
    n = len(x) // spf
    if n < 2:
        return {"blocks": n, "error": "块数不足"}
    blocks = [x[i * spf : (i + 1) * spf] for i in range(n)]
    exact = 0
    near = 0
    first_dup = None
    last_dup = None
    for i in range(n - 1):
        a, b = blocks[i], blocks[i + 1]
        if a == b:
            exact += 1
            sec = round(i * spf / rate, 3)
            if first_dup is None:
                first_dup = sec
            last_dup = sec
            continue
        m = 0
        for k in range(spf):
            d = a[k] - b[k]
            if d < 0:
                d = -d
            if d > m:
                m = d
                if m > 2:
                    break
        if m <= 2:
            near += 1
    return {
        "blocks": n,
        "exact_dup_pairs": exact,
        "near_dup_pairs": near,
        "exact_dup_ratio": round(exact / (n - 1), 4),
        "first_dup_s": first_dup,
        "last_dup_s": last_dup,
    }


def first_audible(x, thresh: int = 200) -> int:
    for i, v in enumerate(x):
        if abs(v) > thresh:
            return i
    return 0


def envelope(x, win: int):
    env = []
    for i in range(0, len(x) - win + 1, win):
        acc = 0.0
        for k in range(i, i + win):
            v = float(x[k])
            acc += v * v
        env.append(math.sqrt(acc / win))
    return env


def ncc_at(x, y, lag: int, limit: int = 480_000):
    """在给定采样 lag 上算归一化互相关（限长控制耗时）。"""
    if lag >= 0:
        u = x[lag : lag + limit]
        v = y[: len(u)]
    else:
        v = y[-lag : -lag + limit]
        u = x[: len(v)]
    n = min(len(u), len(v))
    if n < 1024:
        return 0.0, 0.0, 0
    u = u[:n]
    v = v[:n]
    mu = sum(u) / n
    mv = sum(v) / n
    suu = svv = suv = 0.0
    for i in range(n):
        du = u[i] - mu
        dv = v[i] - mv
        suu += du * du
        svv += dv * dv
        suv += du * dv
    denom = math.sqrt(suu * svv)
    ncc = suv / denom if denom > 0 else 0.0
    return ncc, math.sqrt(suu / n), n


def compare_exact(in_raw: bytes, out_raw: bytes, channels: int, rate: int):
    """16KB 探针在 in 里字节级搜索 → 命中做逐字节比较。"""
    probe_len = 16384
    frame_bytes = 2 * channels
    # 跳过 out 头部静音（bed 抖动缓冲起步会先写 0）
    skip_frames = 0
    for i in range(0, min(len(out_raw) // frame_bytes, rate)):
        chunk = out_raw[i * frame_bytes : (i + 1) * frame_bytes]
        if any(b not in (0,) for b in chunk):
            skip_frames = i
            break
    off_bytes = skip_frames * frame_bytes
    if off_bytes + probe_len > len(out_raw):
        return {"probe": "too_short"}
    probe = out_raw[off_bytes : off_bytes + probe_len]
    hit = in_raw.find(probe)
    if hit < 0 or hit % frame_bytes != 0:
        return {"probe": "not_found", "out_offset_frames": skip_frames}
    lag_frames = (off_bytes - hit) // frame_bytes
    n = min(len(in_raw) - hit, len(out_raw) - off_bytes)
    n -= n % frame_bytes
    a = in_raw[hit : hit + n]
    b = out_raw[off_bytes : off_bytes + n]
    matched = sum(1 for i in range(0, n, 97) if a[i : i + 97] == b[i : i + 97]) * 97
    mismatch = -1
    for i in range(0, n, 128):
        if a[i : i + 128] != b[i : i + 128]:
            for j in range(i, min(i + 128, n)):
                if a[j] != b[j]:
                    mismatch = j
                    break
            break
    exact = a == b
    return {
        "probe": "found",
        "lag_frames": lag_frames,
        "lag_ms": round(lag_frames / rate * 1000, 3),
        "out_lead_silence_s": round(skip_frames / rate, 4),
        "compared_frames": n // frame_bytes,
        "exact_match": exact,
        "matched_ratio_approx": round(matched / n, 6),
        "first_mismatch_frame": (mismatch // frame_bytes) if mismatch >= 0 else None,
    }


def compare_envelope(in_left, out_left, rate: int):
    """能量包络互相关定粗 lag（重采样/丢包场景），再在 raw 上给 ncc。"""
    win = max(1, rate // 100)  # 10ms
    ea = envelope(in_left, win)
    eb = envelope(out_left, win)
    if not ea or not eb:
        return {"error": "包络为空"}
    max_lag = min(400, max(0, len(eb) - 1))
    mua = sum(ea[:4000]) / max(1, len(ea[:4000]))
    best = (0.0, 0)
    for lag in range(0, max_lag + 1):
        n = min(len(ea), len(eb) - lag)
        if n < 100:
            break
        dot = 0.0
        na = 0.0
        nb = 0.0
        for i in range(0, n, 1):
            a = ea[i] - mua
            b = eb[i + lag] - mua
            dot += a * b
            na += a * a
            nb += b * b
        denom = math.sqrt(na * nb)
        score = dot / denom if denom > 0 else 0.0
        if score > best[0]:
            best = (score, lag)
    lag_samples = best[1] * win
    ncc, rms_diff, n = ncc_at(in_left, out_left, lag_samples)
    return {
        "envelope_win_ms": round(win / rate * 1000, 2),
        "envelope_score": round(best[0], 4),
        "lag_frames": lag_samples,
        "lag_ms": round(lag_samples / rate * 1000, 3),
        "ncc": round(ncc, 6),
        "rms_diff": round(rms_diff, 3),
        "compared_frames": n,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("in_pcm")
    ap.add_argument("out_pcm")
    ap.add_argument("--rate", type=int, default=48000)
    ap.add_argument("--in-rate", type=int, default=0, help="输入 PCM 速率（重采样路径时与 --rate 不同）")
    ap.add_argument("--spf", type=int, default=352)
    ap.add_argument("--channels", type=int, default=2)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    in_left, in_raw, in_frames = read_pcm(args.in_pcm, args.channels)
    out_left, out_raw, out_frames = read_pcm(args.out_pcm, args.channels)
    rate = args.rate
    in_rate = args.in_rate or rate
    same_rate = in_rate == rate

    report: dict = {
        "rate": rate,
        "in_rate": in_rate,
        "spf": args.spf,
        "channels": args.channels,
        "in": {
            "frames": in_frames,
            "seconds": round(in_frames / in_rate, 4),
            "peak": peak_of(in_left),
            "rms": round(rms_of(in_left), 3),
        },
        "out": {
            "frames": out_frames,
            "seconds": round(out_frames / rate, 4),
            "peak": peak_of(out_left),
            "rms": round(rms_of(out_left), 3),
        },
    }
    report["out"]["duration_ratio_vs_in"] = (
        round(report["out"]["seconds"] / report["in"]["seconds"], 5)
        if report["in"]["seconds"] else None
    )
    report["freq"] = analyze_freq(out_left, rate)
    report["freq_in"] = analyze_freq(in_left, in_rate)
    report["dup"] = dup_blocks(out_left, rate, args.spf)
    if same_rate:
        exact = compare_exact(in_raw, out_raw, args.channels, rate)
        report["align"] = exact
        if exact.get("probe") != "found" or not exact.get("exact_match"):
            report["align_env"] = compare_envelope(in_left, out_left, rate)
    else:
        report["align"] = {
            "probe": "skipped",
            "reason": f"速率不同（in={in_rate} out={rate}）：按 FFT 主峰 + RMS + 时长比判定",
        }
        report["align_env"] = {
            "rms_in": round(rms_of(in_left), 3),
            "rms_out": round(rms_of(out_left), 3),
            "rms_ratio": (round(rms_of(out_left) / rms_of(in_left), 5)
                          if rms_of(in_left) else None),
        }

    print(json.dumps(report, ensure_ascii=False, indent=2))
    if args.json:
        return 0

    print("\n=== 结论速读 ===")
    exact = report.get("align")
    f = report["freq"]
    if isinstance(f, dict) and "peaks" in f:
        tops = ", ".join(f"{p['freq']}Hz" for p in f["peaks"][:3])
        print(f"· out 主峰：{tops}（in 主峰：" + ", ".join(
            f"{p['freq']}Hz" for p in report["freq_in"].get("peaks", [])[:3]) + "）")
    d = report["dup"]
    if isinstance(d, dict) and "exact_dup_ratio" in d:
        print(f"· 相邻块重复率={d['exact_dup_ratio']}（{d['exact_dup_pairs']}/{d['blocks'] - 1}），"
              f"首次={d['first_dup_s']}s 末次={d['last_dup_s']}s")
    print(f"· out 时长={report['out']['seconds']}s  比值={report['out']['duration_ratio_vs_in']}")
    if exact is not None and exact.get("probe") == "found":
        print(f"· 字节对齐 lag={exact['lag_ms']}ms 逐字节一致={exact['exact_match']} "
              f"近似匹配率={exact['matched_ratio_approx']} 首错帧={exact['first_mismatch_frame']}")
    if "align_env" in report:
        e = report["align_env"]
        if "rms_ratio" in e:
            print(f"· 速率不同：RMS in={e['rms_in']} out={e['rms_out']} 比值={e['rms_ratio']}")
        else:
            print(f"· 包络对齐 lag={e.get('lag_ms')}ms env_score={e.get('envelope_score')} "
                  f"ncc={e.get('ncc')} rms_diff={e.get('rms_diff')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
