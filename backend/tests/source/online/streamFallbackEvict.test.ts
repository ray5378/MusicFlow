// 守卫测试：evictStreamFallbackCache —— 失效源缓存必须能被逐出（P1-1）。
//
// 背景：换源直链（网易等约 20 分钟过期）一旦进 fallbackCache/playableCache，
// 两个缓存都是「命中即返回、不重探」，过期链会被锁死到 FIFO 淘汰或服务重启。
// 契约：拉流实测失败 → evict 该歌双缓存 → 下次 findFallbackStream /
// ensurePlayableStream 必须重新走真实搜索/探测。删掉或改坏 evict 即 CI 红。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../../plugins/_env.js";

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { initDatabase, db, sqlite } from "../../../src/db/index.js";
import { songs } from "../../../src/db/schema.js";
import { registerPlugin, unregisterPlugin } from "../../../src/plugins/registry.js";
import { eq } from "drizzle-orm";
import {
  findFallbackStream,
  ensurePlayableStream,
  evictStreamFallbackCache,
  clearStreamFallbackCache,
} from "../../../src/services/source/online/streamFallback.js";

const PROVIDER = "gmdl-evict-test";

const manifestOf = {
  id: PROVIDER,
  name: PROVIDER,
  version: "1.0.0",
  type: "source",
  capabilities: ["search", "stream"],
  platforms: ["netease", "kugou", "qq"],
  configSchema: [],
  permissions: ["net"],
  sourcePreference: ["kugou", "netease", "qq"],
} as const;

const fakeConfig = { baseUrl: "http://gm:18080" };
const streamUrl = (_config: any, song: any) =>
  `http://gm:18080/music/download?id=${song.id}&source=${song.source}`;

// 探测计数：所有候选 URL 一律 206（可播），统计真实探测次数。
let probeCount = 0;
vi.stubGlobal(
  "fetch",
  async (_url: string) => {
    probeCount++;
    return new Response("stream-bytes", { status: 206 });
  },
);

const CANDIDATES = [
  { id: "k1", name: "七里香", artist: "周杰伦", album: "七里香", duration: 240, source: "kugou" },
  { id: "n1", name: "七里香", artist: "周杰伦", album: "七里香", duration: 240, source: "netease" },
];

function enableProvider(cands: any[]) {
  const searchCalls: string[] = [];
  const provider = {
    id: PROVIDER,
    manifest: manifestOf,
    search: async (_config: any, params: any) => {
      searchCalls.push(params.query || "");
      return { songs: cands };
    },
    streamUrl,
  };
  registerPlugin(manifestOf as any, provider);
  sqlite.prepare(`
    INSERT INTO plugins (id, name, version, description, manifest, enabled, config, created_at, updated_at)
    VALUES (?, ?, '1.0.0', '', ?, 1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET enabled = 1, config = excluded.config, manifest = excluded.manifest
  `).run(PROVIDER, PROVIDER, JSON.stringify(manifestOf), JSON.stringify(fakeConfig), new Date().toISOString(), new Date().toISOString());
  return { searchCalls };
}

function seedSong(id: string, url: string) {
  db.insert(songs).values({
    id,
    title: "七里香",
    artist: "周杰伦",
    album: "七里香",
    coverArt: null,
    duration: 240,
    path: `web:${PROVIDER}:netease`,
    contentType: "audio/mpeg",
    suffix: "mp3",
    discNumber: 1,
    track: 0,
    genre: "",
    size: 0,
    playCount: 0,
    url,
    fingerprint: `fp-${id}`,
    type: "web",
    pluginEntry: PROVIDER,
    sourceData: JSON.stringify({ source: "netease" }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();
}

beforeAll(() => {
  initDatabase();
});

afterEach(() => {
  clearStreamFallbackCache();
  probeCount = 0;
  sqlite.prepare("DELETE FROM songs WHERE plugin_entry = ?").run(PROVIDER);
  sqlite.prepare("DELETE FROM plugins WHERE id = ?").run(PROVIDER);
  sqlite.prepare("DELETE FROM plugins WHERE id = 'core-stream-fallback'").run();
  unregisterPlugin(PROVIDER);
});

afterAll(() => {
  sqlite.prepare("DELETE FROM songs WHERE plugin_entry = ?").run(PROVIDER);
  sqlite.prepare("DELETE FROM plugins WHERE id = ?").run(PROVIDER);
  unregisterPlugin(PROVIDER);
});

describe("evictStreamFallbackCache — 失效源缓存逐出契约", () => {
  it("findFallbackStream: 缓存命中不再重搜,evict 后必须重新真实搜索", async () => {
    const { searchCalls } = enableProvider(CANDIDATES);

    const first = await findFallbackStream("s-evict-1", "七里香", "周杰伦", "七里香", 240, PROVIDER, "netease");
    expect(first?.source).toBe("kugou"); // 真实搜索命中
    expect(searchCalls.length).toBe(1);

    const cached = await findFallbackStream("s-evict-1", "七里香", "周杰伦", "七里香", 240, PROVIDER, "netease");
    expect(cached?.source).toBe(""); // 缓存命中标记（过期链锁死的根因）
    expect(searchCalls.length).toBe(1); // 不重搜

    evictStreamFallbackCache("s-evict-1");

    const after = await findFallbackStream("s-evict-1", "七里香", "周杰伦", "七里香", 240, PROVIDER, "netease");
    expect(after?.source).toBe("kugou"); // 逐出后重新真实搜索
    expect(searchCalls.length).toBe(2);
  });

  it("ensurePlayableStream: playableCache 命中不再探测,evict 后必须重新探测", async () => {
    enableProvider(CANDIDATES);
    seedSong("s-evict-2", "http://gm:18080/orig/s-evict-2");
    const song = db.select().from(songs).where(eq(songs.id, "s-evict-2")).get() as any;

    const first = await ensurePlayableStream(song);
    expect(first).toBeTruthy();
    const probesAfterFirst = probeCount;
    expect(probesAfterFirst).toBeGreaterThan(0);

    const second = await ensurePlayableStream(song);
    expect(second).toBeTruthy();
    expect(probeCount).toBe(probesAfterFirst); // 缓存命中:零探测

    evictStreamFallbackCache("s-evict-2");

    await ensurePlayableStream(song);
    expect(probeCount).toBeGreaterThan(probesAfterFirst); // 逐出后重新探测
  });

  it("evict 只逐出指定 songId,不影响其它歌曲的缓存", async () => {
    const { searchCalls } = enableProvider(CANDIDATES);

    await findFallbackStream("s-evict-a", "七里香", "周杰伦", "七里香", 240, PROVIDER, "netease");
    await findFallbackStream("s-evict-b", "七里香", "周杰伦", "七里香", 240, PROVIDER, "netease");
    expect(searchCalls.length).toBe(2);

    evictStreamFallbackCache("s-evict-a");
    await findFallbackStream("s-evict-b", "七里香", "周杰伦", "七里香", 240, PROVIDER, "netease");
    expect(searchCalls.length).toBe(2); // b 仍是缓存命中

    await findFallbackStream("s-evict-a", "七里香", "周杰伦", "七里香", 240, PROVIDER, "netease");
    expect(searchCalls.length).toBe(3); // 只有 a 被逐出
  });
});
