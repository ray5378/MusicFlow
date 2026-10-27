// ==================== 正缓存不得覆盖未过期的负缓存（2026-10-27 第四刀） ====================
//
// 事故（《纵身一跃》）：VIP 试听源的**直链能 200/206 正常解析** —— 错的是内容只有 60s，
// 不是源不存在。于是队列预解析（RESOLVE-AUDIO）每次都顺利写下「可播」正缓存（1h），
// 把判官刚写的负缓存盖住；`getCachedPlayability` 读正缓存优先 ⇒ 判跳失效，照播 60s。
//
// 真凶是**并发竞态**，不是顺序覆盖：
//   ensurePlayableStream 在 `await probe()`（网络 I/O，最长 12s）飞行中，
//   判官在 prefetchCache 里落 `markUnplayable(songId)`；等 probe 返回 206 ok，
//   第 721 行 addPlayable 又把正缓存写回去 —— 负缓存当场被盖。
//   单线程顺序调用反而看不出来（那时会被 fallback 短路挡住），
//   所以本文件用「可控 gate 的 fetch」把 probe 悬停，复现飞行期落负缓存。
//
// 本文件锁住修复后的契约：
//   ① markUnplayable 立即清掉该歌的正缓存（不许两条矛盾结论并存）；
//   ② 负缓存未过期期间，源解析成功也不得写正缓存（含 probe 飞行中落负缓存的竞态）；
//   ③ 负缓存过期后（源可能已恢复）正缓存自动解禁 —— 不永久拉黑。
// DATA_DIR 隔离由 vitest 的 tests/setup.ts 统一负责。
import { beforeAll, afterEach, afterAll, describe, expect, it, vi } from "vitest";
import { initDatabase, db, sqlite } from "../../../src/db/index.js";
import { songs } from "../../../src/db/schema.js";
import { registerPlugin, unregisterPlugin } from "../../../src/plugins/registry.js";
import {
  clearStreamFallbackCache,
  configureStreamFallbackCache,
  ensurePlayableStream,
  getCachedPlayability,
  markUnplayable,
} from "../../../src/services/source/online/streamFallback.js";

const PROVIDER = "gmdl-shadow-test";
const SONG_ID = "shadow-song-1";
const TWO_HOURS = 2 * 60 * 60 * 1000;

/** 一把可手动放行的门：用来把 probe 悬停在网络 I/O 上，制造竞态窗口。 */
type Gate = { promise: Promise<Response>; release: (r: Response) => void };
function makeGate(): Gate {
  let release!: (r: Response) => void;
  const promise = new Promise<Response>((res) => {
    release = res;
  });
  return { promise, release };
}

const OK_206 = () => new Response("bytes", { status: 206, headers: { "content-type": "audio/mpeg" } });

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

let nowShift = 0;
const realNow = Date.now;

/** 取本用例的歌行（ensurePlayableStream 需要真实行）。 */
const songRowOf = () => db.select().from(songs).all().find((s: any) => s.id === SONG_ID) as any;

beforeAll(() => {
  initDatabase();
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + nowShift);
  registerPlugin(manifestOf as any, {
    id: PROVIDER,
    manifest: manifestOf,
    // 不给候选 ⇒ 换源必然无解，可播性完全由「原链 206」决定。
    search: async () => ({ songs: [] }),
    streamUrl: (_c: any, s: any) => `http://gm:18080/music/download?id=${s.id}&source=${s.source}`,
  } as any);
  sqlite
    .prepare(
      "INSERT INTO plugins (id, name, version, description, manifest, enabled, config, created_at, updated_at) VALUES (?, ?, '1.0.0', '', ?, 1, '{}', ?, ?) ON CONFLICT(id) DO UPDATE SET enabled = 1",
    )
    .run(PROVIDER, PROVIDER, JSON.stringify(manifestOf), new Date().toISOString(), new Date().toISOString());
  db.insert(songs)
    .values({
      id: SONG_ID,
      title: "恋人",
      artist: "李荣浩",
      album: "黑马",
      coverArt: null,
      duration: 275,
      path: `web:${PROVIDER}:qq`,
      contentType: "audio/mpeg",
      suffix: "mp3",
      discNumber: 1,
      track: 0,
      genre: "",
      size: 0,
      playCount: 0,
      url: "http://orig/x.mp3",
      fingerprint: `fp-${SONG_ID}`,
      type: "web",
      pluginEntry: PROVIDER,
      sourceData: JSON.stringify({ source: "qq" }),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any)
    .run();
});

afterEach(() => {
  nowShift = 0;
  clearStreamFallbackCache();
  configureStreamFallbackCache({
    playableTtlMs: 60 * 60 * 1000,
    negativeTtlMs: TWO_HOURS,
    transientBackoffMs: 5 * 1000,
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  sqlite.prepare("DELETE FROM songs WHERE plugin_entry = ?").run(PROVIDER);
  sqlite.prepare("DELETE FROM plugins WHERE id = ?").run(PROVIDER);
  unregisterPlugin(PROVIDER);
});

describe("正缓存不得盖住负缓存（判跳才看得见）", () => {
  it("源解析成功先写正缓存 → playable", async () => {
    vi.stubGlobal("fetch", async () => OK_206());
    expect(await ensurePlayableStream(songRowOf())).toBe("http://orig/x.mp3");
    expect(getCachedPlayability(SONG_ID)).toBe("playable");
  });

  it("判死写负缓存后：正缓存被立即清掉 ⇒ 连源都不探，直接短路（旧代码这里返回 url 照播 60s）", async () => {
    vi.stubGlobal("fetch", async () => OK_206());
    await ensurePlayableStream(songRowOf()); // 先制造正缓存
    expect(getCachedPlayability(SONG_ID)).toBe("playable");
    markUnplayable(SONG_ID);
    expect(getCachedPlayability(SONG_ID)).toBe("unplayable");
    expect(await ensurePlayableStream(songRowOf())).toBeNull();
  });

  it("负缓存未过期期间：源再解析成功也不得翻回 playable（《纵身一跃》防线）", async () => {
    vi.stubGlobal("fetch", async () => OK_206());
    markUnplayable(SONG_ID);
    expect(await ensurePlayableStream(songRowOf())).toBeNull();
    expect(getCachedPlayability(SONG_ID)).toBe("unplayable"); // 关键：不许被正缓存盖住
  });

  it("并发竞态（真凶）：probe 飞行中判官落下负缓存 ⇒ resolve 回来不许把正缓存写回去", async () => {
    const gate = makeGate();
    vi.stubGlobal("fetch", async () => gate.promise);
    const inFlight = ensurePlayableStream(songRowOf());
    await new Promise((r) => setTimeout(r, 0)); // 让 ensurePlayableStream 走到 await probe 并悬停
    expect(getCachedPlayability(SONG_ID)).toBe("unknown"); // 此刻还没落任何结论
    markUnplayable(SONG_ID); // 判官在 probe 飞行期落负缓存（prefetchCache 的真实时序）
    gate.release(OK_206()); // 上游 206 可解析 —— 源是活的，错的是内容
    await inFlight;
    expect(getCachedPlayability(SONG_ID)).toBe("unplayable"); // ★ 关键：不许被 206 翻回 playable
    expect(await ensurePlayableStream(songRowOf())).toBeNull(); // 下一次调用：判跳可见
  });

  it("负缓存过期后：正缓存解禁（源恢复自动复活，不永久拉黑）", async () => {
    vi.stubGlobal("fetch", async () => OK_206());
    markUnplayable(SONG_ID);
    nowShift = TWO_HOURS + 1_000; // 越过负缓存 TTL
    expect(await ensurePlayableStream(songRowOf())).toBe("http://orig/x.mp3");
    expect(getCachedPlayability(SONG_ID)).toBe("playable");
  });
});
