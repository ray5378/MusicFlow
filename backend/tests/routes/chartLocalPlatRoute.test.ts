// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import { Hono } from "hono";
import md5 from "md5";
import { fileURLToPath } from "url";
import { db, sqlite, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users, plugins } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../../src/middleware/auth.js";
import { apiRoutes, clearRecommendCache } from "../../src/routes/api/index.js";
import {
  discoverExternalPlugins,
} from "../../src/plugins/discovery.js";
import {
  getPlugin, getPluginImpl, getEnabledByCapability,
  registerPlugin, unregisterPlugin,
} from "../../src/plugins/registry.js";

// 端到端验证「首页接口分流」:
//   三个榜单插件(经改动后)声明 localPlatformRecommend → 已入库歌单走 /v1/local-recommend
//   (不再被当作 recommendPlaylist 走 /v1/recommend 的导入路线)。
//   插件源码为真实 index.js/plugin.json(sibling 仓库 MusicFlow-plugins),沙箱加载后
//   用 discovery 的真实 host(playlists.get 读真实 DB)驱动 recommendLocal(),再打真实接口。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRCPLUGINS = path.resolve(HERE, "../../../MusicFlow-plugins/plugins");
const hasPluginRepo = fs.existsSync(SRCPLUGINS);

const app = new Hono();
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);

const PLAIN = "hunter2";
const CLIENT_SALT = "clientsalt123";
const authQS = () => `u=alice&t=${md5(PLAIN + CLIENT_SALT)}&s=${CLIENT_SALT}`;

const TMP_ROOT = path.join(process.env.DATA_DIR as string, "test-chart-plugins");

const CHART_IDS = { "qq-chart": "qq-chart", "kugou-chart": "kugou-chart", "netease-chart": "netease-chart" };
// 各插件待写盘的真实本地歌单 id(runDailyJob 的 PLAYLIST_PREFIX + 榜单 id)
const SEEDED = [
  { pid: "pl-qq-chart-26", name: "QQ音乐·热歌榜", songCount: 50, cover: "cq" },
  { pid: "pl-kugou-chart-8888", name: "酷狗·TOP500", songCount: 500, cover: "ck" },
  { pid: "pl-netease-chart-3778678", name: "网易云·热歌榜", songCount: 300, cover: "cn" },
];

function seedUser() {
  if (db.select().from(users).where(eq(users.username, "alice")).get()) return "u1";
  db.insert(users).values({
    id: "u1", username: "alice", password: "", salt: "s", subsonicSalt: "ss",
    passEnc: encryptPassword(PLAIN), isAdmin: 1, isActive: 1, email: "a@b.c",
  }).run();
  return "u1";
}

function seedPlaylist(id: string, name: string, songCount: number, cover: string) {
  sqlite.prepare(`INSERT INTO playlists (id, name, owner_id, is_public, comment, cover_art, song_count, duration, source_platform, source_plugin, created_at, updated_at)
          VALUES (?,?,?,1,?,?,?,0,?,?,?,?)`)
    .run(id, name, "u1", "", cover, songCount, "chart", "chart", new Date().toISOString(), new Date().toISOString());
}
function clearPlaylists() {
  sqlite.prepare("DELETE FROM playlist_songs WHERE playlist_id LIKE 'pl-%-chart-%' OR playlist_id IN (SELECT id FROM playlists WHERE source_plugin='chart')").run();
  sqlite.prepare("DELETE FROM playlists WHERE source_plugin='chart'").run();
}
function enablePlugin(id: string, config: Record<string, any>) {
  db.delete(plugins).where(eq(plugins.name, id)).run();
  db.insert(plugins).values({ name: id, enabled: 1, config: JSON.stringify(config) }).run();
}
function disableAll() {
  for (const id of Object.values(CHART_IDS)) db.delete(plugins).where(eq(plugins.name, id)).run();
}

async function get(route: string) {
  const res = await app.request(`/rest/api/${route}?${authQS()}`);
  return { res, body: await res.json().catch(() => null) };
}

beforeAll(async () => {
  if (!hasPluginRepo) return;
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.9.8";
  initDatabase();
  seedUser();
  // 只复制三个榜单插件到隔离发现目录(避免加载 go-music-dl/lastfm 等其余外置插件)
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  for (const id of Object.values(CHART_IDS)) {
    fs.cpSync(path.join(SRCPLUGINS, id), path.join(TMP_ROOT, id), { recursive: true });
  }
  await discoverExternalPlugins("1.9.8", TMP_ROOT);
}, 30000);

beforeEach(() => {
  clearRecommendCache();
  clearPlaylists();
  disableAll();
});

describe("三个榜单插件(改动后)声明 localPlatformRecommend 并走本地接口", () => {
  it("沙箱加载:具备 localPlatformRecommend 能力 + recommendLocal/runDailyJob 方法", () => {
    if (!hasPluginRepo) return;
    for (const id of Object.values(CHART_IDS)) {
      const m = getPlugin(id);
      expect(m).toBeDefined();
      expect(m!.manifest.capabilities).toEqual(["localPlatformRecommend"]);
      const impl = getPluginImpl(id);
      expect(typeof impl?.recommendLocal).toBe("function");
      expect(typeof impl?.runDailyJob).toBe("function");
      expect(typeof impl?.recommend).not.toBe("function"); // 不再暴露 recommend()
    }
  });

  it("/v1/local-recommend:已入库榜单卡片含真实 cover/songCount/imported,未入库榜单不展示", async () => {
    if (!hasPluginRepo) return;
    enablePlugin("qq-chart", { chartIds: ["26", "27"], homeCount: 6, sortOrder: 30 });
    enablePlugin("kugou-chart", { rankIds: ["8888"], homeCount: 6, sortOrder: 31 });
    enablePlugin("netease-chart", { chartIds: ["3778678"], homeCount: 6, sortOrder: 32 });
    for (const s of SEEDED) seedPlaylist(s.pid, s.name, s.songCount, s.cover);
    // 只入库了 pl-qq-chart-26,27 未入库 → 应跳过

    const { body } = await get("v1/local-recommend");
    expect(body.success).toBe(true);
    const ch = (body.channels as any[]).sort((a: any, b: any) => a.sortOrder - b.sortOrder);
    // 内置「本地随机(按平台)」provider 与三个榜单插件同走 /v1/local-recommend,多 provider 共存。
    // 故这里只校验三个榜单插件各自的分区频道存在且数据正确,不要求频道全集恰好等于三插件。
    const chartSources = ["qq", "kugou", "netease"];
    for (const src of chartSources) {
      const c = ch.find((x: any) => x.source === src);
      expect(c).toBeTruthy();
      // 三个榜单分区再按 sortOrder 升序(30/31/32)
    }
    // 分区展示文案透传:三个榜单插件携带 subtag「每日更新」;tagline 说明性文案已移除
    // (三端前端均改为「有 tagline 才渲染副标题」,榜单分区不再显示小字注释)。
    const qqCh = ch.find((x: any) => x.source === "qq");
    expect(qqCh).toMatchObject({
      subtag: "每日更新",
    });
    expect(qqCh.tagline).toBeUndefined();
    const kgCh = ch.find((x: any) => x.source === "kugou");
    expect(kgCh?.subtag).toBe("每日更新");
    const neCh = ch.find((x: any) => x.source === "netease");
    expect(neCh?.subtag).toBe("每日更新");
    expect(ch.filter((x: any) => chartSources.includes(x.source)).map((x: any) => x.sortOrder))
      .toEqual([30, 31, 32]);
    // 内置 provider 作为独立 provider 也返回了分区(这里是 chart 源,取决于 seed 的 source_platform)
    expect(ch.some((x: any) => !chartSources.includes(x.source))).toBe(true);

    const qq = ch.find((c: any) => c.source === "qq");
    expect(qq.playlists.length).toBe(1); // 27 未入库被跳过
    expect(qq.playlists[0]).toMatchObject({
      id: "pl-qq-chart-26", name: "QQ音乐·热歌榜", songCount: 50,
      coverArt: "pl-pl-qq-chart-26", imported: true,
    });

    const kg = ch.find((c: any) => c.source === "kugou");
    expect(kg.playlists[0].id).toBe("pl-kugou-chart-8888");
    expect(kg.playlists[0].songCount).toBe(500);
    expect(kg.playlists[0].coverArt).toBe("pl-pl-kugou-chart-8888");

    const ne = ch.find((c: any) => c.source === "netease");
    expect(ne.playlists[0].id).toBe("pl-netease-chart-3778678");
    expect(ne.playlists[0].songCount).toBe(300);
    expect(ne.playlists[0].coverArt).toBe("pl-pl-netease-chart-3778678");
  });

  it("分流:榜单插件不再出现在 /v1/recommend(recommendPlaylist 分支),go-music-dl 仍在", async () => {
    if (!hasPluginRepo) return;
    // 榜单插件启用 + go-music-dl stub(仍 recommend + recommendPlaylist)+ 相关歌单入库
    enablePlugin("qq-chart", { chartIds: ["26"], homeCount: 6, sortOrder: 30 });
    enablePlugin("kugou-chart", { rankIds: ["8888"], homeCount: 6, sortOrder: 31 });
    enablePlugin("netease-chart", { chartIds: ["3778678"], homeCount: 6, sortOrder: 32 });
    registerPlugin(
      { id: "go-music-dl", name: "go-music-dl", version: "1.0.0", type: "source", capabilities: ["recommend", "recommendPlaylist"], platforms: ["qq"] } as any,
      { manifest: { id: "go-music-dl" }, recommend: async () => ({ channels: [{ source: "qq", name: "go-music-dl 精选", count: 1, sortOrder: 10, playlists: [{ id: "gm-1", source: "qq", name: "GM", cover: "" }] }] }) },
    );
    db.insert(plugins).values({ name: "go-music-dl", enabled: 1, config: JSON.stringify({ baseUrl: "http://gm:8080", sortOrder: 10 }) }).run();
    for (const s of SEEDED) seedPlaylist(s.pid, s.name, s.songCount, s.cover);

    const { body } = await get("v1/recommend");
    expect(body.success).toBe(true);
    // go-music-dl 频道仍在
    const gmCh = (body.channels as any[]).find((c: any) => c._pluginId === "go-music-dl");
    expect(gmCh).toBeTruthy();
    // 榜单卡片绝不该出现在 /v1/recommend
    const allIds = (body.channels as any[]).flatMap((c: any) => (c.playlists || []).map((p: any) => p.id));
    for (const s of SEEDED) expect(allIds).not.toContain(s.pid);
    expect(allIds).not.toContain("pl-qq-chart-27");
    // 三个榜单插件都不是 recommendPlaylist
    expect(getEnabledByCapability("recommendPlaylist").map((p: any) => p.manifest.id)).not.toContain("qq-chart");

    unregisterPlugin("go-music-dl");
  });
});