// P1:syncAllRecommendPlaylists 参与全局批量闸(acquireBatchLock)。
// 修复前 Path A 推荐歌单重导不持锁,与 Path B(插件 runDailyJob)并发叠加抢 CPU/带宽;
// 修复后作为整体入闸,FIFO 排队。
import "../../plugins/_env.js";

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { initDatabase, sqlite } from "../../../src/db/index.js";
import { registerPlugin, unregisterPlugin } from "../../../src/plugins/registry.js";
import { syncAllRecommendPlaylists } from "../../../src/services/source/online/recommendImport.js";
import { acquireBatchLock, sleep, _resetPacerForTest } from "../../../src/services/plugin/batchPacer.js";

const PROVIDER = "p1-test-prov";

const manifest = {
  id: PROVIDER,
  name: PROVIDER,
  version: "1.0.0",
  type: "source",
  capabilities: ["recommend", "playlistSongs", "stream", "search"],
  platforms: ["netease"],
  configSchema: [],
  permissions: ["net"],
  recommendPrefix: "p1://recommend/",
} as const;

function registerProvider(calls: { recommend: number }) {
  const impl = {
    id: PROVIDER,
    manifest,
    async recommend() {
      calls.recommend++;
      return {
        channels: [{ source: "netease", playlists: [{ id: "1", source: "netease", name: "test", cover: "" }] }],
      };
    },
    async playlistSongs() {
      return { songs: [{ id: "101", source: "netease", name: "Song", artist: "Artist", album: "Album", duration: 200 }] };
    },
    streamUrl: (_c: any, s: any) => `http://p1/stream?id=${s.id}`,
  };
  registerPlugin(manifest as any, impl);
  sqlite.prepare(`
    INSERT INTO plugins (id, name, version, description, manifest, enabled, config, created_at, updated_at)
    VALUES (?, ?, ?, '', ?, 1, '{}', ?, ?)
    ON CONFLICT(id) DO UPDATE SET enabled = 1, config = '{}', manifest = excluded.manifest
  `).run(PROVIDER, PROVIDER, "1.0.0", JSON.stringify(manifest), new Date().toISOString(), new Date().toISOString());
  return impl;
}

beforeAll(() => {
  initDatabase();
  _resetPacerForTest();
});

beforeEach(() => {
  _resetPacerForTest();
  sqlite.prepare("INSERT OR IGNORE INTO users (id, username, password, salt, subsonic_salt) VALUES (?,?,?,?,?)").run("u1", "u1", "x", "x", "x");
  sqlite.prepare("DELETE FROM playlist_songs WHERE playlist_id LIKE 'pl-%'").run();
  sqlite.prepare("DELETE FROM playlists WHERE source_url LIKE 'p1://%'").run();
});

afterAll(() => {
  unregisterPlugin(PROVIDER);
  sqlite.prepare("DELETE FROM plugins WHERE id = ?").run(PROVIDER);
  _resetPacerForTest();
});

describe("P1 syncAllRecommendPlaylists 参与全局批量闸", () => {
  it("锁被占用时排队不执行,释放后才跑", async () => {
    const calls = { recommend: 0 };
    registerProvider(calls);
    const release = await acquireBatchLock();
    const running = syncAllRecommendPlaylists(PROVIDER, { userId: "u1" });
    await sleep(80);
    expect(calls.recommend).toBe(0); // 全局闸被占 → 尚未开始拉推荐
    release();
    const r = await running;
    expect(r.synced).toBe(1);
    expect(r.failed).toBe(0);
    expect(calls.recommend).toBe(1);
  });

  it("锁空闲时直接执行,不排队", async () => {
    const calls = { recommend: 0 };
    registerProvider(calls);
    const r = await syncAllRecommendPlaylists(PROVIDER, { userId: "u1" });
    expect(r.synced).toBe(1);
    expect(calls.recommend).toBe(1);
  });
});
