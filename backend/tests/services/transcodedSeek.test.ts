/**
 * P2-4：Web 端实时管道流的 seek 位置换算。
 *
 * 被测文件 `frontend/src/utils/transcodedSeek.ts` 是纯函数（无 Vue / 无 Howler 依赖），
 * 因此可跨包直接单测。换算差一位就会让拖动后的进度显示与歌词整体偏移 ——
 * 是 P2-4 最该被锁死的一处（真机拖动需人工验收，这里锁逻辑）。
 */
import { describe, it, expect } from "vitest";
import {
  seekTargetFromLogical,
  toLogicalPosition,
  withTimeOffset,
} from "../../../frontend/src/utils/transcodedSeek.js";

describe("seekTargetFromLogical（逻辑位置 → 服务端 timeOffset）", () => {
  it("整秒位置：偏移取整秒，流内零头为 0", () => {
    const t = seekTargetFromLogical(30);
    expect(t.logicalPosition).toBe(30);
    expect(t.serverOffset).toBe(30);
    expect(t.sourcePosition).toBe(0);
  });

  it("含零头：0.1s 粒度直接发给服务端（不再 floor 丢精度）", () => {
    const t = seekTargetFromLogical(30.7);
    expect(t.serverOffset).toBe(30.7);
    expect(t.sourcePosition).toBeCloseTo(0, 6);
  });

  it("0 / 负数 / 非法值一律归零（不能给服务端传负 timeOffset）", () => {
    for (const bad of [0, -0.5, -100, NaN, Infinity, -Infinity]) {
      const t = seekTargetFromLogical(bad);
      expect(t.logicalPosition).toBe(0);
      expect(t.serverOffset).toBe(0);
      expect(t.sourcePosition).toBe(0);
    }
  });
});

describe("toLogicalPosition（流内位置 + 偏移 → 逻辑位置）", () => {
  it("基本相加", () => {
    expect(toLogicalPosition(10, 30)).toBe(40);
  });

  it("给了 maximum 就 clamp（进度不超过全曲时长）", () => {
    expect(toLogicalPosition(10, 30, 35)).toBe(35);
  });

  it("maximum 省略 / 为 0 时不 clamp（时长未知不误截）", () => {
    expect(toLogicalPosition(10, 30)).toBe(40);
    expect(toLogicalPosition(10, 30, 0)).toBe(40);
  });

  it("结果不为负 / 非法输入当 0", () => {
    expect(toLogicalPosition(-5, 0)).toBe(0);
    expect(toLogicalPosition(NaN, NaN)).toBe(0);
  });

  it("与 seekTargetFromLogical 互逆（往返不丢精度）", () => {
    const t = seekTargetFromLogical(42.6);
    expect(toLogicalPosition(t.sourcePosition, t.serverOffset)).toBeCloseTo(42.6, 6);
  });
});

describe("withTimeOffset（给流 URL 追加 timeOffset）", () => {
  it("已有 query 用 & 追加", () => {
    expect(withTimeOffset("/rest/stream?id=x&token=t", 30)).toBe("/rest/stream?id=x&token=t&timeOffset=30");
  });

  it("无 query 用 ? 追加", () => {
    expect(withTimeOffset("/rest/stream", 5)).toBe("/rest/stream?timeOffset=5");
  });

  it("0 / 负数 / 非法值保持原 URL（便于缓存常规请求）", () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(withTimeOffset("/rest/stream?id=x", bad)).toBe("/rest/stream?id=x");
    }
  });

  it("小数按 0.1s 粒度发送（服务端 parseTimeOffset 接受小数）", () => {
    expect(withTimeOffset("/rest/stream-remote?a=1", 12.9)).toBe("/rest/stream-remote?a=1&timeOffset=12.9");
    expect(withTimeOffset("/rest/stream?id=x", 12.95)).toBe("/rest/stream?id=x&timeOffset=13");
  });
});
