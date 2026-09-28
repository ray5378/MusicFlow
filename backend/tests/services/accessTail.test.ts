// 覆盖率长尾补充:services/access.ts 的三处残余分支。
//   - permissionCatalog()           —— 目录快照访问器(路由层展示用)
//   - canUseRenderer 的 `group:` 分支 —— 自己创建的组「创建即可控」,无需额外设备授权
//   - decoratePeersForClient 的成员托管映射 —— 活跃组在播时其成员行被标 managedByGroup
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeEach } from "vitest";
import { v4 as uuidv4 } from "uuid";
import md5 from "md5";
import { db } from "../../src/db/index.js";
import { users, userPermissions, userRendererGrants } from "../../src/db/schema.js";
import {
  PERM,
  PERMISSION_CATALOG,
  permissionCatalog,
  canUseRenderer,
  decoratePeersForClient,
  setUserPermission,
  invalidateAccessCaches,
} from "../../src/services/access.js";
import { getGroupManager } from "../../src/services/group/index.js";

beforeEach(() => {
  invalidateAccessCaches();
  db.delete(userPermissions).run();
  db.delete(userRendererGrants).run();
  db.delete(users).run();
});

/** user_permissions / user_renderer_grants 有 FK,必须先建用户行。 */
function mkUser(): string {
  const id = uuidv4();
  db.insert(users)
    .values({
      id,
      username: `u-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      password: md5("x"),
      salt: "s",
      subsonicSalt: "ss",
      isAdmin: 0,
      isActive: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
  return id;
}

describe("permissionCatalog", () => {
  it("返回完整权限目录(与 PERMISSION_CATALOG 同源,管理端 UI 展示用)", () => {
    // 与常量同源即可:目录是管理端「逐项勾选」的数据源,漏一项就会有一类功能不可授。
    expect(permissionCatalog()).toBe(PERMISSION_CATALOG);
    expect(permissionCatalog().length).toBeGreaterThan(0);
  });
});

describe("canUseRenderer: 群组「创建即可控」例外", () => {
  it("普通用户对自己创建的组 → 可用(无需额外设备授权)", () => {
    const uid = mkUser();
    // 先过 renderer.use 这道功能权限门(第 146 行),否则测不到 group 例外分支。
    setUserPermission(uid, PERM.RENDERER_USE, true);
    const g = getGroupManager().createGroup("tail-group", [], uid);

    // 组 owner 判定在设备授权表里没有 group:<id> 行,唯一放行来源就是 owner 例外分支。
    expect(canUseRenderer(uid, false, `group:${g.id}`)).toBe(true);
  });

  it("普通用户对**别人**创建的组 → 不可用(例外不越权)", () => {
    const owner = mkUser();
    const other = mkUser();
    setUserPermission(other, PERM.RENDERER_USE, true);
    const g = getGroupManager().createGroup("tail-group-2", [], owner);

    // owner 不是 other ⇒ isOwnedBy 为 false ⇒ 回落到设备授权表(无行)⇒ false。
    expect(canUseRenderer(other, false, `group:${g.id}`)).toBe(false);
  });
});

describe("decoratePeersForClient: 活跃组托管成员", () => {
  it("活跃组的成员行被标 managedByGroup,且其自身 isActive 被出口强制置 false", () => {
    const uid = mkUser();
    // 所有组都不属于 uid 也无妨:用管理员视角(全量可见)专测托管映射本身。
    const groupPeer = {
      peerId: "group:G1",
      kind: "group",
      groupId: "G1",
      memberIds: ["dlna:D1", "sendspin:C1"],
      queue: { isActive: true },
    };
    const dlnaMember = {
      peerId: "dlna:D1",
      kind: "dlna",
      queue: { isActive: true, items: [{ songId: "s1" }] },
    };
    const sendspinMember = {
      peerId: "sendspin:C1",
      kind: "sendspin",
      queue: { isActive: true },
    };

    const rows = decoratePeersForClient([groupPeer, dlnaMember, sendspinMember], uid, true);
    const byId = new Map(rows.map((r) => [r.peerId, r]));

    // 成员被活跃组托管:DLNA 行挂上托管组 id,自身播放状态作废(不是清库,items 保留)。
    const d = byId.get("dlna:D1")!;
    expect(d.managedByGroup).toBe("G1");
    expect(d.queue!.isActive).toBe(false);
    expect(d.queue!.items).toEqual([{ songId: "s1" }]);

    // sendspin 成员同样被托管。
    expect(byId.get("sendspin:C1")!.managedByGroup).toBe("G1");

    // 组自身**不**被自己托管(托管映射的键是成员 id,不是组 id)。
    expect(byId.get("group:G1")!.managedByGroup).toBeUndefined();
  });

  it("组队列未激活 → 不产生托管(不在播就不托管成员)", () => {
    const uid = mkUser();
    const rows = decoratePeersForClient(
      [
        { peerId: "group:G2", kind: "group", groupId: "G2", memberIds: ["dlna:D2"], queue: { isActive: false } },
        { peerId: "dlna:D2", kind: "dlna", queue: { isActive: true } },
      ],
      uid,
      true,
    );
    const d = rows.find((r) => r.peerId === "dlna:D2")!;
    expect(d.managedByGroup).toBeUndefined();
    expect(d.queue!.isActive).toBe(true);
  });

  it("local 行不参与托管判定(其对外 id 已被归一化,不能命中设备键)", () => {
    const uid = mkUser();
    // 成员 id 若被错误地写成 local:<uid>,splitMemberId 返回 null ⇒ pid 原样 = "local:<uid>"。
    // 但出口处 local 行 peerId 被改写成规范形式,永不会与托管映射的键相等(注释第 287 行)。
    const rows = decoratePeersForClient(
      [
        { peerId: "group:G3", kind: "group", groupId: "G3", memberIds: [`local:${uid}`], queue: { isActive: true } },
        { peerId: `local:${uid}`, kind: "local", platform: "web", queue: { isActive: true } },
      ],
      uid,
      true,
    );
    const self = rows.find((r) => r.peerId === `local:${uid}`)!;
    expect(self).toBeTruthy();
    expect(self.managedByGroup).toBeUndefined();
    expect(self.queue!.isActive).toBe(true);
  });
});
