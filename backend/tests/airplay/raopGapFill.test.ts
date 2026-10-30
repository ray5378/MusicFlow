// A(垫片窗静音续流)+ B(消费停滞看门狗)回归:
// 2026-10-29 240 实证:换歌垫片窗(~2.5-3s)RTP 完全断流 ⇒ MUZO 接收端反复饿到
// 假死(零 timing/零重传)⇒ 永久无声,只有完整重握手能唤醒。
//   A = fillGapSilence:垫片窗内 8ms 节拍续发静音(seq 连续/时间戳续走/无 SYNC),
//       结束复位 started ⇒ 新流真·首包仍带 0xE0 marker(与 primeSilence 同语义)。
//   B = livenessWatchdogShouldFire 纯判据 + env 开关/阈值。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RaopPlayer, CHUNK_LEN } from "../../src/services/airplay/raop.js";
import {
  livenessBreakerActive,
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

  it("GAP_FILL / LIVENESS_WATCHDOG 缺省 ON(v4.10.0 判据源=timing 心跳);0/false 关闭", () => {
    expect(raopBridgeGapFillEnabled()).toBe(true);
    // v4.10.0:判据源 = 设备 timing 心跳(健康期 20 次/分钟,实测 40 分钟不断流;
    // 接收端僵死时立刻归零且永不恢复)⇒ 缺省开启,阈值 45s。
    expect(raopBridgeLivenessWatchdogEnabled()).toBe(true);
    process.env.MF_BRIDGE_RAOP_GAP_FILL = "0";
    expect(raopBridgeGapFillEnabled()).toBe(false);
    process.env.MF_BRIDGE_RAOP_LIVENESS_WATCHDOG = "0";
    expect(raopBridgeLivenessWatchdogEnabled()).toBe(false);
    process.env.MF_BRIDGE_RAOP_LIVENESS_WATCHDOG = "false";
    expect(raopBridgeLivenessWatchdogEnabled()).toBe(false);
    process.env.MF_BRIDGE_RAOP_LIVENESS_WATCHDOG = "1";
    expect(raopBridgeLivenessWatchdogEnabled()).toBe(true);
    process.env.MF_BRIDGE_RAOP_LIVENESS_WATCHDOG = "true";
    expect(raopBridgeLivenessWatchdogEnabled()).toBe(true);
  });

  it("LIVENESS_MS 缺省 15000(v4.10.1),下限 5000,env 可上调", () => {
    // 15s 的依据(2026-10-30 240 pcap):HiVi 上行 NTP 4611 包 / 9 会话 / ≈4.1 小时,
    // 会话内最大间隔仅 6.0s(>10s 样本 0)⇒ 15s = 自然上限 2.5 倍仍有余量;
    // 旧缺省 45s 会把每次"接收端僵死"的失声拖到 45s 以上。
    expect(raopBridgeLivenessMs()).toBe(15000);
    process.env.MF_BRIDGE_RAOP_LIVENESS_MS = "10";
    expect(raopBridgeLivenessMs()).toBe(15000); // 低于下限回落缺省
    process.env.MF_BRIDGE_RAOP_LIVENESS_MS = "6000";
    expect(raopBridgeLivenessMs()).toBe(6000);
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

// v4.10.0:任何自动恢复都必须有失败退避。v4.9.8 的反面教材是没有退避 ——
// 判据错了一次误判就演变成每 5 分钟一次的连环重连(每次 9~14s 静音)。
describe("livenessBreakerActive(心跳重连熔断)", () => {
  const NOW = 1_700_000_000_000;

  it("从未触发 → 不熔断", () => {
    expect(livenessBreakerActive([], NOW)).toBe(false);
  });

  it("10 分钟内仅 1 次 → 不熔断(允许第一次自愈)", () => {
    expect(livenessBreakerActive([NOW - 1_000], NOW)).toBe(false);
  });

  it("10 分钟内 2 次 → 熔断", () => {
    expect(livenessBreakerActive([NOW - 300_000, NOW - 1_000], NOW)).toBe(true);
  });

  it("只有 1 次在窗口内、另一次已超 10 分钟 → 不熔断", () => {
    expect(livenessBreakerActive([NOW - 700_000, NOW - 1_000], NOW)).toBe(false);
  });

  it("3 次都在窗口内 → 熔断", () => {
    expect(livenessBreakerActive([NOW - 500_000, NOW - 200_000, NOW - 1_000], NOW)).toBe(true);
  });
});
