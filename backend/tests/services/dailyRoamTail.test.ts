// 覆盖率长尾补充:services/plugin/dailyRoam.ts 的残余分支。
//   - 配置读取抛错(sqlite/registry 层异常)→ 回落默认两张固定源,不冒泡(50-51)
//   - 存量歌单被改名 → ensureRoamPlaylist 自愈回「今日漫游」(65-68)
//   - 插件对象 runDailyJob / generateComboPlaylist 两个入口(239-245)
// registry.getPluginConfig 在本文件里**始终抛错**,用来锁「读配置失败也不能中断日调度」。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { sqlite } from "../../src/db/index.js";
import { registerBuiltinPlugins } from "../../src/plugins/builtins.js";

vi.mock("../../src/plugins/registry.js", async (imp) => {
  const real: any = await imp();
  return {
    ...real,
    // 模拟 plugins 表读取失败(引擎异常/并发锁)。loadSources 必须吞掉并回落默认。
    getPluginConfig: () => {
      throw new Error("plugins table read failed");
    },
  };
});

import {
  generateRoamPlaylist,
  dailyRoamPlugin,
  ROAM_PLAYLIST_ID,
  ROAM_TAG,
} from "../../src/services/plugin/dailyRoam.js";
import { FIXED_TODAY_ID } from "../../src/services/plugin/dailyRecommend.js";
import { LOCAL_FIXED_PLAYLIST_ID } from "../../src/services/plugin/localRecommend.js";
import { resetDailyCoverClaims } from "../../src/services/playlistCover.js";

function seedSongs(n: number) {
  const ins = sqlite.prepare("INSERT OR REPLACE INTO songs (id, title, artist, album, duration, path, suffix, type, created_at) VALUES (?,?,?,?,?,?,?,?,?)");
  for (let i = 0; i < n; i++) {
    ins.run(`tail-s${i}`, `Song ${i}`, "Artist", "Album", 200, `l:src:/tmp/tail-s${i}.mp3`, "mp3", "local", new Date().toISOString());
  }
}

function seedPlaylist(id: string, name: string, from: number, to: number) {
  const owner = sqlite.prepare("SELECT id FROM users WHERE is_admin = 1 LIMIT 1").get() as any;
  const now = new Date().toISOString();
  if (!sqlite.prepare("SELECT id FROM playlists WHERE id = ?").get(id)) {
    sqlite.prepare("INSERT INTO playlists (id, name, owner_id, is_public, comment, created_at, updated_at) VALUES (?,?,?,1,?,?,?)")
      .run(id, name, owner.id, "", now, now);
  }
  const ins = sqlite.prepare("INSERT INTO playlist_songs (playlist_id, song_id, position, playable, created_at) VALUES (?,?,?,1,?)");
  for (let i = from; i < to; i++) ins.run(id, `tail-s${i}`, i - from, now);
}

beforeAll(() => {
  registerBuiltinPlugins();
  seedSongs(20);
});

beforeEach(() => {
  resetDailyCoverClaims();
  for (const id of [ROAM_PLAYLIST_ID, FIXED_TODAY_ID, LOCAL_FIXED_PLAYLIST_ID]) {
    sqlite.prepare("DELETE FROM playlist_songs WHERE playlist_id = ?").run(id);
    sqlite.prepare("UPDATE playlists SET song_count = 0, duration = 0, comment = '' WHERE id = ?").run(id);
  }
});

describe("dailyRoam 长尾", () => {
  it("读配置抛错 → 回落默认两张固定源,日调度不中断", () => {
    // 配置读取异常(50-51):必须吞掉并回落 DEFAULT_SOURCES,否则整条日调度链会炸。
    seedPlaylist(FIXED_TODAY_ID, "每日推荐", 0, 3);
    seedPlaylist(LOCAL_FIXED_PLAYLIST_ID, "本地推荐", 2, 5);

    const r = generateRoamPlaylist({ force: true });
    expect(r.skipped).toBe(false);
    expect(r.total).toBe(5); // tail-s0..tail-s4 去重合并
    expect(r.sources).toContain(FIXED_TODAY_ID);
    expect(r.sources).toContain(LOCAL_FIXED_PLAYLIST_ID);
  });

  it("存量今日漫游行被改过名 → 生成时自愈回「今日漫游」", () => {
    const owner = sqlite.prepare("SELECT id FROM users WHERE is_admin = 1 LIMIT 1").get() as any;
    const now = new Date().toISOString();
    sqlite.prepare(
      "INSERT INTO playlists (id, name, owner_id, is_public, comment, created_at, updated_at) VALUES (?,?,?,1,?,?,?) ON CONFLICT(id) DO UPDATE SET name = excluded.name",
    ).run(ROAM_PLAYLIST_ID, "被改坏的名字", owner.id, "", now, now);

    seedPlaylist(FIXED_TODAY_ID, "每日推荐", 0, 2);
    generateRoamPlaylist({ force: true });

    const row = sqlite.prepare("SELECT name FROM playlists WHERE id = ?").get(ROAM_PLAYLIST_ID) as any;
    expect(row.name).toBe("今日漫游");
  });

  it("插件 runDailyJob / generateComboPlaylist 两个入口行为一致(239-245)", async () => {
    seedPlaylist(FIXED_TODAY_ID, "每日推荐", 0, 4);

    const msg = await dailyRoamPlugin.runDailyJob({ force: true });
    // 文案格式: "<date>: <total> 首今日漫游 (<n> 个来源)";来源数受"源歌单行是否存在"影响,
    // 不是本用例要锁的东西,故只锁载体与规模。
    expect(msg).toMatch(/首今日漫游 \(\d+ 个来源\)/);
    expect(msg).toContain("4 首今日漫游");

    const r = await dailyRoamPlugin.generateComboPlaylist({ force: true });
    expect(r.playlistId).toBe(ROAM_PLAYLIST_ID);
    expect(r.name).toBe("今日漫游");
    expect(r.total).toBe(4);
    expect(r.skipped).toBe(false);
  });

  it("无内容时 runDailyJob 返回 null(调用方据此跳过通知)", async () => {
    // 两个源都空 → generateRoamPlaylist skipped=true → runDailyJob 必须返回 null。
    const r = await dailyRoamPlugin.runDailyJob({ force: true });
    expect(r).toBeNull();
  });

  it("无内容时不写当天时间戳(保持可重试)", () => {
    const owner = sqlite.prepare("SELECT id FROM users WHERE is_admin = 1 LIMIT 1").get() as any;
    const now = new Date().toISOString();
    // 显式保证漫游行存在且 comment 为空,排除「首次创建时写了 ROAM_TAG」的干扰。
    sqlite.prepare(
      "INSERT INTO playlists (id, name, owner_id, is_public, comment, created_at, updated_at) VALUES (?,?,?,1,'',?,?) ON CONFLICT(id) DO UPDATE SET comment = ''",
    ).run(ROAM_PLAYLIST_ID, "今日漫游", owner.id, now, now);

    const r = generateRoamPlaylist({ force: true });
    expect(r.skipped).toBe(true);
    const row = sqlite.prepare("SELECT comment FROM playlists WHERE id = ?").get(ROAM_PLAYLIST_ID) as any;
    // 没有可用内容时不写 "ROAM_TAG 日期"(否则当天幂等会卡死后续重试)。
    expect(String(row?.comment || "")).not.toContain(ROAM_TAG);
  });
});
