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

// 音流对外链接的 token 保护:新建/编辑音流时须绑定「通用播放器控制」渠道 token,
// 对外链接由后端基于该 token 生成;token 缺失或停用时链接为空。
const app = new Hono();
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);

const PLAIN = "hunter2";
const CLIENT_SALT = "clientsalt123";
const authQS = () => "u=alice&t=" + md5(PLAIN + CLIENT_SALT) + "&s=" + CLIENT_SALT;

function seedUser() {
  if (db.select().from(users).where(eq(users.username, "alice")).get()) return;
  db.insert(users).values({ id: "u1", username: "alice", password: "", salt: "salt", subsonicSalt: "subsalt", passEnc: encryptPassword(PLAIN), isAdmin: 1, isActive: 1, email: "a@b.c" }).run();
}

function seedToken(id: string, name: string, token: string, enabled: number, createdAt: string) {
  db.insert(playerWebhookTokens).values({ id, name, token, enabled, ownerUserId: "u1", createdAt, updatedAt: createdAt }).run();
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  seedUser();
});

beforeEach(() => {
  db.delete(flows).run();
  db.delete(playerWebhookTokens).run();
  seedToken("tok-a", "ke-ting", "TOKEN_A", 1, "2024-01-01T00:00:00.000Z");
  seedToken("tok-b", "shu-fang", "TOKEN_B", 1, "2024-01-02T00:00:00.000Z");
});

async function createFlow(name: string, tokenId?: string) {
  const res = await app.request("/rest/api/v1/flows?" + authQS(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(tokenId === undefined ? { name } : { name, tokenId }),
  });
  return { res, body: await res.json().catch(() => null) };
}

const flowUrl = (id: string) => "/rest/api/v1/flows/" + id + "?" + authQS();

describe("音流对外链接渠道 token 保护", () => {
  it("指定 tokenId 新建:对外链接携带该 token 值", async () => {
    const { res, body } = await createFlow("my-flow", "tok-a");
    expect(res.status).toBe(200);
    expect(body.flow.tokenId).toBe("tok-a");
    expect(body.flow.tokenName).toBe("ke-ting");
    expect(body.flow.webhookUrl).toContain("/webhooks/flows/" + body.flow.id);
    expect(body.flow.webhookUrl).toContain("token=" + encodeURIComponent("TOKEN_A"));
  });

  it("未指定 tokenId 新建:自动绑定第一个启用渠道 token", async () => {
    const { body } = await createFlow("auto-bind");
    expect(body.flow.tokenId).toBe("tok-a");
    expect(body.flow.webhookUrl).toContain("TOKEN_A");
  });

  it("PUT 改绑渠道 token:对外链接随之切换", async () => {
    const { body } = await createFlow("rebind", "tok-a");
    const res = await app.request(flowUrl(body.flow.id), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokenId: "tok-b" }),
    });
    const up = await res.json();
    expect(up.flow.tokenId).toBe("tok-b");
    expect(up.flow.tokenName).toBe("shu-fang");
    expect(up.flow.webhookUrl).toContain("TOKEN_B");
    expect(up.flow.webhookUrl).not.toContain("TOKEN_A");
  });

  it("指定不存在的 tokenId 新建被拒绝", async () => {
    const { res } = await createFlow("bad-token", "tok-nope");
    expect(res.status).toBe(400);
  });
});

describe("token 有效性对对外链接的影响", () => {
  it("绑定的 token 停用后,对外链接为空(不可用)", async () => {
    const { body } = await createFlow("disable-link", "tok-a");
    expect(body.flow.webhookUrl).toContain("TOKEN_A");
    await db.update(playerWebhookTokens).set({ enabled: 0 }).where(eq(playerWebhookTokens.id, "tok-a")).run();
    const res = await app.request(flowUrl(body.flow.id));
    const detail = await res.json();
    expect(detail.flow.tokenId).toBe("tok-a");
    expect(detail.flow.webhookUrl).toBe("");
  });

  it("未绑定 token 的音流对外链接为空", async () => {
    const { body } = await createFlow("no-bind", "tok-a");
    await app.request(flowUrl(body.flow.id), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokenId: "" }),
    });
    const res = await app.request(flowUrl(body.flow.id));
    const detail = await res.json();
    expect(detail.flow.webhookUrl).toBe("");
  });
});