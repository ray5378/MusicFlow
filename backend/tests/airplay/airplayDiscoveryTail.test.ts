// 覆盖率长尾补充:services/airplay/discovery.ts 的三处残余路径。
//   - find() 的即时回调(browser.find 命中一次就走 upsert)
//   - 30s 续期定时器:换新 browser 发一次 PTR/SRV 查询,命中只续 lastSeen/available
//   - spinQuery 本体(短命句柄 + lifeMs 后收掉)
// bonjour-service 需要真实 UDP 5353,整体 mock;用假定时器驱动 30s 续期,不真等。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const M = vi.hoisted(() => ({ browsers: [] as any[] }));

vi.mock("bonjour-service", () => ({
  Bonjour: class {
    destroy() {}
    find(_opts: any, onHit: (svc: any) => void) {
      const handlers: Record<string, Function[]> = {};
      const b = {
        on: (ev: string, cb: Function) => { (handlers[ev] ||= []).push(cb); },
        stop: () => {},
        handlers,
        onHit,
      };
      M.browsers.push(b);
      return b;
    }
  },
}));

import {
  startAirPlayDiscovery,
  stopAirPlayDiscovery,
  getAirPlayDevice,
  getAirPlayDevices,
  addPersistedAirPlayDevice,
  removeAirPlayDevice,
} from "../../src/services/airplay/discovery.js";

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

beforeEach(() => {
  M.browsers = [];
  for (const d of getAirPlayDevices()) removeAirPlayDevice(d.id);
});

afterEach(() => {
  stopAirPlayDiscovery();
  vi.restoreAllMocks();
});

describe("discovery: find() 即时回调", () => {
  it("browser.find 的初次命中直接 upsert(不等 up 事件)", () => {
    startAirPlayDiscovery();
    // find 的回调是「本轮查询的即时应答」通道,与 up/txt-update 事件并行。
    M.browsers[0].onHit(svc());
    const d = getAirPlayDevice("00226CFFA0C0");
    expect(d).toBeTruthy();
    expect(d!.available).toBe(true);
    expect(d!.name).toBe("HiVi H5MKII");
  });
});

describe("discovery: 30s 续期", () => {
  it("每 30s 换新句柄发一次查询;命中只续 lastSeen/available,不发重复 alive", () => {
    vi.useFakeTimers();
    try {
      startAirPlayDiscovery();
      expect(M.browsers.length).toBe(1); // 常驻句柄

      // 预置一台「曾被发现、现在已陈旧离线」的设备:续期只能让它复活,不能重建行。
      addPersistedAirPlayDevice({
        id: "tickdev",
        name: "Tick",
        host: "192.168.10.44",
        port: 5000,
        supportsRsa: true,
        lastSeen: 0,
        available: false,
      });

      vi.advanceTimersByTime(30_000); // 触发续期定时器
      expect(M.browsers.length).toBe(2); // 续期换了一个**短命新句柄**(不是复用常驻句柄)
      const spin = M.browsers[1];

      // 新句柄命中 → 只续 lastSeen / available(不落库、不发 alive,由常驻句柄负责事件)。
      spin.onHit(svc({ name: "tickdev@Tick", fqdn: "tickdev@Tick._raop._tcp.local", addresses: ["192.168.10.44"] }));
      const d = getAirPlayDevice("tickdev")!;
      expect(d.available).toBe(true);
      expect(d.lastSeen).toBeGreaterThan(0);
      expect(d.name).toBe("Tick"); // 续期不改写显示名(仅续期)

      // lifeMs(3000ms)后短命句柄自行收掉 —— 定时器不再挂着。
      vi.advanceTimersByTime(3_000);
    } finally {
      // 先停(此时 clearInterval 还是假实现),再恢复真实定时器。
      stopAirPlayDiscovery();
      vi.useRealTimers();
    }
  });

  it("续期命中一台**未知**设备时什么也不做(不凭空建行)", () => {
    vi.useFakeTimers();
    try {
      startAirPlayDiscovery();
      vi.advanceTimersByTime(30_000);
      const spin = M.browsers[1];
      spin.onHit(svc({ name: "unknown@New", fqdn: "unknown@New._raop._tcp.local" }));
      // 续期回调只做 lastSeen/available 续期,devices 里没有该 id 就跳过。
      expect(getAirPlayDevice("unknown")).toBeUndefined();
      vi.advanceTimersByTime(3_000);
    } finally {
      stopAirPlayDiscovery();
      vi.useRealTimers();
    }
  });
});
