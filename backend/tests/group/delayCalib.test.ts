// 群组 A/V 延迟补偿(delayCalib)单测。
// 语义铁律:**正数 = 该侧更晚出声,负数 = 该侧更早出声**;两侧独立存,只有差值影响 A/V。
// AirPlay 侧 → anchorShiftUs;Sendspin 侧 → 下发戳偏移。范围 ±30s(用户定稿)。
import "../plugins/_env.js";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db, initDatabase } from "../../src/db/index.js";
import { playerGroups } from "../../src/db/schema.js";
import {
  DEFAULT_TRACK_LEAD_MS,
  GROUP_DELAY_MAX_MS,
  GROUP_DELAY_MIN_MS,
  GROUP_DELAY_STEP_MS,
  airplay2DelayUsOf,
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

  it("切歌垫片组级默认 0(用户定调:默认关闭,手动修改后下一首生效)", () => {
    expect(DEFAULT_TRACK_LEAD_MS).toBe(0);
  });
});

describe("getGroupDelays / setGroupDelays", () => {
  it("新组两列默认 0(不补偿)", () => {
    expect(getGroupDelays(GID)).toEqual({ airplayMs: 0, airplay2Ms: 0, sendspinMs: 0, trackLeadMs: 0 });
  });

  it("写入后立即读到(内存先更新,真·实时依赖这一点)", () => {
    const next = setGroupDelays(GID, { airplayMs: 120, sendspinMs: -80 });
    expect(next).toEqual({ airplayMs: 120, airplay2Ms: 0, sendspinMs: -80, trackLeadMs: 0 });
    expect(getGroupDelays(GID)).toEqual({ airplayMs: 120, airplay2Ms: 0, sendspinMs: -80, trackLeadMs: 0 });
  });

  it("只传一侧时另一侧保持原值(避免前端漏字段把值清零)", () => {
    setGroupDelays(GID, { airplayMs: 100, sendspinMs: 0 });
    const after = setGroupDelays(GID, { sendspinMs: 60 });
    expect(after).toEqual({ airplayMs: 100, airplay2Ms: 0, sendspinMs: 60, trackLeadMs: 0 });
  });

  it("落库成功:清缓存后仍读到新值(不是只活在内存里)", () => {
    setGroupDelays(GID, { airplayMs: -300, sendspinMs: 300 });
    invalidateGroupDelays(GID);
    expect(getGroupDelays(GID)).toEqual({ airplayMs: -300, airplay2Ms: 0, sendspinMs: 300, trackLeadMs: 0 });
  });

  it("越界写入被钳制后回读一致", () => {
    const next = setGroupDelays(GID, { airplayMs: 1e9, sendspinMs: -1e9 });
    expect(next).toEqual({ airplayMs: GROUP_DELAY_MAX_MS, airplay2Ms: 0, sendspinMs: GROUP_DELAY_MIN_MS, trackLeadMs: 0 });
    invalidateGroupDelays(GID);
    expect(getGroupDelays(GID)).toEqual({ airplayMs: GROUP_DELAY_MAX_MS, airplay2Ms: 0, sendspinMs: GROUP_DELAY_MIN_MS, trackLeadMs: 0 });
  });

  it("未知组 id → 全 0(不抛,不误伤别的组)", () => {
    expect(getGroupDelays("nope")).toEqual({ airplayMs: 0, airplay2Ms: 0, sendspinMs: 0, trackLeadMs: 0 });
    expect(getGroupDelays(undefined)).toEqual({ airplayMs: 0, airplay2Ms: 0, sendspinMs: 0, trackLeadMs: 0 });
    expect(getGroupDelays(null)).toEqual({ airplayMs: 0, airplay2Ms: 0, sendspinMs: 0, trackLeadMs: 0 });
  });
});

// ==================== O2 回归:返回的补偿值不得是共享可变对象 ====================
// 修前:`getGroupDelays` 把模块级常量 ZERO 直接返回并塞进 cache ⇒ 任一调用方改写返回值
// 就同时污染「全局默认」与「所有无行组」的读值(别处莫名多出补偿,刷新也不一致)。
describe("返回值不共享可变对象(O2)", () => {
  it("①两次 getGroupDelays 不是同一对象引用(有行组 / 无行组 / 缺 groupId 三路都要新对象)", () => {
    const hitA = getGroupDelays(GID);
    const hitB = getGroupDelays(GID);
    expect(hitA).not.toBe(hitB);
    expect(hitA).toEqual(hitB);

    const unknownA = getGroupDelays("no-such-group");
    const unknownB = getGroupDelays("no-such-group");
    expect(unknownA).not.toBe(unknownB);

    const noneA = getGroupDelays(undefined);
    const noneB = getGroupDelays(null);
    expect(noneA).not.toBe(noneB);
    expect(noneA).not.toBe(getGroupDelays(undefined));
  });

  it("②改写第一次返回值不影响第二次读取(不污染缓存,也不污染全局默认)", () => {
    setGroupDelays(GID, { airplayMs: 120, sendspinMs: -80 });

    const first = getGroupDelays(GID);
    first.airplayMs = 9999;
    first.sendspinMs = -9999;
    // 缓存未被改写:再读仍是落库值。
    expect(getGroupDelays(GID)).toEqual({ airplayMs: 120, airplay2Ms: 0, sendspinMs: -80, trackLeadMs: 0 });
    invalidateGroupDelays(GID);
    expect(getGroupDelays(GID)).toEqual({ airplayMs: 120, airplay2Ms: 0, sendspinMs: -80, trackLeadMs: 0 });

    // 全局默认同理:改一个「缺 groupId」的返回值,不得让后续读到非 0。
    const zero = getGroupDelays(undefined);
    zero.airplayMs = 500;
    expect(getGroupDelays(undefined)).toEqual({ airplayMs: 0, airplay2Ms: 0, sendspinMs: 0, trackLeadMs: 0 });
    expect(getGroupDelays(null)).toEqual({ airplayMs: 0, airplay2Ms: 0, sendspinMs: 0, trackLeadMs: 0 });
    expect(getGroupDelays("no-such-group")).toEqual({ airplayMs: 0, airplay2Ms: 0, sendspinMs: 0, trackLeadMs: 0 });
  });
});

describe("AirPlay 2 第三格(airplay2Ms)", () => {
  it("三格+垫片各自独立读写(AP1 与 AP2 不是同一个数)", () => {
    const next = setGroupDelays(GID, { airplayMs: 120, airplay2Ms: -45, sendspinMs: 80, trackLeadMs: 1500 });
    expect(next).toEqual({ airplayMs: 120, airplay2Ms: -45, sendspinMs: 80, trackLeadMs: 1500 });
    expect(getGroupDelays(GID)).toEqual({ airplayMs: 120, airplay2Ms: -45, sendspinMs: 80, trackLeadMs: 1500 });
  });

  it("切歌垫片默认 0(用户定调:默认关闭),只改垫片时三格不动", () => {
    setGroupDelays(GID, { airplayMs: 100, airplay2Ms: 200, sendspinMs: 60 });
    const after = setGroupDelays(GID, { trackLeadMs: 2500 });
    expect(after).toEqual({ airplayMs: 100, airplay2Ms: 200, sendspinMs: 60, trackLeadMs: 2500 });
    invalidateGroupDelays(GID);
    expect(getGroupDelays(GID).trackLeadMs).toBe(2500);
    invalidateGroupDelays(GID);
    expect(setGroupDelays(GID, { trackLeadMs: 0 }).trackLeadMs).toBe(0); // 0 = 关闭
  });

  it("只改第三格时 AP1 / Sendspin 两格不动(前端逐格调不会被互相清零)", () => {
    setGroupDelays(GID, { airplayMs: 100, airplay2Ms: 20, sendspinMs: 60 });
    const after = setGroupDelays(GID, { airplay2Ms: 7 });
    expect(after).toEqual({ airplayMs: 100, airplay2Ms: 7, sendspinMs: 60, trackLeadMs: 0 });
  });

  it("第三格同样过 ±30s 钳制(不过 clamp 就会把越界值写进内存+DB)", () => {
    expect(setGroupDelays(GID, { airplay2Ms: 1e9 }).airplay2Ms).toBe(GROUP_DELAY_MAX_MS);
    expect(setGroupDelays(GID, { airplay2Ms: -1e9 }).airplay2Ms).toBe(GROUP_DELAY_MIN_MS);
  });

  it("第三格真的落库:清缓存后仍读到(不是只活在内存里)", () => {
    setGroupDelays(GID, { airplay2Ms: -250 });
    invalidateGroupDelays(GID);
    expect(getGroupDelays(GID).airplay2Ms).toBe(-250);
  });

  it("airplay2DelayUsOf = airplay2Ms×1000,且不受 AP1 格影响(串格会在这里被抓)", () => {
    setGroupDelays(GID, { airplayMs: 90, airplay2Ms: -30, sendspinMs: 0 });
    expect(airplay2DelayUsOf(GID)).toBe(-30_000);
    expect(airplayDelayUsOf(GID)).toBe(90_000);
  });

  it("只设 AP1 格 ⇒ 第三格仍为 0(继承只发生在 DB 补列那一刻,读路径不代填)", () => {
    setGroupDelays(GID, { airplayMs: 55, sendspinMs: 0 });
    expect(getGroupDelays(GID).airplay2Ms).toBe(0);
    expect(airplay2DelayUsOf(GID)).toBe(0);
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
