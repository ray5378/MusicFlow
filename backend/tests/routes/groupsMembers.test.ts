// 群组成员增量口:POST /v1/groups/:id/members 原子加减(幂等、无读写竞态)。
// sendspin 成员只验格式(可离线建组),对齐钩子在无服务时静默 no-op。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import md5 from "md5";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../../src/middleware/auth.js";
import { apiRoutes } from "../../src/routes/api/index.js";
import { getGroupManager } from "../../src/services/group/index.js";

const app = new Hono();
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);

const PLAIN = "hunter2";
const CLIENT_SALT = "clientsalt123";
const authQS = () => `u=alice&t=${md5(PLAIN + CLIENT_SALT)}&s=${CLIENT_SALT}`;

async function post(path: string, body: unknown) {
  const res = await app.request(`/rest/api${path}?${authQS()}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function put(path: string, body: unknown) {
  const res = await app.request(`/rest/api${path}?${authQS()}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("groups members 增量口", () => {
  beforeAll(() => {
    if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
    initDatabase();
    if (!db.select().from(users).where(eq(users.username, "alice")).get()) {
      db.insert(users).values({ id: "u1", username: "alice", password: "", salt: "salt", subsonicSalt: "subsalt", passEnc: encryptPassword(PLAIN), isAdmin: 1, isActive: 1, email: "a@b.c" }).run();
    }
  });

  it("建组→增量加→幂等→摘除,added/removed 如实回报", async () => {
    const created = await post("/v1/groups", { name: "多房间", memberIds: ["sendspin:ROOM-A"] });
    expect(created.status).toBe(201);
    const id = created.body.group.id as string;

    // 增量加(含已在组内的 → no-op 不重复)
    const r1 = await post(`/v1/groups/${id}/members`, { add: ["sendspin:ROOM-B", "sendspin:ROOM-A"] });
    expect(r1.status).toBe(200);
    expect(r1.body.added).toEqual(["sendspin:ROOM-B"]);
    expect(r1.body.removed).toEqual([]);
    expect(r1.body.group.memberIds).toEqual(["sendspin:ROOM-A", "sendspin:ROOM-B"]);

    // 幂等重放:已在组内的 add 返回空
    const r2 = await post(`/v1/groups/${id}/members`, { add: ["sendspin:ROOM-B"] });
    expect(r2.status).toBe(200);
    expect(r2.body.added).toEqual([]);

    // 摘除(含不在组内的 → no-op)
    const r3 = await post(`/v1/groups/${id}/members`, { remove: ["sendspin:ROOM-A", "sendspin:NOBODY"] });
    expect(r3.status).toBe(200);
    expect(r3.body.removed).toEqual(["sendspin:ROOM-A"]);
    expect(getGroupManager().get(id)?.memberIds).toEqual(["sendspin:ROOM-B"]);
  });

  it("非法成员 400,未知组 404", async () => {
    const created = await post("/v1/groups", { name: "校验组" });
    expect(created.status).toBe(201);
    const id = created.body.group.id as string;

    const bad = await post(`/v1/groups/${id}/members`, { add: ["group:xxx"] });
    expect(bad.status).toBe(400);

    const missing = await post("/v1/groups/no-such-id/members", { add: ["sendspin:X"] });
    expect(missing.status).toBe(404);
  });

  it("PUT 全量替换仍精确生效(含顺序),与增量口共存", async () => {
    const created = await post("/v1/groups", { name: "兼容组", memberIds: ["sendspin:A"] });
    const id = created.body.group.id as string;
    const r = await put(`/v1/groups/${id}`, { memberIds: ["sendspin:B", "sendspin:A"] });
    expect(r.status).toBe(200);
    // PUT 保留提交顺序(leader 语义),不是 append
    expect(getGroupManager().get(id)?.memberIds).toEqual(["sendspin:B", "sendspin:A"]);
  });
});
