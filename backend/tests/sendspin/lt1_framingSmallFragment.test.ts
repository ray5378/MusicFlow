// framing.ts 覆盖率补口:小载荷的**单分片**路径与分片边界。
//
// 缺口背景:fragment() 有两条分支 —— 载荷 ≤ MAX_FRAGMENT_FIRST+1 时**单帧**下发
// (只需 [MORE, origType] 两字节头),否则首帧截到 MAX_FRAGMENT_FIRST、后续帧按
// MAX_FRAGMENT_NEXT 续。既有测试只走了「必须分片」那条,单帧路径全黑 —— 而它才是
// 真实音频/JSON 帧的常态(opus 20ms 包、server/* JSON 都远小于 64KB)。
//
// 守住的产品契约:
//   1) 小载荷必须产出**恰好一条**分片,且头 = [BIN_FRAGMENT_MORE, origType];
//   2) fragment→reassemble 必须**逐字节还原**(首帧头 2B、续帧头 1B 的剥法不同);
//   3) 边界(max_first+1 vs max_first+2)必须落在正确的分支上,不能多切一刀。
import "../plugins/_env.js";

import { describe, it, expect } from "vitest";
import { fragment, reassemble } from "../../src/services/sendspin/framing.js";
import {
  BIN_FRAGMENT_MORE,
  BIN_FRAGMENT_END,
  MAX_FRAGMENT_FIRST,
  MAX_FRAGMENT_NEXT,
} from "../../src/services/sendspin/constants.js";

describe("fragment:小载荷单分片路径", () => {
  it("载荷远小于上限 → 恰好一条分片,头为 [MORE, origType]", () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const parts = fragment(data, 0x42);
    expect(parts).toHaveLength(1);
    // 契约:单分片仍用 MORE 头(不是 END)——接收端首帧恒剥 2B,类型字节必须原样带出。
    expect(parts[0][0]).toBe(BIN_FRAGMENT_MORE);
    expect(parts[0][1]).toBe(0x42);
    expect(Array.from(parts[0].subarray(2))).toEqual([1, 2, 3, 4, 5]);
  });

  it("空载荷也算小载荷 → 单分片(仅 2B 头)", () => {
    const parts = fragment(new Uint8Array(0), 7);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toHaveLength(2);
    expect(parts[0][0]).toBe(BIN_FRAGMENT_MORE);
    expect(parts[0][1]).toBe(7);
  });

  it("边界:length === MAX_FRAGMENT_FIRST+1 → 仍走单分片", () => {
    const data = new Uint8Array(MAX_FRAGMENT_FIRST + 1).fill(0xab);
    const parts = fragment(data, 1);
    expect(parts).toHaveLength(1);
    expect(parts[0].length).toBe(MAX_FRAGMENT_FIRST + 1 + 2);
    // 契约:边界值不得多切一刀(多一片 = 多一次加密+发送开销,且接收端多等一帧)。
    expect(reassemble(parts)).toEqual(data);
  });

  it("边界:length === MAX_FRAGMENT_FIRST+2 → 必须切成多片,首片带 MORE 头、末片带 END 头", () => {
    const data = new Uint8Array(MAX_FRAGMENT_FIRST + 2).fill(0xcd);
    const parts = fragment(data, 9);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts[0][0]).toBe(BIN_FRAGMENT_MORE);
    expect(parts[0][1]).toBe(9);
    expect(parts[0].length).toBe(MAX_FRAGMENT_FIRST + 2);
    // 末片头必须是 END(否则接收端永远不认为重组完成)
    expect(parts[parts.length - 1][0]).toBe(BIN_FRAGMENT_END);
    expect(reassemble(parts)).toEqual(data);
  });

  it("多片重组逐字节还原(含 MAX_FRAGMENT_NEXT 续片),头字节不进载荷", () => {
    const data = new Uint8Array(MAX_FRAGMENT_FIRST + MAX_FRAGMENT_NEXT + 100);
    for (let i = 0; i < data.length; i++) data[i] = i & 0xff;
    const parts = fragment(data, 3);
    expect(parts.length).toBe(3);
    expect(reassemble(parts)).toEqual(data);
  });
});
