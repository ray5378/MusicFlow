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
      // 预填充缓冲(设备侧抗抖动窗口):缺省 3000ms,Web 配置页可随时改档位。
      prefillBufferMs: 3000,
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
      prefillBufferMs: 3000,
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

  // 2026-09-24 卡顿治理(B1):预填充缓冲改成 Web 配置页的**档位下拉**(存字符串),
  // 推流循环每 5s 重读。这里钉死归一化:档位字符串能被读成数字、越界/非法回落缺省。
  it("prefill_buffer_ms:档位字符串生效,越界/非法回落缺省 3000", () => {
    sqlite.prepare("DELETE FROM plugins WHERE id = 'sendspin-renderer' OR name = 'sendspin-renderer'").run();
    const write = (cfg: any) =>
      sqlite
        .prepare("INSERT INTO plugins (id, name, config) VALUES ('sendspin-renderer', 'sendspin-renderer', ?) ON CONFLICT(id) DO UPDATE SET config = excluded.config")
        .run(JSON.stringify(cfg));
    // 无行 / 空 → 缺省 3000
    expect(readSendspinPluginConfig().prefillBufferMs).toBe(3000);
    write({});
    expect(readSendspinPluginConfig().prefillBufferMs).toBe(3000);
    // 下拉档位(字符串)→ 读成数字
    for (const [raw, want] of [["800", 800], ["1500", 1500], ["3000", 3000], ["5000", 5000], ["10000", 10000]] as const) {
      write({ prefill_buffer_ms: raw });
      expect(readSendspinPluginConfig().prefillBufferMs).toBe(want);
    }
    // 数字同样认
    write({ prefill_buffer_ms: 2000 });
    expect(readSendspinPluginConfig().prefillBufferMs).toBe(2000);
    // 越界夹紧 / 非法回落
    write({ prefill_buffer_ms: 999999 });
    expect(readSendspinPluginConfig().prefillBufferMs).toBe(30000);
    write({ prefill_buffer_ms: 1 });
    expect(readSendspinPluginConfig().prefillBufferMs).toBe(100);
    for (const bad of ["abc", null, undefined, Number.NaN, -5, 0]) {
      write({ prefill_buffer_ms: bad });
      expect(readSendspinPluginConfig().prefillBufferMs).toBe(3000);
    }
    sqlite.prepare("DELETE FROM plugins WHERE id = 'sendspin-renderer'").run();
  });
});
