// 桥接会话「内容时钟」契约测试(2026-10-24)。
//
// 为什么需要这组用例:
//   群组播放时 AirPlay 成员走桥接(RAOP 会话 + BridgeRing,内容来自 sendspin pump)。
//   桥接会话的**会话开始**与**pump 起播**不是同一时刻 —— 实测 230-r1 建会话
//   22:24:20.8、pump 22:24:29.5,空转 8.4s。旧实现用「本会话已过时长」上报位置,
//   于是这段空转被算成已播内容:该成员上报位置比组超前 8.4s,同组另一台只超前 0.6s
//   (各自握手完成时刻不同 ⇒ 各偏各的),群组同步的观测口径直接被污染。
//   修法是把桥接会话的上报位置改成 **pump 内容时间线**(BridgeRing.contentSec),
//   与组位置、其他成员同源。以下三条用例锁死这条口径,另一条锁环的行为。
// MUST be the first import: re-exports the isolated DATA_DIR env for this file.
import "../plugins/_env.js";

import { describe, it, expect } from "vitest";
import { CliSink } from "../../src/services/airplay/ap2/cliSink.js";
import { BridgeRing } from "../../src/services/airplay/bridgeRing.js";

/** 只构造、不启动:positionSec 只依赖 a.contentClock / baseSec / t0Us,不碰进程。 */
function makeSink(contentClock?: () => number | null): CliSink {
  const args: Record<string, unknown> = {
    deviceId: "dev-x",
    host: "127.0.0.1",
    port: 7000,
    protocol: "airplay2",
    makeProducer: () => async () => null,
    binPath: "/bin/true",
  };
  if (contentClock) args.contentClock = contentClock;
  return new CliSink(args as never);
}

describe("桥接会话的位置口径(pump 内容时间线)", () => {
  it("注入了 contentClock ⇒ 位置按内容时钟报,而不是会话已过时长", () => {
    const sink = makeSink(() => 12.5);
    // 旧实现没有 pump 起播(t0Us=0)时恒返回 0;修好后必须如实报内容时钟。
    expect(sink.positionSec).toBeCloseTo(12.5, 6);
  });

  it("pump 还没送第一帧(contentClock 返回 null)⇒ 回落到原时间线且不抛错", () => {
    const sink = makeSink(() => null);
    expect(sink.positionSec).toBe(0);
  });

  it("非桥接会话(没有 contentClock)⇒ 行为完全不变", () => {
    const sink = makeSink();
    expect(sink.positionSec).toBe(0);
  });

  it("contentClock 给出负值/NaN ⇒ 夹到 0,不把进度条画到负数", () => {
    expect(makeSink(() => -3).positionSec).toBe(0);
    expect(makeSink(() => Number.NaN).positionSec).toBe(0);
  });
});

describe("BridgeRing.contentSec(内容时间线的 0 点 = pump 首帧)", () => {
  it("首帧之前为 null(调用方据此回落到旧口径),push 之后才开始计时", () => {
    const ring = new BridgeRing("t");
    expect(ring.contentSec).toBeNull();
    // 用与 ring 内部 nowUs() 同源的单调时钟当 tsUs,内容时钟才会从 ~0 起算。
    const tsUs = process.hrtime.bigint() / 1000n;
    ring.push(tsUs, Buffer.alloc(4 * 480)); // 480 帧(48k) = 10ms
    const sec = ring.contentSec;
    expect(sec).not.toBeNull();
    expect(sec as number).toBeGreaterThanOrEqual(0);
    expect(sec as number).toBeLessThan(5);
  });

  it("reset(切歌/seek)后回到 null,不会带着上一首的内容位置继续报", () => {
    const ring = new BridgeRing("t");
    ring.push(process.hrtime.bigint() / 1000n, Buffer.alloc(4 * 480));
    expect(ring.contentSec).not.toBeNull();
    ring.reset();
    expect(ring.contentSec).toBeNull();
  });
});
