// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll } from "vitest";
import { db, initDatabase } from "../../src/db/index.js";
import { plugins } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { registerBuiltinPlugins, seedPluginRows } from "../../src/plugins/builtins.js";
import { registerPlugin, unregisterPlugin } from "../../src/plugins/registry.js";
import { DAILY_RECOMMEND_PLUGIN_ID } from "../../src/services/plugin/dailyRecommend.js";

// 内置插件 manifest 升级同步:升级部署后 DB 里是旧快照(如 configSchema:[]),
// seedPluginRows 应刷新内置插件 manifest/version,保留用户 config/enabled;
// 外置插件行不被刷新(manifest 以安装包为准)。

const FAKE_EXTERNAL = "fake-external-plugin";

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  registerBuiltinPlugins(); // 注册 + 通过 db-ready 钩子播种内置行
});

describe("seedPluginRows 内置 manifest 升级同步", () => {
  it("内置插件 DB manifest 过期时刷新(保留 config/enabled)", () => {
    const stale = {
      id: DAILY_RECOMMEND_PLUGIN_ID,
      name: "每日推荐",
      version: "0.0.0",
      type: "recommender",
      description: "旧版",
      capabilities: ["dailyPlaylist"],
      configSchema: [], // 旧版:无 homeCount 配置
    };
    db.update(plugins)
      .set({ manifest: JSON.stringify(stale), version: "0.0.0", config: JSON.stringify({ homeCount: 12 }) })
      .where(eq(plugins.name, DAILY_RECOMMEND_PLUGIN_ID))
      .run();

    seedPluginRows();

    const row = db.select().from(plugins).where(eq(plugins.name, DAILY_RECOMMEND_PLUGIN_ID)).get() as any;
    const fresh = JSON.parse(row.manifest);
    expect(fresh.configSchema.some((f: any) => f.key === "homeCount")).toBe(true);
    expect(row.version).not.toBe("0.0.0");
    // 用户配置与启用状态保留
    expect(JSON.parse(row.config)).toEqual({ homeCount: 12 });
    expect(row.enabled).toBe(1);
  });

  it("外置插件行 manifest 不被刷新", () => {
    const fakeManifest = {
      id: FAKE_EXTERNAL,
      name: "Fake External",
      version: "9.9.9",
      type: "source",
      description: "外部测试插件",
      capabilities: ["search"],
      configSchema: [],
    };
    registerPlugin(fakeManifest as any, {} as any);
    // 模拟已安装:先 seed 播种该行,再改成"旧版"快照
    seedPluginRows();
    const stale = { ...fakeManifest, configSchema: [], version: "1.0.0" };
    db.update(plugins)
      .set({ manifest: JSON.stringify(stale), version: "1.0.0" })
      .where(eq(plugins.name, FAKE_EXTERNAL))
      .run();

    seedPluginRows();

    const row = db.select().from(plugins).where(eq(plugins.name, FAKE_EXTERNAL)).get() as any;
    // 非内置插件:seed 不刷新 → 仍是"旧版"快照
    expect(JSON.parse(row.manifest).version).toBe("1.0.0");
    unregisterPlugin(FAKE_EXTERNAL);
    db.delete(plugins).where(eq(plugins.name, FAKE_EXTERNAL)).run();
  });
});
