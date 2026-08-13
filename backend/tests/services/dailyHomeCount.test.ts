// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db, initDatabase } from "../../src/db/index.js";
import { plugins } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { getDailyHomeCount, DAILY_RECOMMEND_PLUGIN_ID, DEFAULT_HOME_COUNT, MAX_HOME_COUNT } from "../../src/services/plugin/dailyRecommend.js";
import { dailyRecommendHomeCount } from "../../src/services/pluginAccess.js";
import { registerBuiltinPlugins } from "../../src/plugins/builtins.js";

// 每日推荐插件 homeCount 配置 → 首页顶部展示张数(默认 8,1~24 clamp)。
// 读 DB plugins 表 config;门面经能力(dailyPlaylist)拿插件 impl.getHomeCount。

function setConfig(homeCount: any) {
  const cfg: any = {};
  if (homeCount !== undefined) cfg.homeCount = homeCount;
  const existing = db.select().from(plugins).where(eq(plugins.name, DAILY_RECOMMEND_PLUGIN_ID)).get();
  if (existing) {
    db.update(plugins).set({ config: JSON.stringify(cfg), enabled: 1 }).where(eq(plugins.name, DAILY_RECOMMEND_PLUGIN_ID)).run();
  } else {
    db.insert(plugins).values({ name: DAILY_RECOMMEND_PLUGIN_ID, enabled: 1, config: JSON.stringify(cfg) }).run();
  }
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  // 注册内置插件(含 daily-recommend)并播种 DB 行,门面按能力(dailyPlaylist)才能取到 impl。
  registerBuiltinPlugins();
});

beforeEach(() => {
  setConfig(undefined); // 默认:无 homeCount
});

describe("getDailyHomeCount (插件内部读取)", () => {
  it("未配置时回落默认 8", () => {
    expect(getDailyHomeCount()).toBe(DEFAULT_HOME_COUNT);
  });
  it("homeCount=12 原样返回", () => {
    setConfig(12);
    expect(getDailyHomeCount()).toBe(12);
  });
  it("homeCount=99 clamp 到 24", () => {
    setConfig(99);
    expect(getDailyHomeCount()).toBe(MAX_HOME_COUNT);
  });
  it("homeCount=0 视为非法回落默认", () => {
    setConfig(0);
    expect(getDailyHomeCount()).toBe(DEFAULT_HOME_COUNT);
  });
  it("homeCount 非数字回落默认", () => {
    setConfig("abc");
    expect(getDailyHomeCount()).toBe(DEFAULT_HOME_COUNT);
  });
});

describe("dailyRecommendHomeCount (能力门面,前端读到的值)", () => {
  it("默认 8", () => {
    expect(dailyRecommendHomeCount()).toBe(DEFAULT_HOME_COUNT);
  });
  it("配置 12 时返回 12", () => {
    setConfig(12);
    expect(dailyRecommendHomeCount()).toBe(12);
  });
  it("插件禁用时回落默认 8", () => {
    db.update(plugins).set({ enabled: 0 }).where(eq(plugins.name, DAILY_RECOMMEND_PLUGIN_ID)).run();
    expect(dailyRecommendHomeCount()).toBe(DEFAULT_HOME_COUNT);
  });
});
