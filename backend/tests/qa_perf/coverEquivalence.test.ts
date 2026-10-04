// QA 独立验证 · P0-2 封面语义等价(不依赖工程师测试)
//
// 目标:证明新逻辑 resolveRowCover(main-SQL 的 cover_art + 正则 + resolveCoverFile)
// 与旧逻辑 getPlaylistCover(id) 在**同一批歌单**上逐字段等价,尤其三个边界:
//   (a) cover_art 为 null/空 → 两者都必须 null(不能因短路顺序返回 pl-<id>)
//   (b) cover_art 无扩展名(abc123)→ 正则不匹配 → 两者都必须 null
//   (c) cover_art 带 .jpg 但文件不存在 → 两者都必须 null(resolveCoverFile 兜住)
// 另覆盖生产真实形态:cover_art = "<uuid>.jpg"(带扩展名但非 pl- 前缀)。
//
// MUST be first import:隔离 DATA_DIR。
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import { initDatabase, sqlite } from "../../src/db/index.js";
import { registerBuiltinPlugins } from "../../src/plugins/builtins.js";
import {
  clearCoverResolveCache,
  getPlaylistCover,
  listPlayableCoverRefs,
  resolveCoverFile,
} from "../../src/services/playlistCover.js";
import {
  recommendLocalPlatforms,
  invalidatePlatformPool,
  LOCAL_PLATFORM_REC_PLUGIN_ID,
} from "../../src/services/plugin/localPlatformRecommend.js";

const NOW = "2026-09-27T00:00:00.000Z";
let owner = "";

function coversDir(): string {
  return path.join(process.env.DATA_DIR as string, "covers");
}
function writeCover(name: string) {
  fs.mkdirSync(coversDir(), { recursive: true });
  fs.writeFileSync(path.join(coversDir(), name), "x");
}

function seedPlaylist(
  id: string,
  platform: string | null,
  opts: { name?: string; coverArt?: string | null; songCount?: number } = {},
) {
  sqlite
    .prepare(
      `INSERT INTO playlists (id, name, owner_id, is_public, comment, cover_art, song_count, duration,
                              sync_enabled, source_platform, created_at, updated_at)
       VALUES (?,?,?,1,'',?,?,0,0,?,?,?)`,
    )
    .run(id, opts.name ?? id, owner, opts.coverArt ?? null, opts.songCount ?? 0, platform, NOW, NOW);
}

function seedPlayableSong(playlistId: string, songId: string, coverRef: string | null) {
  sqlite
    .prepare(
      `INSERT INTO songs (id, title, artist, album, duration, path, suffix, type, cover_art, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(songId, songId, "A", "Al", 100, `l:src:/tmp/${songId}.mp3`, "mp3", "local", coverRef, NOW);
  sqlite
    .prepare(`INSERT INTO playlist_songs (playlist_id, song_id, position, playable, created_at) VALUES (?,?,?,1,?)`)
    .run(playlistId, songId, 0, NOW);
}

function setPluginConfig(cfg: Record<string, unknown>, enabled = 1) {
  sqlite
    .prepare("UPDATE plugins SET config = ?, enabled = ? WHERE name = ?")
    .run(JSON.stringify(cfg), enabled, LOCAL_PLATFORM_REC_PLUGIN_ID);
}

type Kind = "self" | "song" | "null";

/** 旧逻辑(参考实现):精确复刻改动前的判定。 */
function oldKind(id: string): Kind {
  if (getPlaylistCover(id)) return "self"; // 非空 → 旧代码返回 pl-<id>
  if (listPlayableCoverRefs(id).length > 0) return "song"; // 兜底抽歌内封面
  return "null";
}

/** 新逻辑:从 recommendLocalPlatforms() 的输出反推判定类别。 */
function newKind(pl: { id: string; coverArt: string | null }): Kind {
  if (pl.coverArt === null || pl.coverArt === undefined) return "null";
  if (pl.coverArt === `pl-${pl.id}`) return "self";
  return "song";
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  registerBuiltinPlugins();
  const admin = sqlite.prepare("SELECT id FROM users WHERE is_admin = 1 LIMIT 1").get() as any;
  if (admin) owner = admin.id;
  else {
    sqlite
      .prepare(
        "INSERT INTO users (id, username, password, salt, subsonic_salt, pass_enc, is_admin, is_active, email, created_at, updated_at) VALUES ('u1','admin','','s','ss','',1,1,'a@b.c',?,?)",
      )
      .run(NOW, NOW);
    owner = "u1";
  }
});

beforeEach(() => {
  sqlite.prepare("DELETE FROM playlist_songs").run();
  sqlite.prepare("DELETE FROM playlists").run();
  sqlite.prepare("DELETE FROM songs").run();
  clearCoverResolveCache();
  invalidatePlatformPool();
  setPluginConfig({ homeCount: 50 }, 1);
});

describe("P0-2 封面语义等价(旧 getPlaylistCover vs 新 resolveRowCover)", () => {
  it("三个边界 + 生产形态逐字段等价", () => {
    // (正常)自身封面,小写扩展名,文件存在 → self
    writeCover("pl-p-lower.jpg");
    seedPlaylist("p-lower", "netease", { coverArt: "pl-p-lower.jpg" });
    // (正常)大写扩展名,正则 /i 命中,文件存在 → self
    writeCover("pl-p-upper.PNG");
    seedPlaylist("p-upper", "netease", { coverArt: "pl-p-upper.PNG" });
    // (边界 c)带 .jpg 但文件不存在 → 无歌 → null
    seedPlaylist("p-missing", "netease", { coverArt: "pl-p-missing.jpg" });
    // (边界 b)无扩展名 → 正则不匹配 → null
    seedPlaylist("p-noext", "netease", { coverArt: "abc123" });
    // (边界 b 强化)无扩展名但**磁盘上真有同名文件** → 正则不匹配必须仍判 null;
    //   若"正则被去掉"会 resolveCoverFile 命中 → 返回 pl-<id>(语义漂移,变异可检出)
    writeCover("noextcover");
    seedPlaylist("p-noext-exists", "netease", { coverArt: "noextcover" });
    // (边界 a)空串 → null
    seedPlaylist("p-empty", "netease", { coverArt: "" });
    // (边界 a)null → null
    seedPlaylist("p-null", "netease", { coverArt: null });
    // (生产形态)<uuid>.jpg 带扩展名但非 pl- 前缀,文件存在 → self(getPlaylistCover 亦非空)
    writeCover("d5279072-4950-4d41-a473-fc380a6858f5.jpg");
    seedPlaylist("p-uuid", "netease", { coverArt: "d5279072-4950-4d41-a473-fc380a6858f5.jpg" });
    // (生产形态)<uuid>.jpg 文件不存在 → null
    seedPlaylist("p-uuid-miss", "netease", { coverArt: "deadbeef-0000-0000-0000-000000000000.jpg" });
    // (兜底)无自身封面,但有可播歌封面文件 → song
    writeCover("cv-song.jpg");
    seedPlaylist("p-fallback", "netease", { coverArt: null });
    seedPlayableSong("p-fallback", "s-cv1", "cv-song.jpg");
    // (兜底缺失)无自身封面,歌封面文件不存在 → null
    seedPlaylist("p-fallback-miss", "netease", { coverArt: null });
    seedPlayableSong("p-fallback-miss", "s-cv2", "cv-missing.jpg");
    // (混合)自身封面文件不存在,但有可播歌封面 → song(两条路径都必须落到兜底)
    seedPlaylist("p-selfmiss-song", "netease", { coverArt: "pl-p-selfmiss-song.jpg" });
    seedPlayableSong("p-selfmiss-song", "s-cv3", "cv-song.jpg");

    const channels = recommendLocalPlatforms().channels;
    expect(channels.length).toBe(1);
    const byId: Record<string, { id: string; coverArt: string | null }> = {};
    for (const pl of channels[0].playlists) byId[pl.id] = pl;

    const ids = [
      "p-lower",
      "p-upper",
      "p-missing",
      "p-noext",
      "p-noext-exists",
      "p-empty",
      "p-null",
      "p-uuid",
      "p-uuid-miss",
      "p-fallback",
      "p-fallback-miss",
      "p-selfmiss-song",
    ];
    const rows: string[] = [];
    for (const id of ids) {
      const nk = newKind(byId[id]);
      const ok = oldKind(id);
      rows.push(`${id.padEnd(20)} old=${ok} new=${nk} coverArt=${JSON.stringify(byId[id].coverArt)}`);
      expect(nk, `${id} 语义不一致`).toBe(ok);
    }
    // 打印证据(判定类别全景)
    // eslint-disable-next-line no-console
    console.log("\n[P0-2 等价矩阵]\n" + rows.join("\n"));

    // 明确断言三个边界
    expect(byId["p-null"].coverArt).toBeNull(); // (a)
    expect(byId["p-empty"].coverArt).toBeNull(); // (a)
    expect(byId["p-noext"].coverArt).toBeNull(); // (b):关键——不能返回 pl-<id>
    expect(byId["p-noext-exists"].coverArt).toBeNull(); // (b 强化):有同名文件但无扩展名 → 仍 null
    expect(byId["p-missing"].coverArt).toBeNull(); // (c)
    expect(byId["p-uuid-miss"].coverArt).toBeNull(); // (生产形态缺失)
    // 有封面的必须归一化为不带扩展名的 pl-<id>
    expect(byId["p-lower"].coverArt).toBe("pl-p-lower");
    expect(byId["p-upper"].coverArt).toBe("pl-p-upper");
    expect(byId["p-uuid"].coverArt).toBe("pl-p-uuid");
  });

  it("直接对照详情页解析路径:非空/空与 getPlaylistCover 一致", () => {
    writeCover("pl-p-a.jpg");
    seedPlaylist("p-a", "netease", { coverArt: "pl-p-a.jpg" });
    seedPlaylist("p-b", "netease", { coverArt: "nope.jpg" });
    expect(getPlaylistCover("p-a")).not.toBeNull();
    expect(getPlaylistCover("p-b")).toBeNull();
    // 新逻辑内部依赖的 resolveCoverFile 与 getPlaylistCover 用的是同一个探测
    expect(resolveCoverFile("pl-p-a.jpg")).not.toBeNull();
    expect(resolveCoverFile("nope.jpg")).toBeNull();
  });
});
