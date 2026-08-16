// P2:matchPlaylistInBackground 在全局批量闸占用时排队,释放后才执行匹配。
// (started 计时移到了取锁之后,日志 in Xs 不再含排队时长。)
import "../../plugins/_env.js";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initDatabase, sqlite } from "../../../src/db/index.js";
import { registerPlugin, unregisterPlugin } from "../../../src/plugins/registry.js";
import { matchPlaylistInBackground } from "../../../src/services/plugin/shared.js";
import { acquireBatchLock, sleep, _resetPacerForTest } from "../../../src/services/plugin/batchPacer.js";

const MATCHER = "p2-test-matcher";
const PL = "pl-p2-test";
const USER = "u2";

const manifest = {
  id: MATCHER,
  name: MATCHER,
  version: "1.0.0",
  type: "source",
  capabilities: ["search", "stream"],
  platforms: ["netease"],
  configSchema: [],
  permissions: ["net"],
} as const;

function registerMatcher(calls: { search: number }) {
  const impl = {
    id: MATCHER,
    manifest,
    async search() {
      calls.search++;
      return { songs: [] };
    },
    streamUrl: (_c: any, s: any) => `http://p2/stream?id=${s.id}`,
  };
  registerPlugin(manifest as any, impl);
  sqlite.prepare(`
    INSERT INTO plugins (id, name, version, description, manifest, enabled, config, created_at, updated_at)
    VALUES (?, ?, ?, '', ?, 1, '{}', ?, ?)
    ON CONFLICT(id) DO UPDATE SET enabled = 1, config = '{}', manifest = excluded.manifest
  `).run(MATCHER, MATCHER, "1.0.0", JSON.stringify(manifest), new Date().toISOString(), new Date().toISOString());
  return impl;
}

function seedPlaylist() {
  sqlite.prepare("DELETE FROM playlist_songs WHERE playlist_id = ?").run(PL);
  sqlite.prepare("DELETE FROM playlists WHERE id = ?").run(PL);
  sqlite.prepare("INSERT OR IGNORE INTO users (id, username, password, salt, subsonic_salt) VALUES (?,?,?,?,?)").run(USER, USER, "x", "x", "x");
  sqlite.prepare("INSERT INTO playlists (id, name, owner_id, created_at, updated_at) VALUES (?,?,?,?,?)")
    .run(PL, "p2", USER, new Date().toISOString(), new Date().toISOString());
  // 非 source:id 占位 → 匹配走真实 search(而非 P0 直通)。
  sqlite.prepare(`
    INSERT INTO playlist_songs (playlist_id, position, playable, song_id, external_song_id, external_title, external_artist)
    VALUES (?, 0, 0, NULL, 'bare-id', 'Song', 'Artist')
  `).run(PL);
}

beforeAll(() => {
  initDatabase();
  _resetPacerForTest();
});

afterAll(() => {
  unregisterPlugin(MATCHER);
  sqlite.prepare("DELETE FROM plugins WHERE id = ?").run(MATCHER);
  sqlite.prepare("DELETE FROM playlist_songs WHERE playlist_id = ?").run(PL);
  sqlite.prepare("DELETE FROM playlists WHERE id = ?").run(PL);
  _resetPacerForTest();
});

describe("P2 matchPlaylistInBackground 排队", () => {
  it("全局闸被占时先排队,释放后才触发匹配", async () => {
    const calls = { search: 0 };
    registerMatcher(calls);
    seedPlaylist();
    const release = await acquireBatchLock();
    const p = matchPlaylistInBackground(PL);
    await sleep(100);
    expect(calls.search).toBe(0); // 排队中,匹配尚未开始
    release();
    await p;
    expect(calls.search).toBe(1);
  });
});
