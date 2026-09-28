// 覆盖率长尾补充:services/source/online/service.ts 的残余分支。
//   - planArtist / planAlbum 的「缓存未命中 → 回查 DB 命中」路径(51-53 / 71-73)
//   - bilibili 源需要 Referer 头(187)
//   - gate="verify" 无比对对象时降级放行(311-313) / 部分通过(386-387) / 失败计数(472-473)
//   - gate="verify" 单首被拒 → 明确报错(343-347);通过 → 继续入库(348)
//   - 封面限流器抛错 → 该首 failed、整批不中断(474-477)
//   - 后台封面回填 reject → 被 .catch 吞掉(491-493)
//   - 整批被门禁拒 → 直接返回 rejected(383-385);批量预载命中既有指纹 → deduped(399-401)
// match/covers 用替身;provider 走内存注册表 + DB enabled 行,不真联网。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { db, sqlite } from "../../src/db/index.js";
import { songs, artists, albums, plugins } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { registerPlugin } from "../../src/plugins/registry.js";

const H = vi.hoisted(() => ({
  coverLimitReject: false,
  backfillRejects: false,
  cross: (list: any[]) => ({ verified: list, rejected: 0 }) as { verified: any[]; rejected: number },
}));

vi.mock("../../src/services/covers.js", () => ({
  // 真实签名:withCoverLimit 同步返回 fn() 的 Promise(不是 async 包裹)。
  withCoverLimit: (fn: () => any) =>
    H.coverLimitReject ? Promise.reject(new Error("cover slot boom")) : fn(),
  runCoverBackfill: async () => {
    if (H.backfillRejects) throw new Error("backfill boom");
    return { ok: 0, fail: 0 };
  },
}));

vi.mock("../../src/services/source/online/match.js", () => ({
  crossVerifySongs: async (_pid: string, _cfg: any, _prov: any, list: any[]) => H.cross(list),
}));

const PROVIDER = "lt3-online-prov";
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

const EX_ARTIST = "lt3-ex-artist";
const EX_ALBUM = "lt3-ex-album";
const SONG_IDS = ["lt3-os-1", "lt3-os-2", "lt3-os-3", "lt3-os-4"];

beforeAll(() => {
  registerPlugin(manifestOf as any, provider);
  sqlite
    .prepare(
      "INSERT INTO plugins (id, name, version, description, manifest, enabled, config, created_at, updated_at) VALUES (?,?,?,?,?,1,?,?,?) ON CONFLICT(id) DO UPDATE SET enabled = 1, config = excluded.config",
    )
    .run(PROVIDER, PROVIDER, "1.0.0", "", JSON.stringify(manifestOf), "{}", new Date().toISOString(), new Date().toISOString());
});

beforeEach(() => {
  H.coverLimitReject = false;
  H.backfillRejects = false;
  H.cross = (list: any[]) => ({ verified: list, rejected: 0 });
  sqlite.prepare("DELETE FROM songs WHERE plugin_entry = ?").run(PROVIDER);
  sqlite.prepare("DELETE FROM albums WHERE id = ?").run(EX_ALBUM);
  sqlite.prepare("DELETE FROM artists WHERE id = ?").run(EX_ARTIST);
});

function seedExistingArtistAlbum() {
  const now = new Date().toISOString();
  db.insert(artists).values({ id: EX_ARTIST, name: "LT Existing Artist", albumCount: 0, createdAt: now, updatedAt: now }).run();
  db.insert(albums)
    .values({ id: EX_ALBUM, name: "LT Existing Album", artistId: EX_ARTIST, artist: "LT Existing Artist", year: 0, genre: "", coverArt: null, songCount: 0, duration: 0, createdAt: now, updatedAt: now })
    .run();
}

import { importOnlineSong, importOnlineSongs } from "../../src/services/source/online/service.js";

describe("planArtist/planAlbum:回查 DB 命中", () => {
  it("单首导入时歌手/专辑缓存为空 → 回查 DB 复用既有行(51-53 / 71-73)", async () => {
    seedExistingArtistAlbum();
    const r = await importOnlineSong(
      PROVIDER,
      { id: "lt3-os-1", source: "netease", name: "LT Song 1", artist: "LT Existing Artist", album: "LT Existing Album", duration: 200 },
      { gate: "skip" },
    );
    expect(r.success).toBe(true);
    const row = sqlite.prepare("SELECT artist_id, album_id FROM songs WHERE plugin_entry = ?").get(PROVIDER) as any;
    // 复用的前提是「查到了既有行」;若走的是新建分支这里会是随机 uuid。
    expect(row.artist_id).toBe(EX_ARTIST);
    expect(row.album_id).toBe(EX_ALBUM);
  });
});

describe("bilibili 源", () => {
  it("source=bilibili 时写入 Referer 头,其它源为空对象(187)", async () => {
    await importOnlineSong(
      PROVIDER,
      { id: "lt3-os-2", source: "bilibili", name: "Bili Song", artist: "BiliArtist", album: "BiliAlbum", duration: 100 },
      { gate: "skip" },
    );
    const rows = sqlite
      .prepare("SELECT stream_headers, source_data FROM songs WHERE plugin_entry = ?")
      .all(PROVIDER) as any[];
    const bili = rows.find((r) => String(r.source_data).includes("bilibili"));
    expect(bili).toBeTruthy();
    expect(JSON.parse(bili.stream_headers)).toEqual({ Referer: "https://www.bilibili.com/" });

    await importOnlineSong(
      PROVIDER,
      { id: "lt3-os-3", source: "netease", name: "Netease Song", artist: "NeArtist", album: "NeAlbum", duration: 100 },
      { gate: "skip" },
    );
    const rows2 = sqlite
      .prepare("SELECT stream_headers, source_data FROM songs WHERE plugin_entry = ?")
      .all(PROVIDER) as any[];
    const ne = rows2.find((r) => String(r.source_data).includes("netease"));
    expect(ne).toBeTruthy();
    expect(JSON.parse(ne.stream_headers)).toEqual({});
  });
});

describe("gate=verify 组合", () => {
  it("整批被门禁拒 → 直接返回 rejected,不入库(383-385)", async () => {
    H.cross = () => ({ verified: [], rejected: 3 });
    const r = await importOnlineSongs(
      PROVIDER,
      [{ id: "lt3-os-r1", source: "netease", name: "R1", artist: "A", album: "AL", duration: 100 }],
    );
    expect(r.added).toBe(0);
    expect(r.deduped).toBe(0);
    expect(r.rejected).toBe(3);
    expect(r.songs).toHaveLength(0);
    // 全批被拒 ⇒ 一行都不该落库。
    expect(sqlite.prepare("SELECT id FROM songs WHERE plugin_entry = ?").all(PROVIDER)).toHaveLength(0);
  });

  it("provider 未配置/无 provider → gateVerify 降级放行,随后逐首因未配置失败(311-313 / 386-387 / 472-473)", async () => {
    const r = await importOnlineSongs(
      "lt3-does-not-exist",
      [{ id: "x1", source: "netease", name: "X", artist: "A", album: "AL", duration: 100 }],
    );
    // 没有比对对象时门禁不拒整批(降级),但入库阶段仍会因为 provider 未配置而失败。
    expect(r.rejected).toBeUndefined();
    expect(r.failed).toBe(1);
    expect(r.added).toBe(0);
  });

  it("单首被门禁拒 → 明确报错且不入库(343-347)", async () => {
    H.cross = () => ({ verified: [], rejected: 2 });
    const r = await importOnlineSong(
      PROVIDER,
      { id: "lt3-os-4", source: "netease", name: "Rejected", artist: "A", album: "AL", duration: 100 },
    );
    expect(r.success).toBe(false);
    expect(r.error).toContain("未通过导入门禁");
    expect(sqlite.prepare("SELECT id FROM songs WHERE plugin_entry = ?").all(PROVIDER)).toHaveLength(0);
  });

  it("单首通过门禁 → 正常入库(348)", async () => {
    const r = await importOnlineSong(
      PROVIDER,
      { id: "lt3-os-4", source: "netease", name: "Accepted", artist: "A", album: "AL", duration: 100 },
    );
    expect(r.success).toBe(true);
    expect(sqlite.prepare("SELECT id FROM songs WHERE plugin_entry = ?").all(PROVIDER)).toHaveLength(1);
  });
});

describe("失败面", () => {
  it("批量预载命中既有指纹 → 该首计 deduped,不重复入库(399-401)", async () => {
    const now = new Date().toISOString();
    // 预置一条与待导歌曲同指纹的行:批量预载必须在 IN 查询里命中它。
    sqlite
      .prepare(
        "INSERT OR REPLACE INTO songs (id, title, artist, album, duration, path, suffix, type, plugin_entry, fingerprint, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run("lt3-os-dup-row", "Dup", "A", "AL", 100, "web:p:/dup", "mp3", "web", PROVIDER, `${PROVIDER}:netease:lt3-os-dup`, now, now);

    const r = await importOnlineSongs(
      PROVIDER,
      [{ id: "lt3-os-dup", source: "netease", name: "Dup", artist: "A", album: "AL", duration: 100 }],
      { gate: "skip" },
    );
    expect(r.deduped).toBe(1);
    expect(r.added).toBe(0);
  });

  it("封面限流器抛错 → 该首 failed,整批不中断(474-477)", async () => {
    H.coverLimitReject = true;
    const r = await importOnlineSongs(
      PROVIDER,
      [{ id: "lt3-os-cover", source: "netease", name: "CoverSong", artist: "A", album: "AL", duration: 100, cover: "https://example.com/c.jpg" }],
      { gate: "skip" },
    );
    expect(r.failed).toBe(1);
    expect(r.added).toBe(0);
  });

  it("后台封面回填 reject → 被 catch 吞掉,不影响导入结果(491-493)", async () => {
    H.backfillRejects = true;
    const r = await importOnlineSongs(
      PROVIDER,
      [{ id: "lt3-os-5", source: "netease", name: "Backfill", artist: "A", album: "AL", duration: 100 }],
      { gate: "skip" },
    );
    expect(r.added).toBe(1);
    // 让 runCoverBackfill 的 rejection 走完 .catch,模拟真实事件循环(不得有 unhandled rejection)。
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});
