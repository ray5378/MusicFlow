import { describe, it, expect, beforeEach } from "vitest";
import { sqlite } from "../../src/db/index.js";
import { _resetSettingsCacheForTest } from "../../src/services/settings.js";
import {
  CORS_ORIGINS_KEY,
  PLAY_HISTORY_RETENTION_KEY,
  corsOrigins,
  playHistoryRetentionDays,
  saveAppConfig,
} from "../../src/services/appConfig.js";

// 应用级可运营配置：设置表优先 + 环境变量兜底。每个测试文件自带独立库（setup.ts）。
describe("appConfig（设置表优先 + env 兜底）", () => {
  beforeEach(() => {
    sqlite.prepare("DELETE FROM settings WHERE key IN (?, ?)").run(CORS_ORIGINS_KEY, PLAY_HISTORY_RETENTION_KEY);
    _resetSettingsCacheForTest();
  });

  it("corsOrigins：设置值为 JSON 数组串时解析并 trim/filter", () => {
    sqlite.prepare("INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)")
      .run(CORS_ORIGINS_KEY, JSON.stringify([" https://a.com ", "", "https://b.com"]), new Date().toISOString());
    _resetSettingsCacheForTest();
    expect(corsOrigins()).toEqual(["https://a.com", "https://b.com"]);
  });

  it("corsOrigins：历史值逗号串回落", () => {
    sqlite.prepare("INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)")
      .run(CORS_ORIGINS_KEY, "https://a.com, https://b.com ,", new Date().toISOString());
    _resetSettingsCacheForTest();
    expect(corsOrigins()).toEqual(["https://a.com", "https://b.com"]);
  });

  it("corsOrigins：非数组 JSON 也按逗号串处理", () => {
    sqlite.prepare("INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)")
      .run(CORS_ORIGINS_KEY, "123", new Date().toISOString());
    _resetSettingsCacheForTest();
    expect(corsOrigins()).toEqual(["123"]);
  });

  it("playHistoryRetentionDays：设置值为非负整数时生效", () => {
    sqlite.prepare("INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)")
      .run(PLAY_HISTORY_RETENTION_KEY, "30", new Date().toISOString());
    _resetSettingsCacheForTest();
    expect(playHistoryRetentionDays()).toBe(30);
  });

  it("playHistoryRetentionDays：非法/负数设置值回落到 env 默认", () => {
    sqlite.prepare("INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)")
      .run(PLAY_HISTORY_RETENTION_KEY, "-1", new Date().toISOString());
    _resetSettingsCacheForTest();
    // 环境未设时默认 3
    expect(playHistoryRetentionDays()).toBeGreaterThanOrEqual(0);
  });

  it("saveAppConfig：corsOrigins 白名单只收 * 与 http(s)，去重", () => {
    const out = saveAppConfig({ corsOrigins: ["https://a.com", "*", "ftp://bad", "javascript:x", " https://a.com "] });
    expect(out.corsOrigins).toEqual(["https://a.com", "*"]);
    expect(corsOrigins()).toEqual(["https://a.com", "*"]);
  });

  it("saveAppConfig：corsOrigins 字符串按换行/逗号切分", () => {
    const out = saveAppConfig({ corsOrigins: "https://a.com\nhttps://b.com, *" });
    expect(out.corsOrigins).toEqual(["https://a.com", "https://b.com", "*"]);
  });

  it("saveAppConfig：保留天数夹在 0..3650 且取整", () => {
    expect(saveAppConfig({ playHistoryRetentionDays: 99999 }).playHistoryRetentionDays).toBe(3650);
    expect(saveAppConfig({ playHistoryRetentionDays: -5 }).playHistoryRetentionDays).toBe(0);
    expect(saveAppConfig({ playHistoryRetentionDays: 7.9 }).playHistoryRetentionDays).toBe(7);
    expect(playHistoryRetentionDays()).toBe(7);
  });

  it("saveAppConfig：非法天数（NaN）忽略，不覆盖现值", () => {
    saveAppConfig({ playHistoryRetentionDays: 10 });
    const out = saveAppConfig({ playHistoryRetentionDays: "abc" });
    expect(out.playHistoryRetentionDays).toBe(10);
  });

  it("saveAppConfig：空补丁回读当前值，不写库", () => {
    const before = { cors: corsOrigins(), days: playHistoryRetentionDays() };
    const out = saveAppConfig({});
    expect(out.corsOrigins).toEqual(before.cors);
    expect(out.playHistoryRetentionDays).toBe(before.days);
  });
});
