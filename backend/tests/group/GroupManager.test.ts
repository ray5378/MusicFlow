import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { GroupManager } from "../../src/services/group/index.js";
import { sqlite } from "../../src/db/index.js";

// 测试环境不跑 initDatabase(),手动建 player_groups 表。
// 2026-10-24 起 DLNA 禁止入组:成员夹具全部改用 airplay 命名空间设备,
// mock airplay/control 提供设备档案(a2 = 不可用,unknown = 不存在)。
beforeAll(() => {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS player_groups (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      member_ids TEXT NOT NULL DEFAULT '[]',
      volume INTEGER NOT NULL DEFAULT 20,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
});

vi.mock("../../src/services/dlna/control.js", () => ({
  getCachedDevices: () => [],
}));

const AIRPLAY_FIXTURES: Record<string, { name: string; available: boolean }> = {
  a1: { name: "客厅音响", available: true },
  a2: { name: "卧室音响", available: false },
  a3: { name: "书房音响", available: true },
};

vi.mock("../../src/services/airplay/control.js", () => ({
  hasAirPlayDevice: (id: string) => id in AIRPLAY_FIXTURES,
  isAirPlayDeviceDisabled: () => false,
  getAirPlayStatus: (id: string) => ({
    available: AIRPLAY_FIXTURES[id]?.available ?? false,
    name: AIRPLAY_FIXTURES[id]?.name ?? id,
    playbackState: "idle",
    position: 0,
    duration: 0,
    volume: 50,
    muted: false,
  }),
}));

describe("GroupManager", () => {
  let gm: GroupManager;

  beforeEach(() => {
    sqlite.exec("DELETE FROM player_groups");
    gm = new GroupManager();
    gm.loadFromDb();
  });

  it("创建组:持久化 + 列表可见 + 成员索引生效", () => {
    const g = gm.createGroup("客厅组", ["airplay:a1", "airplay:a2"]);
    expect(g.id).toBeTruthy();
    expect(g.name).toBe("客厅组");
    expect(gm.list()).toHaveLength(1);
    expect(gm.get(g.id)?.memberIds).toEqual(["airplay:a1", "airplay:a2"]);
    expect(gm.groupsOfDevice("airplay:a1")).toEqual([g.id]);
    expect(gm.groupsOfDevice("airplay:a2")).toEqual([g.id]);
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
    expect(() => gm.createGroup("  ", ["airplay:a1"])).toThrow("组名不能为空");
  });

  it("创建组:未知 airplay 设备抛错", () => {
    expect(() => gm.createGroup("组", ["airplay:a1", "airplay:unknown-device"])).toThrow(
      "不是已知的 AirPlay 设备"
    );
  });

  it("创建组:DLNA 成员一律拒收(2026-10-24 起 DLNA 禁止入组)", () => {
    expect(() => gm.createGroup("组", ["dlna:d1"])).toThrow("DLNA 设备不支持加入群组");
    // 历史裸 id 写法同样拒收(新提交不允许再塞 DLNA 进组)
    expect(() => gm.createGroup("组", ["legacy-dlna-id"])).toThrow("DLNA 设备不支持加入群组");
  });

  it("创建组:非设备前缀的成员抛错(组不能套组)", () => {
    expect(() => gm.createGroup("组", ["group:g1"])).toThrow("不是 DLNA 设备");
    expect(() => gm.createGroup("组", ["local:u1"])).toThrow("不是 DLNA 设备");
  });

  it("多组约束:一台设备可同时加入多个组,且可独立从任一组移除", () => {
    const a = gm.createGroup("组A", ["airplay:a1"]);
    const b = gm.createGroup("组B", ["airplay:a1", "airplay:a2"]);
    expect(gm.groupsOfDevice("airplay:a1")).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(gm.groupsOfDevice("airplay:a2")).toEqual([b.id]);
    // 从组A移除后仍属于组B
    gm.setMembers(a.id, []);
    expect(gm.groupsOfDevice("airplay:a1")).toEqual([b.id]);
    // 删除组B后 a1/a2 不再属于任何组
    gm.deleteGroup(b.id);
    expect(gm.groupsOfDevice("airplay:a1")).toEqual([]);
    expect(gm.groupsOfDevice("airplay:a2")).toEqual([]);
  });

  it("setMembers:全量替换成员,同一设备可在多组共存", () => {
    const a = gm.createGroup("组A", ["airplay:a1"]);
    const b = gm.createGroup("组B", ["airplay:a2"]);
    // a2 已在组B,也可加入组A(多组并存)
    const updated = gm.setMembers(a.id, ["airplay:a1", "airplay:a2"]);
    expect(updated?.memberIds).toEqual(["airplay:a1", "airplay:a2"]);
    expect(gm.groupsOfDevice("airplay:a2")).toEqual(expect.arrayContaining([a.id, b.id]));
    // 只保留 a1,清空后 a1 仍在组A(允许)
    const updated2 = gm.setMembers(a.id, ["airplay:a1", "airplay:a3"]);
    expect(updated2?.memberIds).toEqual(["airplay:a1", "airplay:a3"]);
    expect(gm.groupsOfDevice("airplay:a3")).toEqual([a.id]);
  });

  it("setMembers:重复成员抛错", () => {
    const a = gm.createGroup("组A", ["airplay:a1"]);
    expect(() => gm.setMembers(a.id, ["airplay:a1", "airplay:a1"])).toThrow("不能重复");
  });

  it("renameGroup:改名并持久化", () => {
    const a = gm.createGroup("组A", ["airplay:a1"]);
    const renamed = gm.renameGroup(a.id, "新组名");
    expect(renamed?.name).toBe("新组名");
    expect(gm.get(a.id)?.name).toBe("新组名");
    expect(() => gm.renameGroup(a.id, "  ")).toThrow("组名不能为空");
  });

  it("deleteGroup:删除组并释放成员", () => {
    const a = gm.createGroup("组A", ["airplay:a1", "airplay:a2"]);
    expect(gm.deleteGroup(a.id)).toBe(true);
    expect(gm.get(a.id)).toBeUndefined();
    expect(gm.groupsOfDevice("airplay:a1")).toEqual([]);
    expect(gm.list()).toHaveLength(0);
    // 删除后可重新加入其他组
    gm.createGroup("组B", ["airplay:a1"]);
    expect(gm.list()).toHaveLength(1);
    expect(gm.deleteGroup("not-exist")).toBe(false);
  });

  it("listWithMembers:解析成员设备名称/可用性", () => {
    gm.createGroup("客厅组", ["airplay:a1", "airplay:a2"]);
    const [g] = gm.listWithMembers();
    expect(g.members).toEqual([
      { deviceId: "airplay:a1", name: "客厅音响", available: true, volume: 50, muted: false },
      { deviceId: "airplay:a2", name: "卧室音响", available: false, volume: 50, muted: false },
    ]);
  });

  it("事件广播:created/updated/deleted", () => {
    const events: string[] = [];
    gm.on("group_created", () => events.push("created"));
    gm.on("group_updated", () => events.push("updated"));
    gm.on("group_deleted", () => events.push("deleted"));
    const a = gm.createGroup("组A", ["airplay:a1"]);
    gm.setMembers(a.id, ["airplay:a1", "airplay:a2"]);
    gm.deleteGroup(a.id);
    expect(events).toEqual(["created", "updated", "deleted"]);
  });

  it("组音量:新建默认 20,空组也持久,重启恢复", () => {
    const g = gm.createGroup("空组音量", []);
    expect(g.volume).toBe(20);
    expect(gm.getVolume(g.id)).toBe(20);
    // 空组调音量也必须落库(用户定稿:无成员也持久)
    gm.setVolume(g.id, 55);
    expect(gm.getVolume(g.id)).toBe(55);
    const gm2 = new GroupManager();
    gm2.loadFromDb();
    expect(gm2.getVolume(g.id)).toBe(55);
  });

  it("组音量:setVolume 钳到 0-100 并触发 group_updated;非法入参回缺省", () => {
    const g = gm.createGroup("钳位组", ["airplay:a1"]);
    const events: string[] = [];
    gm.on("group_updated", () => events.push("updated"));
    expect(gm.setVolume(g.id, 150)).toBe(100);
    expect(gm.getVolume(g.id)).toBe(100);
    expect(gm.setVolume(g.id, -5)).toBe(0);
    expect(gm.getVolume(g.id)).toBe(0);
    expect(gm.setVolume(g.id, 42.4)).toBe(42);
    expect(events.length).toBeGreaterThanOrEqual(3);
    // 组不存在:无处可写,返回钳后缺省语义
    expect(gm.setVolume("missing", 70)).toBe(70);
    expect(gm.getVolume("missing")).toBe(20);
  });

  it("组音量:改成员/改名不覆盖已持久的音量", () => {
    const g = gm.createGroup("保住音量", ["airplay:a1"]);
    gm.setVolume(g.id, 33);
    gm.setMembers(g.id, ["airplay:a1", "airplay:a2"]);
    gm.renameGroup(g.id, "新名");
    expect(gm.getVolume(g.id)).toBe(33);
    const gm2 = new GroupManager();
    gm2.loadFromDb();
    expect(gm2.get(g.id)?.volume).toBe(33);
    expect(gm2.get(g.id)?.name).toBe("新名");
  });
});
