// 全量 DLNA 集成测试种子：跨多种音频格式(mp3/wav/flac/ogg/m4a/opus/aac)混排队列，
// 供 /castStream 连续流「格式在单流内任意变化」的转码统一校验。
// 运行方式: cd /root/mfserver/backend && DATA_DIR=/tmp/mf-server/data JWT_SECRET=test-secret-cast \
//           npx tsx /workspace/tool/seed-mixed.mts
import { db, initDatabase, encryptPassword } from "/root/mfserver/backend/src/db/index.js";
import { users, songs, artists, albums, mediaSources } from "/root/mfserver/backend/src/db/schema.js";
import { eq, inArray } from "drizzle-orm";

initDatabase();

db.insert(users).values({
  id: "u-admin", username: "admin", password: "", salt: "salt", subsonicSalt: "subsalt",
  passEnc: encryptPassword("admin"), isAdmin: 1, isActive: 1, email: "a@b.c",
}).onConflictDoNothing().run();

db.insert(mediaSources).values({ id: "src", name: "Local", type: "local", enabled: 1, config: "{}" }).onConflictDoNothing().run();
db.insert(artists).values({ id: "ar1", name: "Cast Artist" }).onConflictDoNothing().run();
db.insert(albums).values({ id: "al1", name: "Cast Album", artistId: "ar1", artist: "Cast Artist", year: 2026, genre: "Test" }).onConflictDoNothing().run();

// 跨格式混排(每个容器/编码一种,时长已知用于整流时长≈和校验)。
// 不做 delete(运行时库 play_history 等外键引用旧曲,直接删会触发 FK 约束);
// 不用 onConflictDoNothing(this better-sqlite3 批量插入不抑制唯一冲突),
// 改为按现存 id 过滤,仅插入缺失的歌曲,重复执行安全、幂等。
const ALL: any[] = [
  { id: "s1", title: "Track MP3",   artist: "Cast Artist", artistId: "ar1", album: "Cast Album", albumId: "al1", duration: 8,  path: "l:src:/tmp/mf-media/a.mp3",  suffix: "mp3",  genre: "Test", type: "local" },
  { id: "s2", title: "Track WAV",   artist: "Cast Artist", artistId: "ar1", album: "Cast Album", albumId: "al1", duration: 5,  path: "l:src:/tmp/mf-media/b.wav",  suffix: "wav",  genre: "Test", type: "local" },
  { id: "s3", title: "Track FLAC",  artist: "Cast Artist", artistId: "ar1", album: "Cast Album", albumId: "al1", duration: 10, path: "l:src:/tmp/mf-media/c.flac", suffix: "flac", genre: "Test", type: "local" },
  { id: "s4", title: "Track OGG",   artist: "Cast Artist", artistId: "ar1", album: "Cast Album", albumId: "al1", duration: 6,  path: "l:src:/tmp/mf-media/d.ogg",  suffix: "ogg",  genre: "Test", type: "local" },
  { id: "s5", title: "Track M4A",   artist: "Cast Artist", artistId: "ar1", album: "Cast Album", albumId: "al1", duration: 7,  path: "l:src:/tmp/mf-media/e.m4a",  suffix: "m4a",  genre: "Test", type: "local" },
  { id: "s6", title: "Track OPUS",  artist: "Cast Artist", artistId: "ar1", album: "Cast Album", albumId: "al1", duration: 4,  path: "l:src:/tmp/mf-media/f.opus", suffix: "opus", genre: "Test", type: "local" },
  { id: "s7", title: "Track AAC",   artist: "Cast Artist", artistId: "ar1", album: "Cast Album", albumId: "al1", duration: 3,  path: "l:src:/tmp/mf-media/g.aac",  suffix: "aac",  genre: "Test", type: "local" },
  { id: "s8", title: "Track MP3B",  artist: "Cast Artist", artistId: "ar1", album: "Cast Album", albumId: "al1", duration: 9,  path: "l:src:/tmp/mf-media/h.mp3",  suffix: "mp3",  genre: "Test", type: "local" },
  { id: "s9", title: "Track MP3C",  artist: "Cast Artist", artistId: "ar1", album: "Cast Album", albumId: "al1", duration: 8,  path: "l:src:/tmp/mf-media/i.mp3",  suffix: "mp3",  genre: "Test", type: "local" },
];
const existing = new Set(db.select().from(songs).all().map((r: any) => r.id));
const toInsert = ALL.filter((s) => !existing.has(s.id));
if (toInsert.length) db.insert(songs).values(toInsert).run();

console.log(`[seed-mixed] songs 幂等 seed: total=${ALL.length} inserted=${toInsert.length} existing=${existing.size}`);