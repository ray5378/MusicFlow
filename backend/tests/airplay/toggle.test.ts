// AirPlay 插件开关测试:isAirPlayEnabled 读插件状态 + stopAirPlayService 幂等安全。
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { sqlite } from "../../src/db/index.js";
import { registerBuiltinPlugins } from "../../src/plugins/builtins.js";
import { isAirPlayEnabled, stopAirPlayService } from "../../src/services/airplay/control.js";

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  registerBuiltinPlugins();
});
beforeEach(() => {
  sqlite.prepare("DELETE FROM plugins").run();
});

describe("AirPlay 开关(默认关闭)", () => {
  it("无 plugins 行(或未注册)时 isAirPlayEnabled = false(默认关闭)", () => {
    expect(isAirPlayEnabled()).toBe(false);
  });

  it("airplay-renderer enabled=1 时 isAirPlayEnabled = true", () => {
    sqlite.prepare("INSERT INTO plugins (id, name, enabled) VALUES (?, ?, 1)").run("p-airplay", "airplay-renderer");
    expect(isAirPlayEnabled()).toBe(true);
  });

  it("airplay-renderer enabled=0 时 isAirPlayEnabled = false", () => {
    sqlite.prepare("INSERT INTO plugins (id, name, enabled) VALUES (?, ?, 0)").run("p-airplay", "airplay-renderer");
    expect(isAirPlayEnabled()).toBe(false);
  });

  it("stopAirPlayService 在无会话/未启动时幂等安全(不抛错)", async () => {
    await expect(stopAirPlayService()).resolves.toBeUndefined();
  });
});
