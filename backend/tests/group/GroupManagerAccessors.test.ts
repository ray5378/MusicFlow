// ==================== GroupManager:权限视图 / 成员解析 / 设备摘除 ====================
//
// 为什么补这一层:
//   ① `listForOwner` / `isOwnedBy` 是「普通用户只能看/操作自己的组」的**唯一判据**,
//      写错就是越权(看不到自己的组,或能看到别人的组);
//   ② `resolveSendspinMember` 的 supervisor 镜像分支(fork 模式下 sendspin 服务跑在
//      子进程,主进程只能读镜像)—— 这条分支一旦失效,sendspin 成员在实际部署里
//      永远显示离线,组内音量条消失;
//   ③ `removeDeviceFromAllGroups`(删除设备时清理)必须真的把成员从每个组摘掉并落库,
//      否则删掉的设备会永远挂在组里。
//
// 手法:进程单例 + 真实 SQLite(继承 GroupManager.test.ts 的建表方式),DLNA 设备源
// 与 sendspin 运行/镜像源全部换成可控假体。
//
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { sqlite } from "../../src/db/index.js";

vi.mock("../../src/services/dlna/control.js", () => ({
  getCachedDevices: () => [
    { id: "d1", name: "客厅音响", available: true },
    { id: "d2", name: "卧室音响", available: false },
  ],
}));

// 本文件刻意模拟「in-proc server 不存在(fork 模式)」—— 只剩 supervisor 镜像。
const H = vi.hoisted(() => ({
  srv: null as any,
  supervisorRunning: true,
  mirrorClients: new Map<string, any>([["sp9", { name: "镜像播放器", ready: true }]]),
}));

vi.mock("../../src/services/sendspin/runtime.js", () => ({
  getServer: () => H.srv,
  getClientCount: () => (H.srv ? H.srv.clients.size : H.mirrorClients.size),
}));

vi.mock("../../src/services/sendspin/supervisor.js", () => ({
  sendspinSupervisor: {
    isRunning: () => H.supervisorRunning,
    mirror: { clients: H.mirrorClients },
  },
}));

vi.mock("../../src/services/sendspin/peerVolume.js", () => ({
  getSendspinDeviceVolume: () => ({ volume: 42, muted: true }),
}));

import { GroupManager, getGroupManager } from "../../src/services/group/index.js";

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

beforeEach(() => {
  sqlite.exec("DELETE FROM player_groups");
  H.srv = null;
  H.supervisorRunning = true;
  // 注意:mock 工厂把 mirror.clients 指向的是**同一个 Map 实例**,故这里只能
  // 就地增删不能整体替换引用(替换后 mock 仍看旧 Map)。
  H.mirrorClients.clear();
  H.mirrorClients.set("sp9", { name: "镜像播放器", ready: true });
});

describe("GroupManager:按 owner 过滤(普通用户越权隔离)", () => {
  let gm: GroupManager;

  beforeEach(() => {
    gm = new GroupManager();
    gm.loadFromDb();
  });

  it("listForOwner('') → 空数组(管理员走全量口径,不把空 owner 当通配)", () => {
    gm.createGroup("G", [], "u1");
    expect(gm.listForOwner("")).toEqual([]);
  });

  it("listForOwner 只回该 owner 的组,别人的组不可见", () => {
    const a = gm.createGroup("A组", [], "u1");
    gm.createGroup("B组", [], "u2");
    expect(gm.listForOwner("u1").map((g) => g.id)).toEqual([a.id]);
  });

  it("listWithMembersForOwner('') → 空数组(注释与实现不符,见报告)", () => {
    gm.createGroup("全量组", ["d1"], "u1");
    // 说明:该方法的 docblock 写「管理员传入空串返回全量」,但实现直接委托
    // listForOwner("") → 短路返回 []。当前唯一调用点(routes/api/groups.ts)对管理员
    // 走的是 listWithMembers(),所以线上未暴露;一旦有人按注释调用,管理员会看到空列表。
    // 这里按**实际契约**断言,避免把注释当契约。
    expect(gm.listWithMembersForOwner("")).toEqual([]);
  });

  it("listWithMembersForOwner(uid) 只回该 owner 的组并附成员详情", () => {
    const g = gm.createGroup("我的组", ["d1"], "u1");
    gm.createGroup("别人的组", ["d2"], "u2");
    const mine = gm.listWithMembersForOwner("u1");
    expect(mine.map((x) => x.id)).toEqual([g.id]);
    expect(mine[0].members[0]).toMatchObject({ deviceId: "d1", name: "客厅音响", available: true });
  });

  it("isOwnedBy:管理员恒 true;普通用户须为 owner;组不存在 false", () => {
    const g = gm.createGroup("归属组", [], "u1");
    expect(gm.isOwnedBy(g.id, "u2", true)).toBe(true); // 管理员恒有权
    expect(gm.isOwnedBy(g.id, "u1", false)).toBe(true); // owner 本人
    expect(gm.isOwnedBy(g.id, "u2", false)).toBe(false); // 非 owner
    expect(gm.isOwnedBy("no-such-group", "u1", false)).toBe(false); // 不存在
  });
});

describe("GroupManager:sendspin 成员走 supervisor 镜像解析(fork 部署形态)", () => {
  it("in-proc server 缺失但 supervisor 在跑 → 从镜像取名称/在线,且回显持久音量", () => {
    const gm = new GroupManager();
    gm.loadFromDb();
    // 关键:runtime.getServer() 返回 null 时**不得**直接判离线 —— fork 模式下
    // 服务在子进程,主进程只有镜像。漏掉这条分支,生产里 sendspin 成员恒显示离线。
    expect(H.srv).toBeNull();
    const states = gm.resolveMemberStates(["sendspin:sp9", "sendspin:unknown"]);
    expect(states[0]).toMatchObject({ deviceId: "sendspin:sp9", name: "镜像播放器", available: true, volume: 42, muted: true });
    // 镜像里没有的客户端 → 离线占位,但仍回显持久音量/静音(灰态可调)
    expect(states[1]).toMatchObject({ deviceId: "sendspin:unknown", available: false, volume: 42, muted: true });
  });

  it("supervisor 未运行且镜像为空 → 离线占位(不抛)", () => {
    H.supervisorRunning = false;
    H.mirrorClients.clear();
    const gm = new GroupManager();
    gm.loadFromDb();
    const states = gm.resolveMemberStates(["sendspin:sp9"]);
    expect(states[0]).toMatchObject({ available: false, name: "sp9" });
  });
});

describe("GroupManager:removeDeviceFromAllGroups(删除设备时清理)", () => {
  it("把该设备从所有组摘掉并持久化;不含它的组不动", () => {
    const gm = new GroupManager();
    gm.loadFromDb();
    const g1 = gm.createGroup("含 d1", ["d1", "d2"], "u1");
    const g2 = gm.createGroup("不含", ["d2"], "u1");

    gm.removeDeviceFromAllGroups("dlna:d1"); // 命名空间写法也要命中裸 id 存储
    expect(gm.get(g1.id)!.memberIds).toEqual(["d2"]);
    expect(gm.get(g2.id)!.memberIds).toEqual(["d2"]);

    // 持久化:重新 loadFromDb 后仍是摘除后的成员
    const gm2 = new GroupManager();
    gm2.loadFromDb();
    expect(gm2.get(g1.id)!.memberIds).toEqual(["d2"]);
  });

  it("设备不在任何组 → 无副作用(不写库不广播)", () => {
    const gm = new GroupManager();
    gm.loadFromDb();
    const g = gm.createGroup("G", ["d1"], "u1");
    const events: string[] = [];
    gm.on("group_updated", () => events.push("updated"));
    gm.removeDeviceFromAllGroups("d2");
    expect(gm.get(g.id)!.memberIds).toEqual(["d1"]);
    expect(events).toEqual([]);
  });

  it("进程单例也走同一实现(getGroupManager 与 peer 层共用一份状态)", () => {
    const gm = getGroupManager();
    gm.loadFromDb();
    const g = gm.createGroup("单例组", ["d1", "d2"], "");
    gm.removeDeviceFromAllGroups("d2");
    expect(getGroupManager().get(g.id)!.memberIds).toEqual(["d1"]);
  });
});
