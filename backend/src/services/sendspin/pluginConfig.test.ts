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
      // ESPHome 6053 只读桥接默认全关 + 空 PSK(需要用户显式配置才启用)。
      esphomeMirror: false,
      esphomePsk: "",
      esphomePort: 6053,
      // 流式解码默认关(整包路径),灰度观察后再转默认。
      streamSource: false,
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
      esphomeMirror: false,
      esphomePsk: "",
      esphomePort: 6053,
      streamSource: false,
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

  it("esphome 只读桥接:默认全关,psk 去空白,非法端口回落 6053", () => {
    sqlite.prepare("DELETE FROM plugins WHERE id = 'sendspin-renderer' OR name = 'sendspin-renderer'").run();
    const write = (cfg: any) =>
      sqlite
        .prepare("INSERT INTO plugins (id, name, config) VALUES ('sendspin-renderer', 'sendspin-renderer', ?) ON CONFLICT(id) DO UPDATE SET config = excluded.config")
        .run(JSON.stringify(cfg));
    // 缺省关闭 + 空 PSK(桥接建立不了,index.ts 的 attach 会跳过)
    expect(readSendspinPluginConfig().esphomeMirror).toBe(false);
    expect(readSendspinPluginConfig().esphomePsk).toBe("");
    expect(readSendspinPluginConfig().esphomePort).toBe(6053);
    write({});
    expect(readSendspinPluginConfig().esphomeMirror).toBe(false);
    // 只有显式 === true 才开(字符串 "true" 不算)
    write({ esphome_mirror: "true" });
    expect(readSendspinPluginConfig().esphomeMirror).toBe(false);
    write({ esphome_mirror: true, esphome_psk: "  abcd  " });
    expect(readSendspinPluginConfig().esphomeMirror).toBe(true);
    expect(readSendspinPluginConfig().esphomePsk).toBe("abcd");
    // 非字符串 psk 一律当空,避免把对象塞进握手
    write({ esphome_mirror: true, esphome_psk: { a: 1 } });
    expect(readSendspinPluginConfig().esphomePsk).toBe("");
    // 端口越界/非整数 → 回落
    for (const p of [0, -1, 70000, 6.5, "abc", null]) {
      write({ esphome_port: p });
      expect(readSendspinPluginConfig().esphomePort).toBe(6053);
    }
    write({ esphome_port: 6054 });
    expect(readSendspinPluginConfig().esphomePort).toBe(6054);
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

  it("stream_source 缺省关,只有显式 true 才开", () => {
    sqlite.prepare("DELETE FROM plugins WHERE id = 'sendspin-renderer' OR name = 'sendspin-renderer'").run();
    const write = (cfg: any) =>
      sqlite
        .prepare("INSERT INTO plugins (id, name, config) VALUES ('sendspin-renderer', 'sendspin-renderer', ?) ON CONFLICT(id) DO UPDATE SET config = excluded.config")
        .run(JSON.stringify(cfg));
    expect(readSendspinPluginConfig().streamSource).toBe(false);
    write({});
    expect(readSendspinPluginConfig().streamSource).toBe(false);
    write({ stream_source: "true" });
    expect(readSendspinPluginConfig().streamSource).toBe(false);
    write({ stream_source: 1 });
    expect(readSendspinPluginConfig().streamSource).toBe(false);
    write({ stream_source: true });
    expect(readSendspinPluginConfig().streamSource).toBe(true);
    sqlite.prepare("DELETE FROM plugins WHERE id = 'sendspin-renderer'").run();
  });
});
