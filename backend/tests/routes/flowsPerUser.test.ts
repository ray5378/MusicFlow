// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Hono } from "hono";
import md5 from "md5";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users, flows, playerWebhookTokens } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../../src/middleware/auth.js";
import { apiRoutes } from "../../src/routes/api/index.js";
import { PERM, setUserPermission } from "../../src/services/access.js";

// 音流按用户划分:普通用户(有 flow.manage 权限)只能创建/查看/修改/删除/触发
// 自己名下的音流,且只能绑定自己的「通用播放器控制」渠道 token;管理员可见全部。
const app = new Hono();
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);

const PW: Record<string, string> = { alice: "alicepass", bob: "bobpass", root: "rootpass" };
const SALT = "clientsalt123";
const authQS = (u: string) => "u=" + u + "&t=" + md5(PW[u] + SALT) + "&s=" + SALT;

const U = { alice: "u-alice", bob: "u-bob", root: "u-root" };

function seedUser(id: string, username: string, isAdmin: number) {
  if (db.select().from(users).where(eq(users.username, username)).get()) return;
  db.insert(users).values({
    id, username, password: "", salt: "salt", subsonicSalt: "subsalt",
    passEnc: encryptPassword(PW[username]), isAdmin, isActive: 1, email: username + "@x.y",
  }).run();
  // 非管理员也要有音流管理功能权限才能进音流页面/接口。
  if (!isAdmin) setUserPermission(id, PERM.FLOW_MANAGE, true);
}

function seedToken(id: string, name: string, token: string, ownerUserId: string) {
  db.insert(playerWebhookTokens)
    .values({ id, name, token, enabled: 1, ownerUserId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    .run();
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  seedUser(U.root, "root", 1);
  seedUser(U.alice, "alice", 0);
  seedUser(U.bob, "bob", 0);
});

beforeEach(() => {
  db.delete(flows).run();
  db.delete(playerWebhookTokens).run();
  seedToken("tok-alice", "alice-token", "TOKEN_A", U.alice);
  seedToken("tok-bob", "bob-token", "TOKEN_B", U.bob);
  seedToken("tok-root", "root-token", "TOKEN_R", U.root);
});

async function createFlowAs(u: string, name: string, tokenId?: string) {
  const res = await app.request("/rest/api/v1/flows?" + authQS(u), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(tokenId === undefined ? { name } : { name, tokenId }),
  });
  return { res, body: await res.json().catch(() => null) };
}

describe("音流按用户划分(读写隔离)", () => {
  it("alice 创建音流:归属自己,自动绑定自己的启用渠道 token,列表仅见自己的", async () => {
    const { res, body } = await createFlowAs("alice", "alice-flow");
    expect(res.status).toBe(200);
    expect(body.flow.ownerUserId).toBe(U.alice);
    expect(body.flow.tokenId).toBe("tok-alice");
    expect(body.flow.webhookUrl).toContain("TOKEN_A");

    const list = await (await app.request("/rest/api/v1/flows?" + authQS("alice"))).json();
    expect(list.total).toBe(1);
    expect(list.items[0].name).toBe("alice-flow");
  });

  it("bob 看不到也动不了 alice 的音流(list 为空,get/put/delete/run 均 404)", async () => {
    const { body } = await createFlowAs("alice", "alice-flow");
    const id = body.flow.id;

    const list = await (await app.request("/rest/api/v1/flows?" + authQS("bob"))).json();
    expect(list.total).toBe(0);

    const get = await app.request("/rest/api/v1/flows/" + id + "?" + authQS("bob"));
    expect(get.status).toBe(404);

    const put = await app.request("/rest/api/v1/flows/" + id + "?" + authQS("bob"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "hacked" }),
    });
    expect(put.status).toBe(404);

    const del = await app.request("/rest/api/v1/flows/" + id + "?" + authQS("bob"), { method: "DELETE" });
    expect(del.status).toBe(404);

    const run = await app.request("/rest/api/v1/flows/" + id + "/run?" + authQS("bob"), { method: "POST" });
    expect(run.status).toBe(404);

    // 音流仍然属于 alice(未被误删/改名)。
    const own = await (await app.request("/rest/api/v1/flows/" + id + "?" + authQS("alice"))).json();
    expect(own.flow.name).toBe("alice-flow");
  });

  it("bob 不能绑定 alice 的渠道 token(403);缺省也只能绑到自己的", async () => {
    const bad = await createFlowAs("bob", "bad-bind", "tok-alice");
    expect(bad.res.status).toBe(403);

    const { body } = await createFlowAs("bob", "bob-flow");
    expect(body.flow.tokenId).toBe("tok-bob");
  });

  it("管理员可见全部音流并可读取任意用户的音流", async () => {
    const { body } = await createFlowAs("alice", "alice-flow");

    const list = await (await app.request("/rest/api/v1/flows?" + authQS("root"))).json();
    expect(list.total).toBe(1);
    expect(list.items[0].ownerUserId).toBe(U.alice);

    const get = await app.request("/rest/api/v1/flows/" + body.flow.id + "?" + authQS("root"));
    expect(get.status).toBe(200);
  });
});

describe("player-webhook 渠道 token 按归属隔离", () => {
  it("bob 只看到自己的 token(看不到他人 token 值),且不能操作 alice 的", async () => {
    const list = await (await app.request("/rest/api/v1/player-webhook/tokens?" + authQS("bob"))).json();
    expect(list.items.length).toBe(1);
    expect(list.items[0].id).toBe("tok-bob");
    expect(JSON.stringify(list.items)).not.toContain("TOKEN_A");
    expect(JSON.stringify(list.items)).not.toContain("TOKEN_R");

    const put = await app.request("/rest/api/v1/player-webhook/tokens/tok-alice?" + authQS("bob"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(put.status).toBe(404);

    const del = await app.request("/rest/api/v1/player-webhook/tokens/tok-alice?" + authQS("bob"), { method: "DELETE" });
    expect(del.status).toBe(404);

    // alice 的 token 仍是启用状态(未被 bob 破坏)。
    const aliceList = await (await app.request("/rest/api/v1/player-webhook/tokens?" + authQS("alice"))).json();
    expect(aliceList.items[0].id).toBe("tok-alice");
    expect(aliceList.items[0].enabled).toBe(true);
  });

  it("alice 可管理自己的 token;管理员可见全部", async () => {
    const aliceList = await (await app.request("/rest/api/v1/player-webhook/tokens?" + authQS("alice"))).json();
    expect(aliceList.items.length).toBe(1);
    expect(aliceList.items[0].token).toBe("TOKEN_A");

    const rootList = await (await app.request("/rest/api/v1/player-webhook/tokens?" + authQS("root"))).json();
    expect(rootList.items.length).toBe(3);
  });
});
