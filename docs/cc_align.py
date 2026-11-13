#!/usr/bin/env python3
"""跨端 PCM 互相关对齐判定（AirPlay 桥接验收用）。

用法：
  cc_align.py --selftest
  cc_align.py <a.pcm> <b.pcm> [--rate 48000] [--window 10]

语义：delta_ms > 0 表示 a 比 b **晚** delta_ms 播。
判据：|delta| <= 20ms 且 quality >= 0.2 才 PASS。

为什么不用 np.correlate：
  1) 10s@48k = 480k 点，O(n^2) 直接算不可接受；
  2) FFT 卷积结果是**循环序列**，负 lag 落在尾部，必须 wrap 回来，
     否则峰位会被映射到镜像位置（实测给出 −2862.98ms 假值，真值 +137ms）。
"""
import argparse
import sys

import numpy as np


def fft_delta(a: np.ndarray, b: np.ndarray, rate: int, window_s: float = 10.0):
    """返回 (delta_ms, quality)。delta_ms > 0 表示 a 比 b 晚。"""
    w = int(rate * window_s)
    if len(a) >= w:
        a = a[-w:]
    if len(b) >= w:
        b = b[-w:]
    n = len(a) + len(b)
    n = 1 << (n - 1).bit_length()          # 取 2 的幂，FFT 更快
    a = a - a.mean()
    b = b - b.mean()
    cc = np.fft.irfft(np.fft.rfft(a, n) * np.conj(np.fft.rfft(b, n)), n)
    lags = np.arange(n)
    lags = np.where(lags > n // 2, lags - n, lags)   # 🔴 wrap-aware，缺此行就是假峰位
    k = int(np.argmax(cc))
    lag = int(lags[k])
    denom = float(np.sqrt((a * a).sum() * (b * b).sum())) or 1.0
    return lag / rate * 1000.0, float(cc[k]) / denom


def load_pcm(path: str, channels: int = 2) -> np.ndarray:
    """读 interleaved PCM 并降混为单声道帧序列。

    🔴 必须降混：RAOP/sendspin 落盘都是 **交织立体声**，1 frame = channels 个 sample。
    直接把交织序列当单声道做互相关，lag 的单位是 sample 而不是 frame，
    换算时会**恰好差 channels 倍**（实测 137ms 位移被算成 274ms）。
    """
    a = np.fromfile(path, dtype="<i2").astype(np.float64)
    if a.size == 0:
        raise SystemExit(f"EMPTY: {path}")
    if channels > 1:
        a = a[: a.size - (a.size % channels)].reshape(-1, channels).mean(axis=1)
    return a


def selftest() -> None:
    rate = 48000
    rng = np.random.default_rng(7)
    src = rng.standard_normal(rate * 2)
    # a 比 b 晚 137ms（a 头部补零，等价于 a 的内容整体后移）
    shift = int(rate * 0.137)
    b = src
    a = np.concatenate([np.zeros(shift), src])[: len(src)]
    got, q = fft_delta(a, b, rate)
    assert abs(got - 137.0) < 0.5, f"self-test FAILED: {got:.1f} ms (expect +137.0)"
    assert q >= 0.2, f"self-test quality too low: {q}"
    print(f"[selftest] OK  delta={got:.1f} ms  quality={q:.3f}")

    # 反号自检：b 比 a 晚 ⇒ 必须输出负值。防止 lag 符号整体写反。
    got2, q2 = fft_delta(b, a, rate)
    assert abs(got2 + 137.0) < 0.5, f"sign self-test FAILED: {got2:.1f} ms (expect -137.0)"
    print(f"[selftest] OK  reversed delta={got2:.1f} ms  quality={q2:.3f}")


def selftest_stereo() -> None:
    """走完整 interleaved 路径的回归：立体验证声道折算没写错。

    这是本轮真机踩到的坑：不降混时 137ms 会被算成 274ms（恰好 channels 倍）。
    """
    rate, ch = 48000, 2
    rng = np.random.default_rng(11)
    left = rng.standard_normal(rate * 2)
    right = rng.standard_normal(rate * 2)
    src = np.stack([left, right], axis=1).reshape(-1)      # interleaved
    shift_frames = int(rate * 0.137)
    shifted = np.concatenate(
        [np.zeros(shift_frames * ch), src]
    )[: src.size]
    mono_a = load_pcm_arr(shifted, ch)
    mono_b = load_pcm_arr(src, ch)
    got, q = fft_delta(mono_a, mono_b, rate)
    assert abs(got - 137.0) < 0.5, f"stereo self-test FAILED: {got:.1f} ms (expect +137.0)"
    print(f"[selftest] OK  stereo delta={got:.1f} ms  quality={q:.3f}")


def load_pcm_arr(a: np.ndarray, channels: int = 2) -> np.ndarray:
    """load_pcm 的数组版（供自检复用同一降混逻辑，避免两套实现漂移）。"""
    if channels > 1:
        a = a[: a.size - (a.size % channels)].reshape(-1, channels).mean(axis=1)
    return a.astype(np.float64)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("a", nargs="?")
    ap.add_argument("b", nargs="?")
    ap.add_argument("--rate", type=int, default=48000, help="采样率(frame/s)")
    ap.add_argument("--channels", type=int, default=2, help="声道数，落盘 PCM 默认 2")
    ap.add_argument("--window", type=float, default=10.0)
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()

    # 🔴 自检永远先跑：脚本坏了，任何 delta 数字都不是证据
    selftest()
    selftest_stereo()
    if args.selftest or not args.a or not args.b:
        return 0

    a = load_pcm(args.a, args.channels)
    b = load_pcm(args.b, args.channels)
    print(f"a={args.a} frames={a.size} ({a.size / args.rate:.2f}s @ {args.rate}/{args.channels}ch)")
    print(f"b={args.b} frames={b.size} ({b.size / args.rate:.2f}s @ {args.rate}/{args.channels}ch)")

    # 两侧必须同源同长：尾窗取的是"各自最后 N 秒"，长度不同 ⇒ 时间段不对应 ⇒ 假峰位
    diff_s = abs(a.size - b.size) / args.rate
    if diff_s > 1.0:
        print(
            f"WARN: 两侧长度差 {diff_s:.2f}s —— 尾窗内容不对应，峰位可能是重复段落的巧合",
            file=sys.stderr,
        )

    d, q = fft_delta(a, b, args.rate, args.window)
    ok = abs(d) <= 20.0 and q >= 0.2
    print(f"delta_ms = {d:+.1f}   quality = {q:.3f}")
    print(f"JUDGE: {'PASS' if ok else 'FAIL'}")
    if q < 0.2:
        print("WARN: quality < 0.2 —— 峰位是噪声，禁止据此下结论", file=sys.stderr)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
