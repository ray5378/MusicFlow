// 双协议互斥 smoke 测试:DLNA↔AirPlay 同 host 会话互斥的导出函数安全可用。
// 真实设备链路(SOAP/RAOP)依赖网络设备,由 e2e/人工验证;这里覆盖纯逻辑边界:
// 空 host、无会话、无同 host 设备时不抛错、不误杀。
import { describe, it, expect, beforeAll } from "vitest";
import { sqlite } from "../../src/db/index.js";
import { registerBuiltinPlugins } from "../../src/plugins/builtins.js";
import { stopAirPlaySessionsForHost } from "../../src/services/airplay/control.js";
import { stopDevicePlayback } from "../../src/services/dlna/control.js";

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  registerBuiltinPlugins();
  sqlite.prepare("DELETE FROM settings").run();
});

describe("双协议互斥(方案 A)", () => {
  it("stopAirPlaySessionsForHost 空 host 安全返回空数组", async () => {
    const stopped = await stopAirPlaySessionsForHost("");
    expect(stopped).toEqual([]);
  });

  it("stopAirPlaySessionsForHost 无同 host 会话时不误杀、不抛错", async () => {
    const stopped = await stopAirPlaySessionsForHost("192.168.99.99");
    expect(Array.isArray(stopped)).toBe(true);
  });

  it("stopDevicePlayback 对不存在设备安全返回(不抛错)", async () => {
    // getDevice 找不到 → 直接 return;不抛错即通过
    await expect(stopDevicePlayback("nonexistent-device-id")).resolves.toBeUndefined();
  });
});
