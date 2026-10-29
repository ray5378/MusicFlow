// A(垫片窗静音续流)+ B(消费停滞看门狗)回归:
// 2026-10-29 240 实证:换歌垫片窗(~2.5-3s)RTP 完全断流 ⇒ MUZO 接收端反复饿到
// 假死(零 timing/零重传)⇒ 永久无声,只有完整重握手能唤醒。
//   A = fillGapSilence:垫片窗内 8ms 节拍续发静音(seq 连续/时间戳续走/无 SYNC),
//       结束复位 started ⇒ 新流真·首包仍带 0xE0 marker(与 primeSilence 同语义)。
//   B = livenessWatchdogShouldFire 纯判据 + env 开关/阈值。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RaopPlayer, CHUNK_LEN } from "../../src/services/airplay/raop.js";
import {
  livenessWatchdogShouldFire,
  raopBridgeGapFillEnabled,
  raopBridgeLivenessMs,
  raopBridgeLivenessWatchdogEnabled,
} from "../../src/services/airplay/bridgeSession.js";

type Any = any;

function mkPlayer(): Any {
  return new RaopPlayer({ host: "127.0.0.1", port: 5000 }) as Any;
}

function fakeSocket(sent: Any[]) {
  return { send: (...a: Any[]) => { sent.push(a); } };
}

describe("RaopPlayer.fillGapSilence(垫片窗静音续流)", () => {
  it("端口未解析(0)→ 不发包、返回 0(与 primeSilence 同守卫)", async () => {
    const p = mkPlayer();
    const sent: Any[] = [];
    p.audioSocket = fakeSocket(sent);
    p.serverAudioPort = 0;
    const n = await p.fillGapSilence({ shouldStop: () => false, maxMs: 30 });
    expect(n).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("maxMs 窗口内按节拍续发静音:seq 连续、时间戳每块 +CHUNK_LEN、首包带 marker", async () => {
    const p = mkPlayer();
    const sent: Any[] = [];
    p.audioSocket = fakeSocket(sent);
    p.serverAudioPort = 6000;
    p.headTs = 100000;
    const n = await p.fillGapSilence({ shouldStop: () => false, maxMs: 40 });
    expect(n).toBeGreaterThanOrEqual(1);
    expect(sent.length).toBe(n);
    for (let i = 0; i < sent.length; i++) {
      const pkt = sent[i][0] as Buffer;
      // RTP 头 12B + ALAC 帧(CHUNK_LEN*4 + 8B 帧头);逐包一致即可
      expect(pkt.length).toBe(sent[0][0].length);
      if (i > 0) {
        // seq 连续(+1,模 65536;初值随机,只验连续性)
        const prev = sent[i - 1][0].readUInt16BE(2);
        expect(pkt.readUInt16BE(2)).toBe((prev + 1) & 0xffff);
      }
    }
    // 首包带 marker(0x60|0x80),后续不带(旧时间线上 filler 的首个包也是 marker,
    // 与 primeSilence 同语义 —— flush 后 started=false)。
    expect(sent[0][0][1]).toBe(0xe0);
    if (sent.length > 1) expect(sent[1][0][1]).toBe(0x60);
    // 时间戳续走:第 i 包 ts = 100000 + i*CHUNK_LEN
    for (let i = 0; i < sent.length; i++) {
      expect(sent[i][0].readUInt32BE(4)).toBe((100000 + i * CHUNK_LEN) >>> 0);
    }
    // 结束复位 started ⇒ 新流真·首包仍带 marker 位
    expect(p.started).toBe(false);
  });

  it("shouldStop 立即为真 → 不发包", async () => {
    const p = mkPlayer();
    const sent: Any[] = [];
    p.audioSocket = fakeSocket(sent);
    p.serverAudioPort = 6000;
    const n = await p.fillGapSilence({ shouldStop: () => true, maxMs: 100 });
    expect(n).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("shouldStop 中途为真 → 立即停(不等到 maxMs)", async () => {
    const p = mkPlayer();
    const sent: Any[] = [];
    p.audioSocket = fakeSocket(sent);
    p.serverAudioPort = 6000;
    let count = 0;
    const n = await p.fillGapSilence({ shouldStop: () => ++count >= 3, maxMs: 10_000 });
    expect(n).toBeLessThanOrEqual(3);
    expect(n).toBeGreaterThanOrEqual(1);
  });

  it("destroying → 不发包", async () => {
    const p = mkPlayer();
    const sent: Any[] = [];
    p.audioSocket = fakeSocket(sent);
    p.serverAudioPort = 6000;
    p.destroying = true;
    const n = await p.fillGapSilence({ shouldStop: () => false, maxMs: 30 });
    expect(n).toBe(0);
    expect(sent).toHaveLength(0);
  });
});

describe("env 开关与阈值", () => {
  const KEYS = ["MF_BRIDGE_RAOP_GAP_FILL", "MF_BRIDGE_RAOP_LIVENESS_WATCHDOG", "MF_BRIDGE_RAOP_LIVENESS_MS"];
  let saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("GAP_FILL / LIVENESS_WATCHDOG 缺省 ON,0/false 关闭", () => {
    expect(raopBridgeGapFillEnabled()).toBe(true);
    expect(raopBridgeLivenessWatchdogEnabled()).toBe(true);
    process.env.MF_BRIDGE_RAOP_GAP_FILL = "0";
    process.env.MF_BRIDGE_RAOP_LIVENESS_WATCHDOG = "false";
    expect(raopBridgeGapFillEnabled()).toBe(false);
    expect(raopBridgeLivenessWatchdogEnabled()).toBe(false);
  });

  it("LIVENESS_MS 缺省 120000,下限 30000,env 可上调", () => {
    expect(raopBridgeLivenessMs()).toBe(120000);
    process.env.MF_BRIDGE_RAOP_LIVENESS_MS = "10";
    expect(raopBridgeLivenessMs()).toBe(120000); // 低于下限回落缺省
    process.env.MF_BRIDGE_RAOP_LIVENESS_MS = "30000";
    expect(raopBridgeLivenessMs()).toBe(30000);
    process.env.MF_BRIDGE_RAOP_LIVENESS_MS = "60000";
    expect(raopBridgeLivenessMs()).toBe(60000);
  });
});

describe("livenessWatchdogShouldFire(纯判据)", () => {
  const base = {
    enabled: true,
    isAp2: false,
    paused: false,
    connected: true,
    closed: false,
    hasPlayer: true,
    streaming: true,
    reconnectInFlight: false,
    reconnectTimerSet: false,
    quietMs: 121_000,
    thresholdMs: 120_000,
  };

  it("超阈值且在推流 → 触发", () => {
    expect(livenessWatchdogShouldFire(base)).toBe(true);
  });

  it("未超阈值 → 不触发", () => {
    expect(livenessWatchdogShouldFire({ ...base, quietMs: 120_000 })).toBe(false);
    expect(livenessWatchdogShouldFire({ ...base, quietMs: 1_000 })).toBe(false);
  });

  it("暂停 / AP2 / 未连接 / 已关闭 / 无 player / 未在推流 → 一律不触发", () => {
    expect(livenessWatchdogShouldFire({ ...base, paused: true })).toBe(false);
    expect(livenessWatchdogShouldFire({ ...base, isAp2: true })).toBe(false);
    expect(livenessWatchdogShouldFire({ ...base, connected: false })).toBe(false);
    expect(livenessWatchdogShouldFire({ ...base, closed: true })).toBe(false);
    expect(livenessWatchdogShouldFire({ ...base, hasPlayer: false })).toBe(false);
    expect(livenessWatchdogShouldFire({ ...base, streaming: false })).toBe(false);
  });

  it("重连进行中 / 已排程重连 → 不重复触发", () => {
    expect(livenessWatchdogShouldFire({ ...base, reconnectInFlight: true })).toBe(false);
    expect(livenessWatchdogShouldFire({ ...base, reconnectTimerSet: true })).toBe(false);
  });

  it("开关关闭 → 不触发", () => {
    expect(livenessWatchdogShouldFire({ ...base, enabled: false })).toBe(false);
  });
});
