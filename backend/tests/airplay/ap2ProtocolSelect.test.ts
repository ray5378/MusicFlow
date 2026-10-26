// ==================== 桥协议选择唯一落点(Phase 6b · T01)====================
//
// 钉死 selectAirPlayBridgeProtocol 的四条判据与三条契约:
//   ① 旗标 MUSICFLOW_AIRPLAY_AP2=0 ⇒ raop(只有显式 "0" 才关);
//   ② 设备不存在 / supportsAp2 !== true ⇒ raop(protovers ≥ 1.1 是唯一有实测支撑的判据);
//   ③ 未配对(无 hap_credentials)⇒ raop;
//   ④ 否则 ⇒ ap2-realtime;
//   A. 绝不返回 ap2-compat / ap2-buffered(前者与 raop 逐字段相同会诱发无意义分叉,
//      后者仓内无实现 ⇒ 选中即无声);
//   B. 纯查表、无副作用、**绝不抛异常**(DB/发现层任何异常一律回落 raop);
//   C. disabled 不参与选择(准入由 isAirPlayMemberSelectable 负责,协议选择只管「怎么出声」)。
//
// MUST be the first import: control.ts 链路会碰 DB(DATA_DIR 必须指到隔离目录)。
import "../plugins/_env.js";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 设备表 / 凭据表替身:选择器只读这两样,替身让矩阵可以逐条摆布(含抛错注入)。
const H = vi.hoisted(() => {
  const devices: Record<string, { id: string; supportsAp2: boolean; disabled?: boolean }> = {};
  const creds = new Set<string>();
  const state = { deviceThrows: false, credsThrows: false };
  return { devices, creds, state };
});

vi.mock("../../src/services/airplay/discovery.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    getAirPlayDevice: (id: string) => {
      if (H.state.deviceThrows) throw new Error("discovery 炸了(注入)");
      return H.devices[id];
    },
    getAirPlayDevices: () => Object.values(H.devices),
  };
});

vi.mock("../../src/services/airplay/ap2/hapCredentials.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    getHapCredentials: (id: string) => {
      if (H.state.credsThrows) throw new Error("凭据列读失败(注入)");
      return H.creds.has(id)
        ? { accessoryLTPK: "a".repeat(64), controllerLTSK: "b".repeat(128) }
        : null;
    },
  };
});

import { selectAirPlayBridgeProtocol } from "../../src/services/airplay/control.js";
import { PROTOCOL_CAPS, type BridgeProtocol } from "../../src/services/airplay/rates.js";

const FLAG = "MUSICFLOW_AIRPLAY_AP2";

beforeEach(() => {
  for (const k of Object.keys(H.devices)) delete H.devices[k];
  H.creds.clear();
  H.state.deviceThrows = false;
  H.state.credsThrows = false;
  delete process.env[FLAG];
});

afterEach(() => {
  delete process.env[FLAG];
});

describe("selectAirPlayBridgeProtocol · 四条判据矩阵", () => {
  it("① 旗标 MUSICFLOW_AIRPLAY_AP2=0 ⇒ raop(即便设备已配对也不走 AP2)", () => {
    H.devices["ap2-paired"] = { id: "ap2-paired", supportsAp2: true };
    H.creds.add("ap2-paired");
    expect(selectAirPlayBridgeProtocol("ap2-paired")).toBe("ap2-realtime");
    process.env[FLAG] = "0";
    expect(selectAirPlayBridgeProtocol("ap2-paired")).toBe("raop");
  });

  it("① 旗标非 \"0\"(缺省 / \"1\" / 任意值)⇒ 保持 AP2 选择(默认开)", () => {
    H.devices["ap2-paired"] = { id: "ap2-paired", supportsAp2: true };
    H.creds.add("ap2-paired");
    for (const v of [undefined, "1", "true", "", "0 "]) {
      if (v === undefined) delete process.env[FLAG];
      else process.env[FLAG] = v;
      expect(selectAirPlayBridgeProtocol("ap2-paired")).toBe("ap2-realtime");
    }
  });

  it("② 设备不存在 ⇒ raop", () => {
    expect(selectAirPlayBridgeProtocol("no-such-device")).toBe("raop");
  });

  it("② AP1-only 设备(supportsAp2=false)⇒ raop(AP1 行为完全不变)", () => {
    H.devices.hivi = { id: "hivi", supportsAp2: false };
    H.creds.add("hivi"); // 即便库里意外有凭据,AP1 设备也不走 AP2
    expect(selectAirPlayBridgeProtocol("hivi")).toBe("raop");
  });

  it("② supportsAp2 非严格 true(undefined)⇒ raop(不做真值宽松判定)", () => {
    H.devices.weird = { id: "weird", supportsAp2: undefined as unknown as boolean };
    H.creds.add("weird");
    expect(selectAirPlayBridgeProtocol("weird")).toBe("raop");
  });

  it("③ AP2 能力但未配对(无凭据)⇒ raop", () => {
    H.devices["ap2-unpaired"] = { id: "ap2-unpaired", supportsAp2: true };
    expect(selectAirPlayBridgeProtocol("ap2-unpaired")).toBe("raop");
  });

  it("④ AP2 能力 + 已配对 ⇒ ap2-realtime", () => {
    H.devices["ap2-paired"] = { id: "ap2-paired", supportsAp2: true };
    H.creds.add("ap2-paired");
    expect(selectAirPlayBridgeProtocol("ap2-paired")).toBe("ap2-realtime");
  });

  it("C. disabled 不参与协议选择(准入由 isAirPlayMemberSelectable 负责)", () => {
    H.devices["ap2-paired"] = { id: "ap2-paired", supportsAp2: true, disabled: true };
    H.creds.add("ap2-paired");
    expect(selectAirPlayBridgeProtocol("ap2-paired")).toBe("ap2-realtime");
  });
});

describe("selectAirPlayBridgeProtocol · 契约(不抛 / 不选禁用协议)", () => {
  it("B. 发现层抛异常 ⇒ raop(选择器绝不成为新的故障面)", () => {
    H.state.deviceThrows = true;
    expect(() => selectAirPlayBridgeProtocol("x")).not.toThrow();
    expect(selectAirPlayBridgeProtocol("x")).toBe("raop");
  });

  it("B. 凭据列抛异常 ⇒ raop(不向上抛)", () => {
    H.devices["ap2-paired"] = { id: "ap2-paired", supportsAp2: true };
    H.state.credsThrows = true;
    expect(() => selectAirPlayBridgeProtocol("ap2-paired")).not.toThrow();
    expect(selectAirPlayBridgeProtocol("ap2-paired")).toBe("raop");
  });

  it("A. 全设备矩阵下只可能返回 raop / ap2-realtime(绝不 ap2-compat / ap2-buffered)", () => {
    H.devices.a = { id: "a", supportsAp2: false };
    H.devices.b = { id: "b", supportsAp2: true };
    H.devices.c = { id: "c", supportsAp2: true, disabled: true };
    H.creds.add("b");
    H.creds.add("c");
    const ids = ["a", "b", "c", "ghost", ""];
    const seen = new Set<BridgeProtocol>();
    for (const flag of [undefined, "0", "1"]) {
      if (flag === undefined) delete process.env[FLAG];
      else process.env[FLAG] = flag;
      for (const id of ids) seen.add(selectAirPlayBridgeProtocol(id));
    }
    expect([...seen].sort()).toEqual(["ap2-realtime", "raop"]);
    for (const p of seen) {
      expect(p).not.toBe("ap2-compat");
      expect(p).not.toBe("ap2-buffered");
    }
  });

  it("A. 选中的协议在 PROTOCOL_CAPS 里有确定能力(48k / alac-chacha / streamType 96)", () => {
    const caps = PROTOCOL_CAPS["ap2-realtime"];
    expect(caps.rate).toBe(48000);
    expect(caps.clock).toBe("ntp");
    expect(caps.encryption).toBe("alac-chacha");
    expect(caps.streamType).toBe(96);
  });

  it("幂等:同一设备连续调用结果恒定(纯查表,无副作用)", () => {
    H.devices["ap2-paired"] = { id: "ap2-paired", supportsAp2: true };
    H.creds.add("ap2-paired");
    const first = selectAirPlayBridgeProtocol("ap2-paired");
    for (let i = 0; i < 5; i++) expect(selectAirPlayBridgeProtocol("ap2-paired")).toBe(first);
  });
});
