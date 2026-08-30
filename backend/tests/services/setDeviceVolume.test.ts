// setDeviceVolume「回读确认 + 持续重发(时间窗口)」机制测试:
//   1. SetVolume 后 GetVolume 回读命中目标 → 成功
//   2. 设备未采纳(回读恒为旧值)→ 窗口内持续重发,窗口耗尽后抛错
//   3. 设备 GetVolume 一直无回应 → 窗口内持续重发,窗口耗尽后抛错
//   4. confirm:false → 只发 SetVolume,不回读
// 窗口参数用短值加速测试(生产默认 timeoutMs=10000 / confirmIntervalMs=500)。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from "vitest";
import { initDatabase } from "../../src/db/index.js";
import { getCachedDevices, setDeviceVolume } from "../../src/services/dlna/control.js";

const DEV = "vol-confirm-test-dev";
const RC = "http://dev.local/rc";
const AV = "http://dev.local/av";

/** 快速参数:把确认窗口压到 500ms、回读间隔 50ms,避免测试慢。 */
const fast = () => ({ timeoutMs: 500, confirmIntervalMs: 50, tolerance: 1 });

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

describe("setDeviceVolume 回读确认(时间窗口持续重发)", () => {
  it("SetVolume 后 GetVolume 回读命中目标 → 成功(一次即确认,不重发)", async () => {
    fetchMock = vi.fn(async (_url: unknown, init?: any) => {
      const body = String(init?.body || "");
      if (body.includes("SetVolume")) { setVolumeCalls++; return okSoap("SetVolume"); }
      if (body.includes("GetVolume")) { getVolumeCalls++; return volumeSoap(20); }
      throw new Error("unexpected action");
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(setDeviceVolume(DEV, 20, fast())).resolves.toBeUndefined();
    expect(setVolumeCalls).toBe(1);   // 一次即命中,窗口内不再重发
    expect(getVolumeCalls).toBe(1);
  });

  it("设备未采纳(回读恒为旧值)→ 窗口内持续重发 SetVolume,窗口耗尽后抛错", async () => {
    fetchMock = vi.fn(async (_url: unknown, init?: any) => {
      const body = String(init?.body || "");
      if (body.includes("SetVolume")) { setVolumeCalls++; return okSoap("SetVolume"); }
      if (body.includes("GetVolume")) { getVolumeCalls++; return volumeSoap(80); } // 设备一直报 80
      throw new Error("unexpected action");
    });
    vi.stubGlobal("fetch", fetchMock);
    const started = Date.now();
    await expect(setDeviceVolume(DEV, 20, fast())).rejects.toThrow(/未获设备确认|最后回读 80/);
    const elapsed = Date.now() - started;
    expect(setVolumeCalls).toBeGreaterThan(3); // 持续重发(500ms 窗口 / 50ms 频率 ≈ 多轮)
    expect(elapsed).toBeGreaterThanOrEqual(450); // 窗口确实跑满
  });

  it("设备 GetVolume 一直无回应 → 窗口内持续重发,窗口耗尽后抛错", async () => {
    fetchMock = vi.fn(async (_url: unknown, init?: any) => {
      const body = String(init?.body || "");
      if (body.includes("SetVolume")) { setVolumeCalls++; return okSoap("SetVolume"); }
      if (body.includes("GetVolume")) { getVolumeCalls++; throw new Error("GetVolume unsupported"); }
      throw new Error("unexpected action");
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(setDeviceVolume(DEV, 20, fast())).rejects.toThrow(/未获设备确认|无响应/);
    expect(setVolumeCalls).toBeGreaterThan(3); // 无回应也持续重发,直到窗口耗尽
    expect(getVolumeCalls).toBeGreaterThan(3);
  });

  it("confirm:false → 只发一次 SetVolume,完全不回读 GetVolume", async () => {
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
