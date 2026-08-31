// 音量「只发送、不对账」下的高频调用模拟:
// 前端拖拽(2s 内 30 个并发请求)时,后端每个请求只发一次 SetVolume 即返回,
// 无 GetVolume 对账、无重发 —— 设备侧 SOAP 总数 = 请求数,不再被放大轰炸。
// 对比 v1.13.7/11 的确认窗口/延迟对账逻辑(30 并发 → 数百次 SOAP)。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { initDatabase } from "../../src/db/index.js";
import { getCachedDevices, setDeviceVolume } from "../../src/services/dlna/control.js";

const DEV = "vol-drag-sim-dev";
const RC = "http://dev.local/rc";

let soapLog: string[] = [];

function injectDevice(): void {
  const arr = getCachedDevices();
  if (!arr.some((d: any) => d.id === DEV)) {
    arr.push({ id: DEV, name: "拖拽模拟设备", location: "", renderingControlUrl: RC, lastSeen: Date.now(), available: true });
  }
}

function soapOk(action: string): Response {
  return new Response(
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>` +
    `<u:${action}Response xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"></u:${action}Response>` +
    `</s:Body></s:Envelope>`,
    { status: 200, headers: { "Content-Type": "text/xml" } },
  );
}

beforeAll(() => { initDatabase(); });

beforeEach(() => { injectDevice(); });

afterEach(() => {
  const arr = getCachedDevices();
  const i = arr.findIndex((d: any) => d.id === DEV);
  if (i >= 0) arr.splice(i, 1);
  vi.unstubAllGlobals();
  soapLog = [];
});

describe("音量拖拽高频调用(只发送)", () => {
  it("30 个并发请求 → 每个只发 1 次 SetVolume,0 次 GetVolume(无放大)", async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: any) => {
      const body = String(init?.body || "");
      if (body.includes("SetVolume")) { soapLog.push("SET"); return soapOk("SetVolume"); }
      if (body.includes("GetVolume")) { soapLog.push("GET"); return soapOk("GetVolume"); }
      throw new Error("unexpected");
    });
    vi.stubGlobal("fetch", fetchMock);

    const promises: Promise<void>[] = [];
    for (let v = 50; v >= 21; v--) {
      promises.push(setDeviceVolume(DEV, v).catch(() => {}));
    }
    await Promise.all(promises);

    const setCalls = soapLog.filter((x) => x === "SET").length;
    const getCalls = soapLog.filter((x) => x === "GET").length;
    console.log(`[sim] 30 并发 → SetVolume×${setCalls}, GetVolume×${getCalls}, SOAP 总数×${soapLog.length}`);
    expect(setCalls).toBe(30);       // 一请求一发送
    expect(getCalls).toBe(0);        // 完全不对账
    expect(soapLog.length).toBe(30); // 无放大
  });
});
