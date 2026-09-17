// 插件配置读取:缺省/非法回退 + 自定义端口。
import { describe, it, expect } from "vitest";
import { sqlite } from "../../db/index.js";
import { readSendspinPluginConfig } from "./index.js";

describe("readSendspinPluginConfig", () => {
  it("无行 → 默认(legacy 开,8927)", () => {
    sqlite.prepare("DELETE FROM plugins WHERE id = 'sendspin-renderer' OR name = 'sendspin-renderer'").run();
    expect(readSendspinPluginConfig()).toEqual({ allowLegacyClients: true, port: 8927, autoDiscover: true });
  });

  it("自定义端口 + 关 legacy", () => {
    sqlite
      .prepare("INSERT INTO plugins (id, name, config) VALUES ('sendspin-renderer', 'sendspin-renderer', ?) ON CONFLICT(id) DO UPDATE SET config = excluded.config")
      .run(JSON.stringify({ port: 8931, allow_legacy_clients: false }));
    expect(readSendspinPluginConfig()).toEqual({ allowLegacyClients: false, port: 8931, autoDiscover: true });
  });

  it("非法端口回退 8927", () => {
    for (const port of [0, -1, 70000, 1.5, "abc", null]) {
      sqlite
        .prepare("INSERT INTO plugins (id, name, config) VALUES ('sendspin-renderer', 'sendspin-renderer', ?) ON CONFLICT(id) DO UPDATE SET config = excluded.config")
        .run(JSON.stringify({ port }));
      expect(readSendspinPluginConfig().port).toBe(8927);
    }
    sqlite.prepare("DELETE FROM plugins WHERE id = 'sendspin-renderer'").run();
  });

  it("auto_discover 缺省开,显式 false 关", () => {
    sqlite.prepare("DELETE FROM plugins WHERE id = 'sendspin-renderer' OR name = 'sendspin-renderer'").run();
    expect(readSendspinPluginConfig().autoDiscover).toBe(true);
    sqlite
      .prepare("INSERT INTO plugins (id, name, config) VALUES ('sendspin-renderer', 'sendspin-renderer', ?) ON CONFLICT(id) DO UPDATE SET config = excluded.config")
      .run(JSON.stringify({ auto_discover: false }));
    expect(readSendspinPluginConfig().autoDiscover).toBe(false);
    sqlite.prepare("DELETE FROM plugins WHERE id = 'sendspin-renderer'").run();
  });
});
