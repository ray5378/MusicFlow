// encoding.ts 覆盖率缺口分析 + 可达行为补测(cv_ 前缀,避免与既有文件冲突)。
//
// 覆盖率报告点名的四处缺口,逐一核对源码后的结论:
//   1) 399-404 BitReader.readSigned():BitReader 是模块私有类(未 export),且
//      readSigned 在模块内**零调用点**(子帧解析全程只用 read/skip/readUnary)
//      —— 死代码,公共 API 无法触达,不硬凑(见纪律 4)。
//   2) 410-411 BitReader.alignByte():同上,模块内零调用点(resolveFrameEnd 注释
//      里提到的 alignByte 口径已被「候选边界」实现取代)—— 死代码,不可触达。
//   3) 573-574 frameChannelLayout() 的保留值分支(chanCode 11..15):仅有的两个
//      调用点(splitFlacFrames:637 / frameChannelsBps:580)都在 parseFlacFrameHeader
//      成功之后,而后者对 chanCode > 10 直接返回 null —— 分支被上游守卫挡死,
//      公共 API 不可触达。下方第一个用例验证这道守卫本身的行为(保留值帧头
//      → 整段按「非帧头」原样保留)。
//   4) 707-710 looksLikeFrameHeaderAt():模块内零调用点(resolveFrameEnd 实际调用
//      的是 looksLikeFullFrameHeaderAt)—— 死代码,不可触达。其「缓冲耗尽视为像
//      帧头」的语义由 resolveFrameEnd 的第三轮回落口径承担,下方第二个用例验证
//      该真实路径:缓冲恰好在单帧边界耗尽时仍能精确切出一帧。
import "../plugins/_env.js";

import { describe, it, expect } from "vitest";
import { splitFlacFrames } from "../../src/services/sendspin/encoding.js";

/** 手工拼一个最小合法帧缓冲(单/双声道解读两用),共 12B:
 *  帧头 7B = FF F8 60 [chan|bps] + 帧号 1B + blocksize-1 1B + CRC-8 1B
 *  + **一个** FIXED(order=0) 子帧 20bit(2.5B)+ 1.5B 余量(CRC-16 占位)。
 *  ⚠️ channel assignment 语义(RFC 9639,对应 frameChannelLayout):chanCode=1
 *  表示 **2 个子帧**(chanCode+1),不是 1;chanCode=0 表示「随流缺省」,
 *  子帧数 = splitFlacFrames 的 defChannels 入参。故:
 *    - 单子帧解读:byte3=0x08(chanCode=0)+ 显式传 defChannels=1;
 *    - 缺省 defChannels=2 时(byte3=0x18,chanCode=1)同一段字节 = 2 子帧,
 *      第 2 个子帧的位流越出缓冲 → 数据不足保留残余。 */
function minimalFrameBytes(chanCodeByte3 = 0x18): Uint8Array {
  return new Uint8Array([
    0xff, 0xf8, 0x60, chanCodeByte3, // 同步 + bsizeCode=6/srCode=0 + chan=1/bps=16bit
    0x00, // UTF-8 帧号(1B,值 0)
    0x01, // blocksize-1 = 1 → 2 样本
    0x00, // CRC-8(解析路径不校验)
    0x10, 0x00, 0x30, // FIXED order=0 子帧:pad0/type=8/wasted0 + 残差(1 分区 2 样本 unary)
    0x00, 0x00, // CRC-16(不校验,仅为让 strict 口径的帧尾恰好落在缓冲内)
  ]);
}

describe("splitFlacFrames:保留 channel code 被上游守卫拦截(573-574 不可达的行为证据)", () => {
  it("chanCode 11..15(保留值)→ parseFlacFrameHeader 拒绝,整段原样保留不切帧", () => {
    for (const byte3 of [0xb8, 0xc8, 0xd8, 0xe8, 0xf8]) {
      const buf = minimalFrameBytes(byte3);
      const r = splitFlacFrames(buf);
      expect(r.frames.length).toBe(0);
      expect(r.rest.length).toBe(buf.length);
      expect(r.skippedContainerBytes).toBe(0);
    }
  });
});

describe("splitFlacFrames:帧尾确认与缓冲耗尽(死代码 looksLikeFrameHeaderAt 的 p>=len 语义由 resolveFrameEnd 候选回落 + crcEnd 边界承担)", () => {
  it("mono 流(strict 恰好落在缓冲末尾,crcEnd == buf.length)→ 精确切出唯一一帧,rest 为空", () => {
    // chanCode=0(随流缺省)+ defChannels=1 → 只有 1 个子帧,恰耗 20bit:
    // resolveFrameEnd(76):strict = aligned = 12,候选 == buf.length 时
    // 第 1 轮无法用「后继帧头」确认、第 3 轮回落返回 12;crcEnd(12) 未越过
    // buf.length(12) → 接受,切出 [0,12) 整帧。
    const buf = minimalFrameBytes(0x08);
    const r = splitFlacFrames(buf, 1, 16);
    expect(r.frames.length).toBe(1);
    expect(Array.from(r.frames[0]!)).toEqual(Array.from(buf));
    expect(r.rest.length).toBe(0);
    expect(r.skippedContainerBytes).toBe(0);
  });

  it("立体声解读下子帧数据不足(strict 候选越过缓冲末尾)→ 一帧都不切,整段保留 rest 等下一轮", () => {
    // 同一段字节按缺省 defChannels=2 解读:chanCode=1 → 2 个子帧;第 2 个子帧的
    // 位流越出缓冲 → subframeBits 失败 → splitFlacFrames 按契约**绝不猜边界**,
    // 整段保留为 rest。resolveFrameEnd 的 strict 候选(endBit=96 → 15)也越过
    // 缓冲末尾(12),被 crcEnd <= buf.length 边界拒收 —— 两种机制殊途同归。
    const buf = minimalFrameBytes(0x18);
    const r = splitFlacFrames(buf);
    expect(r.frames.length).toBe(0);
    expect(r.rest.length).toBe(buf.length);
    expect(r.skippedContainerBytes).toBe(0);
  });
});
