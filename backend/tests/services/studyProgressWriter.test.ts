// MUST be the first import: redirects DATA_DIR before the backend opens SQLite.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll } from "vitest";
import { db, initDatabase } from "../../src/db/index.js";
import { users, songs, playlists, playlistSongs, studyProgress, studyPlaylistProgress } from "../../src/db/schema.js";
import { and, eq } from "drizzle-orm";
import { noteStudyPlayback } from "../../src/services/study/progress.js";

beforeAll(() => {
  initDatabase();
  db.insert(users).values([
    { id: "u1", username: "alice", password: "", salt: "s1", subsonicSalt: "ss1", passEnc: "", isAdmin: 0, isActive: 1, email: "a@b.c" },
    { id: "u2", username: "bob", password: "", salt: "s2", subsonicSalt: "ss2", passEnc: "", isAdmin: 0, isActive: 1, email: "b@b.c" },
  ]).run();
  db.insert(songs).values([
    { id: "st1", title: "第01课", duration: 600, path: "l:src:/1.mp3", suffix: "mp3", type: "local", kind: "study" },
    { id: "st2", title: "第02课", duration: 300, path: "l:src:/2.mp3", suffix: "mp3", type: "local", kind: "study" },
    { id: "m1", title: "Song", duration: 180, path: "l:src:/m.mp3", suffix: "mp3", type: "local", kind: "music" },
  ]).run();
  db.insert(playlists).values([
    { id: "pl-study", name: "课程", kind: "study", ownerId: "u1" },
    { id: "pl-music", name: "Music", kind: "music", ownerId: "u1" },
  ]).run();
  db.insert(playlistSongs).values({ id: 1, playlistId: "pl-study", songId: "st1", position: 0 }).run();
});

describe("服务端学习记录写入", () => {
  it("按用户隔离写入单曲进度", () => {
    noteStudyPlayback({ userId: "u1", songId: "st1", positionSec: 120, durationSec: 600, force: true });
    noteStudyPlayback({ userId: "u2", songId: "st1", positionSec: 30, durationSec: 600, force: true });
    const a = db.select().from(studyProgress).where(and(eq(studyProgress.userId, "u1"), eq(studyProgress.songId, "st1"))).get();
    const b = db.select().from(studyProgress).where(and(eq(studyProgress.userId, "u2"), eq(studyProgress.songId, "st1"))).get();
    expect(a?.positionSec).toBe(120);
    expect(b?.positionSec).toBe(30);
  });

  it("音乐歌曲不写学习记录", () => {
    noteStudyPlayback({ userId: "u1", songId: "m1", positionSec: 10, durationSec: 180, force: true });
    const row = db.select().from(studyProgress).where(and(eq(studyProgress.userId, "u1"), eq(studyProgress.songId, "m1"))).get();
    expect(row).toBeUndefined();
  });

  it("学习歌单内曲目才写整单续播进度", () => {
    noteStudyPlayback({ userId: "u1", songId: "st1", positionSec: 300, durationSec: 600, playlistId: "pl-study", force: true });
    const ok = db.select().from(studyPlaylistProgress).where(and(eq(studyPlaylistProgress.userId, "u1"), eq(studyPlaylistProgress.playlistId, "pl-study"))).get();
    expect(ok?.positionSec).toBe(300);
    expect(ok?.songId).toBe("st1");

    // 不在歌单里的曲目 / 非学习歌单 → 不写整单进度
    noteStudyPlayback({ userId: "u1", songId: "st2", positionSec: 50, durationSec: 300, playlistId: "pl-study", force: true });
    const notIn = db.select().from(studyPlaylistProgress).where(and(eq(studyPlaylistProgress.userId, "u1"), eq(studyPlaylistProgress.playlistId, "pl-study"))).get();
    expect(notIn?.songId).toBe("st1");
    noteStudyPlayback({ userId: "u1", songId: "st1", positionSec: 60, durationSec: 600, playlistId: "pl-music", force: true });
    const music = db.select().from(studyPlaylistProgress).where(and(eq(studyPlaylistProgress.userId, "u1"), eq(studyPlaylistProgress.playlistId, "pl-music"))).get();
    expect(music).toBeUndefined();
  });

  it("整单续播进度也严格按用户隔离", () => {
    noteStudyPlayback({ userId: "u1", songId: "st1", positionSec: 100, durationSec: 600, playlistId: "pl-study", force: true });
    noteStudyPlayback({ userId: "u2", songId: "st1", positionSec: 400, durationSec: 600, playlistId: "pl-study", force: true });
    const a = db.select().from(studyPlaylistProgress).where(and(eq(studyPlaylistProgress.userId, "u1"), eq(studyPlaylistProgress.playlistId, "pl-study"))).get();
    const b = db.select().from(studyPlaylistProgress).where(and(eq(studyPlaylistProgress.userId, "u2"), eq(studyPlaylistProgress.playlistId, "pl-study"))).get();
    expect(a?.positionSec).toBe(100);
    expect(b?.positionSec).toBe(400);
    // u2 的写入不影响 u1 的单曲进度(仍为 u1 自己最后写入的 100)
    const aSong = db.select().from(studyProgress).where(and(eq(studyProgress.userId, "u1"), eq(studyProgress.songId, "st1"))).get();
    expect(aSong?.positionSec).toBe(100);
  });

  it("位置到 95% 记为已播完", () => {
    noteStudyPlayback({ userId: "u1", songId: "st2", positionSec: 290, durationSec: 300, force: true });
    const row = db.select().from(studyProgress).where(and(eq(studyProgress.userId, "u1"), eq(studyProgress.songId, "st2"))).get();
    expect(row?.finished).toBe(1);
  });
});
