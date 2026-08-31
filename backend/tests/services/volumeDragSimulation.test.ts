// 模拟「前端音量滑块拖拽 → 高频并发 setDeviceVolume」问题:
// 前端 setVolume 无防抖,el-slider @input 每帧发一次 /volume 请求;后端每个请求
// 都进入 setDeviceVolume 的「确认窗口 + 持续重发」循环。本测试模拟一次拖拽
// (2s 内 30 个并发请求,值 50→21 递减),量化设备侧收到的 SOAP 请求总数,
// 证明无防抖时确认循环会被并发放大成请求轰炸。
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

function volumeSoap(v: number): Response {
  return new Response(
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>` +
    `<u:GetVolumeResponse xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1">` +
    `<CurrentVolume>${v}</CurrentVolume></u:GetVolumeResponse>` +
    `</s:Body></s:Envelope>`,
    { status: 200, headers: { "Content-Type": "text/xml" } },
  );
}

beforeAll(() => {
  initDatabase();
});

beforeEach(() => {
  injectDevice();
});

afterEach(() => {
  const arr = getCachedDevices();
  const i = arr.findIndex((d: any) => d.id === DEV);
  if (i >= 0) arr.splice(i, 1);
  vi.unstubAllGlobals();
  soapLog = [];
});

describe("音量拖拽高频调用模拟", () => {
  it("无防抖:一次拖拽(30 并发请求)→ SOAP 请求被确认循环放大成数百次", async () => {
    // 设备「顽固」:SetVolume 总是成功,但 GetVolume 恒返回旧值 80(不采纳),
    // 触发每个 setDeviceVolume 的确认窗口内持续重发(最坏场景)。
    const fetchMock = vi.fn(async (_url: unknown, init?: any) => {
      const body = String(init?.body || "");
      if (body.includes("SetVolume")) { soapLog.push("SET"); return soapOk("SetVolume"); }
      if (body.includes("GetVolume")) { soapLog.push("GET"); return volumeSoap(80); }
      throw new Error("unexpected");
    });
    vi.stubGlobal("fetch", fetchMock);

    // 模拟前端拖拽:2s 内并发发 30 个 setDeviceVolume(值 50→21),不等待完成。
    // 用短参数加速测试(settleMs=30 / attempts=3),保留放大关系。
    const promises: Promise<void>[] = [];
    for (let v = 50; v >= 21; v--) {
      promises.push(setDeviceVolume(DEV, v, { settleMs: 30, attempts: 3 }).catch(() => {}));
    }
    await Promise.all(promises);

    const setCalls = soapLog.filter((x) => x === "SET").length;
    const getCalls = soapLog.filter((x) => x === "GET").length;
    console.log(`[sim] 30 个并发请求 → SetVolume×${setCalls}, GetVolume×${getCalls}, SOAP 总数×${soapLog.length}`);
    // 无防抖时,确认循环把 30 个请求放大成 30×(1 次 Set + N 次 Get/重发)的海量 SOAP。
    expect(soapLog.length).toBeGreaterThan(100);
  });

  it("对照:单次请求(防抖后一次拖拽只发 1 个)→ SOAP 请求数受控", async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: any) => {
      const body = String(init?.body || "");
      if (body.includes("SetVolume")) { soapLog.push("SET"); return soapOk("SetVolume"); }
      if (body.includes("GetVolume")) { soapLog.push("GET"); return volumeSoap(20); } // 采纳 → 快速确认
      throw new Error("unexpected");
    });
    vi.stubGlobal("fetch", fetchMock);
    await setDeviceVolume(DEV, 20, { settleMs: 30, attempts: 2 });
    const setCalls = soapLog.filter((x) => x === "SET").length;
    const getCalls = soapLog.filter((x) => x === "GET").length;
    console.log(`[sim] 单次请求 → SetVolume×${setCalls}, GetVolume×${getCalls}, SOAP 总数×${soapLog.length}`);
    expect(soapLog.length).toBeLessThanOrEqual(10); // 1 次 Set + 有限次确认轮询
  });
});
