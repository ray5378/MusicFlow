// ==================== 预填充档位 × 设备缓冲容量 匹配 ====================
//
// 背景(2026-09-24 真机实测):
//   设备(ESPHome 2026.9.0 / esp32-player-meet)在 `client/hello` 里宣告
//     `player@v1_support.buffer_capacity = 1600000`(字节,= ESPHome 的 `buffer_size`)
//   协议要求 server 只能把音频推到「设备的缓冲装得下」为止
//   (spec: server sends audio chunks as far ahead as the client's buffer capacity
//    allows;aiosendspin `BufferTracker(capacity_bytes=...)`)。
//   本仓此前**完全没读这个字段**,`prefill_buffer_ms` 想填多少就填多少 ——
//   超出部分设备放不下,只会堆在服务端内存并抽干设备缓冲 → 听感「一卡一卡」。
//
// 本文件锁死换算与钳制语义:设备未宣告容量时**行为必须与引入本逻辑前完全一致**。
import { describe, it, expect } from "vitest";
import { SendspinGroup, parseHelloBufferCapacity } from "../../src/services/sendspin/server.js";
import { PREFILL_BUFFER_MAX_MS, PREFILL_BUFFER_MIN_MS } from "../../src/services/sendspin/streamEngine.js";

/** 只够 capacityLimitedPrefillMs / encodedBytesPerSec 用的最小成员桩。 */
function member(codec: string, bufferCapacityBytes = 0): any {
  return { clientId: `${codec}-${bufferCapacityBytes}`, codec, bufferCapacityBytes };
}

function groupWith(members: any[]): SendspinGroup {
  const g = new SendspinGroup("g-cap", { log() {} } as any);
  for (const m of members) g.add(m);
  return g;
}

describe("parseHelloBufferCapacity", () => {
  it("真机形态:player@v1_support.buffer_capacity", () => {
    expect(
      parseHelloBufferCapacity({
        client_id: "3C:0F:02:F9:69:E4",
        "player@v1_support": {
          supported_formats: [{ codec: "flac" }],
          buffer_capacity: 1_600_000,
          supported_commands: ["volume", "mute"],
        },
      }),
    ).toBe(1_600_000);
  });

  it("兼容 player_support 与顶层两种键名", () => {
    expect(parseHelloBufferCapacity({ player_support: { buffer_capacity: 500_000 } })).toBe(500_000);
    expect(parseHelloBufferCapacity({ buffer_capacity: 250_000 })).toBe(250_000);
  });

  it("未宣告 / 非法 / 非正 → 0(不钳制)", () => {
    expect(parseHelloBufferCapacity({ client_id: "x" })).toBe(0);
    expect(parseHelloBufferCapacity({ "player@v1_support": {} })).toBe(0);
    expect(parseHelloBufferCapacity({ "player@v1_support": { buffer_capacity: -1 } })).toBe(0);
    expect(parseHelloBufferCapacity({ "player@v1_support": { buffer_capacity: "abc" } })).toBe(0);
    expect(parseHelloBufferCapacity(null)).toBe(0);
  });
});

describe("deviceCapacityBytes", () => {
  it("取全员最小值(余量须满足最小的那个设备)", () => {
    expect(groupWith([member("flac", 1_600_000), member("flac", 900_000)]).deviceCapacityBytes()).toBe(900_000);
  });

  it("0(未宣告)被忽略,不把整体拉成 0", () => {
    expect(groupWith([member("flac", 0), member("flac", 1_600_000)]).deviceCapacityBytes()).toBe(1_600_000);
  });

  it("全都没宣告 → 0", () => {
    expect(groupWith([member("flac"), member("pcm")]).deviceCapacityBytes()).toBe(0);
  });
});

describe("encodedBytesPerSec 名义回落(实测前)", () => {
  it("PCM 48k/16/2 恰好 192000 B/s", () => {
    expect(groupWith([member("pcm")]).encodedBytesPerSec()).toBe(192_000);
  });

  it("FLAC 取 0.7 × PCM(偏保守 → 钳制更紧),绝不高于 PCM 名义值", () => {
    const flac = groupWith([member("flac")]).encodedBytesPerSec();
    expect(flac).toBeLessThan(192_000);
    expect(flac).toBeGreaterThan(0);
  });
});

describe("capacityLimitedPrefillMs", () => {
  it("★ 未宣告容量 → 上界 = 30s(与引入本逻辑前完全一致)", () => {
    expect(groupWith([member("flac")]).capacityLimitedPrefillMs()).toBe(PREFILL_BUFFER_MAX_MS);
  });

  // 比例 0.6 = DEVICE_BUFFER_HEADROOM_RATIO(见其注释:真机灌满 100% 会被设备
  // 逐帧拒收 `Failed to send audio chunk`,10s 档实测 66% 占用才干净)。
  it("★ 真机 1.6MB + PCM:钳到 5 秒(1600000 × 0.6 / 192000)", () => {
    expect(groupWith([member("pcm", 1_600_000)]).capacityLimitedPrefillMs()).toBe(5000);
  });

  it("★ 真机 1.6MB + FLAC:按 0.7 × PCM 名义码率钳到 ~7.1 秒", () => {
    // 1600000 × 0.6 / 134400 × 1000 = 7142.857 → floor 7142
    expect(groupWith([member("flac", 1_600_000)]).capacityLimitedPrefillMs()).toBe(7142);
  });

  it("★ 真机实测路径:FLAC 105052 B/s → 约 9.1 秒(实测安全水位 10s 之内)", () => {
    const g = groupWith([member("flac", 1_600_000)]);
    (g as any).pushedSamples = 48_000 * 10; // 10s
    (g as any).pushedBytes = 1_050_520; // 105052 B/s
    // 1600000 × 0.6 / 105052 × 1000 = 9138.4 → floor 9138
    expect(g.capacityLimitedPrefillMs()).toBe(9138);
    // 必须严格小于真机验证过干净的水位(10s),否则就是把设备灌满的老问题。
    expect(g.capacityLimitedPrefillMs()).toBeLessThan(10_000);
  });

  it("容量大到装得下 30 秒 → 仍受 30s 时长上限约束(两把尺取小)", () => {
    // 30s FLAC 名义 = 134400 × 30 = 4_032_000 B;给 10MB 也还是 30s。
    expect(groupWith([member("flac", 10_000_000)]).capacityLimitedPrefillMs()).toBe(PREFILL_BUFFER_MAX_MS);
  });

  it("容量小到换算不足下限 → 抬到下限,绝不返回 0/负数", () => {
    // 25000 × 0.6 / 192000 × 1000 = 78.1 → 已低于下限 → 取下限
    expect(groupWith([member("pcm", 25_000)]).capacityLimitedPrefillMs()).toBe(PREFILL_BUFFER_MIN_MS);
    // 极度离谱的 1B → 同样钳到下限,不当成「不填充」
    expect(groupWith([member("pcm", 1)]).capacityLimitedPrefillMs()).toBe(PREFILL_BUFFER_MIN_MS);
  });

  it("多成员取最小容量 → 最保守的水位", () => {
    // 960000 × 0.6 / 192000 = 3.0s
    expect(groupWith([member("pcm", 1_600_000), member("pcm", 960_000)]).capacityLimitedPrefillMs()).toBe(3000);
  });
});

describe("pushMeter 生命周期", () => {
  it("resetPushMeter 清零后回落名义码率", () => {
    const g = groupWith([member("flac")]);
    (g as any).pushedBytes = 500_000;
    (g as any).pushedSamples = 48_000 * 10; // 10s
    expect(g.encodedBytesPerSec()).toBe(50_000);
    g.resetPushMeter();
    expect(g.encodedBytesPerSec()).toBeGreaterThan(50_000); // 回到名义 FLAC 值
  });

  it("实测码率参与钳制:码率越高,同容量装得下的秒数越少", () => {
    const g = groupWith([member("flac", 1_600_000)]);
    const before = g.capacityLimitedPrefillMs();
    // 模拟「实测压缩很差」= 码率翻倍 → 容量换算出的秒数减半。
    (g as any).pushedSamples = 48_000 * 10; // 10s
    (g as any).pushedBytes = 134_400 * 10 * 2; // 268800 B/s
    expect(g.capacityLimitedPrefillMs()).toBeLessThan(before);
  });
});
