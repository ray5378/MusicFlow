// encoding.ts 覆盖率补口:FLAC 真实 STREAMINFO 与声明头的**逐字段比对告警**。
//
// 缺口背景:LibFlacEncoder.verifyHeaderOnce 把「编码器首段真实 STREAMINFO」与
// `flacCodecHeaderB64()` 的合成声明逐字段(bps/sample_rate/channels)比对,不一致就
// 打告警。这是**事故防御**用的:声明与实流漂移时设备会逐帧拒收 —— 表现为「日志全绿、
// 进度正常、完全无声」。告警块从未被执行,等于这道防御从没被验证过「真的会响」。
//
// 之所以能白盒调用:该方法不读任何实例状态(只用模块级 flacCodecHeaderB64() 与入参),
// 故用一个空对象当 this 即可,无需初始化 WASM 编码器。
//
// 守住的产品契约:
//   1) 字段不一致 → 必须打出**含 declared/actual 两边数值**的 warn(排障第一手证据);
//   2) 字段一致 → 不得误报(否则每次起播刷一条假告警,真事故被淹没)。
import "../plugins/_env.js";

import { describe, it, expect, vi, afterEach } from "vitest";
import { LibFlacEncoder, flacCodecHeaderB64 } from "../../src/services/sendspin/encoding.js";

/** 只借原型方法:verifyHeaderOnce 不依赖实例字段。 */
const callVerify = (seg: Uint8Array): void =>
  (LibFlacEncoder.prototype as any).verifyHeaderOnce.call({}, seg);

/** 取合成声明的原始 42B。 */
function declaredBytes(): Buffer {
  return Buffer.from(flacCodecHeaderB64(), "base64");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LibFlacEncoder.verifyHeaderOnce:声明 vs 实流字段比对", () => {
  it("实流 bps/sr/ch 与声明不符 → 打出告警并带出两边数值(事故第一证据)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bad = new Uint8Array(42); // 全零 → bps=1/sr=0/ch=1,与合成的 16/48000/2 不符
    callVerify(bad);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    // 契约:告警必须同时给出 declared 与 actual,只给一边排障时无从判断该改哪边。
    expect(line).toContain("STREAMINFO");
    expect(line).toContain("declared{");
    expect(line).toContain("actual{");
    expect(line).toContain("bps=16"); // declared 的 bps
  });

  it("实流与声明完全一致 → 不得误报", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    callVerify(new Uint8Array(declaredBytes()));
    // 契约:一致时静默 —— 每次起播都报假警会让真事故被淹没。
    expect(warn).not.toHaveBeenCalled();
  });

  it("只有声道数不一致也要报(半匹配不得放过)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const seg = declaredBytes();
    // 通道数在 pack 空间的 bit41..43;把它清掉即 ch: 2 → 1
    const pack = seg.readBigUInt64BE(18);
    const cleared = pack & ~(0x7n << 41n);
    seg.writeBigUInt64BE(cleared, 18);
    callVerify(seg);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("ch=1");
  });
});
