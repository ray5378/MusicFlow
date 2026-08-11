import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { GroupManager } from "../../src/services/group/index.js";
import { sqlite } from "../../src/db/index.js";

// 测试环境不跑 initDatabase(),手动建 player_groups 表。
// GroupManager 的成员校验只依赖 getCachedDevices,这里 mock 成固定设备列表。
beforeAll(() => {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS player_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      member_ids TEXT NOT NULL DEFAULT '[]',
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
});

vi.mock("../../src/services/dlna/control.js", () => ({
  getCachedDevices: () => [
    { id: "d1", name: "客厅音响", available: true },
    { id: "d2", name: "卧室音响", available: false },
    { id: "d3", name: "书房音响", available: true },
  ],
}));

describe("GroupManager", () => {
  let gm: GroupManager;

  beforeEach(() => {
    sqlite.exec("DELETE FROM player_groups");
    gm = new GroupManager();
    gm.loadFromDb();
  });

  it("创建组:持久化 + 列表可见 + 成员索引生效", () => {
    const g = gm.createGroup("客厅组", ["d1", "d2"]);
    expect(g.id).toBeTruthy();
    expect(g.name).toBe("客厅组");
    expect(gm.list()).toHaveLength(1);
    expect(gm.get(g.id)?.memberIds).toEqual(["d1", "d2"]);
    expect(gm.groupsOfDevice("d1")).toEqual([g.id]);
    expect(gm.groupsOfDevice("d2")).toEqual([g.id]);
    // 重启后 loadFromDb 可恢复
    const gm2 = new GroupManager();
    gm2.loadFromDb();
    expect(gm2.list()).toHaveLength(1);
    expect(gm2.get(g.id)?.name).toBe("客厅组");
  });

  it("创建组:空成员也可(动态成员允许空列表)", () => {
    const g = gm.createGroup("空组", []);
    expect(gm.list()).toHaveLength(1);
    expect(g.memberIds).toEqual([]);
  });

  it("创建组:组名为空抛错", () => {
    expect(() => gm.createGroup("  ", ["d1"])).toThrow("组名不能为空");
  });

  it("创建组:未知设备抛错", () => {
    expect(() => gm.createGroup("组", ["d1", "unknown-device"])).toThrow(
      "不是已知的 DLNA 设备"
    );
  });

  it("创建组:非 DLNA 前缀的成员抛错(组不能套组)", () => {
    expect(() => gm.createGroup("组", ["group:g1"])).toThrow("不是 DLNA 设备");
    expect(() => gm.createGroup("组", ["local:u1"])).toThrow("不是 DLNA 设备");
  });

  it("多组约束:一台设备可同时加入多个组,且可独立从任一组移除", () => {
    const a = gm.createGroup("组A", ["d1"]);
    const b = gm.createGroup("组B", ["d1", "d2"]);
    expect(gm.groupsOfDevice("d1")).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(gm.groupsOfDevice("d2")).toEqual([b.id]);
    // 从组A移除后仍属于组B
    gm.setMembers(a.id, []);
    expect(gm.groupsOfDevice("d1")).toEqual([b.id]);
    // 删除组B后 d1/d2 不再属于任何组
    gm.deleteGroup(b.id);
    expect(gm.groupsOfDevice("d1")).toEqual([]);
    expect(gm.groupsOfDevice("d2")).toEqual([]);
  });

  it("setMembers:全量替换成员,同一设备可在多组共存", () => {
    const a = gm.createGroup("组A", ["d1"]);
    const b = gm.createGroup("组B", ["d2"]);
    // d2 已在组B,也可加入组A(多组并存)
    const updated = gm.setMembers(a.id, ["d1", "d2"]);
    expect(updated?.memberIds).toEqual(["d1", "d2"]);
    expect(gm.groupsOfDevice("d2")).toEqual(expect.arrayContaining([a.id, b.id]));
    // 只保留 d1,清空后 d1 仍在组A(允许)
    const updated2 = gm.setMembers(a.id, ["d1", "d3"]);
    expect(updated2?.memberIds).toEqual(["d1", "d3"]);
    expect(gm.groupsOfDevice("d3")).toEqual([a.id]);
  });

  it("setMembers:重复成员抛错", () => {
    const a = gm.createGroup("组A", ["d1"]);
    expect(() => gm.setMembers(a.id, ["d1", "d1"])).toThrow("不能重复");
  });

  it("renameGroup:改名并持久化", () => {
    const a = gm.createGroup("组A", ["d1"]);
    const renamed = gm.renameGroup(a.id, "新组名");
    expect(renamed?.name).toBe("新组名");
    expect(gm.get(a.id)?.name).toBe("新组名");
    expect(() => gm.renameGroup(a.id, "  ")).toThrow("组名不能为空");
  });

  it("deleteGroup:删除组并释放成员", () => {
    const a = gm.createGroup("组A", ["d1", "d2"]);
    expect(gm.deleteGroup(a.id)).toBe(true);
    expect(gm.get(a.id)).toBeUndefined();
    expect(gm.groupsOfDevice("d1")).toEqual([]);
    expect(gm.list()).toHaveLength(0);
    // 删除后可重新加入其他组
    gm.createGroup("组B", ["d1"]);
    expect(gm.list()).toHaveLength(1);
    expect(gm.deleteGroup("not-exist")).toBe(false);
  });

  it("listWithMembers:解析成员设备名称/可用性", () => {
    gm.createGroup("客厅组", ["d1", "d2"]);
    const [g] = gm.listWithMembers();
    expect(g.members).toEqual([
      { deviceId: "d1", name: "客厅音响", available: true },
      { deviceId: "d2", name: "卧室音响", available: false },
    ]);
  });

  it("事件广播:created/updated/deleted", () => {
    const events: string[] = [];
    gm.on("group_created", () => events.push("created"));
    gm.on("group_updated", () => events.push("updated"));
    gm.on("group_deleted", () => events.push("deleted"));
    const a = gm.createGroup("组A", ["d1"]);
    gm.setMembers(a.id, ["d1", "d2"]);
    gm.deleteGroup(a.id);
    expect(events).toEqual(["created", "updated", "deleted"]);
  });
});
