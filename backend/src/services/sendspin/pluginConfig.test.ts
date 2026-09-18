// 插件配置读取:缺省/非法回退 + 自定义端口。
import { describe, it, expect } from "vitest";
import { sqlite } from "../../db/index.js";
import { readSendspinPluginConfig } from "./index.js";

describe("readSendspinPluginConfig", () => {
  it("无行 → 默认(legacy 开,38927)", () => {
    sqlite.prepare("DELETE FROM plugins WHERE id = 'sendspin-renderer' OR name = 'sendspin-renderer'").run();
    expect(readSendspinPluginConfig()).toEqual({
      allowLegacyClients: true,
      port: 38927,
      autoDiscover: true,
      preferredCodec: "pcm",
      // 注:ESPHome 6053 的开关/密钥/端口**已不在插件配置里**(每台设备各自一把,
      // 见下面「6053 开关/密钥不再属于插件配置」用例)。
      // 流式解码默认开(3.0.36 灰度验证稳定后转正)。
      streamSource: true,
    });
  });

  it("自定义端口 + 关 legacy", () => {
    sqlite
      .prepare("INSERT INTO plugins (id, name, config) VALUES ('sendspin-renderer', 'sendspin-renderer', ?) ON CONFLICT(id) DO UPDATE SET config = excluded.config")
      .run(JSON.stringify({ port: 8931, allow_legacy_clients: false }));
    expect(readSendspinPluginConfig()).toEqual({
      allowLegacyClients: false,
      port: 8931,
      autoDiscover: true,
      preferredCodec: "pcm",
      streamSource: true,
    });
  });

  it("非法端口回退 38927", () => {
    for (const port of [0, -1, 70000, 1.5, "abc", null]) {
      sqlite
        .prepare("INSERT INTO plugins (id, name, config) VALUES ('sendspin-renderer', 'sendspin-renderer', ?) ON CONFLICT(id) DO UPDATE SET config = excluded.config")
        .run(JSON.stringify({ port }));
      expect(readSendspinPluginConfig().port).toBe(38927);
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

  it("6053 开关/密钥不再属于插件配置(已改为每台设备各自一把)", () => {
    sqlite.prepare("DELETE FROM plugins WHERE id = 'sendspin-renderer' OR name = 'sendspin-renderer'").run();
    const write = (cfg: any) =>
      sqlite
        .prepare("INSERT INTO plugins (id, name, config) VALUES ('sendspin-renderer', 'sendspin-renderer', ?) ON CONFLICT(id) DO UPDATE SET config = excluded.config")
        .run(JSON.stringify(cfg));
    // ⚠️ 6053 的开关/密钥/端口**已不在插件配置里** —— 它们是每台设备各自的,
    // 存 sendspin_device_state(clientId → psk/port)。这里锁死「即便插件配置里
    // 残留旧字段也不再被读出来」,防止哪天有人手滑把全局开关加回来。
    write({ esphome_mirror: true, esphome_psk: "abcd", esphome_port: 6054 });
    const cfg = readSendspinPluginConfig() as any;
    expect(cfg.esphomeMirror).toBeUndefined();
    expect(cfg.esphomePsk).toBeUndefined();
    expect(cfg.esphomePort).toBeUndefined();
    sqlite.prepare("DELETE FROM plugins WHERE id = 'sendspin-renderer'").run();
  });

  it("preferred_codec 缺省 pcm,flac 生效,非法值回落 pcm", () => {
    sqlite.prepare("DELETE FROM plugins WHERE id = 'sendspin-renderer' OR name = 'sendspin-renderer'").run();
    const write = (cfg: any) =>
      sqlite
        .prepare("INSERT INTO plugins (id, name, config) VALUES ('sendspin-renderer', 'sendspin-renderer', ?) ON CONFLICT(id) DO UPDATE SET config = excluded.config")
        .run(JSON.stringify(cfg));
    // 缺省 / 大小写 / 大写垃圾值 → pcm
    expect(readSendspinPluginConfig().preferredCodec).toBe("pcm");
    write({});
    expect(readSendspinPluginConfig().preferredCodec).toBe("pcm");
    write({ preferred_codec: "opus" });
    expect(readSendspinPluginConfig().preferredCodec).toBe("pcm");
    write({ preferred_codec: null });
    expect(readSendspinPluginConfig().preferredCodec).toBe("pcm");
    // 显式 flac(含大写容错)→ flac
    write({ preferred_codec: "flac" });
    expect(readSendspinPluginConfig().preferredCodec).toBe("flac");
    write({ preferred_codec: "FLAC" });
    expect(readSendspinPluginConfig().preferredCodec).toBe("flac");
    sqlite.prepare("DELETE FROM plugins WHERE id = 'sendspin-renderer'").run();
  });

  it("stream_source 缺省开,只有显式 false 才关", () => {
    sqlite.prepare("DELETE FROM plugins WHERE id = 'sendspin-renderer' OR name = 'sendspin-renderer'").run();
    const write = (cfg: any) =>
      sqlite
        .prepare("INSERT INTO plugins (id, name, config) VALUES ('sendspin-renderer', 'sendspin-renderer', ?) ON CONFLICT(id) DO UPDATE SET config = excluded.config")
        .run(JSON.stringify(cfg));
    // 无行 / 空配置 → 默认开
    expect(readSendspinPluginConfig().streamSource).toBe(true);
    write({});
    expect(readSendspinPluginConfig().streamSource).toBe(true);
    // 非布尔(字符串/数字)不算显式关闭 → 仍按默认开
    write({ stream_source: "false" });
    expect(readSendspinPluginConfig().streamSource).toBe(true);
    write({ stream_source: 0 });
    expect(readSendspinPluginConfig().streamSource).toBe(true);
    // 显式 true → 开
    write({ stream_source: true });
    expect(readSendspinPluginConfig().streamSource).toBe(true);
    // 显式 false(老用户手关过)→ 保持关
    write({ stream_source: false });
    expect(readSendspinPluginConfig().streamSource).toBe(false);
    sqlite.prepare("DELETE FROM plugins WHERE id = 'sendspin-renderer'").run();
  });
});
