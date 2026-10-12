// ==================== markUnplayable(完整性判官专用负缓存)专项回归 ====================
//
// v4.6.1 完整性判官把「整首字节已抓到、但内容是试听片段/假成功」写成 streamFallback
// 负缓存(见 prefetchCache.ts 红线 3 的唯一例外)。这条写路径与探测路径**共用同一份
// 数据**(getCachedPlayability 直接读),但语义有三处不同,必须单独钉住:
//   ① TTL 默认 5 分钟(探测路径负 TTL 只有 45s,面向网络抖动)——
//      判据是完整字节跑出来的硬结论,不是一次抖动;又不锁死:平台版权/试听策略会变。
//   ② transient=false —— 「不可播」是**确定**结论,不是「网络异常不可判定」。
//      调用方(getCachedPlayability 的消费者)据此敢跳歌;若误写成 transient 就会
//      退化成「照常播放」,用户又听到 30s 试听片段。
//   ③ 不永久拉黑 —— 过期后自动复活重新探测;且 findFallbackStream 的短路也随
//      过期一起解除(否则负缓存会把换源/探测一起锁死)。
// 另:空 songId 必须空转(不得写出一条 key 为 "" 的脏条目)。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../../plugins/_env.js";

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { initDatabase, db, sqlite } from "../../../src/db/index.js";
import { songs } from "../../../src/db/schema.js";
import { registerPlugin, unregisterPlugin } from "../../../src/plugins/registry.js";
import {
  clearStreamFallbackCache,
  configureStreamFallbackCache,
  findFallbackStream,
  getCachedPlayability,
  markUnplayable,
} from "../../../src/services/source/online/streamFallback.js";

const PROVIDER = "gmdl-markunplayable-test";
const SONG_ID = "mu-song-1";

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

// ---- 可控的时间:只位移 Date.now(),不 fake timers(避免 AbortSignal.timeout 挂死) ----
let nowShift = 0;
const realNow = Date.now;

// ---- 可控的 provider:只关心「有没有被搜索过」,候选一律不匹配 ⇒ 走负结果 ----
const searchCalls: string[] = [];

beforeAll(() => {
  initDatabase();
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + nowShift);
  registerPlugin(manifestOf as any, {
    id: PROVIDER,
    manifest: manifestOf,
    search: async (_config: any, params: any) => {
      searchCalls.push(params.query || "");
      // 返回不匹配的候选 ⇒ 被导入门禁拦掉 ⇒ 走负结果(与「全候选不可播」同形)。
      return { songs: [{ id: "wrong", name: "路人", artist: "某人", album: "别的", duration: 999, source: "netease" }] };
    },
    streamUrl: (_c: any, s: any) => `http://gm:18080/music/download?id=${s.id}&source=${s.source}`,
  } as any);
  sqlite.prepare(`
    INSERT INTO plugins (id, name, version, description, manifest, enabled, config, created_at, updated_at)
    VALUES (?, ?, '1.0.0', '', ?, 1, '{}', ?, ?)
    ON CONFLICT(id) DO UPDATE SET enabled = 1, manifest = excluded.manifest, config = '{}'
  `).run(PROVIDER, PROVIDER, JSON.stringify(manifestOf), new Date().toISOString(), new Date().toISOString());
  db.insert(songs).values({
    id: SONG_ID, title: "恋人", artist: "李荣浩", album: "黑马",
    coverArt: null, duration: 275, path: `web:${PROVIDER}:qq`, contentType: "audio/mpeg",
    suffix: "mp3", discNumber: 1, track: 0, genre: "", size: 0, playCount: 0,
    url: "http://up.example/x.mp3", fingerprint: `fp-${SONG_ID}`, type: "web",
    pluginEntry: PROVIDER, sourceData: JSON.stringify({ source: "qq" }),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } as any).run();
});

afterEach(() => {
  nowShift = 0;
  searchCalls.length = 0;
  clearStreamFallbackCache();
  configureStreamFallbackCache({
    playableTtlMs: 60 * 60 * 1000,
    negativeTtlMs: 45 * 1000,
    transientBackoffMs: 5 * 1000,
  });
});

afterAll(() => {
  sqlite.prepare("DELETE FROM songs WHERE plugin_entry = ?").run(PROVIDER);
  sqlite.prepare("DELETE FROM plugins WHERE id = ?").run(PROVIDER);
  unregisterPlugin(PROVIDER);
});

describe("markUnplayable — 判官负缓存契约(TTL 5min / 非 transient / 可复活)", () => {
  it("写入后即 unplayable,且明确不是 transient(确定结论,调用方敢跳歌)", () => {
    markUnplayable(SONG_ID);
    const v = getCachedPlayability(SONG_ID);
    expect(v).toBe("unplayable");
    expect(v).not.toBe("transient"); // 网络抖动档不会走到这里
    expect(v).not.toBe("unknown");
  });

  it("默认 TTL 5 分钟:4min59s 仍 unplayable,越过 5min 自动复活为 unknown", () => {
    markUnplayable(SONG_ID);
    nowShift = 5 * 60 * 1000 - 1000; // 差 1s 到期
    expect(getCachedPlayability(SONG_ID)).toBe("unplayable");
    nowShift = 5 * 60 * 1000 + 1000; // 过期
    expect(getCachedPlayability(SONG_ID)).toBe("unknown");
  });

  it("可显式覆写 ttlMs(判官按来源性质自定时长)", () => {
    markUnplayable(SONG_ID, { ttlMs: 10_000 });
    nowShift = 9_000;
    expect(getCachedPlayability(SONG_ID)).toBe("unplayable");
    nowShift = 11_000;
    expect(getCachedPlayability(SONG_ID)).toBe("unknown");
  });

  it("空 songId 空转:不抛、不写脏条目(不带 key 为 \"\" 的负缓存)", () => {
    expect(() => markUnplayable("")).not.toThrow();
    expect(() => markUnplayable(undefined as any)).not.toThrow();
    expect(getCachedPlayability("")).toBe("unknown");
  });

  it("负缓存会短路换源查询;过期后短路解除、重新真实探测(不被永久锁死)", async () => {
    markUnplayable(SONG_ID);
    // 短路:直接返回 null,一次搜索都不发起。
    const hit = await findFallbackStream(SONG_ID, "恋人", "李荣浩", "黑马", 275, PROVIDER, "");
    expect(hit).toBeNull();
    expect(searchCalls.length).toBe(0);

    // 越过 5min ⇒ 负缓存过期 ⇒ 重新走真实探测(本例候选不匹配 ⇒ 仍无源,但确实重探了)。
    nowShift = 5 * 60 * 1000 + 1000;
    const after = await findFallbackStream(SONG_ID, "恋人", "李荣浩", "黑马", 275, PROVIDER, "");
    expect(searchCalls.length).toBeGreaterThan(0);
    expect(after).toBeNull(); // 候选仍不匹配 ⇒ 回到负结果(45s 后还会再探)
  });
});
