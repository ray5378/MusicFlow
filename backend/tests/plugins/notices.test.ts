import { describe, it, expect, beforeEach } from "vitest";
import { sqlite } from "../../src/db/index.js";
import {
  upsertPluginNotice,
  clearPluginNotice,
  clearPluginNotices,
  listPluginNotices,
} from "../../src/plugins/notices.js";

// 插件提醒：表按 (plugin_id,key) 唯一，upsert 更新、clear 删除、list 只列启用插件。
describe("plugin notices", () => {
  beforeEach(() => {
    sqlite.exec("CREATE TABLE IF NOT EXISTS plugin_notices (plugin_id TEXT NOT NULL, key TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'warning', title TEXT NOT NULL DEFAULT '', message TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '', PRIMARY KEY (plugin_id, key))");
    sqlite.exec("DELETE FROM plugin_notices");
    sqlite.exec("DELETE FROM plugins");
  });

  function addPlugin(id: string, enabled = 1) {
    // plugins 表列较多，仅填 NOT NULL 的关键列（用 PRAGMA 探得的最小集）
    sqlite.prepare("INSERT INTO plugins (id, name, enabled, config, created_at, updated_at) VALUES (?,?,?,?,?,?)")
      .run(id, id, enabled, "{}", new Date().toISOString(), new Date().toISOString());
  }

  it("key/message 为空抛错", () => {
    expect(() => upsertPluginNotice("p1", { key: "", message: "x" })).toThrow();
    expect(() => upsertPluginNotice("p1", { key: "k", message: "" })).toThrow();
  });

  it("level 归一：error/info 保留，其它回落 warning", () => {
    addPlugin("p1");
    upsertPluginNotice("p1", { key: "k1", level: "error", message: "e" });
    upsertPluginNotice("p1", { key: "k2", level: "info", message: "i" });
    upsertPluginNotice("p1", { key: "k3", level: "weird", message: "w" });
    const list = listPluginNotices();
    expect(list.find((n) => n.key === "k1")?.level).toBe("error");
    expect(list.find((n) => n.key === "k2")?.level).toBe("info");
    expect(list.find((n) => n.key === "k3")?.level).toBe("warning");
  });

  it("同 (pluginId,key) 重复 upsert 更新同一条", () => {
    addPlugin("p1");
    upsertPluginNotice("p1", { key: "k", title: "old", message: "v1" });
    upsertPluginNotice("p1", { key: "k", title: "new", message: "v2" });
    const list = listPluginNotices();
    expect(list.length).toBe(1);
    expect(list[0].title).toBe("new");
    expect(list[0].message).toBe("v2");
  });

  it("key/title/message 超长截断", () => {
    addPlugin("p1");
    upsertPluginNotice("p1", { key: "k".repeat(200), title: "t".repeat(300), message: "m".repeat(2000) });
    const n = listPluginNotices()[0];
    expect(n.key.length).toBe(128);
    expect(n.title.length).toBe(200);
    expect(n.message.length).toBe(1000);
  });

  it("list 只列启用插件的提醒", () => {
    addPlugin("p1", 1);
    addPlugin("p2", 0);
    upsertPluginNotice("p1", { key: "a", message: "on" });
    upsertPluginNotice("p2", { key: "b", message: "off" });
    const list = listPluginNotices();
    expect(list.length).toBe(1);
    expect(list[0].pluginId).toBe("p1");
  });

  it("clearPluginNotice / clearPluginNotices 删除", () => {
    addPlugin("p1");
    upsertPluginNotice("p1", { key: "a", message: "1" });
    upsertPluginNotice("p1", { key: "b", message: "2" });
    clearPluginNotice("p1", "a");
    expect(listPluginNotices().map((n) => n.key)).toEqual(["b"]);
    clearPluginNotices("p1");
    expect(listPluginNotices()).toEqual([]);
  });
});
