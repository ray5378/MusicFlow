// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import { db, sqlite, initDatabase } from "../../src/db/index.js";
import { users, songs, playlists, playlistSongs } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { discoverExternalPlugins } from "../../src/plugins/discovery.js";
import { getPlugin } from "../../src/plugins/registry.js";
import { TMP_DATA_DIR } from "../plugins/_env.js";

// 验证外置插件经沙箱 host.playlists / host.sources 写歌单的「宿主实现层」
// (discovery.ts 的 upsertPluginPlaylist / completeFromSources / coverArtForSong /
// refreshPluginPlaylistCounts)——这部分是沙箱单测够不到的真实 DB 写入路径。
const PLUGIN_ID = "lb-test";
const PLUGIN_DIR = path.join(TMP_DATA_DIR, "plugins", PLUGIN_ID);

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "dev";
  initDatabase();
  // 一个 admin(upsertPluginPlaylist 的 owner 取首个 admin)
  if (!db.select().from(users).where(eq(users.username, "adminx")).get()) {
    db.insert(users).values({ id: "u-admin", username: "adminx", password: "", salt: "", subsonicSalt: "", isAdmin: 1, isActive: 1 }).run();
  }
  // 一首本地曲(供 coverArtForSong 命中)
  db.delete(songs).where(eq(songs.id, "s1")).run();
  db.insert(songs).values({ id: "s1", title: "本地曲", artist: "本地人", path: "/x/s1.mp3", coverArt: "ca-1" }).run();

  fs.mkdirSync(PLUGIN_DIR, { recursive: true });
  const indexJs = `
    globalThis.__mfPlugin = {
      manifest: {
        id: "lb-test", name: "LB Test", version: "1.0.0", type: "recommender",
        capabilities: ["dailyPlaylist"], configSchema: [],
        permissions: ["net","storage","songs:read","songs:write","playlists:write"],
      },
      create(host) {
        return {
          async runDailyJob(opts) {
            // 无 search 类插件 → sources.complete 应优雅返回 { songId: null }
            const comp = await host.sources.complete({ artist: "X", title: "Y" });
            const entries = [
              { songId: "s1" },
              { externalSongId: "e1", externalTitle: "外部曲", externalArtist: "外部人", externalDuration: 123000 },
            ];
            if (comp && comp.songId) entries.push({ songId: comp.songId });
            await host.playlists.upsert("pl-test", { name: "T", entries, coverSongId: "s1" });
            return "ok:" + entries.length;
          }
        };
      }
    };`;
  fs.writeFileSync(path.join(PLUGIN_DIR, "index.js"), indexJs, "utf8");
  fs.writeFileSync(path.join(PLUGIN_DIR, "plugin.json"), JSON.stringify({
    id: "lb-test", name: "LB Test", version: "1.0.0", type: "recommender",
    capabilities: ["dailyPlaylist"], configSchema: [],
    permissions: ["net","storage","songs:read","songs:write","playlists:write"],
  }), "utf8");
});

afterAll(() => {
  try { fs.rmSync(PLUGIN_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("外置插件 host.playlists / host.sources 宿主实现(真实 DB)", () => {
  it("discover 后 runDailyJob 经 host.playlists.upsert 写入混合歌单", async () => {
    const loaded = await discoverExternalPlugins(process.env.APP_VERSION || "dev");
    expect(loaded).toBeGreaterThanOrEqual(1);
    const reg = getPlugin("lb-test");
    expect(reg).toBeTruthy();

    const res = await reg.impl.runDailyJob({ force: true });
    expect(String(res)).toContain("ok:");

    // 歌单行已建,owner 为 admin,source 标记为 listenbrainz 风格插件
    const p = db.select().from(playlists).where(eq(playlists.id, "pl-test")).get() as any;
    expect(p).toBeTruthy();
    expect(p.name).toBe("T");
    // owner 取首个 admin(由 initDatabase 创建的默认 admin)
    const admin = db.select().from(users).where(eq(users.isAdmin, 1)).orderBy(users.id).limit(1).get() as any;
    expect(p.ownerId).toBe(admin.id);

    // 两条条目:本地可播(song_id=s1, playable=1) + 外部占位(playable=0)
    const entries = db.select().from(playlistSongs).where(eq(playlistSongs.playlistId, "pl-test")).all() as any[];
    expect(entries.length).toBe(2);
    const local = entries.find((e) => e.songId === "s1");
    const ext = entries.find((e) => e.externalTitle === "外部曲");
    expect(local).toBeTruthy();
    expect(local.playable).toBe(1);
    expect(ext).toBeTruthy();
    expect(ext.playable).toBe(0);
    expect(ext.externalDuration).toBe(123000);

    // 计数/时长已重算:2 首、外部 123000ms → 123s
    expect(p.songCount).toBe(2);
    expect(p.duration).toBe(123);
    // 封面:coverSongId=s1 命中本地曲 cover_art → so-s1
    expect(p.coverArt).toBe("so-s1");
  });

  it("completeFromSources 无 search 插件时返回 { songId: null },不报错", async () => {
    const reg = getPlugin("lb-test");
    expect(reg).toBeTruthy();
    // 直接再跑一次(覆盖旧条目),验证 sources.complete 路径稳定
    const res = await reg.impl.runDailyJob({ force: true });
    expect(String(res)).toContain("ok:");
  });
});
