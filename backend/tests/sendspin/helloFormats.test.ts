// ==================== batch48：sendspin `client/hello` 采样率自动探测 ====================
//
// DLNA 那条路**探测无解**（UPnP/DLNA 的 ProtocolInfo / GetProtocolInfo 只报
// mime + DLNA.ORG_PN 编码档位，不编码采样率；240 真机 H5MKII 实测 20 条 audio
// 协议项无一条带 rate），所以 DLNA 只有「手动 + 缺省 48000」。
// Sendspin 这条路**实测能自动探测**：设备在 `client/hello` 的
// `player@v1_support.supported_formats` 里**按「编码 × 声道」逐条**上报
// `sample_rate`/`bit_depth`（真机 ESPHome 2026.9.1 / esp32-player2 报文见下）。
//
// 这里只锁纯函数层（解析 + 键名兼容 + 取最大值 + 坏数据不炸）：
//   - 真机报文 → 48000 + codecs[flac,opus,pcm]；
//   - 设备 YAML 配 `sample_rate: 96000` 后 Opus 条目自动消失（Opus 格式恒 48K）→ 96000；
//   - 旧固件不宣告 / 字段缺失 / 类型错 → 0（= 回落缺省 48000，不抛、不改行为）。
import { describe, it, expect } from "vitest";
import { parseHelloSupportedFormats } from "../../src/services/sendspin/server.js";

/** 240 服务端日志实录的真机报文（ESPHome 2026.9.1 / esp32-player2 C4:9E:7E:08:75:64）。 */
const REAL_HELLO = {
  client_id: "C4:9E:7E:08:75:64",
  name: "Speaker Media Player",
  supported_roles: ["player@v1"],
  "player@v1_support": {
    supported_formats: [
      { codec: "flac", channels: 2, sample_rate: 48000, bit_depth: 16 },
      { codec: "flac", channels: 1, sample_rate: 48000, bit_depth: 16 },
      { codec: "opus", channels: 2, sample_rate: 48000, bit_depth: 16 },
      { codec: "opus", channels: 1, sample_rate: 48000, bit_depth: 16 },
      { codec: "pcm", channels: 2, sample_rate: 48000, bit_depth: 16 },
      { codec: "pcm", channels: 1, sample_rate: 48000, bit_depth: 16 },
    ],
    buffer_capacity: 4800000,
    supported_commands: ["volume", "mute"],
  },
};

/** 同一台设备在 YAML 里加了 `sample_rate: 96000` 重烧后的报文
 *  （按 ESPHome 组件语义：opus 条目消失，flac/pcm 变成 96K）。 */
const REAL_HELLO_96K = {
  ...REAL_HELLO,
  "player@v1_support": {
    supported_formats: [
      { codec: "flac", channels: 2, sample_rate: 96000, bit_depth: 24 },
      { codec: "flac", channels: 1, sample_rate: 96000, bit_depth: 24 },
      { codec: "pcm", channels: 2, sample_rate: 96000, bit_depth: 16 },
    ],
    buffer_capacity: 4800000,
    supported_commands: ["volume", "mute"],
  },
};

describe("parseHelloSupportedFormats：取 max(sample_rate)", () => {
  it("真机报文 → 48000 + codecs[flac,opus,pcm]（去重、保序）", () => {
    expect(parseHelloSupportedFormats(REAL_HELLO)).toEqual({
      maxSampleRate: 48000,
      codecs: ["flac", "opus", "pcm"],
    });
  });

  it("设备配 96K 后 → 96000（多档混报时取最大值）", () => {
    expect(parseHelloSupportedFormats(REAL_HELLO_96K)).toEqual({
      maxSampleRate: 96000,
      codecs: ["flac", "pcm"],
    });
    // 混报（如某些固件同时报两条不同率）→ 取能吃的最高那一档
    expect(
      parseHelloSupportedFormats({
        "player@v1_support": {
          supported_formats: [
            { codec: "flac", sample_rate: 44100 },
            { codec: "flac", sample_rate: 96000 },
            { codec: "flac", sample_rate: 48000 },
          ],
        },
      }),
    ).toEqual({ maxSampleRate: 96000, codecs: ["flac"] });
  });

  it("键名兼容：player_support（非 v1 legacy）与顶层 supported_formats 都认", () => {
    const formats = [{ codec: "pcm", sample_rate: 88200 }];
    expect(parseHelloSupportedFormats({ player_support: { supported_formats: formats } }).maxSampleRate).toBe(88200);
    expect(parseHelloSupportedFormats({ supported_formats: formats }).maxSampleRate).toBe(88200);
    expect(parseHelloSupportedFormats(formats).maxSampleRate).toBe(88200);
  });

  it("旧固件/坏数据一律回 0（回落缺省 48000，绝不抛）", () => {
    for (const bad of [
      null,
      undefined,
      {},
      { "player@v1_support": {} },
      { "player@v1_support": { supported_formats: null } },
      { "player@v1_support": { supported_formats: "48000" } },
    ]) {
      expect(parseHelloSupportedFormats(bad)).toEqual({ maxSampleRate: 0, codecs: [] });
    }
  });

  it("条目级脏数据被逐条跳过：非对象 / 非法 sample_rate / 大小写乱写的 codec", () => {
    const r = parseHelloSupportedFormats({
      "player@v1_support": {
        supported_formats: [
          null,
          "flac",
          48000,
          { codec: "FLAC ", sample_rate: "abc" },
          { codec: "", sample_rate: -1 },
          { codec: "PCM", sample_rate: 96000.4 },
        ],
      },
    });
    // 96000.4 四舍五入成 96000；codec 归一化成小写；
    // 前半段 `codec:"FLAC "` 的 rate 是 "abc" → **只跳这一条的 rate，codec 照样记下来**
    // （排障时"设备到底声明了什么编码"比 rate 更有用）
    expect(r).toEqual({ maxSampleRate: 96000, codecs: ["flac", "pcm"] });
  });

  it("只报 codec 不报 rate → 0（不因为缺 rate 就把 codec 抹掉，日志仍要能看到设备声明了什么）", () => {
    expect(parseHelloSupportedFormats({ "player@v1_support": { supported_formats: [{ codec: "opus" }] } })).toEqual({
      maxSampleRate: 0,
      codecs: ["opus"],
    });
  });
});
