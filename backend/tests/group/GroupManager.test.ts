import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { GroupManager } from "../../src/services/group/index.js";
import { sqlite } from "../../src/db/index.js";

// 测试环境不跑 initDatabase(),手动建 player_groups 表。
//
// ★ 2026-10-23 契约变更:群组成员只允许 `sendspin:<clientId>` / `airplay:<deviceId>`,
//   **DLNA 禁止入组**(各设备自拉流、没有共享时间线,做不了同步)。因此成员校验的
//   数据源从 DLNA 缓存换成了 airplay 设备表(getAirPlayDevice)。
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

vi.mock("../../src/services/airplay/discovery.js", () => ({
  getAirPlayDevice: (id: string) => {
    const table: Record<string, any> = {
      d1: { id: "d1", name: "客厅音响", alias: "", available: true },
      d2: { id: "d2", name: "卧室音响", alias: "", available: false },
      d3: { id: "d3", name: "书房音响", alias: "", available: true },
    };
    return table[id];
  },
}));

describe("GroupManager", () => {
  let gm: GroupManager;

  beforeEach(() => {
    sqlite.exec("DELETE FROM player_groups");
    gm = new GroupManager();
    gm.loadFromDb();
  });

  it("创建组:持久化 + 列表可见 + 成员索引生效", () => {
    const g = gm.createGroup("客厅组", ["airplay:d1", "airplay:d2"]);
    expect(g.id).toBeTruthy();
    expect(g.name).toBe("客厅组");
    expect(gm.list()).toHaveLength(1);
    expect(gm.get(g.id)?.memberIds).toEqual(["airplay:d1", "airplay:d2"]);
    // groupsOfDevice 接受裸 id 与命名空间 id 两种写法
    expect(gm.groupsOfDevice("d1")).toEqual([g.id]);
    expect(gm.groupsOfDevice("airplay:d2")).toEqual([g.id]);
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

  it("创建组:sendspin 成员只校验格式,不要求在线(组可持久化)", () => {
    const g = gm.createGroup("sendspin组", ["sendspin:cid-1", "sendspin:cid-2"]);
    expect(g.memberIds).toEqual(["sendspin:cid-1", "sendspin:cid-2"]);
  });

  it("创建组:组名为空抛错", () => {
    expect(() => gm.createGroup("  ", ["airplay:d1"])).toThrow("组名不能为空");
  });

  it("创建组:未知 airplay 设备抛错(脏数据不得落库)", () => {
    expect(() => gm.createGroup("组", ["airplay:d1", "airplay:unknown-device"])).toThrow(
      "不存在"
    );
  });

  it("创建组:DLNA 成员必须被拒绝(裸 id 与 dlna: 前缀)", () => {
    expect(() => gm.createGroup("组", ["d1"])).toThrow(/DLNA/);
    expect(() => gm.createGroup("组", ["dlna:d1"])).toThrow(/DLNA/);
  });

  it("创建组:组不能套组 / local: 前缀被拒绝", () => {
    expect(() => gm.createGroup("组", ["group:g1"])).toThrow("格式非法");
    expect(() => gm.createGroup("组", ["local:u1"])).toThrow("格式非法");
  });

  it("多组约束:一台设备可同时加入多个组,且可独立从任一组移除", () => {
    const a = gm.createGroup("组A", ["airplay:d1"]);
    const b = gm.createGroup("组B", ["airplay:d1", "airplay:d2"]);
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
    const a = gm.createGroup("组A", ["airplay:d1"]);
    const b = gm.createGroup("组B", ["airplay:d2"]);
    // d2 已在组B,也可加入组A(多组并存)
    const updated = gm.setMembers(a.id, ["airplay:d1", "airplay:d2"]);
    expect(updated?.memberIds).toEqual(["airplay:d1", "airplay:d2"]);
    expect(gm.groupsOfDevice("d2")).toEqual(expect.arrayContaining([a.id, b.id]));
    // 只保留 d1+id3
    const updated2 = gm.setMembers(a.id, ["airplay:d1", "airplay:d3"]);
    expect(updated2?.memberIds).toEqual(["airplay:d1", "airplay:d3"]);
    expect(gm.groupsOfDevice("d3")).toEqual([a.id]);
  });

  it("setMembers:重复成员抛错", () => {
    const a = gm.createGroup("组A", ["airplay:d1"]);
    expect(() => gm.setMembers(a.id, ["airplay:d1", "airplay:d1"])).toThrow("不能重复");
  });

  it("setMembers:换成 DLNA 成员抛错且原成员不变", () => {
    const a = gm.createGroup("组A", ["airplay:d1"]);
    expect(() => gm.setMembers(a.id, ["d1"])).toThrow(/DLNA/);
    expect(gm.get(a.id)?.memberIds).toEqual(["airplay:d1"]);
  });

  it("applyMemberDelta:add DLNA 成员抛错且组不受影响(不得部分生效)", () => {
    // 增量接口是移动端 / 卡片的常用路径,必须与全量替换同口径。
    // 2026-10-24 实机复核:PUT /v1/groups/:id/members 带 dlna 成员回 400
    // 「…是 DLNA 设备:DLNA 各设备自拉流、没有共享时间线…」,组内容不变。
    const a = gm.createGroup("组A", ["airplay:d1"]);
    expect(() => gm.applyMemberDelta(a.id, { add: ["dlna:d2"] })).toThrow(/DLNA/);
    expect(() => gm.applyMemberDelta(a.id, { add: ["d2"] })).toThrow(/DLNA/);
    expect(gm.get(a.id)?.memberIds).toEqual(["airplay:d1"]);
    // 同一批里混进合法成员时也不许「前面那个先加进去」:校验在赋值之前。
    expect(() => gm.applyMemberDelta(a.id, { add: ["airplay:d2", "dlna:d2"] })).toThrow(/DLNA/);
    expect(gm.get(a.id)?.memberIds).toEqual(["airplay:d1"]);
    // 正常增量仍然可用(别把守卫写成一刀切)
    const res = gm.applyMemberDelta(a.id, { add: ["airplay:d2"] });
    expect(res?.added).toEqual(["airplay:d2"]);
    expect(gm.get(a.id)?.memberIds).toEqual(["airplay:d1", "airplay:d2"]);
  });

  it("renameGroup:改名并持久化", () => {
    const a = gm.createGroup("组A", ["airplay:d1"]);
    const renamed = gm.renameGroup(a.id, "新组名");
    expect(renamed?.name).toBe("新组名");
    expect(gm.get(a.id)?.name).toBe("新组名");
    expect(() => gm.renameGroup(a.id, "  ")).toThrow("组名不能为空");
  });

  it("deleteGroup:删除组并释放成员", () => {
    const a = gm.createGroup("组A", ["airplay:d1", "airplay:d2"]);
    expect(gm.deleteGroup(a.id)).toBe(true);
    expect(gm.get(a.id)).toBeUndefined();
    expect(gm.groupsOfDevice("d1")).toEqual([]);
    expect(gm.list()).toHaveLength(0);
    // 删除后可重新加入其他组
    gm.createGroup("组B", ["airplay:d1"]);
    expect(gm.list()).toHaveLength(1);
    expect(gm.deleteGroup("not-exist")).toBe(false);
  });

  it("listWithMembers:解析成员设备名称/可用性(memberId 原样回带)", () => {
    gm.createGroup("客厅组", ["airplay:d1", "airplay:d2", "sendspin:never-seen"]);
    const [g] = gm.listWithMembers();
    expect(g.members.slice(0, 2)).toEqual([
      { deviceId: "airplay:d1", name: "客厅音响", available: true },
      { deviceId: "airplay:d2", name: "卧室音响", available: false },
    ]);
    // sendspin 成员在测试里没有 server/supervisor ⇒ 离线占位(音量回显字段存在性另测)
    expect(g.members[2].deviceId).toBe("sendspin:never-seen");
    expect(g.members[2].available).toBe(false);
    expect(typeof g.members[2].volume).toBe("number");
  });

  it("事件广播:created/updated/deleted", () => {
    const events: string[] = [];
    gm.on("group_created", () => events.push("created"));
    gm.on("group_updated", () => events.push("updated"));
    gm.on("group_deleted", () => events.push("deleted"));
    const a = gm.createGroup("组A", ["airplay:d1"]);
    gm.setMembers(a.id, ["airplay:d1", "airplay:d2"]);
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
    const g = gm.createGroup("钳位组", ["airplay:d1"]);
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
    const g = gm.createGroup("保住音量", ["airplay:d1"]);
    gm.setVolume(g.id, 33);
    gm.setMembers(g.id, ["airplay:d1", "airplay:d2"]);
    gm.renameGroup(g.id, "新名");
    expect(gm.getVolume(g.id)).toBe(33);
    const gm2 = new GroupManager();
    gm2.loadFromDb();
    expect(gm2.get(g.id)?.volume).toBe(33);
    expect(gm2.get(g.id)?.name).toBe("新名");
  });

  it("loadFromDb:历史 DLNA 成员被剔除并落库(迁移)", () => {
    // 直接写一行历史数据(裸 id / dlna: 成员),模拟升级前的库。
    sqlite.exec(`
      INSERT INTO player_groups (id, owner_user_id, name, member_ids, volume, created_at, updated_at)
      VALUES ('g-legacy', '', '老组', '["d1","dlna:d2","sendspin:sp1","airplay:d3"]', 20,
              '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);
    const gm2 = new GroupManager();
    gm2.loadFromDb();
    expect(gm2.get("g-legacy")?.memberIds).toEqual(["sendspin:sp1", "airplay:d3"]);
    // 迁移结果必须持久化(再构造一个实例读到的是清理后的列表)
    const gm3 = new GroupManager();
    gm3.loadFromDb();
    expect(gm3.get("g-legacy")?.memberIds).toEqual(["sendspin:sp1", "airplay:d3"]);
  });
});
