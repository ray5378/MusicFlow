// 服务端「组成员 kind allowlist」现状钉定用例(路由层)。
//
// 背景(2026-10-26):
//   - 成员命名空间:airplay:<deviceId> / sendspin:<clientId>,客户端提交**整条字符串**,
//     服务端不剥前缀、不改写(历史 bug:剥前缀 ⇒ 删除变 no-op ⇒ 成员删不掉)。
//   - 群组只允许 airplay / sendspin 两类成员(2026-10-24 起 DLNA 禁入组)。
//   - 校验的唯一实现是 GroupManager.assertMembersAvailable(src/services/group/index.ts:361-385),
//     两个入口 setMembers(:216) 与 applyMemberDelta(:239) 都调它 —— 本文件钉的正是
//     「两个入口都不漏、拒绝必须无损、存库必须逐字一致」。
//   - 两个入口**只按差集**校验(2026-10-26 修 O1):setMembers 校验「相对现有成员新出现」的部分,
//     applyMemberDelta 只校验 added ⇒ 组里留着历史 DLNA 成员不再让任何成员变更 400(组锁死)。
//
// 这里只断言「校验 + 持久化」这一段边界;设备侧对齐(alignGroupMembers)会去建桥/建
// RTSP 会话,属于另一层,用 no-op 替身隔离(其余导出保持真实,鉴权/权限链都是真的)。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, vi } from "vitest";
import { Hono } from "hono";
import md5 from "md5";
import { eq } from "drizzle-orm";

import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users, playerGroups } from "../../src/db/schema.js";
import { authMiddleware } from "../../src/middleware/auth.js";
import { apiRoutes } from "../../src/routes/api/index.js";
import { getGroupManager } from "../../src/services/group/index.js";
import { addPersistedAirPlayDevice } from "../../src/services/airplay/discovery.js";

// 设备侧对齐不参与本文件的断言(见文件头说明)。
vi.mock("../../src/routes/api/shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/routes/api/shared.js")>();
  return { ...actual, alignGroupMembers: async () => {} };
});

const app = new Hono();
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);

const PLAIN = "hunter2";
const CLIENT_SALT = "clientsalt123";
const authQS = () => `u=alice&t=${md5(PLAIN + CLIENT_SALT)}&s=${CLIENT_SALT}`;

type ApiResult = { status: number; body: any };

async function req(method: string, path: string, body?: unknown): Promise<ApiResult> {
  const res = await app.request(`/rest/api${path}?${authQS()}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

const post = (p: string, b?: unknown) => req("POST", p, b);
const put = (p: string, b?: unknown) => req("PUT", p, b);

/** 直读库里的 member_ids 原文(证明「不剥前缀、不改写、不重排」)。 */
function dbMemberIds(groupId: string): string[] {
  const row = db.select().from(playerGroups).where(eq(playerGroups.id, groupId)).get();
  if (!row) return [];
  try {
    return JSON.parse(row.memberIds || "[]") as string[];
  } catch {
    return [];
  }
}

/** 建一个空组,返回 id。 */
async function createEmptyGroup(name: string): Promise<string> {
  const r = await post("/v1/groups", { name });
  expect(r.status).toBe(201);
  return r.body.group.id as string;
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  if (!db.select().from(users).where(eq(users.username, "alice")).get()) {
    db.insert(users).values({
      id: "u1",
      username: "alice",
      password: "",
      salt: "salt",
      subsonicSalt: "subsalt",
      passEnc: encryptPassword(PLAIN),
      isAdmin: 1,
      isActive: 1,
      email: "a@b.c",
    }).run();
  }
  // AirPlay 设备档案:assertMembersAvailable 要求 hasAirPlayDevice 为真(可用性动态解析,
  // 所以这里给的是「已发现过一次、当前在线」的档案)。
  addPersistedAirPlayDevice({
    id: "ap-member-1",
    name: "组用例音箱",
    host: "127.0.0.1",
    port: 5000,
    supportsRsa: false,
    supportsAp2: false,
    lastSeen: Date.now(),
    available: true,
  });
});

describe("组成员 kind allowlist(路由层现状钉定)", () => {
  it("合法成员 airplay: + sendspin: 写入成功,且库里字符串与提交逐字一致(不剥前缀/不改写/不重排)", async () => {
    const id = await createEmptyGroup("合法成员组");
    const submitted = ["airplay:ap-member-1", "sendspin:ROOM-A"];

    const r = await put(`/v1/groups/${id}`, { memberIds: submitted });
    expect(r.status).toBe(200);
    expect(r.body.group.memberIds).toEqual(submitted);
    // 库内原文逐字一致 —— 这一条专门钉历史 bug(客户端整串提交,服务端不得改写)。
    expect(dbMemberIds(id)).toEqual(submitted);
  });

  it("dlna:<id> → 400,且库里原成员没被破坏(拒绝必须无损)", async () => {
    const id = await createEmptyGroup("DLNA拒收组");
    const before = ["sendspin:ROOM-A"];
    const ok = await put(`/v1/groups/${id}`, { memberIds: before });
    expect(ok.status).toBe(200);
    expect(dbMemberIds(id)).toEqual(before);

    const bad = await put(`/v1/groups/${id}`, { memberIds: [...before, "dlna:d1"] });
    expect(bad.status).toBe(400);
    // 拒绝是无损的:成员与库内原文都没变。
    expect(getGroupManager().get(id)?.memberIds).toEqual(before);
    expect(dbMemberIds(id)).toEqual(before);
  });

  it("未知前缀 foo:xxx → 400", async () => {
    const id = await createEmptyGroup("未知前缀组");
    const r = await put(`/v1/groups/${id}`, { memberIds: ["foo:xxx"] });
    expect(r.status).toBe(400);
    expect(dbMemberIds(id)).toEqual([]);
  });

  it("重复成员 [a, a] → 400(钉 assertMembersAvailable 的重复判定 :366)", async () => {
    const id = await createEmptyGroup("重复成员组");
    const r = await put(`/v1/groups/${id}`, {
      memberIds: ["sendspin:ROOM-A", "sendspin:ROOM-A"],
    });
    expect(r.status).toBe(400);
    expect(dbMemberIds(id)).toEqual([]);
  });

  it("group: / local: 前缀 → 400(组不能套组、不能含本机)", async () => {
    const id = await createEmptyGroup("套组前缀组");
    const g = await put(`/v1/groups/${id}`, { memberIds: ["group:other"] });
    expect(g.status).toBe(400);
    const l = await put(`/v1/groups/${id}`, { memberIds: ["local:u1"] });
    expect(l.status).toBe(400);
    expect(dbMemberIds(id)).toEqual([]);
  });

  it("空数组清空成员 → 成功(400 只针对非法成员,不针对空集)", async () => {
    const id = await createEmptyGroup("清空成员组");
    const add = await put(`/v1/groups/${id}`, { memberIds: ["sendspin:ROOM-A"] });
    expect(add.status).toBe(200);
    expect(dbMemberIds(id)).toEqual(["sendspin:ROOM-A"]);

    const clear = await put(`/v1/groups/${id}`, { memberIds: [] });
    expect(clear.status).toBe(200);
    expect(clear.body.group.memberIds).toEqual([]);
    expect(dbMemberIds(id)).toEqual([]);
  });

  it("组不存在 → 404(管理员 isOwnedBy 恒真,必须显式 gm.get(id) 才不返回 200)", async () => {
    const p = await put("/v1/groups/no-such-group", { memberIds: ["sendspin:ROOM-A"] });
    expect(p.status).toBe(404);
    const d = await post("/v1/groups/no-such-group/members", { add: ["sendspin:ROOM-A"] });
    expect(d.status).toBe(404);
    // 延迟口同理(它显式做了 gm.get 判断,是本仓库的参考实现)。
    const delays = await put("/v1/groups/no-such-group/delays", { airplayMs: 10 });
    expect(delays.status).toBe(404);
  });

  it("delta 入口不是后门:POST members {add:[dlna:x]} → 400,库里不受影响", async () => {
    const id = await createEmptyGroup("delta后门组");
    const seed = await put(`/v1/groups/${id}`, { memberIds: ["sendspin:ROOM-A"] });
    expect(seed.status).toBe(200);

    const bad = await post(`/v1/groups/${id}/members`, { add: ["dlna:d1"] });
    expect(bad.status).toBe(400);
    expect(getGroupManager().get(id)?.memberIds).toEqual(["sendspin:ROOM-A"]);
    expect(dbMemberIds(id)).toEqual(["sendspin:ROOM-A"]);

    // 未知前缀同样从 delta 口被拒。
    const bad2 = await post(`/v1/groups/${id}/members`, { add: ["foo:xxx"] });
    expect(bad2.status).toBe(400);
    expect(dbMemberIds(id)).toEqual(["sendspin:ROOM-A"]);
  });

  it("非数组/非字符串入参的现状口径:memberIds:\"abc\"/null 不触发成员写入,[123] → 400", async () => {
    const id = await createEmptyGroup("脏入参组");
    const seed = await put(`/v1/groups/${id}`, { memberIds: ["sendspin:ROOM-A"] });
    expect(seed.status).toBe(200);

    // PUT 只在 Array.isArray(body.memberIds) 时改成员(见 routes/api/groups.ts:59),
    // 所以字符串/null 是「不改成员」而非 500 —— 现状口径如实钉住。
    const strBody = await put(`/v1/groups/${id}`, { memberIds: "abc" });
    expect(strBody.status).toBe(200);
    expect(dbMemberIds(id)).toEqual(["sendspin:ROOM-A"]);

    const nullBody = await put(`/v1/groups/${id}`, { memberIds: null });
    expect(nullBody.status).toBe(200);
    expect(dbMemberIds(id)).toEqual(["sendspin:ROOM-A"]);

    // 数组里出现非字符串 → assertMembersAvailable 抛「成员必须是字符串 id」→ 400。
    const numBody = await put(`/v1/groups/${id}`, { memberIds: [123] });
    expect(numBody.status).toBe(400);
    expect(dbMemberIds(id)).toEqual(["sendspin:ROOM-A"]);
  });

  it("未知前缀 foo:xxx → 400,且错误文案不含「DLNA」(不得把未知命名空间误报成在加 DLNA 设备)", async () => {
    const id = await createEmptyGroup("未知命名空间文案组");
    const r = await put(`/v1/groups/${id}`, { memberIds: ["foo:xxx"] });
    expect(r.status).toBe(400);
    const msg = JSON.stringify(r.body ?? {});
    // 语义纠偏(2026-10-26):未知前缀不再落进 splitMemberId 的裸 id 兜底 ⇒ 不再报 DLNA 文案。
    expect(msg).not.toContain("DLNA");
    expect(msg).toContain("不是合法的群组成员");
    expect(dbMemberIds(id)).toEqual([]);
  });

  it("dlna:d1 → 400,且文案仍明确说「DLNA 设备不支持加入群组」(两种拒收文案必须可区分)", async () => {
    const id = await createEmptyGroup("DLNA文案组");
    const r = await put(`/v1/groups/${id}`, { memberIds: ["dlna:d1"] });
    expect(r.status).toBe(400);
    const msg = JSON.stringify(r.body ?? {});
    expect(msg).toContain("DLNA 设备不支持加入群组");
    expect(msg).not.toContain("不是合法的群组成员");
    expect(dbMemberIds(id)).toEqual([]);
  });
});

// ==================== O1 回归:历史 DLNA 成员不得让组被永久锁死 ====================
//
// 现状 bug(2026-10-26 实测):setMembers 校验**全量提交列表**、applyMemberDelta 校验
// **合并后的全量 kept**,而 assertMembersAvailable 对 `dlna:` 与历史裸 id 一律 throw ⇒
// 组里只要留着 1 个历史 DLNA 成员,「加减任何成员」都 400;有 ≥2 个时逐个删也清不干净
// (每次删都要提交一份仍含另一个 DLNA 成员的全量列表)⇒ 用户无法自救。
//
// 修法:两个入口都只校验**本次新出现的差集**(setMembers→newOnes,delta→added),
// 并显式补上「结构与重复」校验(改成只校验差集后,这两条会从全量口漏掉)。
//
// ⚠️ 历史 DLNA 成员**无法经 API 造出**(createGroup/setMembers 都拒):只能先正常建组,
//    再直写 `player_groups.memberIds` 造出「2026-10-24 之前落库的历史组」,然后
//    loadFromDb() 重载 GroupManager —— 只为测试造数据,**不给 src 加任何钩子**。

/** 把库里的成员改写成「历史数据」(含 dlna:/裸 id),并重载内存中的 GroupManager。 */
function seedLegacyMembers(groupId: string, memberIds: string[]): void {
  db.update(playerGroups)
    .set({ memberIds: JSON.stringify(memberIds) })
    .where(eq(playerGroups.id, groupId))
    .run();
  getGroupManager().loadFromDb(); // 与启动路径同一个装载函数,内存视图与库一致
}

describe("O1 历史 DLNA 成员不得锁死组(只校验差集)", () => {
  it("①含 1 个历史 DLNA 成员 → 能把它删掉(修前:提交任何仍含它的列表都 400)", async () => {
    const id = await createEmptyGroup("O1-一个历史DLNA");
    const seed = await put(`/v1/groups/${id}`, { memberIds: ["sendspin:ROOM-A"] });
    expect(seed.status).toBe(200);
    seedLegacyMembers(id, ["sendspin:ROOM-A", "dlna:legacy1"]);

    // 修前:前端勾选框把历史成员一并提交 ⇒ 全量校验看到 dlna: ⇒ 400,连「原样保存」都做不到。
    // 修后:该成员已在组内、不在差集里 ⇒ 不参与校验。
    const resubmit = await put(`/v1/groups/${id}`, {
      memberIds: ["sendspin:ROOM-A", "dlna:legacy1"],
    });
    expect(resubmit.status).toBe(200);
    expect(dbMemberIds(id)).toEqual(["sendspin:ROOM-A", "dlna:legacy1"]);

    // 真正把它删掉(历史成员可以从组里消失 = 用户能自救)。
    const r = await put(`/v1/groups/${id}`, { memberIds: ["sendspin:ROOM-A"] });
    expect(r.status).toBe(200);
    expect(r.body.group.memberIds).toEqual(["sendspin:ROOM-A"]);
    expect(dbMemberIds(id)).toEqual(["sendspin:ROOM-A"]);
  });

  it("②含 2 个历史 DLNA 成员 → 逐个删(增量口)能清空", async () => {
    const id = await createEmptyGroup("O1-两个历史DLNA");
    seedLegacyMembers(id, ["sendspin:ROOM-A", "dlna:legacy1", "dlna:legacy2"]);

    const first = await post(`/v1/groups/${id}/members`, { remove: ["dlna:legacy1"] });
    expect(first.status).toBe(200);
    expect(first.body.removed).toEqual(["dlna:legacy1"]);
    expect(getGroupManager().get(id)?.memberIds).toEqual(["sendspin:ROOM-A", "dlna:legacy2"]);

    const second = await post(`/v1/groups/${id}/members`, { remove: ["dlna:legacy2"] });
    expect(second.status).toBe(200);
    expect(second.body.removed).toEqual(["dlna:legacy2"]);
    expect(dbMemberIds(id)).toEqual(["sendspin:ROOM-A"]);

    // 清干净之后仍能正常清空全组(空数组不是非法成员)。
    const clear = await put(`/v1/groups/${id}`, { memberIds: [] });
    expect(clear.status).toBe(200);
    expect(dbMemberIds(id)).toEqual([]);
  });

  it("③历史 DLNA 删干净后能加 airplay: / sendspin:(不再被历史数据连坐)", async () => {
    const id = await createEmptyGroup("O1-清空后加合法成员");
    seedLegacyMembers(id, ["dlna:legacy1"]);

    const dropped = await put(`/v1/groups/${id}`, { memberIds: [] });
    expect(dropped.status).toBe(200);
    expect(dbMemberIds(id)).toEqual([]);

    const submitted = ["airplay:ap-member-1", "sendspin:ROOM-B"];
    const added = await put(`/v1/groups/${id}`, { memberIds: submitted });
    expect(added.status).toBe(200);
    expect(added.body.group.memberIds).toEqual(submitted);
    expect(dbMemberIds(id)).toEqual(submitted);
  });

  it("④含历史 DLNA 的组仍能加合法成员(全量口与增量口都不再锁死)", async () => {
    const id = await createEmptyGroup("O1-含历史DLNA仍可加");
    seedLegacyMembers(id, ["dlna:legacy1"]);

    // 增量口:加一个合法的 sendspin 成员。
    const delta = await post(`/v1/groups/${id}/members`, { add: ["sendspin:ROOM-B"] });
    expect(delta.status).toBe(200);
    expect(delta.body.added).toEqual(["sendspin:ROOM-B"]);
    expect(getGroupManager().get(id)?.memberIds).toEqual(["dlna:legacy1", "sendspin:ROOM-B"]);

    // 全量口:保留历史成员 + 新增合法 airplay 成员。
    const full = await put(`/v1/groups/${id}`, {
      memberIds: ["dlna:legacy1", "airplay:ap-member-1", "sendspin:ROOM-B"],
    });
    expect(full.status).toBe(200);
    expect(dbMemberIds(id)).toEqual(["dlna:legacy1", "airplay:ap-member-1", "sendspin:ROOM-B"]);
  });

  it("⑤含历史 DLNA 的组里 add:[\"dlna:x\"] 仍必须 400(放宽只针对既有成员,不放宽新增)", async () => {
    const id = await createEmptyGroup("O1-新增仍拒收");
    seedLegacyMembers(id, ["dlna:legacy1"]);

    const dlna = await post(`/v1/groups/${id}/members`, { add: ["dlna:x"] });
    expect(dlna.status).toBe(400);
    expect(JSON.stringify(dlna.body ?? {})).toContain("DLNA 设备不支持加入群组");

    // 其余非法命名空间同样从增量口被拒(锚点:放宽差集不得连带放宽 kind allowlist)。
    const unknown = await post(`/v1/groups/${id}/members`, { add: ["foo:xxx"] });
    expect(unknown.status).toBe(400);
    const nested = await post(`/v1/groups/${id}/members`, { add: ["group:other"] });
    expect(nested.status).toBe(400);
    const local = await post(`/v1/groups/${id}/members`, { add: ["local:u1"] });
    expect(local.status).toBe(400);

    // 全量口同样:新提交里出现 dlna: 一律 400,且历史成员不受影响(拒绝无损)。
    const fullDlna = await put(`/v1/groups/${id}`, { memberIds: ["dlna:legacy1", "dlna:brand-new"] });
    expect(fullDlna.status).toBe(400);

    expect(getGroupManager().get(id)?.memberIds).toEqual(["dlna:legacy1"]);
    expect(dbMemberIds(id)).toEqual(["dlna:legacy1"]);
  });

  it("差集校验不得漏掉「已在组内的成员被重复提交」→ 400(修 O1 时必须显式补上)", async () => {
    const id = await createEmptyGroup("O1-重复提交已有成员");
    const seed = await put(`/v1/groups/${id}`, { memberIds: ["sendspin:ROOM-A"] });
    expect(seed.status).toBe(200);

    // "sendspin:ROOM-A" 已在组内 ⇒ 不进差集;若不显式校验重复,这里会被静默接受。
    const dup = await put(`/v1/groups/${id}`, {
      memberIds: ["sendspin:ROOM-A", "sendspin:ROOM-A"],
    });
    expect(dup.status).toBe(400);
    expect(JSON.stringify(dup.body ?? {})).toContain("成员列表不能重复");
    expect(dbMemberIds(id)).toEqual(["sendspin:ROOM-A"]);

    // 含历史 DLNA 成员时同理:已在组内的合法成员重复提交也必须 400。
    seedLegacyMembers(id, ["sendspin:ROOM-A", "dlna:legacy1"]);
    const dup2 = await put(`/v1/groups/${id}`, {
      memberIds: ["sendspin:ROOM-A", "sendspin:ROOM-A", "dlna:legacy1"],
    });
    expect(dup2.status).toBe(400);
    expect(dbMemberIds(id)).toEqual(["sendspin:ROOM-A", "dlna:legacy1"]);
  });
});
