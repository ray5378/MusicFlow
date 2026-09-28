// 覆盖率长尾补充:services/source/online/recommendImport.ts(此前 0% 覆盖)。
//   - recommendSourceUrl / isDailyRecommendPlaylist / findRecommendPlaylist 的纯逻辑(32-75)
//   - replacePlaylistSongs 的增量语义:新增 / position 漂移校正 / 删除缺失(86-163)
//   - removePlaylistRows:删歌单 + 条目 + 清封面缓存(60-64)
//   - importRecommendPlaylist:未配置早返回(187-190)、空歌单自动删除(200-206)、
//     新建(228-257)与已存在则替换(209-226)
// 上游 provider / 交叉比对 / 在线导入 / 封面缓存全部替身,不真联网。
// 注意 playlists.owner_id → users(id)、playlist_songs.song_id → songs(id) 均有 FK,
// 故所有种子行都引用真实存在的用户/歌曲。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { sqlite } from "../../src/db/index.js";
import { registerPlugin } from "../../src/plugins/registry.js";

const PREFIX = "gmdl://recommend/";
const PROVIDER = "lt3-recommend-prov";

const H = vi.hoisted(() => ({
  configured: null as any,
  importResult: { added: 0, deduped: 0, failed: 0, songs: [] as { id: string; title: string }[] },
  cross: (list: any[]) => ({ verified: list, rejected: 0 }) as { verified: any[]; rejected: number },
}));

vi.mock("../../src/services/source/online/index.js", () => ({
  getConfiguredProvider: () => H.configured,
}));
vi.mock("../../src/services/source/online/match.js", () => ({
  crossVerifySongs: async (_pid: string, _cfg: any, _prov: any, list: any[]) => H.cross(list),
}));
vi.mock("../../src/services/source/online/service.js", () => ({
  importOnlineSongs: async () => H.importResult,
}));
vi.mock("../../src/services/playlistCover.js", () => ({
  cacheRemoteCover: async () => null,
  clearPlaylistCoverCache: () => {},
}));
vi.mock("../../src/services/plugin/shared.js", () => ({
  refreshPlaylistCounts: () => {},
}));

const manifest = {
  id: PROVIDER,
  name: PROVIDER,
  version: "1.0.0",
  type: "source",
  capabilities: ["search", "stream"],
  platforms: ["netease"],
  recommendPrefix: PREFIX,
  configSchema: [],
  permissions: ["net"],
} as const;

beforeAll(() => {
  registerPlugin(manifest as any, {} as any);
});

import {
  recommendSourceUrl,
  isDailyRecommendPlaylist,
  findRecommendPlaylist,
  removePlaylistRows,
  replacePlaylistSongs,
  importRecommendPlaylist,
} from "../../src/services/source/online/recommendImport.js";

const PL = "lt3-rec-pl";
const S = { A: "lt3-rec-sa", B: "lt3-rec-sb", C: "lt3-rec-sc", GONE: "lt3-rec-sgone", OLD: "lt3-rec-sold" };
const ALL_SONGS = Object.values(S);

/** playlists.owner_id 有 FK → users(id):必须用真实存在的用户 id。 */
const OWNER = () => (sqlite.prepare("SELECT id FROM users LIMIT 1").get() as any)?.id as string;

function seedSong(id: string) {
  sqlite
    .prepare(
      "INSERT OR REPLACE INTO songs (id, title, artist, album, duration, path, suffix, type, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
    .run(id, id, "A", "AL", 100, `web:p:/${id}`, "mp3", "web", "", "");
}
function seedPlaylist(id: string, sourceUrl: string | null) {
  sqlite
    .prepare("INSERT OR REPLACE INTO playlists (id, name, owner_id, source_url, created_at, updated_at) VALUES (?,?,?,?,?,?)")
    .run(id, "Rec", OWNER(), sourceUrl, "", "");
}
function seedEntry(playlistId: string, songId: string, position: number) {
  sqlite
    .prepare("INSERT INTO playlist_songs (playlist_id, song_id, position, playable, created_at) VALUES (?,?,?,1,'')")
    .run(playlistId, songId, position);
}
function entries(playlistId: string) {
  return sqlite
    .prepare("SELECT song_id, position FROM playlist_songs WHERE playlist_id = ? ORDER BY position")
    .all(playlistId) as { song_id: string; position: number }[];
}

/** 清掉本文件可能创建的推荐歌单(前缀固定,id 随机)。 */
function clearRecommendPlaylists() {
  sqlite
    .prepare("DELETE FROM playlist_songs WHERE playlist_id IN (SELECT id FROM playlists WHERE source_url LIKE ?)")
    .run(`${PREFIX}%`);
  sqlite.prepare("DELETE FROM playlists WHERE source_url LIKE ?").run(`${PREFIX}%`);
}

beforeEach(() => {
  H.configured = null;
  H.importResult = { added: 0, deduped: 0, failed: 0, songs: [] };
  H.cross = (list: any[]) => ({ verified: list, rejected: 0 });
  // 先删条目再删歌单/歌曲,顺序要满足 FK。
  sqlite.prepare("DELETE FROM playlist_songs WHERE playlist_id = ?").run(PL);
  clearRecommendPlaylists();
  sqlite.prepare("DELETE FROM playlists WHERE id = ?").run(PL);
  sqlite.prepare(`DELETE FROM songs WHERE id IN (${ALL_SONGS.map(() => "?").join(",")})`).run(...ALL_SONGS);
  for (const id of ALL_SONGS) seedSong(id);
});

describe("推荐歌单标识纯逻辑", () => {
  it("recommendSourceUrl 用插件声明前缀拼接;未声明前缀则退化为裸 id(32-52)", () => {
    expect(recommendSourceUrl(PROVIDER, "abc")).toBe(`${PREFIX}abc`);
    // 没有 recommendPrefix 声明的 provider ⇒ 空前缀(无插件则无推荐源)。
    expect(recommendSourceUrl("lt3-no-prefix", "abc")).toBe("abc");
  });

  it("isDailyRecommendPlaylist 只认已注册前缀(55-57)", () => {
    expect(isDailyRecommendPlaylist({ sourceUrl: `${PREFIX}xyz` })).toBe(true);
    expect(isDailyRecommendPlaylist({ sourceUrl: "gmdl://other/xyz" })).toBe(false);
    expect(isDailyRecommendPlaylist({ sourceUrl: null })).toBe(false);
    expect(isDailyRecommendPlaylist({})).toBe(false);
  });

  it("findRecommendPlaylist:指定/省略 providerId 两种匹配(68-75)", () => {
    seedPlaylist(PL, `${PREFIX}daily-1`);
    expect(findRecommendPlaylist("daily-1", PROVIDER)?.id).toBe(PL);
    expect(findRecommendPlaylist("daily-1")?.id).toBe(PL); // 无 providerId ⇒ 扫全库按前缀匹配
    expect(findRecommendPlaylist("lt3-nope", PROVIDER)).toBeNull();
    expect(findRecommendPlaylist("lt3-nope")).toBeNull();
  });
});

describe("replacePlaylistSongs 增量替换", () => {
  it("新增缺失条目 + 校正 position 漂移 + 删除远端已无的条目(86-163)", async () => {
    seedPlaylist(PL, `${PREFIX}daily-2`);
    seedEntry(PL, S.A, 5); // position 漂移:替换后应回到 0
    seedEntry(PL, S.GONE, 1); // 远端已无 ⇒ 应被删除

    await replacePlaylistSongs(PL, [
      { id: S.A, title: "A" },
      { id: S.B, title: "B" },
    ]);

    const rows = entries(PL);
    // 只保留远端仍在的两首,且 position 与远端顺序对齐。
    expect(rows.map((r) => r.song_id)).toEqual([S.A, S.B]);
    expect(rows.map((r) => r.position)).toEqual([0, 1]);
  });

  it("空列表 → 清空该歌单全部条目(150-159 删除批)", async () => {
    seedPlaylist(PL, `${PREFIX}daily-4`);
    seedEntry(PL, S.A, 0);
    await replacePlaylistSongs(PL, []);
    expect(entries(PL)).toHaveLength(0);
  });
});

describe("removePlaylistRows", () => {
  it("删歌单行 + 条目 + 清封面缓存(60-63)", () => {
    seedPlaylist(PL, `${PREFIX}daily-3`);
    seedEntry(PL, S.A, 0);

    removePlaylistRows(PL);

    expect(sqlite.prepare("SELECT id FROM playlists WHERE id = ?").get(PL)).toBeUndefined();
    expect(entries(PL)).toHaveLength(0);
  });
});

describe("importRecommendPlaylist", () => {
  const info = (id: string, name = "每日推荐") =>
    ({ id, name, source: "netease", songCount: 0 } as any);

  it("provider 无 playlistSongs 能力 → 早返回 success:false(187-190)", async () => {
    H.configured = null;
    const r = await importRecommendPlaylist("lt3-unknown-prov", info("d0"));
    expect(r.success).toBe(false);
    expect(r.created).toBe(false);
    expect(r.trackCount).toBe(0);
    expect(r.added).toBe(0);
  });

  it("远端歌单为空 → 自动删除已导入的本地歌单,不留空占位(200-206)", async () => {
    H.configured = { config: {}, provider: { playlistSongs: async () => ({ songs: [] }) } };
    H.importResult = { added: 0, deduped: 0, failed: 0, songs: [] };
    seedPlaylist(PL, `${PREFIX}d5`); // 已导入过同一个远端歌单

    const r = await importRecommendPlaylist(PROVIDER, info("d5"));

    expect(r.success).toBe(false);
    expect(r.trackCount).toBe(0);
    // 空歌单不保留占位:本地行被删掉。
    expect(sqlite.prepare("SELECT id FROM playlists WHERE id = ?").get(PL)).toBeUndefined();
  });

  it("首次导入 → 新建本地歌单并写入带标记的 source_url(228-257)", async () => {
    H.configured = { config: {}, provider: { playlistSongs: async () => ({ songs: [{ id: "d6s1" }] }) } };
    H.importResult = { added: 2, deduped: 0, failed: 0, songs: [{ id: S.A, title: "A" }, { id: S.B, title: "B" }] };

    const r = await importRecommendPlaylist(PROVIDER, info("d6", "这是一个非常非常长的每日推荐歌单名字"), { userId: OWNER() });

    expect(r.success).toBe(true);
    expect(r.created).toBe(true);
    expect(r.trackCount).toBe(2);
    const row = sqlite
      .prepare("SELECT id, source_url, external_id, comment, name FROM playlists WHERE source_url = ?")
      .get(`${PREFIX}d6`) as any;
    expect(row).toBeTruthy();
    expect(row.external_id).toBe("d6");
    expect(row.comment).toBe("每日推荐歌单·netease"); // 平台注释标记
    // 名称过长被截断(保留平台标签可见)。
    expect([...row.name].length).toBeLessThanOrEqual(19);
    expect(entries(row.id).map((x) => x.song_id)).toEqual([S.A, S.B]);
  });

  it("已存在同源歌单 → 复用并替换曲目(created:false)(209-226)", async () => {
    H.configured = { config: {}, provider: { playlistSongs: async () => ({ songs: [{ id: "d7s1" }] }) } };
    H.importResult = { added: 1, deduped: 0, failed: 0, songs: [{ id: S.C, title: "C" }] };
    seedPlaylist(PL, `${PREFIX}d7`);
    seedEntry(PL, S.OLD, 0);

    const r = await importRecommendPlaylist(PROVIDER, info("d7"));

    expect(r.success).toBe(true);
    expect(r.created).toBe(false);
    expect(r.playlistId).toBe(PL);
    // 旧曲目被替换为今日推荐。
    expect(entries(PL).map((x) => x.song_id)).toEqual([S.C]);
  });
});
