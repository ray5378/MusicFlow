/**
 * D2 验收:删除用户时,用户私有状态与凭据必须一并清理,不留孤儿行。
 *
 * 原实现只清 6 张表,留下 10 张表的孤儿行;其中 player_webhook_tokens 是
 * **可用凭据** —— 已删用户的 token 仍能通过校验(越权面)。
 *
 * 明确不动:player_groups(共享播放资源),本文件反向断言其**不被**删除。
 *
 * 注意:仓库配置 sequence.shuffle = true(用例顺序被打乱),因此每条用例
 * 必须自带完整的「造数据 → 动作 → 断言」,不能跨用例共享状态。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import md5 from "md5";

import { initDatabase, db, sqlite, encryptPassword } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { authMiddleware } from "../../src/middleware/auth.js";
import { registerUsers } from "../../src/routes/api/users.js";
import { createPlayerWebhookToken, validatePlayerWebhookToken } from "../../src/services/player/playerWebhook.js";

const app = new Hono();
app.use("/rest/api/*", authMiddleware);
const api = new Hono();
registerUsers(api);
app.route("/rest/api", api);

const PLAIN = "hunter2";
const SALT = "clientsalt123";

async function call(method: string, path: string, body?: unknown) {
  const qs = `${path.includes("?") ? "&" : "?"}u=alice&t=${md5(PLAIN + SALT)}&s=${SALT}`;
  const res = await app.request(`/rest/api${path}${qs}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** 待清理表:[表名, 用户列名]。 */
const USER_TABLES: [string, string][] = [
  ["user_permissions", "user_id"],
  ["user_renderer_grants", "user_id"],
  ["player_prefs", "owner_user_id"],
  ["player_name_overrides", "owner_user_id"],
  ["player_webhook_tokens", "owner_user_id"],
  ["user_ratings", "user_id"],
  ["user_play_queues", "user_id"],
  ["local_queues", "user_id"],
  ["recommend_pool", "user_id"],
  ["flows", "owner_user_id"],
];

function countFor(table: string, col: string, userId: string): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${col} = ?`).get(userId) as any).c;
}

/**
 * 按 PRAGMA 元信息补全 NOT NULL 列,避免为每张表写死列清单
 * (表结构演进时本测试不需要跟着改)。
 */
function seedRow(table: string, userCol: string, userId: string, extra: Record<string, unknown> = {}): void {
  const info = sqlite.prepare(`PRAGMA table_info(${table})`).all() as any[];
  const values: Record<string, unknown> = { [userCol]: userId, ...extra };
  for (const c of info) {
    if (c.name in values) continue;
    // INTEGER PRIMARY KEY 是 rowid 别名,必须给数字(给字符串会 "datatype mismatch")
    if (c.pk > 0) {
      values[c.name] = /INT/.test(String(c.type || "").toUpperCase()) ? 1 : `pk-${c.name}`;
      continue;
    }
    if (c.notnull === 1 && c.dflt_value === null) {
      const t = String(c.type || "").toUpperCase();
      values[c.name] = /INT|REAL|NUM|BOOL/.test(t) ? 1 : `x-${c.name}`;
    }
  }
  const names = Object.keys(values);
  sqlite.prepare(
    `INSERT INTO ${table} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`,
  ).run(...names.map((n) => values[n]));
}

function makeUser(id: string, username: string): void {
  if (!sqlite.prepare("SELECT 1 FROM users WHERE id = ?").get(id)) {
    db.insert(users).values({
      id, username, password: "", salt: "s", subsonicSalt: `${username}salt`, isActive: 1,
    }).run();
  }
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  if (!sqlite.prepare("SELECT 1 FROM users WHERE id = 'u1'").get()) {
    db.insert(users).values({
      id: "u1", username: "alice", password: "", salt: "s", subsonicSalt: SALT,
      passEnc: encryptPassword(PLAIN), isAdmin: 1, isActive: 1,
    }).run();
  }
});

describe("DELETE /v1/users/:id 清理用户私有状态与凭据", () => {
  it("造满 10 张表的行 + 一条可用 token → 删除后全部归零、token 立即失效、用户行消失", async () => {
    const UID = "u-orphan";
    makeUser(UID, "orphan");

    for (const [table, col] of USER_TABLES) {
      if (table === "player_webhook_tokens") continue; // 用真实 API 建,拿到可校验的 token
      seedRow(table, col, UID);
    }
    const token = createPlayerWebhookToken(UID, "HA 自动化");

    // —— 删除前基线:每张表都有行,凭据可用 ——
    for (const [table, col] of USER_TABLES) {
      expect(countFor(table, col, UID), `${table} 基线为空`).toBeGreaterThan(0);
    }
    expect(validatePlayerWebhookToken(token)).toEqual({ ownerUserId: UID });

    // —— 动作 ——
    const r = await call("DELETE", `/v1/users/${UID}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true });

    // —— 删除后:一张表都不能留孤儿行 ——
    for (const [table, col] of USER_TABLES) {
      expect(countFor(table, col, UID), `${table} 仍有孤儿行`).toBe(0);
    }
    expect(validatePlayerWebhookToken(token)).toBeUndefined();
    expect(sqlite.prepare("SELECT id FROM users WHERE id = ?").get(UID)).toBeUndefined();
    // 其它用户不受影响
    expect(sqlite.prepare("SELECT id FROM users WHERE id = 'u1'").get()).toBeTruthy();
  });

  it("共享播放资源 player_groups 不被连带删除(设计决策)", async () => {
    const UID = "u-groupowner";
    makeUser(UID, "groupowner");
    seedRow("player_groups", "owner_user_id", UID, { name: "客厅群组" });
    expect(countFor("player_groups", "owner_user_id", UID)).toBeGreaterThan(0);

    const r = await call("DELETE", `/v1/users/${UID}`);
    expect(r.status).toBe(200);
    expect(countFor("player_groups", "owner_user_id", UID)).toBeGreaterThan(0);
    // 用户行本身仍然删掉了
    expect(sqlite.prepare("SELECT id FROM users WHERE id = ?").get(UID)).toBeUndefined();
  });
});
