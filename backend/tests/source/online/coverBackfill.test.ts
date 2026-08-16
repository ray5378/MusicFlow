// Unit tests for covers.ts 的后台封面回填(runCoverBackfill):
//   - 无 coverProvider 时直接跳过(不触发任何封面获取)
//   - 有 coverProvider 时,只为无封面的歌曲拉取封面(有封面的跳过)
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../../plugins/_env.js";

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// 拦截真实网络下载:cacheRemoteCover 直接返回本地引用,便于断言调用次数与落库。
vi.mock("../../../src/services/playlistCover.js", () => ({
  cacheRemoteCover: vi.fn(async (_url: string, songId: string) => `${songId}.jpg`),
}));

import { initDatabase, db, sqlite } from "../../../src/db/index.js";
import { songs } from "../../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { registerPlugin, unregisterPlugin } from "../../../src/plugins/registry.js";
import { runCoverBackfill } from "../../../src/services/covers.js";
import { cacheRemoteCover } from "../../../src/services/playlistCover.js";

const PROVIDER = "cover-fill-provider";
const mockedCache = cacheRemoteCover as unknown as ReturnType<typeof vi.fn>;

function registerCoverProvider(enabled: boolean) {
  const manifest = {
    id: PROVIDER,
    name: PROVIDER,
    version: "1.0.0",
    type: "source",
    capabilities: ["coverProvider", "search", "stream"],
    platforms: ["netease"],
    configSchema: [],
    permissions: ["net"],
  } as const;
  registerPlugin(manifest as any, { searchCover: async () => ({ url: "http://cover/1.jpg" }) });
  sqlite.prepare(`
    INSERT INTO plugins (id, name, version, description, manifest, enabled, config, created_at, updated_at)
    VALUES (?, ?, '1.0.0', '', ?, ?, '{}', ?, ?)
    ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, manifest = excluded.manifest
  `).run(PROVIDER, PROVIDER, JSON.stringify(manifest), enabled ? 1 : 0, new Date().toISOString(), new Date().toISOString());
}

function seedSong(id: string, withCover: boolean) {
  db.insert(songs).values({
    id,
    title: `t-${id}`,
    artist: "a",
    album: "al",
    coverArt: withCover ? `${id}.jpg` : null,
    duration: 100,
    path: "web:cover-fill:netease",
    contentType: "audio/mpeg",
    suffix: "mp3",
    discNumber: 1,
    track: 0,
    genre: "",
    size: 0,
    playCount: 0,
    url: "http://gm:18080/music/download?id=x&source=netease",
    fingerprint: `fp-${id}`,
    type: "web",
    pluginEntry: "cover-fill",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();
}

function clearRows() {
  for (const id of ["cov-a", "cov-b", "cov-c"]) {
    sqlite.prepare("DELETE FROM songs WHERE id = ?").run(id);
  }
  sqlite.prepare("DELETE FROM plugins WHERE id = ?").run(PROVIDER);
  unregisterPlugin(PROVIDER);
}

beforeAll(() => {
  initDatabase();
});

afterAll(() => {
  clearRows();
});

describe("runCoverBackfill — 后台封面回填", () => {
  it("无 coverProvider 时直接跳过,不触发封面获取", async () => {
    registerCoverProvider(false);
    mockedCache.mockClear();
    seedSong("cov-a", false);
    const res = await runCoverBackfill(["cov-a"]);
    expect(mockedCache).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: 0, fail: 0 });
    sqlite.prepare("DELETE FROM songs WHERE id = 'cov-a'").run();
  });

  it("有 coverProvider 时,只为无封面歌曲拉取封面(有封面/不存在的跳过)", async () => {
    registerCoverProvider(true);
    mockedCache.mockClear();
    seedSong("cov-a", false);
    seedSong("cov-b", false);
    seedSong("cov-c", true);

    const res = await runCoverBackfill(["cov-a", "cov-b", "cov-c", "cov-missing"]);

    const calledIds = mockedCache.mock.calls.map((c: any[]) => c[1]).sort();
    expect(calledIds).toEqual(["cov-a", "cov-b"]);
    expect(res).toEqual({ ok: 2, fail: 0 });
    const a = db.select().from(songs).where(eq(songs.id, "cov-a")).get();
    const c = db.select().from(songs).where(eq(songs.id, "cov-c")).get();
    expect(a?.coverArt).toBe("cov-a.jpg");
    expect(c?.coverArt).toBe("cov-c.jpg");
    mockedCache.mockClear();
  });
});