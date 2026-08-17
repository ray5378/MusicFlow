// Unit tests for services/source/online/streamFallback.ts — 换源「歌名+歌手」严格匹配。
//   - 同歌名同歌手 → 换源命中(按 sourcePreference 排序、排除失败源)
//   - 同歌名不同歌手 → 不换源(null,防「点七里香实际播别首」)
//   - 期望曲无歌手 → 仅按歌名换源(向后兼容)
//   - ensurePlayableStream:原 URL 探测失败 → 换源并把替换 URL 写回 songs.url
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../../plugins/_env.js";

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { initDatabase, db, sqlite } from "../../../src/db/index.js";
import { songs } from "../../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { registerPlugin, unregisterPlugin } from "../../../src/plugins/registry.js";
import {
  findFallbackStream,
  ensurePlayableStream,
  clearStreamFallbackCache,
} from "../../../src/services/source/online/streamFallback.js";

const PROVIDER = "gmdl-fb-test";

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
  `http://gm:18080/music/download?id=${song.id}&source=${song.source}&name=${encodeURIComponent(song.name)}`;

// 探测 stub:orig 原 URL 一律 404(触发换源),其余候选 URL 一律 206(可播)。
vi.stubGlobal(
  "fetch",
  async (url: string) =>
    String(url).includes("orig")
      ? new Response("not found", { status: 404 })
      : new Response("stream-bytes", { status: 206 }),
);

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
  return { searchCalls, provider };
}

function seedSong(id: string, opts: { url: string; title?: string | null; artist?: string | null; sourceData?: string | null }) {
  db.insert(songs).values({
    id,
    title: opts.title ?? null,
    artist: opts.artist ?? null,
    album: null,
    coverArt: null,
    duration: 218,
    path: "web:gmdl-fb-test:qq",
    contentType: "audio/mpeg",
    suffix: "mp3",
    discNumber: 1,
    track: 0,
    genre: "",
    size: 0,
    playCount: 0,
    url: opts.url,
    fingerprint: `fp-${id}`,
    type: "web",
    pluginEntry: PROVIDER,
    sourceData: opts.sourceData ?? null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();
}

beforeAll(() => {
  initDatabase();
});

afterEach(() => {
  clearStreamFallbackCache();
  sqlite.prepare("DELETE FROM songs WHERE plugin_entry = ?").run(PROVIDER);
  sqlite.prepare("DELETE FROM plugins WHERE id = ?").run(PROVIDER);
  unregisterPlugin(PROVIDER);
});

afterAll(() => {
  sqlite.prepare("DELETE FROM songs WHERE plugin_entry = ?").run(PROVIDER);
  sqlite.prepare("DELETE FROM plugins WHERE id = ?").run(PROVIDER);
  unregisterPlugin(PROVIDER);
});

describe("findFallbackStream — 换源严格「歌名+歌手」匹配", () => {
  it("同歌名同歌手:换源到偏好源,排除失败源与同名异歌手候选", async () => {
    const { searchCalls } = enableProvider([
      { id: "k1", name: "七里香", artist: "周杰伦", source: "kugou" },
      { id: "n1", name: "七里香", artist: "周杰伦", source: "netease" },
      { id: "q1", name: "七里香", artist: "周杰伦", source: "qq" }, // 失败源,应排除
      { id: "wrong", name: "七里香", artist: "王俊凯", source: "kugou" }, // 同名异歌手,应排除
    ]);

    const fb = await findFallbackStream("s-ok", "七里香", "周杰伦", "七里香", PROVIDER, "qq");

    expect(searchCalls[0]).toBe("七里香 周杰伦");
    expect(fb).toBeTruthy();
    expect(fb!.source).toBe("kugou"); // sourcePreference 优先 kugou
    expect(fb!.url).toContain("id=k1");
  });

  it("同歌名不同歌手 → 不换源(防点七里香播别首)", async () => {
    enableProvider([
      { id: "n1", name: "七里香", artist: "王俊凯", source: "netease" },
    ]);

    const fb = await findFallbackStream("s-wrong", "七里香", "周杰伦", "七里香", PROVIDER, "qq");

    expect(fb).toBeNull();
  });

  it("期望曲无歌手 → 仍按歌名换源(向后兼容)", async () => {
    enableProvider([
      { id: "n1", name: "七里香", artist: "周杰伦", source: "netease" },
    ]);

    const fb = await findFallbackStream("s-noartist", "七里香", "", "", PROVIDER, "qq");

    expect(fb).toBeTruthy();
    expect(fb!.url).toContain("id=n1");
  });

  it("多歌手候选(合作)与期望首位歌手一致即可命中", async () => {
    enableProvider([
      { id: "n1", name: "珊瑚海", artist: "周杰伦、温岚、吴宗宪", source: "netease" },
    ]);

    const fb = await findFallbackStream("s-coop", "珊瑚海", "周杰伦", "八度空间", PROVIDER, "qq");

    expect(fb).toBeTruthy();
    expect(fb!.url).toContain("id=n1");
  });
});

describe("ensurePlayableStream — 原 URL 失败换源并写回", () => {
  it("原 URL 404 → 严格匹配的候选换源并把替换 URL 持久化到 songs.url", async () => {
    enableProvider([
      { id: "n1", name: "七里香", artist: "周杰伦", source: "netease" },
      { id: "wrong", name: "七里香", artist: "王俊凯", source: "netease" },
    ]);
    await seedSong("fb-s1", {
      url: "http://orig/broken.mp3",
      title: "",
      artist: "",
      sourceData: JSON.stringify({ title: "七里香", artist: "周杰伦", source: "qq" }),
    });
    const songRow = db.select().from(songs).where(eq(songs.id, "fb-s1")).get() as any;

    const url = await ensurePlayableStream(songRow);

    // 仅同歌名同歌手的候选被采纳
    expect(url).toContain("id=n1");
    const row = db.select().from(songs).where(eq(songs.id, "fb-s1")).get() as any;
    expect(row.url).toContain("id=n1");
  });

  it("搜不到歌手一致的候选时,不换源也不覆盖原 URL", async () => {
    enableProvider([
      { id: "wrong", name: "七里香", artist: "王俊凯", source: "netease" },
    ]);
    seedSong("fb-s2", {
      url: "http://orig/broken.mp3",
      title: "七里香",
      artist: "周杰伦",
      sourceData: JSON.stringify({ source: "qq" }),
    });
    const songRow = db.select().from(songs).where(eq(songs.id, "fb-s2")).get() as any;

    const url = await ensurePlayableStream(songRow);

    expect(url).toBeNull();
    const row = db.select().from(songs).where(eq(songs.id, "fb-s2")).get() as any;
    expect(row.url).toBe("http://orig/broken.mp3");
  });
});