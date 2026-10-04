// QA 独立验证 · P0-3 随机性语义(用户要求「每次刷新内容不同」必须保留)
//
// 关键区分的两种"缓存":
//   · 候选池缓存(TTL 120s):TTL 内候选集合固定、每次仍重新洗牌 → 刷新内容变;
//   · 整体结果缓存:直接返回上次数组 → 刷新内容不变(错误做法)。
// 本文件用 30 次调用证明:候选集合固定但 picked 顺序/组合变化 → 证明是"重洗"而非"返回缓存数组"。
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { initDatabase, sqlite } from "../../src/db/index.js";
import { registerBuiltinPlugins } from "../../src/plugins/builtins.js";
import { clearCoverResolveCache } from "../../src/services/playlistCover.js";
import {
  recommendLocalPlatforms,
  invalidatePlatformPool,
  LOCAL_PLATFORM_REC_PLUGIN_ID,
} from "../../src/services/plugin/localPlatformRecommend.js";

const NOW = "2026-09-27T00:00:00.000Z";
let owner = "";

function setPluginConfig(cfg: Record<string, unknown>, enabled = 1) {
  sqlite
    .prepare("UPDATE plugins SET config = ?, enabled = ? WHERE name = ?")
    .run(JSON.stringify(cfg), enabled, LOCAL_PLATFORM_REC_PLUGIN_ID);
}

function seedPlaylist(id: string, platform: string | null) {
  sqlite
    .prepare(
      `INSERT INTO playlists (id, name, owner_id, is_public, comment, cover_art, song_count, duration,
                              sync_enabled, source_platform, created_at, updated_at)
       VALUES (?,?,?,1,'',NULL,0,0,0,?,?,?)`,
    )
    .run(id, id, owner, platform, NOW, NOW);
}

const ids = () => recommendLocalPlatforms().channels[0]?.playlists.map((p) => p.id) ?? [];

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  registerBuiltinPlugins();
  const admin = sqlite.prepare("SELECT id FROM users WHERE is_admin = 1 LIMIT 1").get() as any;
  if (admin) owner = admin.id;
  else {
    sqlite
      .prepare(
        "INSERT INTO users (id, username, password, salt, subsonic_salt, pass_enc, is_admin, is_active, email, created_at, updated_at) VALUES ('u1','admin','','s','ss','',1,1,'a@b.c',?,?)",
      )
      .run(NOW, NOW);
    owner = "u1";
  }
});

beforeEach(() => {
  sqlite.prepare("DELETE FROM playlist_songs").run();
  sqlite.prepare("DELETE FROM playlists").run();
  sqlite.prepare("DELETE FROM songs").run();
  clearCoverResolveCache();
  invalidatePlatformPool();
  setPluginConfig({}, 1);
});

describe("P0-3 候选池缓存不吞随机性", () => {
  it("池大小 == homeCount:集合恒定,30 次调用出现多种顺序(确实在重洗)", () => {
    for (let i = 0; i < 6; i++) seedPlaylist(`p-r${i}`, "netease");
    setPluginConfig({ homeCount: 6 });
    const first = ids();
    expect(new Set(first).size).toBe(6);
    const orders = new Set<string>([first.join(",")]);
    for (let i = 0; i < 30; i++) {
      const cur = ids();
      expect(new Set(cur)).toEqual(new Set(first)); // 集合固定(TTL 内不重查库)
      orders.add(cur.join(","));
    }
    // eslint-disable-next-line no-console
    console.log(`[P0-3] 池=6/homeCount=6 → 30 次出现 ${orders.size} 种顺序`);
    expect(orders.size).toBeGreaterThan(1);
  });

  it("池大小 > homeCount:30 次调用的 picked 组合会变化(不是返回缓存数组)", () => {
    for (let i = 0; i < 12; i++) seedPlaylist(`p-c${i}`, "netease");
    setPluginConfig({ homeCount: 4 });
    const pool = new Set(Array.from({ length: 12 }, (_, i) => `p-c${i}`));
    const combos = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const cur = ids();
      expect(cur.length).toBe(4);
      for (const id of cur) expect(pool.has(id)).toBe(true); // 候选全集固定
      combos.add([...cur].sort().join(","));
    }
    // eslint-disable-next-line no-console
    console.log(`[P0-3] 池=12/homeCount=4 → 30 次出现 ${combos.size} 种组合(全集恒为 12)`);
    expect(combos.size).toBeGreaterThan(1);
  });

  it("TTL 内候选池只查库一次(稳态不再叠加 DB 往返)", () => {
    seedPlaylist("p-n1", "netease");
    seedPlaylist("p-n2", "qq");
    const spy = vi.spyOn(sqlite, "prepare");
    for (let i = 0; i < 5; i++) recommendLocalPlatforms();
    const poolQueries = spy.mock.calls.filter((a: any) => /FROM playlists/i.test(String(a[0]))).length;
    spy.mockRestore();
    // eslint-disable-next-line no-console
    console.log(`[P0-3] 5 次调用 → 主 SQL 'FROM playlists' 次数 = ${poolQueries}`);
    expect(poolQueries).toBe(1);
  });

  it("TTL 过期(120s)后自动重建:新歌单无需 invalidate 即出现", () => {
    seedPlaylist("p-old", "netease");
    setPluginConfig({ homeCount: 50 });
    expect(ids()).toEqual(["p-old"]);
    seedPlaylist("p-new", "netease");
    expect(ids()).toEqual(["p-old"]); // TTL 内仍看不到新歌单

    let fake = Date.now();
    const spy = vi.spyOn(Date, "now").mockImplementation(() => fake);
    try {
      fake += 121_000; // 越过 120s TTL
      const after = ids();
      expect(new Set(after)).toEqual(new Set(["p-old", "p-new"]));
      // eslint-disable-next-line no-console
      console.log(`[P0-3] TTL 过期后重建 → ${JSON.stringify(after)}`);
    } finally {
      spy.mockRestore();
    }
  });

  it("invalidatePlatformPool() 后立即反映新数据", () => {
    seedPlaylist("p-x", "netease");
    setPluginConfig({ homeCount: 50 });
    expect(ids()).toEqual(["p-x"]);
    seedPlaylist("p-y", "netease");
    expect(ids()).toEqual(["p-x"]); // 未失效仍看不到
    invalidatePlatformPool();
    expect(new Set(ids())).toEqual(new Set(["p-x", "p-y"]));
  });

  it("边界:带平台歌单数 < homeCount 时不报错、不重复", () => {
    seedPlaylist("p-a", "netease");
    seedPlaylist("p-b", "netease");
    setPluginConfig({ homeCount: 6 });
    const cur = ids();
    expect(cur.length).toBe(2);
    expect(new Set(cur).size).toBe(2); // 无重复
  });

  it("边界:空库 → channels 为空数组(不报错)", () => {
    expect(recommendLocalPlatforms()).toEqual({ channels: [] });
  });
});
