// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import { db, sqlite, initDatabase } from "../../src/db/index.js";
import { users, songs, playlists, playlistSongs, plugins } from "../../src/db/schema.js";
import { and, eq } from "drizzle-orm";
import { discoverExternalPlugins } from "../../src/plugins/discovery.js";
import { getPlugin, registerPlugin, unregisterPlugin } from "../../src/plugins/registry.js";
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
  // 一首无封面本地曲(供「无封面 → 清空」路径)
  db.delete(songs).where(eq(songs.id, "s2")).run();
  db.insert(songs).values({ id: "s2", title: "无封面曲", artist: "本地人", path: "/x/s2.mp3", coverArt: null }).run();

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

  // 第二个测试插件:验证宿主「自动扫描自身条目取封面 / 无封面显式清空」。
  const PLUGIN_DIR2 = path.join(TMP_DATA_DIR, "plugins", "lb-test2");
  fs.mkdirSync(PLUGIN_DIR2, { recursive: true });
  fs.writeFileSync(path.join(PLUGIN_DIR2, "index.js"), `
    globalThis.__mfPlugin = {
      manifest: { id: "lb-test2", name: "LB Test2", version: "1.0.0", type: "recommender",
        capabilities: ["dailyPlaylist"], configSchema: [], permissions: ["playlists:write"] },
      create(host) {
        return {
          async runDailyJob() {
            // 未传 coverSongId → 宿主自动扫描:pl-test2 含 s1(有封面)→ so-s1
            await host.playlists.upsert("pl-test2", { name: "T2", entries: [{ songId: "s1" }] });
            // 全部无封面 → cover_art 显式清空(不再残留旧封面)
            await host.playlists.upsert("pl-test3", { name: "T3", entries: [{ songId: "s2" }] });
            return "ok";
          }
        };
      }
    };`, "utf8");
  fs.writeFileSync(path.join(PLUGIN_DIR2, "plugin.json"), JSON.stringify({
    id: "lb-test2", name: "LB Test2", version: "1.0.0", type: "recommender",
    capabilities: ["dailyPlaylist"], configSchema: [], permissions: ["playlists:write"],
  }), "utf8");
});

afterAll(() => {
  try { fs.rmSync(PLUGIN_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(path.join(TMP_DATA_DIR, "plugins", "lb-test2"), { recursive: true, force: true }); } catch { /* ignore */ }
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

  it("宿主自动扫封面:未传 coverSongId 时取自身第一首有封面歌曲;全无封面则清空", async () => {
    const reg2 = getPlugin("lb-test2");
    expect(reg2).toBeTruthy();
    await reg2.impl.runDailyJob({ force: true });

    const p2 = db.select().from(playlists).where(eq(playlists.id, "pl-test2")).get() as any;
    expect(p2).toBeTruthy();
    expect(p2.coverArt).toBe("so-s1"); // 自动扫描命中 s1(有封面)

    const p3 = db.select().from(playlists).where(eq(playlists.id, "pl-test3")).get() as any;
    expect(p3).toBeTruthy();
    expect(p3.coverArt).toBeNull(); // 全无封面 → 显式清空
  });

  // 注册一个内存级 source 插件(mock 在线源):search 按 (config,{query}) 契约调用。
  async function withMockSource(searchImpl: (config: any, params: any) => any, fn: (searchCalls: any[]) => Promise<void>) {
    const searchCalls: any[] = [];
    const fSrc = {
      manifest: {
        id: "f-src", name: "F Src", version: "1.0.0", type: "source",
        capabilities: ["search"], platforms: ["netease"],
        configSchema: [{ key: "baseUrl", type: "url", label: "baseUrl" }],
      },
      impl: {
        async search(config: any, params: any) {
          searchCalls.push({ config, params });
          return await searchImpl(config, params);
        },
        streamUrl() { return "http://w/1.mp3"; },
      },
    };
    registerPlugin(fSrc.manifest as any, fSrc.impl as any);
    db.delete(plugins).where(eq(plugins.name, "f-src")).run();
    db.insert(plugins).values({ id: "f-src", name: "f-src", enabled: 1, config: JSON.stringify({ baseUrl: "http://gm:18080" }) }).run();
    try {
      await fn(searchCalls);
    } finally {
      unregisterPlugin("f-src");
      db.delete(plugins).where(eq(plugins.name, "f-src")).run();
    }
    return searchCalls;
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("completeFromSources 按 (config,{query}) 契约调用在线源(此前单参传字符串导致补全恒失败)", async () => {
    const searchCalls = await withMockSource(
      (_config: any, _params: any) => ({ songs: [{ id: "w-1", source: "netease", name: "外部曲", artist: "外部人", album: "外部专辑", duration: 200 }] }),
      async (searchCalls) => {
        const reg = getPlugin("lb-test");
        expect(reg).toBeTruthy();
        const r = await reg.impl.runDailyJob({ force: true });
        expect(String(r)).toContain("ok:3"); // comp 成功 → entries 里多一条可播 songId
        // 等待本用例触发的后台 auto-match 完成(清场,避免 fire-and-forget 泄漏到下一用例)
        for (let i = 0; i < 20 && searchCalls.length < 2; i++) await sleep(250);
      },
    );
    // search 收到的是「配置对象」而非字符串:baseUrl 可读,补全才可能成功
    const compCall = searchCalls.find((c) => c.params?.query && c.params.query.includes("X"));
    expect(compCall).toBeTruthy();
    expect(compCall.config).toBeTruthy();
    expect(compCall.config.baseUrl).toBe("http://gm:18080");
    expect(typeof compCall.params.query).toBe("string");
    // auto-match 也被正确调用(生成时未补全的外部条目,后台再补一轮)
    expect(searchCalls.some((c) => c.params?.query && c.params.query.includes("外部曲"))).toBe(true);
  });

  it("upsert 后剩余外部条目自动后台匹配(生成时未补全的,后台再经在线源补一轮)", async () => {
    const searchCalls = await withMockSource(
      (_config: any, _params: any) => ({ songs: [{ id: "w-2", source: "netease", name: "外部曲", artist: "外部人", duration: 200 }] }),
      async (searchCalls) => {
        const reg = getPlugin("lb-test");
        await reg.impl.runDailyJob({ force: true }); // 生成轮:complete(X Y) + upsert 后触发 auto-match
        // 等待后台 auto-match 把 external 条目(e1)更新为可播
        let updated = false;
        for (let i = 0; i < 20; i++) {
          const e = db.select().from(playlistSongs)
            .where(and(eq(playlistSongs.playlistId, "pl-test"), eq(playlistSongs.externalSongId, "e1")))
            .get() as any;
          if (e && e.playable === 1 && e.songId) { updated = true; break; }
          await sleep(250);
        }
        expect(updated).toBe(true); // 外部条目已被后台自动匹配为可播 web 歌曲
      },
    );
    // 至少一次「生成时 complete」+ 一次「auto-match」的 search 调用(都带 baseUrl 配置)
    expect(searchCalls.length).toBeGreaterThanOrEqual(2);
    expect(searchCalls.every((c) => c.config?.baseUrl === "http://gm:18080")).toBe(true);
  });
});
