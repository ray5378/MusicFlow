// ==================== AirPlay (RAOP) mDNS 发现 ====================
// bonjour-service 需要真实 UDP 5353,这里整体 mock,只验证本模块的
// 设备解析(名字/ID/TXT)、上下线事件、持久化钩子与陈旧剔除。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const M = vi.hoisted(() => ({
  browsers: [] as any[],
  destroyed: 0,
  findThrows: false as boolean,
  newThrows: false as boolean,
}));

vi.mock("bonjour-service", () => ({
  Bonjour: class {
    constructor() {
      if (M.newThrows) throw new Error("mDNS unavailable");
    }
    find(_opts: any, onHit: (svc: any) => void) {
      if (M.findThrows) throw new Error("find failed");
      const handlers: Record<string, Function[]> = {};
      const b = {
        on: (ev: string, cb: Function) => { (handlers[ev] ||= []).push(cb); },
        stop: () => {},
        emit: (ev: string, svc: any) => { for (const cb of handlers[ev] || []) cb(svc); },
        handlers,
        onHit,
      };
      M.browsers.push(b);
      return b;
    }
    destroy() { M.destroyed++; }
  },
}));

import {
  startAirPlayDiscovery,
  stopAirPlayDiscovery,
  rescanAirPlayDevices,
  getAirPlayDevices,
  getAirPlayDevice,
  addPersistedAirPlayDevice,
  removeAirPlayDevice,
  onAirPlayEvent,
  setAirPlayPersist,
} from "../../src/services/airplay/discovery.js";

/** 造一个 _raop._tcp 服务记录。 */
function svc(over: Partial<any> = {}): any {
  return {
    name: "00226CFFA0C0@HiVi H5MKII",
    fqdn: "00226CFFA0C0@HiVi H5MKII._raop._tcp.local",
    host: "hivi.local",
    port: 5000,
    addresses: ["192.168.10.30"],
    txt: { et: "0,1", am: "HiVi", pk: "BASE64KEY", flags: "0x4" },
    ...over,
  };
}

const events: any[] = [];
function onEvent(e: any) { events.push(e); }

beforeEach(() => {
  M.browsers = [];
  M.destroyed = 0;
  M.findThrows = false;
  M.newThrows = false;
  events.length = 0;
  onAirPlayEvent(onEvent);
  for (const d of getAirPlayDevices()) removeAirPlayDevice(d.id);
});

afterEach(() => {
  stopAirPlayDiscovery();
  setAirPlayPersist(null);
});

describe("发现生命周期", () => {
  it("startAirPlayDiscovery 建立 browser 并监听 up/down/txt-update/srv-update", () => {
    startAirPlayDiscovery();
    expect(M.browsers.length).toBe(1);
    const b = M.browsers[0];
    for (const ev of ["up", "down", "txt-update", "srv-update"]) {
      expect(b.handlers[ev]?.length, ev).toBe(1);
    }
  });

  it("幂等:重复 start 不再新建 browser", () => {
    startAirPlayDiscovery();
    startAirPlayDiscovery();
    expect(M.browsers.length).toBe(1);
  });

  it("mDNS 不可用(new Bonjour 抛错)→ 静默返回,不冒泡", () => {
    M.newThrows = true;
    expect(() => startAirPlayDiscovery()).not.toThrow();
    expect(M.browsers.length).toBe(0);
  });

  it("stopAirPlayDiscovery 销毁实例且可再次启动", () => {
    startAirPlayDiscovery();
    stopAirPlayDiscovery();
    expect(M.destroyed).toBe(1);
    startAirPlayDiscovery();
    expect(M.browsers.length).toBe(2);
  });
});

describe("设备解析与事件", () => {
  it("up 事件:解析 id/友好名/host/port/TXT,发 alive", () => {
    startAirPlayDiscovery();
    M.browsers[0].emit("up", svc());
    const list = getAirPlayDevices();
    expect(list.length).toBe(1);
    const d = list[0];
    expect(d.id).toBe("00226CFFA0C0");
    expect(d.name).toBe("HiVi H5MKII"); // 剥掉 "<id>@" 前缀
    expect(d.host).toBe("192.168.10.30"); // 取 IPv4 地址
    expect(d.port).toBe(5000);
    expect(d.am).toBe("HiVi");
    expect(d.supportsRsa).toBe(true); // et 含 "1"
    expect(d.available).toBe(true);
    expect(events).toEqual([{ type: "alive", device: d }]);
  });

  it("et 不含 1 → supportsRsa=false", () => {
    startAirPlayDiscovery();
    M.browsers[0].emit("up", svc({ txt: { et: "0" } }));
    expect(getAirPlayDevices()[0].supportsRsa).toBe(false);
  });

  it("无 '@' 的服务名:id 退化为 fqdn,名字用原名", () => {
    startAirPlayDiscovery();
    M.browsers[0].emit("up", svc({ name: "PlainSpeaker", fqdn: "PlainSpeaker._raop._tcp.local" }));
    const d = getAirPlayDevices()[0];
    expect(d.id).toBe("PlainSpeaker._raop._tcp.local");
    expect(d.name).toBe("PlainSpeaker");
  });

  it("无 IP / 无 port → 不入表(无法路由)", () => {
    startAirPlayDiscovery();
    M.browsers[0].emit("up", svc({ addresses: [], host: "", port: 0 }));
    expect(getAirPlayDevices().length).toBe(0);
  });

  it("down 事件:标离线并发 byebye", () => {
    startAirPlayDiscovery();
    M.browsers[0].emit("up", svc());
    M.browsers[0].emit("down", svc());
    expect(getAirPlayDevice("00226CFFA0C0")!.available).toBe(false);
    expect(events[events.length - 1]).toEqual({ type: "byebye", id: "00226CFFA0C0" });
  });

  it("重复 up(同一设备)不重复发 alive;离线后再上线才发", () => {
    startAirPlayDiscovery();
    M.browsers[0].emit("up", svc());
    M.browsers[0].emit("up", svc());
    expect(events.length).toBe(1);
    M.browsers[0].emit("down", svc());
    M.browsers[0].emit("up", svc());
    expect(events.length).toBe(3); // alive + byebye + alive
    expect(events[2].type).toBe("alive");
  });

  it("txt-update / srv-update 走同一条 upsert", () => {
    startAirPlayDiscovery();
    M.browsers[0].emit("txt-update", svc({ txt: { et: "0,1", am: "NewModel" } }));
    expect(getAirPlayDevices()[0].am).toBe("NewModel");
  });

  it("订阅者抛错不影响其它订阅者(事件分发有兜底)", () => {
    onAirPlayEvent(() => { throw new Error("subscriber boom"); });
    startAirPlayDiscovery();
    expect(() => M.browsers[0].emit("up", svc())).not.toThrow();
    expect(events.length).toBeGreaterThan(0);
  });
});

describe("持久化钩子与手动重扫", () => {
  it("setAirPlayPersist:发现时回填 alias/disabled", () => {
    setAirPlayPersist((d: any) => ({ ...d, alias: "主卧", disabled: true }));
    startAirPlayDiscovery();
    M.browsers[0].emit("up", svc());
    const d = getAirPlayDevice("00226CFFA0C0")!;
    expect(d.alias).toBe("主卧");
    expect(d.disabled).toBe(true);
  });

  it("addPersistedAirPlayDevice 可以直接灌入库里恢复的离线设备", () => {
    addPersistedAirPlayDevice({
      id: "restored", name: "Restored", host: "192.168.10.9", port: 5000,
      supportsRsa: false, lastSeen: Date.now(), available: false,
    });
    expect(getAirPlayDevice("restored")!.available).toBe(false);
  });

  it("removeAirPlayDevice 删除(用户永久删除)", () => {
    addPersistedAirPlayDevice({
      id: "gone", name: "G", host: "1.2.3.4", port: 5000,
      supportsRsa: false, lastSeen: Date.now(), available: true,
    });
    removeAirPlayDevice("gone");
    expect(getAirPlayDevice("gone")).toBeUndefined();
  });

  it("rescanAirPlayDevices:未启动发现 → 立即 resolve 且不抛", async () => {
    await expect(rescanAirPlayDevices(10)).resolves.toBeUndefined();
  });

  it("rescanAirPlayDevices:命中即 upsert(刚上电的接收端立刻出现)", async () => {
    startAirPlayDiscovery();
    const p = rescanAirPlayDevices(20);
    // 重扫会新开一个 browser 句柄;模拟它命中
    const refresh = M.browsers[M.browsers.length - 1];
    refresh.onHit(svc({ name: "B@NewSpeaker", fqdn: "B@NewSpeaker._raop._tcp.local" }));
    await p;
    expect(getAirPlayDevice("B")).toBeTruthy();
  });

  it("重扫时 find 抛错 → 捕获并 resolve", async () => {
    startAirPlayDiscovery();
    M.findThrows = true;
    await expect(rescanAirPlayDevices(10)).resolves.toBeUndefined();
  });
});

describe("陈旧剔除", () => {
  it("超过 90s 未刷新 → 读取时标为不可用", () => {
    addPersistedAirPlayDevice({
      id: "stale", name: "S", host: "1.1.1.1", port: 5000,
      supportsRsa: false, lastSeen: Date.now() - 91_000, available: true,
    });
    expect(getAirPlayDevice("stale")!.available).toBe(false);
    expect(getAirPlayDevices().find((d) => d.id === "stale")!.available).toBe(false);
  });
});
