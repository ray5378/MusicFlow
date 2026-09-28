// MUST be the first import:隔离 DATA_DIR 后再加载后端模块。
import "../plugins/_env.js";

// 两个「按所有者/授权」判权的路由域残余未覆盖行补测:
//   routes/api/groups.ts 42-43 / 79-80 / 100-101 —— 非所有者(非管理员)访问他人组一律 404
//   routes/api/groups.ts 66-67                    —— PUT 全量替换成员非法成员名 → 400
//   routes/api/play.ts   38-39                    —— 无该设备授权的投放 → 403
//   routes/api/play.ts   46-47                    —— 拒绝向本机 web 播放器投放 → 403
//   routes/api/play.ts   102-105                  —— playMode 透传到 local/ cast 播放器
//
// 为什么必须用**真实**鉴权与真实 peer 单例:这些行全部是"谁能不能动这台播放器"的
// 安全边界。若把 canControlPeer / pm 换成假体,测的就只是"假体被调用了",而不是
// 真实授权链是否拦住越权。这里 bob 是真账号(带 renderer.use)、真注册本机 peer。
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import md5 from "md5";

import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users, userPermissions, songs } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../../src/middleware/auth.js";
import { apiRoutes } from "../../src/routes/api/index.js";
import { generateToken } from "../../src/utils/auth.js";
import { invalidateAccessCaches, PERM } from "../../src/services/access.js";
import { getGroupManager } from "../../src/services/group/index.js";
import { pm } from "../../src/routes/api/shared.js";

const app = new Hono();
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);

const ADMIN_PLAIN = "hunter2";
const ADMIN_SALT = "clientsalt123";
const adminQS = () => `u=alice&t=${md5(ADMIN_PLAIN + ADMIN_SALT)}&s=${ADMIN_SALT}`;

type Any = any;

async function req(method: string, path: string, opts: { qs?: string; token?: string; body?: unknown } = {}) {
  const qs = opts.qs ? `?${opts.qs}` : "";
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await app.request(`/rest/api${path}${qs}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let parsed: Any = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: res.status, body: parsed };
}

let bobId = "";
let bobToken = "";

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  if (!db.select().from(users).where(eq(users.username, "alice")).get()) {
    db.insert(users).values({
      id: "u1", username: "alice", password: "", salt: "salt", subsonicSalt: "subsalt",
      passEnc: encryptPassword(ADMIN_PLAIN), isAdmin: 1, isActive: 1, email: "a@b.c",
    }).run();
  }
});

beforeEach(() => {
  bobId = uuidv4();
  db.insert(users).values({
    id: bobId, username: `bob-${bobId.slice(0, 8)}`, password: "", salt: "salt", subsonicSalt: "subsalt",
    passEnc: encryptPassword("pw"), isAdmin: 0, isActive: 1, email: "",
  }).run();
  // 只给 renderer.use:让第一层 permMiddleware 放行,
  // 这样 404/403 只可能来自"所有者判定 / 设备授权",而不是把权限门测成同一个东西。
  db.insert(userPermissions).values({ userId: bobId, permKey: PERM.RENDERER_USE, granted: 1, updatedAt: "" }).run();
  invalidateAccessCaches(bobId);
  bobToken = generateToken(bobId, "bob", false);
});

afterEach(async () => {
  vi.restoreAllMocks();
  // 用管理端删除口收尾:它会**显式清理**该用户的私有状态(local_queues / player_prefs /
  // 授权…)。直接 delete(users) 会撞 FK(localPlayFrom 落过队列行) —— 那不是测试想验的东西。
  await req("DELETE", `/v1/users/${bobId}`, { qs: adminQS() });
  db.delete(userPermissions).where(eq(userPermissions.userId, bobId)).run();
  db.delete(users).where(eq(users.id, bobId)).run();
});

// ==================== groups 所有权 ====================

describe("groups: 非所有者访问他人组", () => {
  it("PUT / POST-members / DELETE 对他人组一律 404(不泄漏组是否存在)", async () => {
    // 契约:404 notFoundOrNoPerm —— 用 404 而不是 403,避免把"这个 id 存在"这个
    // 事实泄漏给无权者(枚举攻击面)。三条写入口必须一致。
    const created = await req("POST", "/v1/groups", { qs: adminQS(), body: { name: "alice 的组", memberIds: ["sendspin:ROOM-A"] } });
    expect(created.status).toBe(201);
    const gid = created.body.group.id as string;

    const put = await req("PUT", `/v1/groups/${gid}`, { token: bobToken, body: { name: "改我" } });
    expect(put.status).toBe(404);
    expect(put.body).toMatchObject({ success: false, code: "NOT_FOUND" });

    const post = await req("POST", `/v1/groups/${gid}/members`, { token: bobToken, body: { add: ["sendspin:X"] } });
    expect(post.status).toBe(404);
    expect(post.body).toMatchObject({ success: false, code: "NOT_FOUND" });

    const del = await req("DELETE", `/v1/groups/${gid}`, { token: bobToken });
    expect(del.status).toBe(404);
    expect(del.body).toMatchObject({ success: false, code: "NOT_FOUND" });

    // 关键:越权尝试之后组必须**原样还在**(403/404 只是回执,不能顺手改掉了)
    expect(getGroupManager().get(gid)?.name).toBe("alice 的组");

    getGroupManager().deleteGroup(gid);
  });

  it("PUT 全量替换含非法成员名 → 400 + INVALID_PARAM", async () => {
    // 契约:成员名的 kind 前缀必须在允许集合内,非法值由 setMembers 抛错,
    // 路由把它收成 400(参数问题),而不是 500(服务异常)。
    const created = await req("POST", "/v1/groups", { qs: adminQS(), body: { name: "校验组" } });
    const gid = created.body.group.id as string;

    const r = await req("PUT", `/v1/groups/${gid}`, { qs: adminQS(), body: { memberIds: ["group:not-allowed"] } });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ success: false, code: "INVALID_PARAM" });

    getGroupManager().deleteGroup(gid);
  });
});

// ==================== play 层判权 ====================

describe("/v1/play: 细粒度授权与 web 兜底", () => {
  /** 注册当前用户的某个本机实例,返回对外掩码 peerId。 */
  async function registerLocal(clientId: string, platform: string): Promise<string> {
    const r = await req("POST", "/v1/peers/register", {
      token: bobToken,
      body: { name: "我的机器", clientId, platform },
    });
    expect(r.status).toBe(200);
    return r.body.peer.peerId as string;
  }

  function ensureSong(): string {
    const id = "s-lt2-play-1";
    db.delete(songs).where(eq(songs.id, id)).run();
    db.insert(songs).values({ id, title: "测试曲", artist: "A", duration: 200, path: "l:src:/x.mp3" }).run();
    return id;
  }

  it("投放未授权的 DLNA 设备 → 403(不是 400,不是静默成功)", async () => {
    const songId = ensureSong();
    const r = await req("POST", "/v1/play", {
      token: bobToken,
      body: { peerId: "dlna:not-granted-dev", type: "song", id: songId },
    });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ success: false, code: "FORBIDDEN" });
  });

  it("向本机 web 播放器投放 → 403(方案收敛后 web 不再是被控端)", async () => {
    // 契约:web 播放器的 peer 仍可能被缓存直呼,必须在服务端兜底拒绝。
    const songId = ensureSong();
    const webPeerId = await registerLocal("lt2-web-1", "web");
    const r = await req("POST", "/v1/play", {
      token: bobToken,
      body: { peerId: webPeerId, type: "song", id: songId },
    });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ success: false, code: "FORBIDDEN" });
  });

  it("本机 android 实例:playMode 透传到播放器;回执 peerId 为掩码形式", async () => {
    // 契约:playMode 由服务端统一下发(客户端不再自行洗牌),回执不得泄漏真实 clientId。
    const songId = ensureSong();
    const androidPeerId = await registerLocal("lt2-android-1", "android");

    const spy = vi.spyOn(pm, "localSetPlayMode").mockImplementation(() => undefined);
    const r = await req("POST", "/v1/play", {
      token: bobToken,
      body: { peerId: androidPeerId, type: "song", id: songId, playMode: "shuffle" },
    });

    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toBe("shuffle");
    // 回执是对外掩码:不得出现真实 clientId 段
    expect(typeof r.body.peerId).toBe("string");
    expect(r.body.peerId.startsWith("local:")).toBe(true);
  });

  it("非法 playMode 被忽略(不改变播放器模式)", async () => {
    const songId = ensureSong();
    const androidPeerId = await registerLocal("lt2-android-2", "android");
    const spy = vi.spyOn(pm, "localSetPlayMode").mockImplementation(() => undefined);
    const r = await req("POST", "/v1/play", {
      token: bobToken,
      body: { peerId: androidPeerId, type: "song", id: songId, playMode: "bogus-mode" },
    });
    expect(r.status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
  });
});
