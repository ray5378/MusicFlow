// MUST be the first import: redirects DATA_DIR before the backend opens SQLite.
import "../plugins/_env.js";

import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { QueueController } from "../../src/services/player/QueueController.js";
import { PlaybackState } from "../../src/services/player/types.js";
import type { UniversalPlayer } from "../../src/services/player/UniversalPlayer.js";
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

// 4.14.5 服务端学习记录归属的回归守卫：
//   · 归属用户随「每一次整队替换」重定，绝不继承上一条队列；
//   · 只有 study 曲目 + 有归属用户时才旁路写库；
//   · 暂停/停止/清队列会用最后可听位置 force 补报（跳过节流）；
//   · 学习歌单队列同时写整单续播，音乐歌单不写。

const PRE_PROBE_DISABLED_CFG = {
  enabled: false, lookaheadSongs: 3, deadRunLimit: 50, exhaustedCooldownSeconds: 90,
  probeTimeoutMs: 5000, probeCooldownSeconds: 60, windowMinutes: 8,
  negativeTtlSeconds: 45, concurrency: 3,
};
vi.mock(import("../../src/services/plugin/core/preProbe.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    preProbeActive: () => false,
    readPreProbeConfig: () => ({ ...PRE_PROBE_DISABLED_CFG }),
  };
});

const USER_IDS = Array.from({ length: 12 }, (_, i) => `own-u${i}`);
const STUDY_SONG_IDS = Array.from({ length: 12 }, (_, i) => `own-s${i}`);

beforeAll(() => {
  initDatabase();
  db.insert(users).values(
    USER_IDS.map((id) => ({
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
  db.insert(songs).values([
    ...STUDY_SONG_IDS.map((id) => ({
      id, title: id, duration: 600,
      path: `l:own:/${id}.mp3`, suffix: "mp3", type: "local", kind: "study",
    })),
    { id: "own-m1", title: "音乐", duration: 180, path: "l:own:/m1.mp3", suffix: "mp3", type: "local", kind: "music" },
  ]).run();
  db.insert(playlists).values([
    { id: "own-pl-study", name: "课程", kind: "study", ownerId: "own-u8" },
    { id: "own-pl-music", name: "音乐清单", kind: "music", ownerId: "own-u9" },
  ]).run();
  db.insert(playlistSongs).values([
    { id: 20_001, playlistId: "own-pl-study", songId: "own-s8", position: 0 },
    { id: 20_002, playlistId: "own-pl-music", songId: "own-s9", position: 0 },
  ]).run();
});

function makeMockPlayer(): UniversalPlayer & { calls: string[] } {
  const calls: string[] = [];
  const proto = {
    playerId: "dlna:own",
    async playMedia() { calls.push("playMedia"); return { mediaUri: "u-new" }; },
    async stop() { calls.push("stop"); },
    async pause() { calls.push("pause"); },
    async resume() { calls.push("resume"); },
    async seek() { calls.push("seek"); },
    async setVolume() { calls.push("setVolume"); },
    async pollState() {
      return {
        playerId: "dlna:own", playbackState: PlaybackState.IDLE,
        position: 0, duration: 0, updatedAt: Date.now(),
      };
    },
  };
  return {
    playerId: "dlna:own",
    name: "test",
    attachProtocol: () => {},
    getProtocol: () => proto,
    playMedia: proto.playMedia,
    stop: proto.stop,
    pause: proto.pause,
    resume: proto.resume,
    seek: proto.seek,
    setVolume: proto.setVolume,
    pollState: proto.pollState,
    calls,
  } as unknown as UniversalPlayer & { calls: string[] };
}

function makeCtrl() {
  return {
    beginOptimistic: vi.fn(),
    endOptimistic: vi.fn(),
    reportState: vi.fn(),
    resetTracker: vi.fn(),
    setExpectedDuration: vi.fn(),
    onPositionAdvance: undefined as
      | ((pid: string, pos: number, dur: number) => void)
      | undefined,
  };
}

function studyItem(songId: string) {
  return {
    songId, title: songId, mime: "audio/mpeg", duration: 600, kind: "study",
  };
}

function readSong(userId: string, songId: string) {
  return db.select().from(studyProgress)
    .where(and(eq(studyProgress.userId, userId), eq(studyProgress.songId, songId)))
    .get();
}

describe("QueueController 学习记录归属", () => {
  let qc: QueueController;

  beforeEach(() => {
    qc = new QueueController();
  });

  it("归属用户随整队替换重定，绝不继承上一条队列；clear 一并失效", () => {
    qc.setQueue("dlna:d1", [studyItem("own-s0")], 0, "http://base", undefined, "own-u0");
    expect(qc.getOwnerUserId("d1")).toBe("own-u0");
    expect(qc.getOwnerUserId("dlna:d1")).toBe("own-u0");

    // 第二次整队未带用户 → 必须清空，不能把上一用户的播放记到新入口。
    qc.setQueue("d1", [studyItem("own-s1")], 0, "http://base");
    expect(qc.getOwnerUserId("d1")).toBeUndefined();

    qc.setOwnerUserId("d1", "own-u1");
    expect(qc.getOwnerUserId("d1")).toBe("own-u1");

    qc.clear("d1");
    expect(qc.getOwnerUserId("d1")).toBeUndefined();
  });

  it("位置推进只为 study 曲目、且有归属用户时写库", () => {
    const player = makeMockPlayer();
    const ctrl = makeCtrl();
    qc.registerPlayer("d2", player, ctrl as any);
    qc.setQueue("d2", [studyItem("own-s2")], 0, "http://base", undefined, "own-u2");

    ctrl.onPositionAdvance!("dlna:d2", 30, 600);
    expect(readSong("own-u2", "own-s2")?.positionSec).toBe(30);

    // 无归属用户 → 不写（纯设备队列交给控制端上报）。
    qc.setQueue("d2", [studyItem("own-s3")], 0, "http://base");
    ctrl.onPositionAdvance!("dlna:d2", 40, 600);
    expect(readSong("own-u2", "own-s3")).toBeUndefined();

    // 音乐曲目 → 不写学习记录。
    qc.setQueue("d2", [{
      songId: "own-m1", title: "音乐", mime: "audio/mpeg", duration: 180, kind: "music",
    }], 0, "http://base", undefined, "own-u3");
    ctrl.onPositionAdvance!("dlna:d2", 50, 180);
    expect(readSong("own-u3", "own-m1")).toBeUndefined();
  });

  it("暂停时用最后可听位置强制补报（超长位置按曲长钳制）", async () => {
    const player = makeMockPlayer();
    const ctrl = makeCtrl();
    qc.registerPlayer("d3", player, ctrl as any);
    qc.setQueue("d3", [studyItem("own-s4")], 0, "http://base", undefined, "own-u4");
    await qc.transport("d3", "seek", 120);
    await qc.transport("d3", "pause");
    expect(readSong("own-u4", "own-s4")?.positionSec).toBe(120);

    qc.setQueue("d3", [studyItem("own-s5")], 0, "http://base", undefined, "own-u5");
    await qc.transport("d3", "seek", 900);
    await qc.transport("d3", "stop");
    const clamped = readSong("own-u5", "own-s5");
    expect(clamped?.positionSec).toBe(600);
    expect(clamped?.finished).toBe(1);
  });

  it("清空队列前补报最后位置", async () => {
    const player = makeMockPlayer();
    const ctrl = makeCtrl();
    qc.registerPlayer("d4", player, ctrl as any);
    qc.setQueue("d4", [studyItem("own-s6")], 0, "http://base", undefined, "own-u6");
    await qc.transport("d4", "seek", 200);
    qc.clear("d4");
    expect(readSong("own-u6", "own-s6")?.positionSec).toBe(200);
    expect(qc.getOwnerUserId("d4")).toBeUndefined();
  });

  it("学习歌单队列同时写整单续播；音乐歌单不写", () => {
    const player = makeMockPlayer();
    const ctrl = makeCtrl();
    qc.registerPlayer("d5", player, ctrl as any);

    qc.setQueue(
      "d5", [studyItem("own-s8")], 0, "http://base",
      "playlist:own-pl-study", "own-u8",
    );
    ctrl.onPositionAdvance!("dlna:d5", 60, 600);
    const playlistRow = db.select().from(studyPlaylistProgress)
      .where(and(
        eq(studyPlaylistProgress.userId, "own-u8"),
        eq(studyPlaylistProgress.playlistId, "own-pl-study"),
      )).get();
    expect(playlistRow?.songId).toBe("own-s8");
    expect(playlistRow?.positionSec).toBe(60);

    qc.setQueue(
      "d5", [studyItem("own-s9")], 0, "http://base",
      "playlist:own-pl-music", "own-u9",
    );
    ctrl.onPositionAdvance!("dlna:d5", 70, 600);
    expect(db.select().from(studyPlaylistProgress)
      .where(eq(studyPlaylistProgress.userId, "own-u9")).all()).toHaveLength(0);
  });

  it("enqueue 带 owner 时补登归属（空队列起播也生效）", async () => {
    const player = makeMockPlayer();
    const ctrl = makeCtrl();
    qc.registerPlayer("d6", player, ctrl as any);

    await qc.enqueue("d6", [studyItem("own-s10")], "http://base", "own-u10");

    expect(qc.getOwnerUserId("d6")).toBe("own-u10");
    expect(qc.snapshot("d6").currentIndex).toBe(0);
  });

  it("删除当前曲前补报最后位置", async () => {
    const player = makeMockPlayer();
    const ctrl = makeCtrl();
    qc.registerPlayer("d7", player, ctrl as any);
    qc.setQueue("d7", [
      studyItem("own-s11"),
      { songId: "own-m1", title: "音乐", mime: "audio/mpeg", duration: 180, kind: "music" },
    ], 0, "http://base", undefined, "own-u11");

    await qc.transport("d7", "seek", 90);
    qc.removeAt("d7", 0, "http://base");

    expect(readSong("own-u11", "own-s11")?.positionSec).toBe(90);
    expect(qc.snapshot("d7").items).toHaveLength(1);
  });
});
