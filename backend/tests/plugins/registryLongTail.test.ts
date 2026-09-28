// ==================== plugins/registry 长尾(兼容门面 + 配置解析兜底) ====================
// 既有 tests/plugins/registry.test.ts 覆盖能力查找与启用门禁;这里只补:
//   - registerOnlineProvider / getOnlineProvider / listOnlineProviders(兼容门面)
//   - getPluginImpl / getCapabilities(未注册返回空值)
//   - getPluginConfig 对「非法 config JSON」的兜底(必须返回 null,不能抛)
// MUST be the first import: re-exports the isolated DATA_DIR env for this file.
import "./_env.js";

import { describe, it, expect } from "vitest";
import { sqlite } from "../../src/db/index.js";
import {
  registerOnlineProvider,
  unregisterPlugin,
  getPlugin,
  getPluginImpl,
  getOnlineProvider,
  listOnlineProviders,
  getCapabilities,
  getPluginConfig,
} from "../../src/plugins/registry.js";

// 模块级 registry 是单例,且本仓开 shuffle:用每次运行唯一的 id 前缀避免与其它用例串台。
const U = Math.random().toString(36).slice(2, 8);
const pid = (s: string) => `lt4reg-${s}-${U}`;

describe("registry 兼容门面(OnlineProvider == 已注册 impl)", () => {
  it("registerOnlineProvider 注册 (manifest, impl) 后按 provider 身份可取出", () => {
    const id = pid("prov");
    const manifest = {
      id, name: id, version: "1.0.0", type: "source",
      capabilities: ["search", "stream"],
    } as any;
    registerOnlineProvider({ manifest, marker: 42 });
    // impl 就是 provider 对象本身(在线源契约)
    expect(getPluginImpl(id)?.marker).toBe(42);
    expect(getOnlineProvider(id)?.marker).toBe(42);
    expect(getPlugin(id)?.manifest.id).toBe(id);
    // listOnlineProviders 投影全部注册项的 impl
    expect(listOnlineProviders().some((p) => p?.marker === 42)).toBe(true);
    // getCapabilities 不要求启用,仅读注册的 manifest
    expect(getCapabilities(id)).toEqual(["search", "stream"]);
    unregisterPlugin(id);
    expect(getPlugin(id)).toBeUndefined();
  });

  it("未注册 id:getPluginImpl/getPlugin 返回 undefined,getCapabilities 返回空数组", () => {
    // 为什么:核心按能力查找必须能容忍未注册 id(市场未安装的插件)。
    const missing = pid("missing");
    expect(getPluginImpl(missing)).toBeUndefined();
    expect(getPlugin(missing)).toBeUndefined();
    expect(getCapabilities(missing)).toEqual([]);
  });
});

describe("registry:getPluginConfig 解析兜底", () => {
  it("plugins.config 不是合法 JSON → null(不抛)", () => {
    // 为什么:配置列被外部写坏(手工改库/旧版本)时,序列化路径必须降级而非整库报错。
    const id = pid("badcfg");
    sqlite
      .prepare(
        `INSERT INTO plugins (id, name, enabled, config) VALUES (?, ?, 1, ?)
         ON CONFLICT(id) DO UPDATE SET enabled = 1, config = excluded.config`,
      )
      .run(`row-${id}`, id, "{not-json");
    try {
      expect(getPluginConfig(id)).toBeNull();
    } finally {
      sqlite.prepare("DELETE FROM plugins WHERE name = ?").run(id);
    }
  });

  it("config 缺省(NULL)且已启用 → 空对象(合法)", () => {
    const id = pid("nullcfg");
    sqlite
      .prepare(
        `INSERT INTO plugins (id, name, enabled, config) VALUES (?, ?, 1, NULL)
         ON CONFLICT(id) DO UPDATE SET enabled = 1, config = NULL`,
      )
      .run(`row-${id}`, id);
    try {
      expect(getPluginConfig(id)).toEqual({});
    } finally {
      sqlite.prepare("DELETE FROM plugins WHERE name = ?").run(id);
    }
  });
});
