// ==================== Phase 3:桥接总开关 flag + session owner 登记(MAJ-06) ====================
//
// 钉死:
//   ① MUSICFLOW_AIRPLAY_BRIDGE flag:缺省启用;显式 "0" 整条桥接路径不激活;
//      其他任意值(含 "1"/空串以外)仍启用(≠"0" 判定)。
//   ② bridge owner 登记:与 native cast 互斥的事实表 —— register 覆盖、clear 幂等、
//      isBridgeOwned 只看存在性。stop 路径据此跳过桥占用设备(MAJ-06)。
import "../plugins/_env.js";

import { afterEach, describe, expect, it } from "vitest";
import {
  isAirplayBridgeEnabled,
  registerBridgeOwner,
  clearBridgeOwner,
  isBridgeOwned,
} from "../../src/services/airplay/control.js";

const OWNER_IDS = ["ap-owner-1", "ap-owner-2"];

afterEach(() => {
  delete process.env.MUSICFLOW_AIRPLAY_BRIDGE;
  for (const id of OWNER_IDS) clearBridgeOwner(id);
});

describe("MUSICFLOW_AIRPLAY_BRIDGE 总开关", () => {
  it("缺省启用;显式 =0 关闭;其他值仍启用(≠\"0\" 判定)", () => {
    delete process.env.MUSICFLOW_AIRPLAY_BRIDGE;
    expect(isAirplayBridgeEnabled()).toBe(true);
    process.env.MUSICFLOW_AIRPLAY_BRIDGE = "0";
    expect(isAirplayBridgeEnabled()).toBe(false);
    process.env.MUSICFLOW_AIRPLAY_BRIDGE = "1";
    expect(isAirplayBridgeEnabled()).toBe(true);
    process.env.MUSICFLOW_AIRPLAY_BRIDGE = "false"; // 只有字面 "0" 才关
    expect(isAirplayBridgeEnabled()).toBe(true);
  });
});

describe("bridge owner 登记(MAJ-06:owner={kind:\"bridge\", token})", () => {
  it("register/clear/isBridgeOwned 往返;重登记覆盖;clear 幂等", () => {
    expect(isBridgeOwned("ap-owner-1")).toBe(false);
    registerBridgeOwner("ap-owner-1", "tok-1");
    expect(isBridgeOwned("ap-owner-1")).toBe(true);
    // 重登记(同设备重新 bridgePrepare)覆盖旧 token,不产生第二行
    registerBridgeOwner("ap-owner-1", "tok-2");
    expect(isBridgeOwned("ap-owner-1")).toBe(true);
    clearBridgeOwner("ap-owner-1");
    expect(isBridgeOwned("ap-owner-1")).toBe(false);
    clearBridgeOwner("ap-owner-1"); // 幂等
    expect(isBridgeOwned("ap-owner-1")).toBe(false);
  });

  it("多设备互不干扰(逐设备独立事实)", () => {
    registerBridgeOwner("ap-owner-1", "tok-1");
    registerBridgeOwner("ap-owner-2", "tok-2");
    expect(isBridgeOwned("ap-owner-1")).toBe(true);
    expect(isBridgeOwned("ap-owner-2")).toBe(true);
    clearBridgeOwner("ap-owner-1");
    expect(isBridgeOwned("ap-owner-1")).toBe(false);
    expect(isBridgeOwned("ap-owner-2")).toBe(true); // 另一座桥不受影响
  });
});
