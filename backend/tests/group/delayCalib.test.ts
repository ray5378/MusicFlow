// 群组 A/V 延迟补偿(delayCalib)单测 —— v4.8.0 起**按成员**存。
// 语义铁律:**正数 = 该设备更晚出声,负数 = 该设备更早出声**;组内每个播放器独立一格。
// AirPlay 成员 → 桥投递位移(bridgeAnchorShiftUsOf);Sendspin 成员 → 下发戳偏移
// (sendspinDelayUsOfClient)。范围 ±30s(用户定稿)。
import "../plugins/_env.js";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db, initDatabase } from "../../src/db/index.js";
import { playerGroups } from "../../src/db/schema.js";
import {
  DEFAULT_TRACK_LEAD_MS,
  GROUP_DELAY_MAX_MS,
  GROUP_DELAY_MIN_MS,
  GROUP_DELAY_STEP_MS,
  bridgeAnchorShiftUsOf,
  clampGroupDelayMs,
  getMemberDelayMs,
  getMemberDelays,
  getTrackLeadMs,
  invalidateGroupDelays,
  parseUserGroupId,
  sendspinDelayUsOfClient,
  setMemberDelay,
  setTrackLeadMs,
  trackSwitchLeadUsOf,
} from "../../src/services/group/delayCalib.js";

const GID = "g-delay-1";

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
});

beforeEach(() => {
  db.delete(playerGroups).run();
  invalidateGroupDelays(GID);
  db.insert(playerGroups)
    .values({ id: GID, name: "客厅组", memberIds: JSON.stringify(["airplay:hivi", "sendspin:esp1"]) })
    .run();
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

describe("getMemberDelays / setMemberDelay(按成员)", () => {
  it("新组默认空表(300ms 对齐点已取消,不补偿)", () => {
    expect(getMemberDelays(GID)).toEqual({});
    expect(getMemberDelayMs(GID, "airplay:hivi")).toBe(0);
    expect(getTrackLeadMs(GID)).toBe(DEFAULT_TRACK_LEAD_MS);
  });

  it("写入后立即读到(内存先更新,真·实时依赖这一点)", () => {
    setMemberDelay(GID, "airplay:hivi", 120);
    setMemberDelay(GID, "sendspin:esp1", -60);
    expect(getMemberDelayMs(GID, "airplay:hivi")).toBe(120);
    expect(getMemberDelayMs(GID, "sendspin:esp1")).toBe(-60);
  });

  it("成员互相独立(组内每台播放器一格,不按协议一刀切)", () => {
    setMemberDelay(GID, "airplay:hivi", 300);
    expect(getMemberDelayMs(GID, "sendspin:esp1")).toBe(0);
    setMemberDelay(GID, "sendspin:esp1", -100);
    expect(getMemberDelayMs(GID, "airplay:hivi")).toBe(300);
    expect(getMemberDelays(GID)).toEqual({ "airplay:hivi": 300, "sendspin:esp1": -100 });
  });

  it("同协议的两台设备也能各拿各的值(v4.8.0 的立项动机)", () => {
    setMemberDelay(GID, "airplay:hivi", 300);
    setMemberDelay(GID, "airplay:hivi2", 0);
    expect(getMemberDelayMs(GID, "airplay:hivi")).toBe(300);
    expect(getMemberDelayMs(GID, "airplay:hivi2")).toBe(0);
  });

  it("越界写入被钳制后回读一致", () => {
    expect(setMemberDelay(GID, "airplay:hivi", 999999)).toBe(30000);
    expect(setMemberDelay(GID, "sendspin:esp1", -999999)).toBe(-30000);
    expect(getMemberDelayMs(GID, "airplay:hivi")).toBe(30000);
    expect(getMemberDelayMs(GID, "sendspin:esp1")).toBe(-30000);
  });

  it("落库成功:清缓存后仍读到新值(不是只活在内存里)", () => {
    setMemberDelay(GID, "airplay:hivi", 250);
    invalidateGroupDelays(GID);
    expect(getMemberDelayMs(GID, "airplay:hivi")).toBe(250);
  });

  it("未知组 id → 空表(不抛,不误伤别的组)", () => {
    expect(getMemberDelays("nope")).toEqual({});
    expect(getMemberDelayMs("nope", "airplay:hivi")).toBe(0);
    setMemberDelay(GID, "airplay:hivi", 5);
    expect(getMemberDelays("nope")).toEqual({});
  });
});

describe("返回值不共享可变对象(O2)", () => {
  it("①两次 getMemberDelays 不是同一对象引用", () => {
    setMemberDelay(GID, "airplay:hivi", 1);
    const a = getMemberDelays(GID);
    const b = getMemberDelays(GID);
    expect(a).not.toBe(b);
    expect(getMemberDelays("nope")).not.toBe(getMemberDelays("nope"));
  });

  it("②改写第一次返回值不影响第二次读取(不污染缓存)", () => {
    setMemberDelay(GID, "airplay:hivi", 2);
    const a = getMemberDelays(GID);
    a["airplay:hivi"] = 9999;
    a["hacked"] = 1;
    expect(getMemberDelayMs(GID, "airplay:hivi")).toBe(2);
    expect(getMemberDelays(GID)["hacked"]).toBeUndefined();
  });
});

describe("单位换算与组名解析", () => {
  it("bridgeAnchorShiftUsOf = 成员格 ms×1000(正数 ⇒ 桥投递时戳后移)", () => {
    setMemberDelay(GID, "airplay:hivi", 250);
    expect(bridgeAnchorShiftUsOf(`ug:${GID}`, "hivi")).toBe(250_000n);
  });

  it("bridgeAnchorShiftUsOf 只认 ug:<gid> 与已设成员(设备组/未设成员 → 0n)", () => {
    setMemberDelay(GID, "airplay:hivi", 250);
    expect(bridgeAnchorShiftUsOf("ESP32-客厅", "hivi")).toBe(0n);
    expect(bridgeAnchorShiftUsOf(`ug:${GID}`, "ghost")).toBe(0n);
    expect(bridgeAnchorShiftUsOf("ug:", "hivi")).toBe(0n);
  });

  it("sendspinDelayUsOfClient 只认 ug:<gid>(设备组不补偿)", () => {
    setMemberDelay(GID, "sendspin:esp1", 90);
    expect(sendspinDelayUsOfClient(`ug:${GID}`, "esp1")).toBe(90_000n);
    expect(sendspinDelayUsOfClient("ESP32-客厅", "esp1")).toBe(0n);
    expect(sendspinDelayUsOfClient("ug:", "esp1")).toBe(0n);
  });

  it("AirPlay 与 Sendspin 取值口互不串(键含命名空间前缀)", () => {
    setMemberDelay(GID, "airplay:hivi", 300);
    expect(sendspinDelayUsOfClient(`ug:${GID}`, "hivi")).toBe(0n);
    expect(bridgeAnchorShiftUsOf(`ug:${GID}`, "esp1")).toBe(0n);
  });

  it("parseUserGroupId 解析 ug: 前缀", () => {
    expect(parseUserGroupId(`ug:${GID}`)).toBe(GID);
    expect(parseUserGroupId("ug:")).toBeNull();
    expect(parseUserGroupId("client-1")).toBeNull();
  });
});

describe("切歌垫片(组级,API 隐藏调参口)", () => {
  it("默认 0 = 完全自动(A 方案动态 lead 生效)", () => {
    expect(getTrackLeadMs(GID)).toBe(0);
    expect(trackSwitchLeadUsOf(`ug:${GID}`)).toBe(0n);
    expect(trackSwitchLeadUsOf("client-1")).toBe(0n);
  });

  it("setTrackLeadMs 写入+落库(清缓存后仍读到),不影响成员格", () => {
    setMemberDelay(GID, "airplay:hivi", 300);
    expect(setTrackLeadMs(GID, 1500)).toBe(1500);
    invalidateGroupDelays(GID);
    expect(getTrackLeadMs(GID)).toBe(1500);
    expect(getMemberDelayMs(GID, "airplay:hivi")).toBe(300);
  });
});
