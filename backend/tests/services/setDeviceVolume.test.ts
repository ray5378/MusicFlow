// setDeviceVolume「只发送、不对账」机制测试:
//   1. SetVolume 发出即返回(1 次 Set,0 次 GetVolume)
//   2. SetVolume 网络/UPnP 失败 → 抛错
// 不再有回读确认/延迟对账/重发/代际锁(用户:"直接清理对账的规则,只发送不对账了")。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from "vitest";
import { initDatabase } from "../../src/db/index.js";
import { getCachedDevices, setDeviceVolume } from "../../src/services/dlna/control.js";

const DEV = "vol-send-test-dev";
const RC = "http://dev.local/rc";
const AV = "http://dev.local/av";

function injectDevice(): void {
  const arr = getCachedDevices();
  if (!arr.some(d => d.id === DEV)) {
    arr.push({ id: DEV, name: "音量只发送测试", location: "", renderingControlUrl: RC, avTransportUrl: AV, lastSeen: Date.now(), available: true });
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

function faultSoap(): Response {
  return new Response(
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>` +
    `<s:Fault><errorCode>501</errorCode><errorDescription>Action Failed</errorDescription></s:Fault>` +
    `</s:Body></s:Envelope>`,
    { status: 500, headers: { "Content-Type": "text/xml; charset=utf-8" } },
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

describe("setDeviceVolume 只发送不对账", () => {
  it("SetVolume 发出即返回(1 次 Set,0 次 GetVolume)", async () => {
    fetchMock = vi.fn(async (_url: unknown, init?: any) => {
      const body = String(init?.body || "");
      if (body.includes("SetVolume")) { setVolumeCalls++; return okSoap("SetVolume"); }
      if (body.includes("GetVolume")) { getVolumeCalls++; return okSoap("GetVolume"); }
      throw new Error("unexpected action");
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(setDeviceVolume(DEV, 20)).resolves.toBeUndefined();
    expect(setVolumeCalls).toBe(1);
    expect(getVolumeCalls).toBe(0); // 完全不对账
  });

  it("SetVolume 失败(UPnP fault)→ 抛错", async () => {
    fetchMock = vi.fn(async (_url: unknown, init?: any) => {
      const body = String(init?.body || "");
      if (body.includes("SetVolume")) { setVolumeCalls++; return faultSoap(); }
      throw new Error("unexpected action");
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(setDeviceVolume(DEV, 20)).rejects.toThrow(/UPnP error|501|Action Failed/);
    expect(setVolumeCalls).toBe(1); // 只发一次,不重发
    expect(getVolumeCalls).toBe(0);
  });

  it("设备不支持音量控制(RenderingControl 缺失)→ 抛错", async () => {
    const arr = getCachedDevices();
    arr.push({ id: "no-rc-dev", name: "无RC", location: "", lastSeen: Date.now(), available: true });
    try {
      await expect(setDeviceVolume("no-rc-dev", 20)).rejects.toThrow("设备不支持音量控制");
    } finally {
      const i = arr.findIndex((d: any) => d.id === "no-rc-dev");
      if (i >= 0) arr.splice(i, 1);
    }
  });
});
