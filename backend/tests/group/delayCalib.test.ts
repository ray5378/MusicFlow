// 群组 A/V 延迟补偿(delayCalib)单测。
// 语义铁律:**正数 = 该侧更晚出声,负数 = 该侧更早出声**;两侧独立存,只有差值影响 A/V。
// AirPlay 侧 → anchorShiftUs;Sendspin 侧 → 下发戳偏移。范围 ±30s(用户定稿)。
import "../plugins/_env.js";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db, initDatabase } from "../../src/db/index.js";
import { playerGroups } from "../../src/db/schema.js";
import {
  GROUP_DELAY_MAX_MS,
  GROUP_DELAY_MIN_MS,
  GROUP_DELAY_STEP_MS,
  airplayDelayUsOf,
  clampGroupDelayMs,
  getGroupDelays,
  invalidateGroupDelays,
  parseUserGroupId,
  sendspinDelayUsOfGroupName,
  setGroupDelays,
} from "../../src/services/group/delayCalib.js";

const GID = "g-delay-1";

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
});

beforeEach(() => {
  db.delete(playerGroups).run();
  invalidateGroupDelays(GID);
  db.insert(playerGroups).values({ id: GID, name: "客厅组", memberIds: "[]" }).run();
});

describe("clampGroupDelayMs", () => {
  it("范围内原样返回,且四舍五入到整数毫秒", () => {
    expect(clampGroupDelayMs(0)).toBe(0);
    expect(clampGroupDelayMs(120)).toBe(120);
    expect(clampGroupDelayMs(-250)).toBe(-250);
    expect(clampGroupDelayMs(12.6)).toBe(13);
  });

  it("越界钳到 ±30s(大偏移只用于排查,但仍是合法入参)", () => {
    expect(clampGroupDelayMs(99999)).toBe(GROUP_DELAY_MAX_MS);
    expect(clampGroupDelayMs(-99999)).toBe(GROUP_DELAY_MIN_MS);
    expect(clampGroupDelayMs("30000")).toBe(30000);
  });

  it("非数字 → 0(不吞错、不抛)", () => {
    expect(clampGroupDelayMs(undefined)).toBe(0);
    expect(clampGroupDelayMs(null)).toBe(0);
    expect(clampGroupDelayMs("abc")).toBe(0);
    expect(clampGroupDelayMs(NaN)).toBe(0);
  });

  it("步进常量 10ms(前端 el-input-number 用)", () => {
    expect(GROUP_DELAY_STEP_MS).toBe(10);
  });
});

describe("getGroupDelays / setGroupDelays", () => {
  it("新组两列默认 0(不补偿)", () => {
    expect(getGroupDelays(GID)).toEqual({ airplayMs: 0, sendspinMs: 0 });
  });

  it("写入后立即读到(内存先更新,真·实时依赖这一点)", () => {
    const next = setGroupDelays(GID, { airplayMs: 120, sendspinMs: -80 });
    expect(next).toEqual({ airplayMs: 120, sendspinMs: -80 });
    expect(getGroupDelays(GID)).toEqual({ airplayMs: 120, sendspinMs: -80 });
  });

  it("只传一侧时另一侧保持原值(避免前端漏字段把值清零)", () => {
    setGroupDelays(GID, { airplayMs: 100, sendspinMs: 0 });
    const after = setGroupDelays(GID, { sendspinMs: 60 });
    expect(after).toEqual({ airplayMs: 100, sendspinMs: 60 });
  });

  it("落库成功:清缓存后仍读到新值(不是只活在内存里)", () => {
    setGroupDelays(GID, { airplayMs: -300, sendspinMs: 300 });
    invalidateGroupDelays(GID);
    expect(getGroupDelays(GID)).toEqual({ airplayMs: -300, sendspinMs: 300 });
  });

  it("越界写入被钳制后回读一致", () => {
    const next = setGroupDelays(GID, { airplayMs: 1e9, sendspinMs: -1e9 });
    expect(next).toEqual({ airplayMs: GROUP_DELAY_MAX_MS, sendspinMs: GROUP_DELAY_MIN_MS });
    invalidateGroupDelays(GID);
    expect(getGroupDelays(GID)).toEqual({ airplayMs: GROUP_DELAY_MAX_MS, sendspinMs: GROUP_DELAY_MIN_MS });
  });

  it("未知组 id → 全 0(不抛,不误伤别的组)", () => {
    expect(getGroupDelays("nope")).toEqual({ airplayMs: 0, sendspinMs: 0 });
    expect(getGroupDelays(undefined)).toEqual({ airplayMs: 0, sendspinMs: 0 });
    expect(getGroupDelays(null)).toEqual({ airplayMs: 0, sendspinMs: 0 });
  });
});

describe("两侧单位换算", () => {
  it("airplayDelayUsOf = ms×1000(正数进 anchorShiftUs ⇒ 桥内容落点后移)", () => {
    setGroupDelays(GID, { airplayMs: 120, sendspinMs: 0 });
    expect(airplayDelayUsOf(GID)).toBe(120_000);
    setGroupDelays(GID, { airplayMs: -120, sendspinMs: 0 });
    expect(airplayDelayUsOf(GID)).toBe(-120_000);
  });

  it("sendspinDelayUsOfGroupName 只认 ug:<gid>(设备组不补偿)", () => {
    setGroupDelays(GID, { airplayMs: 0, sendspinMs: 90 });
    expect(sendspinDelayUsOfGroupName(`ug:${GID}`)).toBe(90_000n);
    expect(sendspinDelayUsOfGroupName("ESP32-客厅")).toBe(0n);
    expect(sendspinDelayUsOfGroupName("ug:")).toBe(0n);
  });

  it("parseUserGroupId 解析 ug: 前缀", () => {
    expect(parseUserGroupId(`ug:${GID}`)).toBe(GID);
    expect(parseUserGroupId("ug:")).toBeNull();
    expect(parseUserGroupId("client-1")).toBeNull();
  });
});
