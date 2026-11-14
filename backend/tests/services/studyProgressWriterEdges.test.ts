// MUST be the first import: redirects DATA_DIR before the backend opens SQLite.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll } from "vitest";
import { db, initDatabase } from "../../src/db/index.js";
import {
  users,
  songs,
  playlists,
  playlistSongs,
  studyProgress,
  studyPlaylistProgress,
} from "../../src/db/schema.js";
import { and, eq } from "drizzle-orm";
import { noteStudyPlayback } from "../../src/services/study/progress.js";

// 4.14.5 服务端权威写入的回归守卫（边界）：
//   · 5s 节流只挡非 force；换曲/暂停/停止的补报必须能立刻落库；
//   · 位置/时长归一（负数、超长、时长未知）；
//   · 未知歌曲 / 空 userId / 空 songId 一律不写；
//   · 单曲与整单进度都按用户各留最新 50 条。
// 全部用本文件专属的用户/歌曲 id，避免与本目录其它用例共享状态（vitest 会打乱顺序）。

const BASE_USERS = Array.from({ length: 12 }, (_, i) => `edge-u${i}`);

beforeAll(() => {
  initDatabase();
  db.insert(users).values(
    BASE_USERS.map((id) => ({
      id,
      username: id,
      password: "",
      salt: `salt-${id}`,
      subsonicSalt: `ss-${id}`,
      passEnc: "",
      isAdmin: 0,
      isActive: 1,
      email: `${id}@test.local`,
    })),
  ).run();
});

describe("noteStudyPlayback 边界", () => {
  it("非 force 在 5s 内被节流，force 立刻覆盖", () => {
    const uid = "edge-u0";
    db.insert(songs).values({
      id: "edge-s-throttle", title: "节流", duration: 600,
      path: "l:edge:/throttle.mp3", suffix: "mp3", type: "local", kind: "study",
    }).run();

    noteStudyPlayback({ userId: uid, songId: "edge-s-throttle", positionSec: 10, durationSec: 600 });
    noteStudyPlayback({ userId: uid, songId: "edge-s-throttle", positionSec: 20, durationSec: 600 });
    const throttled = db.select().from(studyProgress)
      .where(and(eq(studyProgress.userId, uid), eq(studyProgress.songId, "edge-s-throttle"))).get();
    expect(throttled?.positionSec).toBe(10);

    noteStudyPlayback({ userId: uid, songId: "edge-s-throttle", positionSec: 30, durationSec: 600, force: true });
    const forced = db.select().from(studyProgress)
      .where(and(eq(studyProgress.userId, uid), eq(studyProgress.songId, "edge-s-throttle"))).get();
    expect(forced?.positionSec).toBe(30);
  });

  it("位置负数归零，超出时长按曲长钳制并记已播完", () => {
    const uid = "edge-u1";
    db.insert(songs).values([
      { id: "edge-s-neg", title: "负数", duration: 300, path: "l:edge:/neg.mp3", suffix: "mp3", type: "local", kind: "study" },
      { id: "edge-s-over", title: "超长", duration: 300, path: "l:edge:/over.mp3", suffix: "mp3", type: "local", kind: "study" },
    ]).run();

    noteStudyPlayback({ userId: uid, songId: "edge-s-neg", positionSec: -50, durationSec: 300, force: true });
    const neg = db.select().from(studyProgress)
      .where(and(eq(studyProgress.userId, uid), eq(studyProgress.songId, "edge-s-neg"))).get();
    expect(neg?.positionSec).toBe(0);
    expect(neg?.finished).toBe(0);

    noteStudyPlayback({ userId: uid, songId: "edge-s-over", positionSec: 900, durationSec: 300, force: true });
    const over = db.select().from(studyProgress)
      .where(and(eq(studyProgress.userId, uid), eq(studyProgress.songId, "edge-s-over"))).get();
    expect(over?.positionSec).toBe(300);
    expect(over?.finished).toBe(1);
  });

  it("上报时长为 0 时回退到曲库时长；曲库也无时长则 finished 保持 0", () => {
    const uid = "edge-u2";
    db.insert(songs).values([
      { id: "edge-s-fallback", title: "回退", duration: 240, path: "l:edge:/fb.mp3", suffix: "mp3", type: "local", kind: "study" },
      { id: "edge-s-nodur", title: "无时长", duration: 0, path: "l:edge:/nd.mp3", suffix: "mp3", type: "local", kind: "study" },
    ]).run();

    noteStudyPlayback({ userId: uid, songId: "edge-s-fallback", positionSec: 230, durationSec: 0, force: true });
    const fb = db.select().from(studyProgress)
      .where(and(eq(studyProgress.userId, uid), eq(studyProgress.songId, "edge-s-fallback"))).get();
    expect(fb?.durationSec).toBe(240);
    expect(fb?.finished).toBe(1);

    noteStudyPlayback({ userId: uid, songId: "edge-s-nodur", positionSec: 10, durationSec: 0, force: true });
    const nd = db.select().from(studyProgress)
      .where(and(eq(studyProgress.userId, uid), eq(studyProgress.songId, "edge-s-nodur"))).get();
    expect(nd?.durationSec).toBe(0);
    expect(nd?.finished).toBe(0);
  });

  it("未知歌曲 / 空 userId / 空 songId 不落库", () => {
    const uid = "edge-u3";
    noteStudyPlayback({ userId: uid, songId: "edge-s-missing", positionSec: 10, durationSec: 100, force: true });
    expect(db.select().from(studyProgress).where(eq(studyProgress.userId, uid)).all()).toHaveLength(0);

    noteStudyPlayback({ userId: "", songId: "edge-s-missing", positionSec: 10, durationSec: 100, force: true });
    noteStudyPlayback({ userId: uid, songId: "", positionSec: 10, durationSec: 100, force: true });
    expect(db.select().from(studyProgress).where(eq(studyProgress.userId, uid)).all()).toHaveLength(0);
  });

  it("单曲进度按用户只保留最新 50 条", () => {
    const uid = "edge-u4";
    const ids = Array.from({ length: 52 }, (_, i) => `edge-cap-${i}`);
    db.insert(songs).values(ids.map((id) => ({
      id, title: id, duration: 100, path: `l:edge:/${id}.mp3`, suffix: "mp3", type: "local", kind: "study",
    }))).run();
    const base = Date.now() - 60_000;
    db.insert(studyProgress).values(ids.map((songId, i) => ({
      userId: uid, songId, positionSec: i, durationSec: 100, finished: 0,
      updatedAt: new Date(base + i * 1000).toISOString(),
    }))).run();

    // 新写入一条（时间最新）→ 触发裁剪，总数回到 50，最老的一条被删。
    noteStudyPlayback({ userId: uid, songId: "edge-cap-0", positionSec: 50, durationSec: 100, force: true });
    const left = db.select().from(studyProgress).where(eq(studyProgress.userId, uid)).all();
    expect(left).toHaveLength(50);
    expect(left.some((r) => r.songId === "edge-cap-1")).toBe(false);
    expect(left.some((r) => r.songId === "edge-cap-51")).toBe(true);
  });

  it("整单续播进度按用户只保留最新 50 个歌单", () => {
    const uid = "edge-u5";
    const songId = "edge-pl-song";
    db.insert(songs).values({
      id: songId, title: "整单", duration: 100,
      path: "l:edge:/plsong.mp3", suffix: "mp3", type: "local", kind: "study",
    }).run();
    const plIds = Array.from({ length: 52 }, (_, i) => `edge-pl-${i}`);
    db.insert(playlists).values(plIds.map((id) => ({
      id, name: id, kind: "study", ownerId: uid,
    }))).run();
    db.insert(playlistSongs).values(plIds.map((playlistId, i) => ({
      id: 10_000 + i, playlistId, songId, position: 0,
    }))).run();

    const base = Date.now() - 60_000;
    db.insert(studyPlaylistProgress).values(plIds.slice(0, 51).map((playlistId, i) => ({
      userId: uid, playlistId, songId, positionSec: i, durationSec: 100,
      updatedAt: new Date(base + i * 1000).toISOString(),
    }))).run();

    noteStudyPlayback({
      userId: uid, songId, positionSec: 40, durationSec: 100,
      playlistId: "edge-pl-51", force: true,
    });
    const left = db.select().from(studyPlaylistProgress).where(eq(studyPlaylistProgress.userId, uid)).all();
    expect(left).toHaveLength(50);
    expect(left.some((r) => r.playlistId === "edge-pl-0")).toBe(false);
    expect(left.some((r) => r.playlistId === "edge-pl-51")).toBe(true);
  });
});
