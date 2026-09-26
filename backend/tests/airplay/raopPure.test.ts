// RAOP 纯函数契约测试(协议层的时间轴换算 + ALAC 裸流编码)。
// 为什么单独测:raop.ts 整体 547 行里 socket/RTSP 会话需要真设备才跑得动,而
// 时间轴换算错了的表现是「进度条位置对不上 / 多端不同步 / seek 后跳回」—— 这类
// bug 只能靠纯函数断言拦住。
// MUST be the first import: re-exports the isolated DATA_DIR env for this file.
import "../plugins/_env.js";

import { describe, it, expect } from "vitest";
import {
  SAMPLE_RATE,
  CHUNK_LEN,
  PCM_BYTES_PER_CHUNK,
  RAOP_LATENCY_MIN,
  NTP_EPOCH_DELTA,
  ntpNow,
  ntpFromDate,
  ts2ntp,
  ntp2ts,
  ms2ts,
  ts2ms,
  ntpToMs,
  seekStartTs,
  seekPositionSec,
  pcmToAlacRaw,
} from "../../src/services/airplay/raop.js";

describe("RAOP 常量(与 libraop 对齐,改动即协议不兼容)", () => {
  it("采样参数固定 44.1k/16bit/立体声,每包 352 帧", () => {
    expect(SAMPLE_RATE).toBe(44100);
    expect(CHUNK_LEN).toBe(352);
    expect(PCM_BYTES_PER_CHUNK).toBe(352 * 2 * 2);
    expect(RAOP_LATENCY_MIN).toBe(11025);
    expect(NTP_EPOCH_DELTA).toBe(2208988800);
  });
});

describe("NTP 换算", () => {
  it("ntpFromDate(epoch 0) = NTP 纪元秒数(1900→1970 = 2208988800)", () => {
    const ntp = ntpFromDate(new Date(0));
    expect(ntp >> 32n).toBe(BigInt(NTP_EPOCH_DELTA));
  });

  it("ntpToMs:整秒 NTP → 毫秒", () => {
    expect(ntpToMs(0n)).toBe(0);
    expect(ntpToMs(1n << 32n)).toBe(1000);
  });

  it("ts2ntp/ntp2ts 往返一致(1 秒 = 44100 帧)", () => {
    const ntp = ts2ntp(44100, 44100);
    expect(ntp2ts(ntp, 44100)).toBe(44100);
  });

  it("ms2ts/ts2ms 往返一致", () => {
    expect(ms2ts(1000, 44100)).toBe(44100);
    expect(ts2ms(44100, 44100)).toBe(1000);
  });

  it("ntpNow 单调递增(设备只消费 NTP 差值,回退会让同步崩掉)", () => {
    const a = ntpNow();
    const b = ntpNow();
    expect(typeof a).toBe("bigint");
    expect(b).toBeGreaterThanOrEqual(a);
  });
});

describe("seek 时间轴锚定", () => {
  it("seekStartTs:目标帧按 chunk 长度向下对齐(44000 = 125×352)", () => {
    // 1 秒 = 44100 帧,44100 % 352 = 100 → 对齐到 44000
    expect(seekStartTs(1000, 1, 44100, 352)).toBe(45000);
  });

  it("seekStartTs:负 seek 视为 0(不允许时间轴倒退到基准之前)", () => {
    expect(seekStartTs(1000, -5, 44100, 352)).toBe(1000);
  });

  it("seekStartTs:结果按 uint32 回绕(RTP 时间戳是 32 位)", () => {
    const wrapped = seekStartTs(4_294_967_000, 1, 44100, 352);
    expect(wrapped).toBeGreaterThanOrEqual(0);
    expect(wrapped).toBeLessThanOrEqual(0xffffffff);
  });

  it("seekPositionSec:发 N 包后的内容位置 = (start + N×chunk - base)/rate", () => {
    const pos = seekPositionSec(1000, 45000, 0, 352, 44100);
    expect(pos).toBeCloseTo(44000 / 44100, 2);
    const after10 = seekPositionSec(1000, 45000, 10, 352, 44100);
    expect(after10).toBeCloseTo((44000 + 3520) / 44100, 2);
  });
});

describe("pcmToAlacRaw(裸 ALAC 位打包)", () => {
  // 实现返回 out.subarray(0, p+1):头部 7 字节 + (bsize-1)×4 + 尾部 4 = bsize*4+8。
  it("输出长度 = bsize*4 + 8,头部标识位固定,末字节为结束标记", () => {
    const bsize = CHUNK_LEN;
    const pcm = Buffer.alloc(bsize * 4);
    const out = pcmToAlacRaw(pcm, bsize, bsize);
    expect(out.length).toBe(bsize * 4 + 8);
    expect(out[0]).toBe(1 << 5);
    expect(out[1]).toBe(0);
    expect(out[2]).toBe((1 << 4) | (1 << 1));
    expect(out[out.length - 1]).toBe((7 >> 1) << 6);
  });

  it("静音输入可编码且输出确定(同输入同输出)", () => {
    const pcm = Buffer.alloc(64 * 4);
    const a = pcmToAlacRaw(pcm, 64, 64);
    const b = pcmToAlacRaw(pcm, 64, 64);
    expect(a.length).toBe(64 * 4 + 8);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("frames 小于 bsize:不足部分补零,长度仍按 bsize 计且不越界", () => {
    const pcm = Buffer.alloc(10 * 4);
    const out = pcmToAlacRaw(pcm, 10, 352);
    expect(out.length).toBe(352 * 4 + 8);
    // 尾部零填充区应为 0(未写入脏数据)
    expect(out[out.length - 10]).toBe(0);
  });

  it("非零采样会改变输出位流(编码器确实在打包数据)", () => {
    const bsize = 64;
    const silence = Buffer.alloc(bsize * 4);
    const tone = Buffer.alloc(bsize * 4);
    for (let i = 0; i < bsize * 2; i++) tone.writeUInt16LE(0x7f00, i * 2);
    expect(Buffer.from(pcmToAlacRaw(tone, bsize, bsize)).equals(
      Buffer.from(pcmToAlacRaw(silence, bsize, bsize)),
    )).toBe(false);
  });
});
