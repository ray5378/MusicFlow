// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import md5 from "md5";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users, playlists } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../../src/middleware/auth.js";
import { apiRoutes } from "../../src/routes/api/index.js";

const app = new Hono();
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);

const PLAIN = "hunter2";
const CLIENT_SALT = "clientsalt123";
const authQS = () => `u=alice&t=${md5(PLAIN + CLIENT_SALT)}&s=${CLIENT_SALT}`;

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  if (!db.select().from(users).where(eq(users.username, "alice")).get()) {
    db.insert(users).values({ id: "u1", username: "alice", password: "", salt: "salt", subsonicSalt: "subsalt", passEnc: encryptPassword(PLAIN), isAdmin: 1, isActive: 1, email: "a@b.c" }).run();
  }
  // 三张无每日推荐标签的普通歌单,createdAt 各不相同,用于校验排序。
  db.delete(playlists).where(eq(playlists.ownerId, "u1")).run();
  db.insert(playlists).values([
    { id: "sort-c", name: "C 年中", ownerId: "u1", createdAt: "2024-06-15T10:00:00.000Z", updatedAt: "2024-06-15T10:00:00.000Z" },
    { id: "sort-a", name: "A 最早", ownerId: "u1", createdAt: "2023-01-10T08:30:00.000Z", updatedAt: "2023-01-10T08:30:00.000Z" },
    { id: "sort-b", name: "B 最新", ownerId: "u1", createdAt: "2025-03-20T12:45:00.000Z", updatedAt: "2025-03-20T12:45:00.000Z" },
  ]).run();
});

async function listWithSort(sort?: string) {
  const qs = sort ? `${authQS()}&sort=${sort}` : authQS();
  const res = await app.request(`/rest/api/v1/playlists?${qs}`);
  return (await res.json()) as { items: { id: string; created: string }[] };
}

describe("GET /v1/playlists?sort= (歌单排序)", () => {
  it("sort=created_asc 按创建时间升序(最早在前)", async () => {
    const { items } = await listWithSort("created_asc");
    const created = items.map((i) => i.created);
    expect(created).toEqual([...created].sort()); // 升序
    expect(items[0].id).toBe("sort-a"); // 2023 最早
    expect(items[items.length - 1].id).toBe("sort-b"); // 2025 最新
  });

  it("sort=created_desc 按创建时间降序(最新在前)", async () => {
    const { items } = await listWithSort("created_desc");
    expect(items[0].id).toBe("sort-b"); // 2025 最新
    expect(items[items.length - 1].id).toBe("sort-a"); // 2023 最早
  });

  it("created_desc 与 created_asc 完全逆序", async () => {
    const asc = (await listWithSort("created_asc")).items.map((i) => i.id);
    const desc = (await listWithSort("created_desc")).items.map((i) => i.id);
    expect(desc).toEqual([...asc].reverse());
  });

  it("未知 sort 值回退默认(不抛错,仍返回歌单)", async () => {
    const { items } = await listWithSort("bogus_value");
    expect(items.length).toBeGreaterThanOrEqual(3);
  });
});
