// End-to-end test for the batch-scoped cover-download dedup in importOnlineSongs:
// a whole go-music-dl playlist often shares one cover URL per album — the first
// song downloads it once (writes <songId>.jpg), later songs with the SAME URL
// reuse those bytes via copyOnlineCoverToRef instead of re-fetching. This test
// asserts end-to-end correctness (each song gets its own resolvable cover file,
// byte-identical) without asserting the exact network-call count, which would be
// racy under worker concurrency.
// MUST be the first import: re-exports the isolated DATA_DIR env for this file.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import { initDatabase, db, sqlite } from "../../src/db/index.js";
import { songs, users } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { registerPlugin, unregisterPlugin } from "../../src/plugins/registry.js";
import { importOnlineSongs } from "../../src/services/source/online/service.js";
import { resolveCoverFile } from "../../src/services/playlistCover.js";
import { getDataDir } from "../../src/utils/env.js";

const PROVIDER = "cover-dedup";
const USER = "cover-dedup-user";
const ONLINE_DIR = path.join(getDataDir(), "online-covers");

const manifestOf = {
  id: PROVIDER,
  name: PROVIDER,
  version: "1.0.0",
  type: "source",
  capabilities: ["search", "stream"],
  platforms: ["netease"],
  configSchema: [],
  permissions: ["net"],
} as const;

const provider = {
  id: PROVIDER,
  manifest: manifestOf,
  search: async () => ({ songs: [] }),
  streamUrl: () => "http://gm:18080/music/download",
};

// A shared remote cover for all songs. cacheRemoteCover only needs >=100 bytes.
const SHARED_COVER = "https://example.com/shared-cover.jpg";
const IMAGE_BYTES = Buffer.from(Array(256).fill(0xaa));

const realFetch = globalThis.fetch;
beforeAll(() => {
  initDatabase();
  registerPlugin(manifestOf as any, provider);
  sqlite.prepare(`
    INSERT INTO plugins (id, name, version, description, manifest, enabled, config, created_at, updated_at)
    VALUES (?, ?, '1.0.0', '', ?, 1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET enabled = 1, config = excluded.config, manifest = excluded.manifest
  `).run(PROVIDER, PROVIDER, JSON.stringify(manifestOf), JSON.stringify({}), new Date().toISOString(), new Date().toISOString());
  db.insert(users).values({ id: USER, username: "cover-dedup", password: "x", salt: "x", subsonicSalt: "x" }).run();
  globalThis.fetch = (async () => ({ ok: true, arrayBuffer: async () => IMAGE_BYTES })) as any;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  sqlite.prepare("DELETE FROM songs WHERE plugin_entry = ?").run(PROVIDER);
  sqlite.prepare("DELETE FROM users WHERE id = ?").run(USER);
  sqlite.prepare("DELETE FROM plugins WHERE id = ?").run(PROVIDER);
  unregisterPlugin(PROVIDER);
});

describe("importOnlineSongs — 批内封面去重(同一 URL 只下载一次,其余本地复制)", () => {
  it("共享同一封面 URL 的歌各得独立可解析 cover 文件,且字节一致", async () => {
    const res = await importOnlineSongs(PROVIDER, [
      { id: "d1", source: "netease", name: "歌1", artist: "封面歌手", album: "封面专辑", duration: 180, cover: SHARED_COVER },
      { id: "d2", source: "netease", name: "歌2", artist: "封面歌手", album: "封面专辑", duration: 200, cover: SHARED_COVER },
      { id: "d3", source: "netease", name: "歌3", artist: "封面歌手", album: "封面专辑", duration: 210, cover: SHARED_COVER },
    ]);

    expect(res.added).toBe(3);
    expect(res.failed).toBe(0);

    // 都写入了远程封面 URL(而非空),且各自引用可解析到实际文件
    const rows = db.select().from(songs).where(eq(songs.pluginEntry, PROVIDER)).all();
    expect(rows.length).toBe(3);
    const coverRefs = rows.map((s) => (s as any).coverArt as string);
    for (const ref of coverRefs) {
      expect(ref).toContain(".jpg");
      expect(resolveCoverFile(ref)).toBeTruthy();
    }
    // 每首歌独立 ref(按各自 songId),去重不强引用同一文件
    expect(new Set(coverRefs).size).toBe(3);

    // 三次本地复制的字节与下载源一致 → 复用成立
    const bytes = coverRefs.map((ref) => fs.readFileSync(resolveCoverFile(ref)!));
    expect(bytes.every((b) => b.equals(IMAGE_BYTES))).toBe(true);
    // 落盘在平台封面目录(在线独立挂卷)
    expect(coverRefs.every((ref) => fs.existsSync(path.join(ONLINE_DIR, ref)))).toBe(true);
  });
});