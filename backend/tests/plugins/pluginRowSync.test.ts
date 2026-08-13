// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Hono } from "hono";
import md5 from "md5";
import { db, initDatabase, encryptPassword, sqlite } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../../src/middleware/auth.js";
import { apiRoutes } from "../../src/routes/api/index.js";
import { registerPlugin, unregisterPlugin } from "../../src/plugins/registry.js";
import { syncPluginRowAfterInstall } from "../../src/plugins/registryCatalog.js";

// 修复:升级 go-music-dl 1.2.3 → 1.2.4 提示成功但插件页仍显示旧版本的根因——
// ① installPlugin 未 reload(内存不覆盖)、② 外置插件 DB 行不随升级刷新。
// 覆盖:syncPluginRowAfterInstall 同步 DB 行 + GET /v1/plugins 以 registry 为准返回版本。
// 测试里对 plugins 表一律用 raw sqlite 读写(避开 drizzle builder 在测试环境的坑)。

const PLUGIN_ID = "fake-upgrade-plugin";
const OLD = { id: PLUGIN_ID, name: "Fake", version: "1.2.3", type: "source", description: "old", capabilities: ["search"], configSchema: [] };
const NEW = { id: PLUGIN_ID, name: "Fake", version: "1.2.4", type: "source", description: "new", capabilities: ["search"], configSchema: [{ key: "homeCount", label: "N", type: "number" }], permissions: ["net"] };

const app = new Hono();
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);
const PLAIN = "hunter2";
const authQS = () => `u=alice&t=${md5(PLAIN + "clientsalt123")}&s=clientsalt123`;

function seedUser() {
  if (db.select().from(users).where(eq(users.username, "alice")).get()) return;
  db.insert(users).values({ id: "u1", username: "alice", password: "", salt: "salt", subsonicSalt: "subsalt", passEnc: encryptPassword(PLAIN), isAdmin: 1, isActive: 1, email: "a@b.c" }).run();
}

const insertRow = (manifest: any, version: string, extra: Record<string, any> = {}) => {
  sqlite.prepare(
    `INSERT INTO plugins (id, name, version, description, manifest, enabled, config, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    PLUGIN_ID, PLUGIN_ID, version, manifest.description || "",
    JSON.stringify(manifest),
    extra.enabled ?? 1,
    extra.config ?? "{}",
    new Date().toISOString(), new Date().toISOString(),
  );
};

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  seedUser();
});

beforeEach(() => {
  sqlite.prepare("DELETE FROM plugins WHERE name = ?").run(PLUGIN_ID);
  unregisterPlugin(PLUGIN_ID);
});

describe("syncPluginRowAfterInstall (升级同步 DB 行)", () => {
  it("已存在行更新为 1.2.4 + 新 manifest，保留 enabled/config", () => {
    insertRow(OLD, "1.2.3", { enabled: 1, config: JSON.stringify({ baseUrl: "http://x:1" }) });

    syncPluginRowAfterInstall(NEW as any);

    const row = sqlite.prepare("SELECT * FROM plugins WHERE name = ?").get(PLUGIN_ID) as any;
    expect(row.version).toBe("1.2.4");
    expect(JSON.parse(row.manifest).version).toBe("1.2.4");
    expect(JSON.parse(row.manifest).configSchema.some((f: any) => f.key === "homeCount")).toBe(true);
    // 用户配置与启用状态保留
    expect(row.enabled).toBe(1);
    expect(JSON.parse(row.config)).toEqual({ baseUrl: "http://x:1" });
  });

  it("行不存在时不插行(交给后续 discover/seed 补)", () => {
    syncPluginRowAfterInstall(NEW as any);
    const row = sqlite.prepare("SELECT * FROM plugins WHERE name = ?").get(PLUGIN_ID);
    expect(row).toBeUndefined();
  });
});

describe("GET /v1/plugins 版本以 registry 为准", () => {
  it("外置插件 registry 1.2.4 时返回 1.2.4(即使 DB 行是 1.2.3)", async () => {
    insertRow(OLD, "1.2.3");
    registerPlugin(NEW as any, { manifest: NEW } as any);

    const res = await app.request(`/rest/api/v1/plugins?${authQS()}`);
    const body = await res.json();
    const row = (body as any[]).find((r: any) => r.name === PLUGIN_ID);
    expect(row).toBeTruthy();
    expect(row.version).toBe("1.2.4");
    expect(JSON.parse(row.manifest).configSchema.some((f: any) => f.key === "homeCount")).toBe(true);
  });
});
