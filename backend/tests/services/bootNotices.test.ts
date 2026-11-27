import { describe, it, expect, beforeEach } from "vitest";
import { sqlite } from "../../src/db/index.js";
import { upsertPluginNotice, clearPluginNotices } from "../../src/plugins/notices.js";
import { takeBootNotices, resetBootNoticesDelivered } from "../../src/services/system/bootNotices.js";

// 启动后一次性提醒：同一提醒每次进程启动只下发一次（内存 delivered 集合，重启复位）。
describe("bootNotices（启动只下发一次）", () => {
  beforeEach(() => {
    // plugin_notices 是 notices.ts 懒建表；测试先确保表存在再清空
    sqlite.exec("CREATE TABLE IF NOT EXISTS plugin_notices (plugin_id TEXT NOT NULL, key TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'warning', title TEXT NOT NULL DEFAULT '', message TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '', PRIMARY KEY (plugin_id, key))");
    sqlite.exec("DELETE FROM plugin_notices");
    sqlite.exec("DELETE FROM plugins");
    resetBootNoticesDelivered();
  });

  function addPlugin(id: string) {
    sqlite.prepare("INSERT INTO plugins (id, name, enabled) VALUES (?,?,?)").run(id, id, 1);
  }

  it("无提醒返回空数组", () => {
    expect(takeBootNotices()).toEqual([]);
  });

  it("首次拿到当前全部提醒，字段从 PluginNotice 转 BootNotice", () => {
    addPlugin("p1");
    upsertPluginNotice("p1", { key: "k", level: "error", title: "T", message: "M" });
    const out = takeBootNotices();
    expect(out.length).toBe(1);
    expect(out[0]).toMatchObject({ id: "p1:k", pluginId: "p1", key: "k", level: "error", title: "T", message: "M" });
    expect(typeof out[0].at).toBe("string");
  });

  it("第二次 take 不重复下发（同进程内只一次）", () => {
    addPlugin("p1");
    upsertPluginNotice("p1", { key: "k", message: "M" });
    expect(takeBootNotices().length).toBe(1);
    expect(takeBootNotices().length).toBe(0);
  });

  it("新增的提醒下次页面加载时下发，已下发的不再出现", () => {
    addPlugin("p1");
    upsertPluginNotice("p1", { key: "a", message: "A" });
    takeBootNotices(); // a 已下发
    upsertPluginNotice("p1", { key: "b", message: "B" }); // 新增 b
    const out = takeBootNotices();
    expect(out.map((n) => n.key)).toEqual(["b"]);
  });

  it("resetBootNoticesDelivered 复位后可再次下发（模拟重启）", () => {
    addPlugin("p1");
    upsertPluginNotice("p1", { key: "k", message: "M" });
    takeBootNotices();
    expect(takeBootNotices()).toEqual([]);
    resetBootNoticesDelivered();
    expect(takeBootNotices().length).toBe(1);
  });

  it("插件禁用后其提醒不进下发（listPluginNotices 只列启用）", () => {
    addPlugin("p1");
    upsertPluginNotice("p1", { key: "k", message: "M" });
    sqlite.prepare("UPDATE plugins SET enabled = 0 WHERE id = 'p1'").run();
    expect(takeBootNotices()).toEqual([]);
  });
});
