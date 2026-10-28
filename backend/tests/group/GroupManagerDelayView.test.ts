// group/index.ts(GroupManager)定向单测:读视图延迟补偿 / 成员命名空间 / 增量成员 / 设备解析。
//
// 基线 82.91% 行 / 64.51% 分支,未覆盖部分集中在:
//   ① delayView —— 延迟补偿**只**进读视图,绝不写进 PlayerGroup 实体(否则落库路径被污染);
//   ② splitMemberId / assertMembersAvailable 的命名空间与拒收规则(DLNA 已禁入组);
//   ③ applyMemberDelta 的「已在组内 add / 不在组内 remove 为 no-op」与去重保序;
//   ④ resolveMembers 按 kind 分派(DLNA 缓存 / airplay 档案 + 会话态 / sendspin server+镜像)。
// 说明:GroupManager 自身逻辑用真库(setup.ts 每文件独立 SQLite),外部设备源全部 mock。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const devices: Array<{ id: string; name: string; alias?: string; available: boolean }> = [];
  const airplay: Record<string, any> = {};
  const disabled = new Set<string>();
  const spinVol: Record<string, { volume: number; muted: boolean }> = {};
  const state = {
    server: null as any,
    supervisorRunning: false,
    mirrorClients: new Map<string, any>(),
  };
  return { devices, airplay, disabled, spinVol, state };
});

vi.mock("../../src/services/dlna/control.js", () => ({
  getCachedDevices: () => h.devices,
}));

vi.mock("../../src/services/airplay/control.js", () => ({
  hasAirPlayDevice: (id: string) => id in h.airplay,
  isAirPlayDeviceDisabled: (id: string) => h.disabled.has(id),
  getAirPlayStatus: (id: string) =>
    h.airplay[id] ?? {
      available: false, name: id, playbackState: "IDLE", position: 0, duration: 0, volume: 0, muted: false,
    },
}));

vi.mock("../../src/services/sendspin/runtime.js", () => ({
  getServer: () => h.state.server,
}));

vi.mock("../../src/services/sendspin/supervisor.js", () => ({
  sendspinSupervisor: {
    isRunning: () => h.state.supervisorRunning,
    mirror: { get clients() { return h.state.mirrorClients; } },
  },
}));

vi.mock("../../src/services/sendspin/peerVolume.js", () => ({
  getSendspinDeviceVolume: (clientId: string) =>
    h.spinVol[clientId] ?? { volume: 80, muted: false },
}));

import { GroupManager, getGroupManager, splitMemberId, DEFAULT_GROUP_VOLUME } from "../../src/services/group/index.js";
import { setMemberDelay } from "../../src/services/group/delayCalib.js";
import { sqlite } from "../../src/db/index.js";

function apFixture(id: string, over: Record<string, unknown> = {}): void {
  h.airplay[id] = {
    available: true, name: `设备-${id}`, playbackState: "PLAYING", position: 3, duration: 100, volume: 44, muted: false, ...over,
  };
}

let gm: GroupManager;

beforeEach(() => {
  sqlite.exec("DELETE FROM player_groups");
  h.devices.length = 0;
  for (const k of Object.keys(h.airplay)) delete h.airplay[k];
  for (const k of Object.keys(h.spinVol)) delete h.spinVol[k];
  h.disabled.clear();
  h.state.server = null;
  h.state.supervisorRunning = false;
  h.state.mirrorClients = new Map<string, any>();
  gm = new GroupManager();
  gm.loadFromDb();
});

describe("splitMemberId:命名空间解析", () => {
  it("三种 kind 前缀被正确剥离", () => {
    expect(splitMemberId("sendspin:sp1")).toEqual({ kind: "sendspin", id: "sp1" });
    expect(splitMemberId("airplay:a1")).toEqual({ kind: "airplay", id: "a1" });
    expect(splitMemberId("dlna:d1")).toEqual({ kind: "dlna", id: "d1" });
  });

  it("裸 id 视为历史 DLNA 写法(仅旧组可解析,新提交会被拒收)", () => {
    expect(splitMemberId("legacy-id")).toEqual({ kind: "dlna", id: "legacy-id" });
  });

  it("group:/local: 前缀返回 null(组不能套组、不能含本机)", () => {
    expect(splitMemberId("group:g1")).toBeNull();
    expect(splitMemberId("local:u1")).toBeNull();
  });

  it("空前缀(只写前缀)与非字符串/空串 → null", () => {
    expect(splitMemberId("sendspin:")).toBeNull();
    expect(splitMemberId("airplay:")).toBeNull();
    expect(splitMemberId("dlna:")).toBeNull();
    expect(splitMemberId("")).toBeNull();
    expect(splitMemberId(undefined as any)).toBeNull();
  });
});

describe("读视图延迟补偿(delayView,按成员)", () => {
  it("getWithMembers 带出 memberDelays(member id → ms)", () => {
    const g = gm.createGroup("延迟组", []);
    setMemberDelay(g.id, "airplay:a1", 120);
    setMemberDelay(g.id, "sendspin:sp1", -80);
    const view = gm.getWithMembers(g.id)!;
    expect(view.memberDelays["airplay:a1"]).toBe(120);
    expect(view.memberDelays["sendspin:sp1"]).toBe(-80);
  });

  it("PlayerGroup 实体**不含**延迟字段(不污染落库路径)", () => {
    const g = gm.createGroup("干净实体", []);
    setMemberDelay(g.id, "airplay:a1", 50);
    expect(g).not.toHaveProperty("memberDelays");
    expect(g).not.toHaveProperty("trackSwitchLeadMs");
    expect(gm.get(g.id)).not.toHaveProperty("memberDelays");
    expect(gm.list()[0]).not.toHaveProperty("memberDelays");
    // 读视图才有
    expect(gm.listWithMembers()[0].memberDelays["airplay:a1"]).toBe(50);
  });

  it("新组不播种延迟:memberDelays 为空对象(300ms 对齐点已取消,默认全 0)", () => {
    const g = gm.createGroup("默认全零", []);
    const view = gm.getWithMembers(g.id)!;
    expect(view.memberDelays).toEqual({});
  });

  it("显式清零后读视图回 0(setMemberDelay 写 0 即落库,不复活)", () => {
    const g = gm.createGroup("显式清零", []);
    setMemberDelay(g.id, "airplay:a1", 300);
    setMemberDelay(g.id, "airplay:a1", 0);
    const view = gm.getWithMembers(g.id)!;
    expect(view.memberDelays["airplay:a1"]).toBe(0);
  });

  it("listWithMembersForOwner 同样带延迟 + 成员详情;未知组 getWithMembers → undefined", () => {
    const g = gm.createGroup("我的组", [], "user-1");
    setMemberDelay(g.id, "sendspin:sp1", -10);
    const [view] = gm.listWithMembersForOwner("user-1");
    expect(view.memberDelays["sendspin:sp1"]).toBe(-10);
    expect(view.members).toEqual([]);
    expect(gm.getWithMembers("nope")).toBeUndefined();
  });
});

describe("归属与列表", () => {
  it("listForOwner:空 owner 返回空(管理员走全量接口)", () => {
    gm.createGroup("组A", [], "user-1");
    expect(gm.listForOwner("")).toEqual([]);
    expect(gm.listForOwner("user-1")).toHaveLength(1);
    expect(gm.listForOwner("user-2")).toEqual([]);
  });

  it("isOwnedBy:管理员恒有权;owner 有权;他人无权;组不存在无权", () => {
    const g = gm.createGroup("组", [], "user-1");
    expect(gm.isOwnedBy(g.id, "anyone", true)).toBe(true);
    expect(gm.isOwnedBy(g.id, "user-1", false)).toBe(true);
    expect(gm.isOwnedBy(g.id, "user-2", false)).toBe(false);
    expect(gm.isOwnedBy("nope", "user-1", false)).toBe(false);
  });

  it("getGroupManager 是单例(WS 推送/路由层共用同一份内存表)", () => {
    expect(getGroupManager()).toBe(getGroupManager());
  });
});

describe("创建组:名称与成员校验", () => {
  it("名称 trim 后为空 → 抛错", () => {
    expect(() => gm.createGroup("   ")).toThrow("组名不能为空");
    expect(() => gm.createGroup(undefined as any)).toThrow("组名不能为空");
  });

  it("名称超过 50 字符 → 抛错(边界:50 正好允许)", () => {
    expect(gm.createGroup("字".repeat(50)).name).toHaveLength(50);
    expect(() => gm.createGroup("字".repeat(51))).toThrow("组名不能超过 50 个字符");
  });

  it("成员含非字符串 / 重复 → 抛错", () => {
    apFixture("a1");
    expect(() => gm.createGroup("组", ["airplay:a1", 42 as any])).toThrow("成员必须是字符串 id");
    expect(() => gm.createGroup("组", ["airplay:a1", "airplay:a1"])).toThrow("成员列表不能重复");
  });

  it("airplay 成员:设备档案不存在 / 已禁用 → 拒收", () => {
    apFixture("a1");
    h.disabled.add("a1");
    expect(() => gm.createGroup("组", ["airplay:ghost"])).toThrow("不是已知的 AirPlay 设备");
    expect(() => gm.createGroup("组", ["airplay:a1"])).toThrow("已被禁用");
  });

  it("sendspin 成员:只校验格式,离线也允许入组(组可持久化,在线态动态解析)", () => {
    const g = gm.createGroup("纯 sendspin 组", ["sendspin:sp1"]);
    expect(g.memberIds).toEqual(["sendspin:sp1"]);
  });

  it("新建组音量默认 20,且落库可恢复(空组成员也能保存)", () => {
    const g = gm.createGroup("空组");
    expect(g.volume).toBe(DEFAULT_GROUP_VOLUME);
    expect(g.ownerUserId).toBe("");
    const gm2 = new GroupManager();
    gm2.loadFromDb();
    expect(gm2.get(g.id)?.name).toBe("空组");
  });
});

describe("setMembers / applyMemberDelta", () => {
  it("setMembers:命名空间字符串原样保留(不剥 airplay:/sendspin:)", () => {
    apFixture("a1");
    const g = gm.createGroup("组", []);
    gm.setMembers(g.id, ["airplay:a1", "sendspin:sp-1"]);
    expect(gm.get(g.id)!.memberIds).toEqual(["airplay:a1", "sendspin:sp-1"]);
  });

  it("setMembers:组不存在 → undefined(路由层据此 404)", () => {
    expect(gm.setMembers("nope", [])).toBeUndefined();
  });

  it("applyMemberDelta:先删后加,新增 append,顺序不变,返回真实 added/removed", () => {
    apFixture("a1");
    apFixture("a2");
    const g = gm.createGroup("组", ["airplay:a1"]);
    const r = gm.applyMemberDelta(g.id, { add: ["airplay:a2"], remove: [] })!;
    expect(r.added).toEqual(["airplay:a2"]);
    expect(r.removed).toEqual([]);
    expect(r.group.memberIds).toEqual(["airplay:a1", "airplay:a2"]);

    const r2 = gm.applyMemberDelta(g.id, { add: [], remove: ["airplay:a1"] })!;
    expect(r2.removed).toEqual(["airplay:a1"]);
    expect(r2.group.memberIds).toEqual(["airplay:a2"]);
  });

  it("applyMemberDelta:已在组内 add / 不在组内 remove / 非字符串元素 → 全是 no-op", () => {
    apFixture("a1");
    const g = gm.createGroup("组", ["airplay:a1"]);
    const r = gm.applyMemberDelta(g.id, { add: ["airplay:a1", 7 as any], remove: ["airplay:ghost"] })!;
    expect(r.added).toEqual([]);
    expect(r.removed).toEqual([]);
    expect(r.group.memberIds).toEqual(["airplay:a1"]);
  });

  it("applyMemberDelta:delta 字段缺失/非数组 → 视为空(不崩)", () => {
    const g = gm.createGroup("组", []);
    const r = gm.applyMemberDelta(g.id, {} as any)!;
    expect(r.added).toEqual([]);
    expect(r.removed).toEqual([]);
    expect(gm.applyMemberDelta("nope", { add: [] })).toBeUndefined();
  });
});

describe("音量 / 改名 / 删除 / 设备归属", () => {
  it("setVolume:同值早退(不重复落库/不重复广播)", () => {
    const g = gm.createGroup("组", []);
    const events: string[] = [];
    gm.on("group_updated", () => events.push("updated"));
    expect(gm.setVolume(g.id, 20)).toBe(20); // 与缺省相同 → 直接返回
    expect(events).toEqual([]);
    expect(gm.setVolume(g.id, 21)).toBe(21);
    expect(events).toEqual(["updated"]);
  });

  it("setVolume:NaN/Infinity 回缺省;越界钳制", () => {
    const g = gm.createGroup("组", []);
    expect(gm.setVolume(g.id, Number.NaN)).toBe(DEFAULT_GROUP_VOLUME);
    expect(gm.setVolume(g.id, Number.POSITIVE_INFINITY)).toBe(DEFAULT_GROUP_VOLUME);
    expect(gm.setVolume(g.id, -1)).toBe(0);
    expect(gm.setVolume(g.id, 101)).toBe(100);
  });

  it("getVolume:组不存在回缺省(供 status 回显不崩)", () => {
    expect(gm.getVolume("nope")).toBe(DEFAULT_GROUP_VOLUME);
  });

  it("renameGroup:组不存在 → undefined;名称非法抛错", () => {
    const g = gm.createGroup("组", []);
    expect(gm.renameGroup("nope", "x")).toBeUndefined();
    expect(() => gm.renameGroup(g.id, "  ")).toThrow("组名不能为空");
  });

  it("deleteGroup:不存在 → false;删除广播 + 释放归属", () => {
    apFixture("a1");
    const g = gm.createGroup("组", ["airplay:a1"]);
    const events: string[] = [];
    gm.on("group_deleted", (id: string) => events.push(id));
    expect(gm.deleteGroup("nope")).toBe(false);
    expect(gm.deleteGroup(g.id)).toBe(true);
    expect(events).toEqual([g.id]);
    expect(gm.groupsOfDevice("airplay:a1")).toEqual([]);
  });

  it("groupsOfDevice:裸 id 与命名空间 id 都能命中(按裸 id 比对)", () => {
    apFixture("a1");
    const g = gm.createGroup("组", ["airplay:a1"]);
    expect(gm.groupsOfDevice("airplay:a1")).toEqual([g.id]);
    expect(gm.groupsOfDevice("a1")).toEqual([g.id]);
    expect(gm.groupsOfDevice("nope")).toEqual([]);
  });

  it("removeDeviceFromAllGroups:从所有组摘除并广播;未命中不广播", () => {
    apFixture("a1");
    apFixture("a2");
    const g1 = gm.createGroup("组1", ["airplay:a1", "airplay:a2"]);
    const g2 = gm.createGroup("组2", ["airplay:a1"]);
    const events: string[] = [];
    gm.on("group_updated", (g: any) => events.push(g.id));

    gm.removeDeviceFromAllGroups("a1"); // 裸 id 也能删掉命名空间写法
    expect(gm.get(g1.id)!.memberIds).toEqual(["airplay:a2"]);
    expect(gm.get(g2.id)!.memberIds).toEqual([]);
    expect(events).toEqual([g1.id, g2.id]);

    events.length = 0;
    gm.removeDeviceFromAllGroups("ap-not-in-any");
    expect(events).toEqual([]);
  });
});

describe("成员解析(按 kind 分派 —— 在线判定的单一真相源)", () => {
  it("DLNA 成员:优先 alias,其次 name;不在缓存 → 名称回 memberId 且离线", () => {
    h.devices.push({ id: "d1", name: "原生名", alias: "别名", available: true });
    const states = gm.resolveMemberStates(["d1", "d-missing"]);
    expect(states[0]).toEqual({ deviceId: "d1", name: "别名", available: true });
    expect(states[1]).toEqual({ deviceId: "d-missing", name: "d-missing", available: false });
  });

  it("airplay 成员:名称/可用性/音量/静音全部来自会话态(与 /v1/airplay status 同源)", () => {
    apFixture("a1", { available: false, name: "客厅", volume: 33, muted: true });
    const [s] = gm.resolveMemberStates(["airplay:a1"]);
    expect(s).toEqual({ deviceId: "airplay:a1", name: "客厅", available: false, volume: 33, muted: true });
  });

  it("sendspin 成员:in-proc server 在线 → 实时 ready 与名称", () => {
    h.spinVol.sp1 = { volume: 66, muted: false };
    h.state.server = { clients: new Map([["sp1", { name: "卧室", ready: false }]]) };
    const [s] = gm.resolveMemberStates(["sendspin:sp1"]);
    expect(s).toEqual({ deviceId: "sendspin:sp1", name: "卧室", available: false, volume: 66, muted: false });
  });

  it("sendspin 成员:in-proc 无此 client 但 supervisor 镜像有(fork 模式)→ 用镜像", () => {
    h.state.server = { clients: new Map() };
    h.state.supervisorRunning = true;
    h.state.mirrorClients = new Map([["sp2", { name: "镜像设备", ready: true }]]);
    h.spinVol.sp2 = { volume: 12, muted: true };
    const [s] = gm.resolveMemberStates(["sendspin:sp2"]);
    expect(s).toEqual({ deviceId: "sendspin:sp2", name: "镜像设备", available: true, volume: 12, muted: true });
  });

  it("sendspin 成员:服务未运行 → 离线占位,但仍回显持久音量(灰态可调)", () => {
    h.spinVol.sp3 = { volume: 5, muted: true };
    const [s] = gm.resolveMemberStates(["sendspin:sp3"]);
    expect(s).toEqual({ deviceId: "sendspin:sp3", name: "sp3", available: false, volume: 5, muted: true });
  });

  it("不可解析成员(group:/local:):原样回显且离线(不抛)", () => {
    const [s] = gm.resolveMemberStates(["group:g2", "local:me"]);
    expect(s).toEqual({ deviceId: "group:g2", name: "group:g2", available: false });
  });
});

describe("loadFromDb 容错", () => {
  it("memberIds 坏 JSON → 空数组(不阻断启动);volume 越界钳到 100", () => {
    sqlite
      .prepare("INSERT INTO player_groups (id, owner_user_id, name, member_ids, volume) VALUES (?, ?, ?, ?, ?)")
      .run("legacy-1", "", "历史组", "not-json", 999);
    const gm2 = new GroupManager();
    gm2.loadFromDb();
    const g = gm2.get("legacy-1")!;
    expect(g.memberIds).toEqual([]);
    expect(g.volume).toBe(100);
    expect(g.ownerUserId).toBe("");
  });
});
