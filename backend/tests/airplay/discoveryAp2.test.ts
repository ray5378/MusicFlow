// ==================== E2:AirPlay 2 能力分级发现 ====================
// 契约(见 discovery.ts 文件头):
//   1. **设备表只由 `_raop._tcp` 产生** —— 纯 AP2-only 广播不得凭空造出设备;
//   2. `_airplay._tcp` 只给已存在的 raop 设备打能力标记 `supportsAp2`;
//   3. 判据 = 同时有 `_airplay` 记录 **且** `protovers ≥ 1.1`(不是某个靠猜的 features 位);
//   4. deviceid 归一后对齐(`86:bc:3f:fb:a3:08` ≡ `86BC3FFBA308`);
//   5. `_airplay` 记录下线 ⇒ 能力翻回 false,但设备可用性仍由 `_raop` 决定。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const M = vi.hoisted(() => ({ browsers: [] as any[] }));

vi.mock("bonjour-service", () => ({
  Bonjour: class {
    find(opts: any, onHit: (svc: any) => void) {
      const handlers: Record<string, Function[]> = {};
      const b = {
        type: opts?.type,
        on: (ev: string, cb: Function) => { (handlers[ev] ||= []).push(cb); },
        stop: () => {},
        emit: (ev: string, svc: any) => { for (const cb of handlers[ev] || []) cb(svc); },
        handlers,
        onHit,
      };
      M.browsers.push(b);
      return b;
    }
    destroy() {}
  },
}));

import {
  startAirPlayDiscovery,
  stopAirPlayDiscovery,
  getAirPlayDevices,
  getAirPlayDevice,
  removeAirPlayDevice,
  normalizeAp2DeviceId,
  protoversAtLeast,
} from "../../src/services/airplay/discovery.js";

function raopSvc(over: Partial<any> = {}): any {
  return {
    name: "86BC3FFBA308@Living Room",
    fqdn: "86BC3FFBA308@Living Room._raop._tcp.local",
    host: "ap2.local",
    port: 7000,
    addresses: ["192.168.10.230"],
    txt: { et: "0,1", am: "Airplay2-Receiver", pk: "PK" },
    ...over,
  };
}

function airplaySvc(over: Partial<any> = {}): any {
  return {
    name: "Living Room",
    fqdn: "86BC3FFBA308@Living Room._airplay._tcp.local",
    host: "ap2.local",
    port: 7000,
    addresses: ["192.168.10.230"],
    txt: {
      deviceid: "86:bc:3f:fb:a3:08",
      features: "0x405f4200,0x1c300",
      srcvers: "366.0",
      protovers: "1.1",
      flags: "0x20004",
      gid: "5dccfd20-b166-49cc-a593-6abd5f724ddb",
      model: "Airplay2-Receiver",
    },
    ...over,
  };
}

/** 取指定类型的句柄:`_raop` 是第 0 条,`_airplay` 是第 1 条。 */
const raopBrowser = () => M.browsers.find((b) => b.type === "raop");
const ap2Browser = () => M.browsers.find((b) => b.type === "airplay");

beforeEach(() => {
  M.browsers = [];
  for (const d of getAirPlayDevices()) removeAirPlayDevice(d.id);
});

afterEach(() => stopAirPlayDiscovery());

describe("纯函数:deviceid 归一与 protovers 判据", () => {
  it("12 位十六进制(可带 : / - / 空格)→ 大写无分隔;其它 id 原样保留", () => {
    expect(normalizeAp2DeviceId("86:bc:3f:fb:a3:08")).toBe("86BC3FFBA308");
    expect(normalizeAp2DeviceId("86-BC-3F-FB-A3-08")).toBe("86BC3FFBA308");
    expect(normalizeAp2DeviceId("86bc3ffba308")).toBe("86BC3FFBA308");
    expect(normalizeAp2DeviceId("Speaker._airplay._tcp.local")).toBe("Speaker._airplay._tcp.local");
    expect(normalizeAp2DeviceId("")).toBe("");
  });

  it("protovers ≥ 1.1 才算 AP2;缺省 / 非法 / 1.0 一律 false", () => {
    expect(protoversAtLeast("1.1", [1, 1])).toBe(true);
    expect(protoversAtLeast("2.0", [1, 1])).toBe(true);
    expect(protoversAtLeast("1.0", [1, 1])).toBe(false);
    expect(protoversAtLeast(undefined, [1, 1])).toBe(false);
    expect(protoversAtLeast("beta", [1, 1])).toBe(false);
  });
});

describe("E2 分级发现", () => {
  it("_raop 先到、_airplay 后到 → 补上 supportsAp2 并保留原始能力", () => {
    startAirPlayDiscovery();
    raopBrowser().emit("up", raopSvc());
    expect(getAirPlayDevice("86BC3FFBA308")!.supportsAp2).toBe(false);

    ap2Browser().emit("up", airplaySvc());
    const d = getAirPlayDevice("86BC3FFBA308")!;
    expect(d.supportsAp2).toBe(true);
    expect(d.ap2?.features).toBe("0x405f4200,0x1c300");
    expect(d.ap2?.srcvers).toBe("366.0");
    expect(d.ap2?.protovers).toBe("1.1");
    // AP1 侧字段不受影响
    expect(d.supportsRsa).toBe(true);
    expect(d.port).toBe(7000);
  });

  it("_airplay 先到、_raop 后到 → 设备一入表就是 supportsAp2=true(先到先缓存)", () => {
    startAirPlayDiscovery();
    ap2Browser().emit("up", airplaySvc());
    expect(getAirPlayDevices()).toHaveLength(0); // 不许凭空造设备

    raopBrowser().emit("up", raopSvc());
    expect(getAirPlayDevice("86BC3FFBA308")!.supportsAp2).toBe(true);
  });

  it("**只有 `_airplay` 广播(纯 AP2-only)→ 设备不入表**(AP1 设备表行为不变)", () => {
    startAirPlayDiscovery();
    ap2Browser().emit("up", airplaySvc({ txt: { deviceid: "AA:BB:CC:DD:EE:FF", protovers: "1.1" } }));
    expect(getAirPlayDevices()).toHaveLength(0);
  });

  it("有 `_airplay` 但 protovers=1.0 → supportsAp2=false", () => {
    startAirPlayDiscovery();
    raopBrowser().emit("up", raopSvc());
    ap2Browser().emit("up", airplaySvc({ txt: { ...airplaySvc().txt, protovers: "1.0" } }));
    expect(getAirPlayDevice("86BC3FFBA308")!.supportsAp2).toBe(false);
  });

  it("`_airplay` 缺 deviceid → 忽略(不猜、不影响既有设备)", () => {
    startAirPlayDiscovery();
    raopBrowser().emit("up", raopSvc());
    ap2Browser().emit("up", airplaySvc({ txt: { features: "0x1", protovers: "1.1" } }));
    expect(getAirPlayDevice("86BC3FFBA308")!.supportsAp2).toBe(false);
  });

  it("`_airplay` down → 能力翻回 false,但设备仍在线(可用性由 `_raop` 决定)", () => {
    startAirPlayDiscovery();
    raopBrowser().emit("up", raopSvc());
    ap2Browser().emit("up", airplaySvc());
    expect(getAirPlayDevice("86BC3FFBA308")!.supportsAp2).toBe(true);

    ap2Browser().emit("down", airplaySvc());
    const d = getAirPlayDevice("86BC3FFBA308")!;
    expect(d.supportsAp2).toBe(false);
    expect(d.available).toBe(true);
  });

  it("stop 后再 start:能力表被清空,不会被上一轮残留污染", () => {
    startAirPlayDiscovery();
    raopBrowser().emit("up", raopSvc());
    ap2Browser().emit("up", airplaySvc());
    expect(getAirPlayDevice("86BC3FFBA308")!.supportsAp2).toBe(true);

    stopAirPlayDiscovery();
    // 设备表由调用方负责清空(插件关闭时 dst 保留持久化行);这里手动清掉后重新发现。
    for (const d of getAirPlayDevices()) removeAirPlayDevice(d.id);
    startAirPlayDiscovery();
    raopBrowser().emit("up", raopSvc());
    expect(getAirPlayDevice("86BC3FFBA308")!.supportsAp2).toBe(false);
  });
});
