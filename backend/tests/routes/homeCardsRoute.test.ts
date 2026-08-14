// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Hono } from "hono";
import md5 from "md5";
import { db, initDatabase, encryptPassword, sqlite } from "../../src/db/index.js";
import { users, plugins } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../../src/middleware/auth.js";
import { apiRoutes } from "../../src/routes/api/index.js";
import { registerPlugin, unregisterPlugin } from "../../src/plugins/registry.js";

// 首页固定卡聚合(/v1/recommend/home-cards) + 位次冲突校验(PUT /v1/plugins/:id):
// 推荐插件 manifest 声明 homePlaylistId + configSchema(showOnHome/homePosition),
// 核心按能力收集、按位次排序;保存时位次重复 → 400 拒绝。
const app = new Hono();
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);

const PLAIN = "hunter2";
const CLIENT_SALT = "clientsalt123";
const authQS = () => `u=alice&t=${md5(PLAIN + CLIENT_SALT)}&s=${CLIENT_SALT}`;

function homePlugin(id: string, cap: string, playlistId: string, defaultShow: boolean, defaultPos: number) {
  return {
    manifest: {
      id, name: `插件 ${id}`, version: "1.0.0", type: "recommender",
      capabilities: [cap],
      homePlaylistId: playlistId,
      configSchema: [
        { key: "showOnHome", label: "在首页显示", type: "switch", default: defaultShow },
        { key: "homePosition", label: "首页显示位次", type: "number", default: defaultPos },
      ],
    },
    impl: { manifest: null },
  };
}

function enablePlugin(name: string, config: Record<string, any> = {}) {
  db.delete(plugins).where(eq(plugins.name, name)).run();
  db.insert(plugins).values({ id: name, name, enabled: 1, config: JSON.stringify(config) }).run();
}

function seedPlaylist(id: string, name: string, songCount: number) {
  const owner = sqlite.prepare("SELECT id FROM users WHERE is_admin = 1 LIMIT 1").get() as any;
  const now = new Date().toISOString();
  if (!sqlite.prepare("SELECT id FROM playlists WHERE id = ?").get(id)) {
    sqlite.prepare("INSERT INTO playlists (id, name, owner_id, is_public, comment, song_count, created_at, updated_at) VALUES (?,?,?,1,'',?,?,?)")
      .run(id, name, owner.id, songCount, now, now);
  }
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  if (!db.select().from(users).where(eq(users.username, "alice")).get()) {
    db.insert(users).values({ id: "u1", username: "alice", password: "", salt: "salt", subsonicSalt: "subsalt", passEnc: encryptPassword(PLAIN), isAdmin: 1, isActive: 1, email: "a@b.c" }).run();
  }
  seedPlaylist("pl-roam", "今日漫游", 50);
  seedPlaylist("pl-daily", "每日推荐", 45);
  seedPlaylist("pl-local", "本地推荐", 40);
});

beforeEach(() => {
  // 导入 apiRoutes 会顺带注册内置推荐插件,先全部反注册 + 删行,只留假插件。
  for (const id of ["f-roam", "f-daily", "f-local", "daily-recommend", "local-recommend", "daily-roam"]) {
    db.delete(plugins).where(eq(plugins.name, id)).run();
    unregisterPlugin(id);
  }
  const roam = homePlugin("f-roam", "comboPlaylist", "pl-roam", true, 1);
  const daily = homePlugin("f-daily", "dailyPlaylist", "pl-daily", false, 0);
  const local = homePlugin("f-local", "localPlaylist", "pl-local", false, 0);
  registerPlugin(roam.manifest as any, roam.impl as any);
  registerPlugin(daily.manifest as any, daily.impl as any);
  registerPlugin(local.manifest as any, local.impl as any);
  enablePlugin("f-roam", { showOnHome: true, homePosition: 1 });
  enablePlugin("f-daily", { showOnHome: false, homePosition: 0 });
  enablePlugin("f-local", { showOnHome: false, homePosition: 0 });
});

async function getHomeCards() {
  const res = await app.request(`/rest/api/v1/recommend/home-cards?${authQS()}`);
  return { res, body: await res.json().catch(() => null) };
}

async function putPlugin(id: string, body: any) {
  const res = await app.request(`/rest/api/v1/plugins/${id}?${authQS()}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("GET /v1/recommend/home-cards (插件自治首页卡)", () => {
  it("只返回 showOnHome=true 的插件,并按位次排序", async () => {
    enablePlugin("f-daily", { showOnHome: true, homePosition: 2 });
    const { body } = await getHomeCards();
    expect(body.success).toBe(true);
    expect(body.cards.map((c: any) => c.pluginId)).toEqual(["f-roam", "f-daily"]);
    expect(body.cards[0]).toMatchObject({ pluginId: "f-roam", position: 1, playlistId: "pl-roam", isCombo: true, songCount: 50 });
    expect(body.cards[1]).toMatchObject({ pluginId: "f-daily", position: 2, isCombo: false, songCount: 45 });
  });

  it("showOnHome=false / 未配置的插件不出现", async () => {
    const { body } = await getHomeCards();
    expect(body.cards).toHaveLength(1); // 只有 f-roam
    expect(body.cards[0].pluginId).toBe("f-roam");
  });
});

describe("PUT /v1/plugins/:id 首页位次冲突校验", () => {
  it("位次与其它在首页显示的插件重复 → 400 拒绝", async () => {
    // f-roam 已占位次 1;f-daily 也想占 1
    const { status, body } = await putPlugin("f-daily", { config: { showOnHome: true, homePosition: 1 } });
    expect(status).toBe(400);
    expect(body.error).toContain("位次 1");
    expect(body.error).toContain("插件 f-roam");
    // DB 未被修改
    const row = db.select().from(plugins).where(eq(plugins.name, "f-daily")).get() as any;
    expect(JSON.parse(row.config).homePosition).toBe(0);
  });

  it("位次不冲突 → 保存成功", async () => {
    const { status, body } = await putPlugin("f-daily", { config: { showOnHome: true, homePosition: 2 } });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  it("自己占自己的位次不算冲突(改其它字段可保存)", async () => {
    const { status } = await putPlugin("f-roam", { config: { showOnHome: true, homePosition: 1, sourcePlaylists: ["pl-daily"] } });
    expect(status).toBe(200);
  });

  it("showOnHome=false 或位次 0(未固定)不参与冲突", async () => {
    // f-daily 关闭首页显示,但把位次也设 1 → 不应冲突(不显示)
    const { status } = await putPlugin("f-daily", { config: { showOnHome: false, homePosition: 1 } });
    expect(status).toBe(200);
    // f-daily 显示但位次 0 → 不冲突
    const { status: s2 } = await putPlugin("f-daily", { config: { showOnHome: true, homePosition: 0 } });
    expect(s2).toBe(200);
  });
});
