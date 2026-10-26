// AP2 配对服务(pairAirPlayDevice)与 cast 准入(getAirPlayCastGateError)钉定用例。
//
// 用户规则(2026-10-27 拍板):
//   1. 未配对的 AP2 设备不得进组、不得出现在「可选择播放器」;
//   2. 凭据失效不摘出已有的组:播放回落 AP1;只有「新加入」严格禁止;
//   3. AP1-only 设备(supportsAp2=false,如 HiVi)完全不受影响;
//   4. 直接投屏到未配对 AP2 ⇒ 报错要求先配对,**不静默回落 AP1**;
//      但已经是群组成员的设备放行(那条路就是规则 2 的 AP1 回落)。
//
// 本文件钉住:
//   · 配对成功必须经 recordPairSetupSuccess → saveHapCredentials **落库**(唯一写入口);
//   · 写库失败 / 未产生 seed ⇒ 结果不是 ok(**绝不静默成功**);
//   · PIN 错 / 超时 / 不支持 AP2 的分类码与文案;
//   · PIN 只传给会话层,不进凭据、不进结果;
//   · cast 准入:未配对 AP2 直接投屏被拒、群组成员放行、AP1-only 与已配对放行。
//
// 依赖全部替身:不连真设备(ap2Session)、不碰真凭据表(hapCredentials)、
// 设备档案由 discovery 替身提供。
import "../plugins/_env.js";

import { describe, it, expect, beforeEach, vi } from "vitest";

const S = vi.hoisted(() => {
  /** 设备档案(d=> discovery 替身返回的形状)。 */
  let devices: Record<string, any> = {};
  /** deviceId → 是否已配对(hapCredentials 替身的真相源)。 */
  let paired: Record<string, boolean> = {};
  /** deviceId → 所属群组 id 列表(cast 准入用)。 */
  let groups: Record<string, string[]> = {};
  /** 下一次 saveHapCredentials 是否抛错(模拟写库失败)。 */
  let persistThrows = false;
  /** pairNewDevice 的替身:成功时回调 seed 并返回凭据;失败由用例注入(mockRejectedValueOnce)。 */
  const defaultPair = async (opts: any) => {
    opts?.onNewControllerSeed?.("ab".repeat(32));
    return { accessoryLTPK: "a".repeat(64), controllerLTSK: "b".repeat(128) };
  };
  const pairNewDevice = vi.fn(defaultPair);
  const saveHapCredentials = vi.fn((deviceId: string, _creds: any) => {
    if (persistThrows) throw new Error("磁盘写失败(注入)");
    paired[deviceId] = true;
  });
  return {
    pairNewDevice,
    saveHapCredentials,
    setDevices(v: Record<string, any>) {
      devices = v;
    },
    getDevice(id: string) {
      return devices[id];
    },
    listDevices() {
      return Object.values(devices);
    },
    setPaired(id: string, v: boolean) {
      paired[id] = v;
    },
    isPaired(id: string) {
      return !!paired[id];
    },
    setGroups(id: string, g: string[]) {
      groups[id] = g;
    },
    groupsOf(id: string) {
      return groups[id] ?? [];
    },
    setPersistThrows(v: boolean) {
      persistThrows = v;
    },
    reset() {
      devices = {};
      paired = {};
      groups = {};
      persistThrows = false;
      // mockReset 会清空 once 队列与实现,再装回缺省实现(避免用例间串味)
      pairNewDevice.mockReset();
      pairNewDevice.mockImplementation(defaultPair);
      saveHapCredentials.mockClear();
    },
  };
});

vi.mock("../../src/services/airplay/ap2/ap2Session.js", () => ({
  pairNewDevice: S.pairNewDevice,
  openVerifiedChannel: vi.fn(),
}));

vi.mock("../../src/services/airplay/ap2/hapCredentials.js", () => ({
  getHapCredentials: (id: string) => (S.isPaired(id) ? { accessoryLTPK: "a".repeat(64), controllerLTSK: "b".repeat(128) } : null),
  saveHapCredentials: S.saveHapCredentials,
  clearHapCredentials: (id: string) => S.setPaired(id, false),
  parseHapCredentials: () => null,
  buildHapCredentials: () => "",
  HAP_CREDENTIALS_HEX_LEN: 192,
  ACCESSORY_LTPK_HEX_LEN: 64,
  CONTROLLER_LTSK_HEX_LEN: 128,
}));

vi.mock("../../src/services/airplay/discovery.js", () => ({
  getAirPlayDevice: (id: string) => S.getDevice(id),
  getAirPlayDevices: () => S.listDevices(),
  onAirPlayEvent: () => undefined,
  startAirPlayDiscovery: async () => undefined,
  stopAirPlayDiscovery: async () => undefined,
  setAirPlayPersist: () => undefined,
  removeAirPlayDevice: () => undefined,
  addPersistedAirPlayDevice: () => undefined,
}));

vi.mock("../../src/services/settings.js", () => ({
  getSetting: (_key: string, def = "") => def,
  setSetting: () => undefined,
  getSettingBool: (_key: string, def: boolean) => def,
  _resetSettingsCacheForTest: () => undefined,
}));

vi.mock("../../src/services/group/index.js", () => ({
  getGroupManager: () => ({ groupsOfDevice: (id: string) => S.groupsOf(id) }),
  GroupManager: class {},
}));

import {
  AP2_PAIR_MESSAGES,
  _resetAirPlayControllerIdCacheForTest,
  getAirPlayCastGateError,
  isValidAirPlayPin,
  pairAirPlayDevice,
} from "../../src/services/airplay/control.js";

/** AP2 capable 且(按用例)已配对/未配对的设备档案。 */
function ap2Device(id = "hp-1", over: Record<string, any> = {}): any {
  return { id, name: `音箱 ${id}`, host: "192.168.1.50", port: 7000, supportsRsa: false, supportsAp2: true, available: true, lastSeen: Date.now(), ...over };
}
/** AP1-only 设备(例:用户的 HiVi)。 */
function ap1Device(id = "hivi", over: Record<string, any> = {}): any {
  return { id, name: `HiVi ${id}`, host: "192.168.1.60", port: 5000, supportsRsa: false, supportsAp2: false, available: true, lastSeen: Date.now(), ...over };
}

beforeEach(() => {
  S.reset();
  _resetAirPlayControllerIdCacheForTest();
});

describe("pairAirPlayDevice:PIN 配对", () => {
  it("成功:经唯一写入口把凭据落库,结果 ok 且不自动起播", async () => {
    S.setDevices({ "hp-1": ap2Device() });
    const r = await pairAirPlayDevice("hp-1", "1234");
    expect(r).toEqual({ ok: true });
    // 落库:唯一写入口 saveHapCredentials(deviceId, {accessoryLTPK, controllerLTSK})
    expect(S.saveHapCredentials).toHaveBeenCalledTimes(1);
    expect(S.saveHapCredentials).toHaveBeenCalledWith("hp-1", {
      accessoryLTPK: "a".repeat(64),
      controllerLTSK: "b".repeat(128),
    });
    expect(S.isPaired("hp-1")).toBe(true);
    // PIN 只交给会话层,不得混进凭据
    expect(S.pairNewDevice).toHaveBeenCalledTimes(1);
    expect(S.pairNewDevice.mock.calls[0][0]).toMatchObject({ host: "192.168.1.50", port: 7000, pin: "1234" });
    expect(Object.keys(S.saveHapCredentials.mock.calls[0][1])).not.toContain("pin");
  });

  it("PIN 错误:code=ap2-pin,且失败不写任何凭据(契约:失败不写)", async () => {
    S.setDevices({ "hp-1": ap2Device() });
    const err: any = new Error("pair-setup M4: server proof 校验失败（PIN 错误或对端损坏）");
    err.kind = "auth";
    err.name = "HapPairingError";
    S.pairNewDevice.mockRejectedValueOnce(err);
    const r = await pairAirPlayDevice("hp-1", "9999");
    expect(r).toMatchObject({ ok: false, code: "ap2-pin" });
    expect((r as any).message).toBe(AP2_PAIR_MESSAGES.pinWrong);
    expect(S.saveHapCredentials).not.toHaveBeenCalled();
    expect(S.isPaired("hp-1")).toBe(false);
  });

  it("设备不响应(超时):code=ap2-timeout", async () => {
    S.setDevices({ "hp-1": ap2Device() });
    const err: any = new Error("pair-setup: 超时");
    err.name = "RtspError";
    S.pairNewDevice.mockRejectedValueOnce(err);
    const r = await pairAirPlayDevice("hp-1", "1234");
    expect(r).toMatchObject({ ok: false, code: "ap2-timeout" });
    expect((r as any).message).toBe(AP2_PAIR_MESSAGES.timeout);
    expect(S.saveHapCredentials).not.toHaveBeenCalled();
  });

  it("协议/网络异常:code=ap2-fail(与 PIN 错、超时区分开)", async () => {
    S.setDevices({ "hp-1": ap2Device() });
    const err: any = new Error("connect ECONNREFUSED 192.168.1.50:7000");
    err.code = "ECONNREFUSED";
    S.pairNewDevice.mockRejectedValueOnce(err);
    const r = await pairAirPlayDevice("hp-1", "1234");
    expect(r).toMatchObject({ ok: false, code: "ap2-fail" });
    expect(S.saveHapCredentials).not.toHaveBeenCalled();
  });

  it("凭据写库失败:code=ap2-persist,**不静默成功**", async () => {
    S.setDevices({ "hp-1": ap2Device() });
    S.setPersistThrows(true);
    const r = await pairAirPlayDevice("hp-1", "1234");
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ ok: false, code: "ap2-persist" });
    expect((r as any).message).toBe(AP2_PAIR_MESSAGES.persist);
    expect(S.isPaired("hp-1")).toBe(false);
  });

  it("配对过程没产生 controller seed:视为失败,不写半截凭据", async () => {
    S.setDevices({ "hp-1": ap2Device() });
    S.pairNewDevice.mockResolvedValueOnce({ accessoryLTPK: "a".repeat(64), controllerLTSK: "b".repeat(128) });
    const r = await pairAirPlayDevice("hp-1", "1234");
    expect(r).toMatchObject({ ok: false, code: "ap2-fail" });
    expect(S.saveHapCredentials).not.toHaveBeenCalled();
  });

  it("AP1-only 设备(HiVi):code=ap2-unsupported,不发起任何配对", async () => {
    S.setDevices({ hivi: ap1Device() });
    const r = await pairAirPlayDevice("hivi", "1234");
    expect(r).toMatchObject({ ok: false, code: "ap2-unsupported" });
    expect((r as any).message).toBe(AP2_PAIR_MESSAGES.unsupported);
    expect(S.pairNewDevice).not.toHaveBeenCalled();
  });

  it("设备不存在:code=ap2-unsupported(前置条件错误,不发起配对)", async () => {
    const r = await pairAirPlayDevice("nope", "1234");
    expect(r).toMatchObject({ ok: false, code: "ap2-unsupported" });
    expect(S.pairNewDevice).not.toHaveBeenCalled();
  });

  it("PIN 不是 4 位数字:code=ap2-pin,不发起配对", async () => {
    S.setDevices({ "hp-1": ap2Device() });
    for (const bad of ["", "12", "12345", "12a4", " 12 "]) {
      const r = await pairAirPlayDevice("hp-1", bad);
      expect(r, `pin=${JSON.stringify(bad)}`).toMatchObject({ ok: false, code: "ap2-pin" });
    }
    expect(S.pairNewDevice).not.toHaveBeenCalled();
  });

  it("isValidAirPlayPin:只认 4 位数字(路由层与主流程共用同一判据)", () => {
    expect(isValidAirPlayPin("1234")).toBe(true);
    expect(isValidAirPlayPin(" 1234 ")).toBe(true);
    expect(isValidAirPlayPin("123")).toBe(false);
    expect(isValidAirPlayPin("１２３４")).toBe(false); // 全角数字不算
    expect(isValidAirPlayPin(1234 as any)).toBe(false); // 类型不符由路由层归一
  });
});

describe("getAirPlayCastGateError:cast 准入(不静默回落 AP1)", () => {
  it("未配对 AP2 且不在任何群组:拒绝,文案要求先完成 AirPlay 2 配对", async () => {
    S.setDevices({ "hp-1": ap2Device() });
    const msg = await getAirPlayCastGateError("hp-1");
    expect(msg).toBeTruthy();
    expect(msg!).toContain("AirPlay 2 配对");
  });

  it("未配对 AP2 但已是群组成员:放行(用户规则 2 —— 凭据失效不摘组,播放回落 AP1)", async () => {
    S.setDevices({ "hp-1": ap2Device() });
    S.setGroups("hp-1", ["g-1"]);
    expect(await getAirPlayCastGateError("hp-1")).toBeNull();
  });

  it("已配对 AP2:放行", async () => {
    S.setDevices({ "hp-1": ap2Device() });
    S.setPaired("hp-1", true);
    expect(await getAirPlayCastGateError("hp-1")).toBeNull();
  });

  it("AP1-only 设备(HiVi)完全不受影响:放行", async () => {
    S.setDevices({ hivi: ap1Device() });
    expect(await getAirPlayCastGateError("hivi")).toBeNull();
  });

  it("未知设备:放行(交给后续「设备不存在」错误,不误伤)", async () => {
    expect(await getAirPlayCastGateError("nope")).toBeNull();
  });
});
