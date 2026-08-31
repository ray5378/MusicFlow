// setDeviceVolume「秒发秒走 + 延迟对账 + 不对重发」机制测试:
//   1. SetVolume 后等稳定,GetVolume 对账命中目标 → 成功(一次即命中)
//   2. 设备未采纳(对账恒为旧值)→ 重发 SetVolume,attempts 次后抛错
//   3. 设备 GetVolume 一直无回应 → 重发,attempts 次后抛错
//   4. confirm:false → 只发 SetVolume,不对账
// 参数用短值加速测试(生产默认 settleMs=1500 / attempts=6)。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from "vitest";
import { initDatabase } from "../../src/db/index.js";
import { getCachedDevices, setDeviceVolume } from "../../src/services/dlna/control.js";

const DEV = "vol-confirm-test-dev";
const RC = "http://dev.local/rc";
const AV = "http://dev.local/av";

/** 快速参数:稳定等待 50ms、重发 2 次,避免测试慢。 */
const fast = (attempts = 2) => ({ settleMs: 50, attempts, tolerance: 1 });

function injectDevice(): void {
  const arr = getCachedDevices();
  if (!arr.some(d => d.id === DEV)) {
    arr.push({ id: DEV, name: "音量确认测试", location: "", renderingControlUrl: RC, avTransportUrl: AV, lastSeen: Date.now(), available: true });
  }
}

function cleanDevice(): void {
  const arr = getCachedDevices();
  const i = arr.findIndex(d => d.id === DEV);
  if (i >= 0) arr.splice(i, 1);
}

let fetchMock: ReturnType<typeof vi.fn>;
let setVolumeCalls = 0;
let getVolumeCalls = 0;

function okSoap(action: string): Response {
  return new Response(
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>` +
    `<u:${action}Response xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"></u:${action}Response>` +
    `</s:Body></s:Envelope>`,
    { status: 200, headers: { "Content-Type": "text/xml; charset=utf-8" } },
  );
}

function volumeSoap(value: number): Response {
  return new Response(
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>` +
    `<u:GetVolumeResponse xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1">` +
    `<CurrentVolume>${value}</CurrentVolume></u:GetVolumeResponse>` +
    `</s:Body></s:Envelope>`,
    { status: 200, headers: { "Content-Type": "text/xml; charset=utf-8" } },
  );
}

beforeAll(() => {
  initDatabase();
  injectDevice();
});

afterAll(() => {
  cleanDevice();
});

afterEach(() => {
  vi.unstubAllGlobals();
  setVolumeCalls = 0;
  getVolumeCalls = 0;
});

describe("setDeviceVolume 秒发秒走 + 延迟对账", () => {
  it("SetVolume 后等稳定,GetVolume 对账命中 → 成功(一次即命中)", async () => {
    fetchMock = vi.fn(async (_url: unknown, init?: any) => {
      const body = String(init?.body || "");
      if (body.includes("SetVolume")) { setVolumeCalls++; return okSoap("SetVolume"); }
      if (body.includes("GetVolume")) { getVolumeCalls++; return volumeSoap(20); }
      throw new Error("unexpected action");
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(setDeviceVolume(DEV, 20, fast())).resolves.toBeUndefined();
    expect(setVolumeCalls).toBe(1);   // 一次即对账命中,不重发
    expect(getVolumeCalls).toBe(1);
  });

  it("设备未采纳(对账恒为旧值)→ 重发 SetVolume,attempts 次后抛错", async () => {
    fetchMock = vi.fn(async (_url: unknown, init?: any) => {
      const body = String(init?.body || "");
      if (body.includes("SetVolume")) { setVolumeCalls++; return okSoap("SetVolume"); }
      if (body.includes("GetVolume")) { getVolumeCalls++; return volumeSoap(80); } // 设备一直报 80
      throw new Error("unexpected action");
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(setDeviceVolume(DEV, 20, fast(2))).rejects.toThrow(/对账失败|最后回读 80/);
    expect(setVolumeCalls).toBe(2);   // attempts=2:重发一次后放弃
  });

  it("设备 GetVolume 一直无回应 → 重发,attempts 次后抛错", async () => {
    fetchMock = vi.fn(async (_url: unknown, init?: any) => {
      const body = String(init?.body || "");
      if (body.includes("SetVolume")) { setVolumeCalls++; return okSoap("SetVolume"); }
      if (body.includes("GetVolume")) { getVolumeCalls++; throw new Error("GetVolume unsupported"); }
      throw new Error("unexpected action");
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(setDeviceVolume(DEV, 20, fast(2))).rejects.toThrow(/对账失败|无响应/);
    expect(setVolumeCalls).toBe(2);   // attempts=2:重发一次后放弃
    expect(getVolumeCalls).toBe(2);
  });

  it("confirm:false → 只发一次 SetVolume,完全不对账", async () => {
    fetchMock = vi.fn(async (_url: unknown, init?: any) => {
      const body = String(init?.body || "");
      if (body.includes("SetVolume")) { setVolumeCalls++; return okSoap("SetVolume"); }
      if (body.includes("GetVolume")) { getVolumeCalls++; return volumeSoap(20); }
      throw new Error("unexpected action");
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(setDeviceVolume(DEV, 20, { ...fast(), confirm: false })).resolves.toBeUndefined();
    expect(setVolumeCalls).toBe(1);
    expect(getVolumeCalls).toBe(0);
  });
});
