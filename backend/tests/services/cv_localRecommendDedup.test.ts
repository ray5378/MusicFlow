// ==================== 覆盖率 C 类缺口:localRecommend 候选来源循环的 seen 去重 ====================
//
// 目标:src/services/plugin/localRecommend.ts pickCandidateSongs 内 addFromAlbumIds
// (202-204)与 addFromGenres(216-218)两个候选来源循环的 seen.add(r.id)+
// candidates.push(...) 分支 —— 同一条歌在多个来源/权重里重复出现时只保留第一次。
// 该函数不导出,经公共入口 pickLocalRecommendSongs 触达:无参考歌单池 →
// buildTasteProfile → pickCandidateSongs。
//
// 造数设计(收藏计分驱动,零播放历史 → recentSongIds 为空,排除分支不干扰):
//   s1..s3  artist_id=ar-dedup  album_id=al-shared genre=rock —— 艺人来源先加入
//   s4      artist_id=ar2-dedup album_id=al-only  genre=jazz —— 艺人来源加入
//   s5      album_id=al-only genre=pop(无 artist_id)         —— 专辑循环 add(此前未被见过)
//   s6      genre=pop(无 artist_id/album_id)                 —— 仅风格来源可达 → 风格循环 add
// 收藏 s1/s2/s4/s5/s6:给 s5/s6 所在专辑/风格打分,使 al-only / pop 进入 top 列表。
// 结果 = 6 首无重复;s5 同时命中 al-only(专辑)与 pop(风格)两来源,专辑循环先入、
// 风格循环 seen 命中被跳过 —— 正是目标去重分支。
//
// FK 注意:songs.artist_id / album_id 外键指向 artists / albums(foreign_keys=ON),
// 必须先建父行;user_favorite_songs.user_id 外键指向 users,用真实 admin id。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll } from "vitest";
import { initDatabase, sqlite } from "../../src/db/index.js";
import { pickLocalRecommendSongs } from "../../src/services/plugin/localRecommend.js";
import { setSetting } from "../../src/services/settings.js";

function seedAdminUser(): string {
  const existing = sqlite.prepare("SELECT id FROM users WHERE is_admin=1 LIMIT 1").get() as { id: string } | undefined;
  if (existing) return existing.id; // initDatabase 会自动建默认 admin(id 非 'u1'),直接复用
  sqlite.prepare(
    "INSERT INTO users (id, username, password, salt, subsonic_salt, pass_enc, is_admin, is_active, email, created_at, updated_at) VALUES ('u1','admin','','s','ss','',1,1,'a@b.c',?,?)",
  ).run(new Date().toISOString(), new Date().toISOString());
  return "u1";
}

function seedDedupLibrary(adminId: string): void {
  const now = new Date().toISOString();
  const insArtist = sqlite.prepare("INSERT INTO artists (id, name, created_at, updated_at) VALUES (?,?,?,?)");
  insArtist.run("ar-dedup", "Dedup Artist", now, now);
  insArtist.run("ar2-dedup", "Second Artist", now, now);
  const insAlbum = sqlite.prepare("INSERT INTO albums (id, name, created_at, updated_at) VALUES (?,?,?,?)");
  insAlbum.run("al-shared", "Shared Album", now, now);
  insAlbum.run("al-only", "Only Album", now, now);

  const insSong = sqlite.prepare(
    "INSERT INTO songs (id, title, artist, artist_id, album, album_id, genre, duration, path, suffix, type, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  const song = (id: string, artist: string, artistId: string | null, album: string, albumId: string | null, genre: string) => {
    insSong.run(id, `Song ${id}`, artist, artistId, album, albumId, genre, 200, `l:src:/tmp/${id}.mp3`, "mp3", "local", now);
  };
  song("s1", "Dedup Artist", "ar-dedup", "Shared Album", "al-shared", "rock");
  song("s2", "Dedup Artist", "ar-dedup", "Shared Album", "al-shared", "rock");
  song("s3", "Dedup Artist", "ar-dedup", "Shared Album", "al-shared", "rock");
  song("s4", "Second Artist", "ar2-dedup", "Only Album", "al-only", "jazz");
  song("s5", "", null, "Only Album", "al-only", "pop");
  song("s6", "", null, "", null, "pop");

  // 收藏即计分(+2.0/首):让 ar-dedup / ar2-dedup / al-shared / al-only /
  // rock / jazz / pop 全部进入各自的 top 列表,三个来源循环都会真实执行。
  const fav = sqlite.prepare("INSERT OR IGNORE INTO user_favorite_songs (user_id, song_id) VALUES (?,?)");
  for (const id of ["s1", "s2", "s4", "s5", "s6"]) fav.run(adminId, id);
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  setSetting("daily_recommend_local_enabled", "true");
  const adminId = seedAdminUser();
  seedDedupLibrary(adminId);
});

describe("pickLocalRecommendSongs:候选来源循环去重(seen 分支)", () => {
  it("同一首歌在多个来源重复出现只保留第一次:s5 经专辑循环入一次,s6 由风格循环补入", () => {
    const r = pickLocalRecommendSongs(new Date("2026-08-20T12:00:00"));

    // 候选 6 首 ≥ 5,未触发全库随机兜底,断言的是口味抽取路径本身。
    expect(r.fallback).toBe(false);
    expect(r.songIds).toHaveLength(6);
    // 去重的行为结果:无任何重复 id
    expect(new Set(r.songIds).size).toBe(r.songIds.length);
    expect(new Set(r.songIds)).toEqual(new Set(["s1", "s2", "s3", "s4", "s5", "s6"]));
    // s5 同时命中 al-only(专辑)与 pop(风格)两个查询,只保留专辑循环的第一次;
    // s6 只在风格循环可达 —— 证明专辑/风格两个循环的 add 分支都真实执行。
    expect(r.songIds.filter((x) => x === "s5")).toHaveLength(1);
    expect(r.songIds).toContain("s6");
  });

  it("同一天(同种子)两次调用内容确定:去重后的候选集稳定", () => {
    const a = pickLocalRecommendSongs(new Date("2026-08-21T12:00:00"));
    const b = pickLocalRecommendSongs(new Date("2026-08-21T12:00:00"));
    expect(a.songIds).toEqual(b.songIds);
    expect(new Set(a.songIds).size).toBe(a.songIds.length);
  });
});
