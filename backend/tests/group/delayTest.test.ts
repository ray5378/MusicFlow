// group/delayTest.ts 定向单测:群组「测试延迟」服务(起测 / 幂等 / 停止还原 / 收尾清理)。
//
// 为什么补这份:该服务是 v4.11.0 新增的「必生效」入口,踩过的坑都在**静默**面:
//   ① 起测把整队换成测试音 → 停止必须按快照还原(队列项/下标/播放模式/进度);
//   ② 「装载但未播」的组停止时**绝不能**顺手起播(首版缺陷,用户点测试→停测试会莫名放歌);
//   ③ 测试音 songs 行被 play_history 等 NO ACTION 外键引用 ⇒ 先删主行必抛
//      FOREIGN KEY constraint failed(第二次起测必炸);故写入走 upsert、删除先清引用行;
//   ④ 样本本身:16k 单声道、5s 一次 20ms 咔哒、300s 一轮(曲库 id 固定)。
// 全部依赖桩:队列控制器 / 组状态都不碰真实设备与子进程;DB 用 tests/setup.ts 的隔离库。
import "../plugins/_env.js";
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db, initDatabase } from "../../src/db/index.js";
import {
  playHistory,
  playlists,
  playlistSongs,
  songs,
  userFavoriteSongs,
  users,
} from "../../src/db/schema.js";
import { getDataDir } from "../../src/utils/env.js";

const TONE_SONG_ID = "mf-delay-test";
const TONE_RATE = 16_000;
const TONE_DURATION_SEC = 300;
const TONE_BYTES = 44 + TONE_DURATION_SEC * TONE_RATE * 2;

const h = vi.hoisted(() => {
  const calls: Array<[string, ...any[]]> = [];
  const snap = {
    items: [] as any[],
    currentIndex: -1,
    playMode: "shuffle" as any,
    isActive: false,
  };
  const state = {
    playFromThrowsOnce: false,
    statusThrows: false,
    status: { state: "STOPPED", position: 0, duration: 0 } as any,
  };
  const qc = {
    snapshot() {
      return { ...snap, ended: false, shuffleOrder: [], shufflePos: -1 };
    },
    getContentContext() {
      return "ctx" as string | undefined;
    },
    async playFrom(_id: string, items: any[], index: number) {
      calls.push(["playFrom", items, index]);
      if (state.playFromThrowsOnce) {
        state.playFromThrowsOnce = false; // 只炸第一次:起测失败后还原路径仍可跑
        throw new Error("cast 失败");
      }
      return 0;
    },
    setPlayMode(_id: string, mode: string) {
      calls.push(["setPlayMode", mode]);
    },
    setQueue(_id: string, items: any[], index: number) {
      calls.push(["setQueue", items, index]);
    },
    clear(_id: string, opts?: any) {
      calls.push(["clear", opts]);
    },
    stopPlayback(_id: string) {
      calls.push(["stopPlayback"]);
    },
    async transport(_id: string, op: string, arg?: number) {
      calls.push(["transport", op, arg]);
    },
  };
  return { calls, snap, state, qc };
});

vi.mock("../../src/services/player/index.js", () => ({
  getQueueController: () => h.qc,
}));

vi.mock("../../src/services/group/protocolPlayer.js", () => ({
  getGroupStatus: async () => {
    if (h.state.statusThrows) throw new Error("现场读不到");
    return h.state.status;
  },
}));

import {
  isGroupDelayTestActive,
  startGroupDelayTest,
  stopGroupDelayTest,
} from "../../src/services/group/delayTest.js";

const BASE = "http://127.0.0.1:8080";

function item(songId: string): any {
  return { songId, title: songId, mime: "audio/mpeg", duration: 60 };
}

function resetSnap(items: any[] = [], index = -1, playMode: any = "shuffle"): void {
  h.snap.items = items;
  h.snap.currentIndex = index;
  h.snap.playMode = playMode;
  h.calls.length = 0;
  h.state.playFromThrowsOnce = false;
  h.state.statusThrows = false;
  h.state.status = { state: "STOPPED", position: 0, duration: 0 };
}

/** 测试音文件路径(与生产同一推导:数据目录下 delay-test/click-5s.wav)。 */
function toneFile(): string {
  return join(getDataDir(), "delay-test", "click-5s.wav");
}

/** 造「引用行」的父行:playlist_songs → playlists.id、user_favorite_songs / play_history
 *  → users.id 都是外键,缺父行时直接插引用行会 FOREIGN KEY constraint failed。
 *  幂等:同一文件内多个用例共用同一份父行。 */
function seedRefs(): void {
  db.insert(users)
    .values({ id: "u1", username: "u1", password: "", salt: "s", subsonicSalt: "ss" })
    .onConflictDoNothing()
    .run();
  db.insert(playlists)
    .values({ id: "pl-1", name: "pl", ownerId: "u1" })
    .onConflictDoNothing()
    .run();
}

/** 读 WAV 的一个 16bit 采样(s16le,单声道)。 */
function sampleAt(sec: number): number {
  const buf = readFileSync(toneFile());
  return buf.readInt16LE(44 + Math.round(sec * TONE_RATE) * 2);
}

beforeAll(() => {
  initDatabase();
});

beforeEach(() => {
  resetSnap();
});

afterEach(async () => {
  // 模块级 activeTests 在文件内跨用例存活 —— 逐个收口,避免用例间串场。
  for (const gid of ["gA", "gB", "gC", "gD", "gE", "gF", "gG", "gH"]) {
    await stopGroupDelayTest(gid, BASE).catch(() => {});
  }
  db.delete(playHistory).where(eq(playHistory.songId, TONE_SONG_ID)).run();
  db.delete(playlistSongs).where(eq(playlistSongs.songId, TONE_SONG_ID)).run();
  db.delete(userFavoriteSongs).where(eq(userFavoriteSongs.songId, TONE_SONG_ID)).run();
  db.delete(songs).where(eq(songs.id, TONE_SONG_ID)).run();
  // 父行最后删(引用行已清),不留跨用例串场。
  db.delete(playHistory).where(eq(playHistory.userId, "u1")).run();
  db.delete(userFavoriteSongs).where(eq(userFavoriteSongs.userId, "u1")).run();
  db.delete(playlistSongs).where(eq(playlistSongs.playlistId, "pl-1")).run();
  db.delete(playlists).where(eq(playlists.id, "pl-1")).run();
  db.delete(users).where(eq(users.id, "u1")).run();
});

describe("测试音样本(16kHz 单声道 / 5s 一次 20ms 咔哒)", () => {
  it("生成 300s 单声道 16bit WAV:尺寸 = 44 + 300×16000×2,首帧与 5s 处有咔哒,间隙与咔哒尾部为静音", async () => {
    await startGroupDelayTest("gA", BASE);
    expect(existsSync(toneFile())).toBe(true);
    expect(statSync(toneFile()).size).toBe(TONE_BYTES);

    expect(sampleAt(0)).not.toBe(0); // 第 1 次咔哒
    expect(sampleAt(5)).not.toBe(0); // 第 2 次咔哒(间隔 5s)
    expect(sampleAt(2.5)).toBe(0); // 两次之间
    expect(sampleAt(5.025)).toBe(0); // 20ms 咔哒本体之后
  });

  it("重复起测不重写样本(尺寸正确即复用同一份文件)", async () => {
    await startGroupDelayTest("gA", BASE);
    const mtime1 = statSync(toneFile()).mtimeMs;
    await stopGroupDelayTest("gA", BASE);
    await startGroupDelayTest("gB", BASE);
    expect(statSync(toneFile()).mtimeMs).toBe(mtime1);
  });

  it("songs 行:曲库固定 id mf-delay-test 指向数据目录里的 WAV", async () => {
    await startGroupDelayTest("gA", BASE);
    const row = db.select().from(songs).where(eq(songs.id, TONE_SONG_ID)).get() as any;
    expect(row).toBeTruthy();
    expect(row.path).toBe(`l:delaytest:${toneFile()}`);
    expect(row.suffix).toBe("wav");
    expect(row.duration).toBe(TONE_DURATION_SEC);
    expect(row.size).toBe(TONE_BYTES);
  });
});

describe("起测(startGroupDelayTest)", () => {
  it("把该组队列换成测试音单曲,playMode=one(循环语义与平时单曲循环同源)", async () => {
    resetSnap([item("s1"), item("s2")], 1, "loop");
    const r = await startGroupDelayTest("gA", BASE);
    expect(r).toEqual({ running: true, intervalMs: 5000, clickMs: 20, durationSec: 300 });
    expect(isGroupDelayTestActive("gA")).toBe(true);
    const playFrom = h.calls.find((c) => c[0] === "playFrom")!;
    expect(playFrom[1]).toHaveLength(1);
    expect(playFrom[1][0].songId).toBe(TONE_SONG_ID);
    expect(playFrom[2]).toBe(0);
    expect(h.calls.filter((c) => c[0] === "setPlayMode").at(-1)).toEqual(["setPlayMode", "one"]);
  });

  it("已在测试 ⇒ 幂等(不重复替换队列、不再起播)", async () => {
    await startGroupDelayTest("gA", BASE);
    const n1 = h.calls.filter((c) => c[0] === "playFrom").length;
    const again = await startGroupDelayTest("gA", BASE);
    expect(again.running).toBe(true);
    expect(h.calls.filter((c) => c[0] === "playFrom").length).toBe(n1);
  });

  it("起测前组在播 ⇒ 记下进度现场(停止时按原下标重播并补回进度)", async () => {
    resetSnap([item("s1"), item("s2"), item("s3")], 1, "loop");
    h.state.status = { state: "PLAYING", position: 42, duration: 60 };
    await startGroupDelayTest("gA", BASE);
    await stopGroupDelayTest("gA", BASE);
    const playFrom = h.calls.filter((c) => c[0] === "playFrom");
    expect(playFrom).toHaveLength(2);
    expect(playFrom[1][1]).toHaveLength(3);
    expect(playFrom[1][2]).toBe(1);
    expect(h.calls.filter((c) => c[0] === "transport" && c[1] === "seek").at(-1)).toEqual(["transport", "seek", 42]);
  });
});

describe("停止(stopGroupDelayTest):三种现场必须区分", () => {
  it("起测前在播 ⇒ 恢复起测前的 playMode", async () => {
    resetSnap([item("s1"), item("s2")], 1, "single");
    h.state.status = { state: "PLAYING", position: 17, duration: 60 };
    await startGroupDelayTest("gA", BASE);
    const r = await stopGroupDelayTest("gA", BASE);
    expect(r).toEqual({ running: false, restored: true });
    expect(isGroupDelayTestActive("gA")).toBe(false);
    expect(h.calls.filter((c) => c[0] === "setPlayMode").at(-1)).toEqual(["setPlayMode", "single"]);
  });

  it("起测前暂停 ⇒ 重新起播后**再暂停**(不把用户的暂停态变成播放)", async () => {
    resetSnap([item("s1")], 0, "loop");
    h.state.status = { state: "PAUSED", position: 9, duration: 60 };
    await startGroupDelayTest("gA", BASE);
    await stopGroupDelayTest("gA", BASE);
    expect(h.calls.filter((c) => c[0] === "transport").at(-1)).toEqual(["transport", "pause", undefined]);
    expect(h.calls.some((c) => c[0] === "transport" && c[1] === "seek")).toBe(false);
  });

  it("起测前只是装载队列未播 ⇒ 只还原队列数据与游标,**绝不顺手起播**", async () => {
    resetSnap([item("s1"), item("s2")], 0, "shuffle");
    h.state.status = { state: "STOPPED", position: 0, duration: 0 };
    await startGroupDelayTest("gA", BASE);
    await stopGroupDelayTest("gA", BASE);
    expect(h.calls.filter((c) => c[0] === "playFrom")).toHaveLength(1); // 只有起测那一次
    expect(h.calls.find((c) => c[0] === "setQueue")).toEqual(["setQueue", h.snap.items, 0]);
    // 两次:stopGroupDelayTest 先停一次,restorePrevQueue 的「装载未播」分支为把
    // setQueue 置起的 isActive 再压回停止态,又停一次(语义上是同一现场的两段)。
    expect(h.calls.filter((c) => c[0] === "stopPlayback")).toHaveLength(2);
  });

  it("起测前无队列 ⇒ 清空队列(设备已停,队列不留测试音)", async () => {
    resetSnap([], -1, "shuffle");
    await startGroupDelayTest("gA", BASE);
    const r = await stopGroupDelayTest("gA", BASE);
    expect(r).toEqual({ running: false, restored: false });
    expect(h.calls.find((c) => c[0] === "clear")).toEqual(["clear", { skipDeviceStop: true }]);
  });

  it("不在测试中 ⇒ 幂等(不动作)", async () => {
    await expect(stopGroupDelayTest("gZ", BASE)).resolves.toEqual({ running: false, restored: false });
    expect(h.calls).toHaveLength(0);
  });

  it("现场读不到组状态 ⇒ 按「没在播」处理,只还原队列数据", async () => {
    resetSnap([item("s1")], 0, "loop");
    h.state.statusThrows = true;
    await startGroupDelayTest("gA", BASE);
    const r = await stopGroupDelayTest("gA", BASE);
    expect(r.restored).toBe(true);
    expect(h.calls.filter((c) => c[0] === "playFrom")).toHaveLength(1);
    expect(h.calls.some((c) => c[0] === "setQueue")).toBe(true);
  });
});

describe("收尾清理(外键顺序)", () => {
  it("停止后删除测试音 songs 行;playlist_songs / user_favorite_songs / play_history 引用行先清", async () => {
    await startGroupDelayTest("gA", BASE);
    // 模拟前端 scrobble 给测试音记历史、用户把它加进歌单/收藏
    seedRefs();
    db.insert(playlistSongs).values({ playlistId: "pl-1", songId: TONE_SONG_ID, position: 0 }).run();
    db.insert(userFavoriteSongs).values({ userId: "u1", songId: TONE_SONG_ID, createdAt: "" }).run();
    db.insert(playHistory).values({ userId: "u1", songId: TONE_SONG_ID, playedAt: "" }).run();

    await stopGroupDelayTest("gA", BASE);
    expect(db.select().from(songs).where(eq(songs.id, TONE_SONG_ID)).all()).toHaveLength(0);
    expect(db.select().from(playlistSongs).where(eq(playlistSongs.songId, TONE_SONG_ID)).all()).toHaveLength(0);
    expect(db.select().from(userFavoriteSongs).where(eq(userFavoriteSongs.songId, TONE_SONG_ID)).all()).toHaveLength(0);
    expect(db.select().from(playHistory).where(eq(playHistory.songId, TONE_SONG_ID)).all()).toHaveLength(0);
  });

  it("另一组仍在测试时不删行;全部停止后才删(不把还在出声的曲目抽掉)", async () => {
    await startGroupDelayTest("gA", BASE);
    await startGroupDelayTest("gB", BASE);
    await stopGroupDelayTest("gA", BASE);
    expect(db.select().from(songs).where(eq(songs.id, TONE_SONG_ID)).all()).toHaveLength(1);
    await stopGroupDelayTest("gB", BASE);
    expect(db.select().from(songs).where(eq(songs.id, TONE_SONG_ID)).all()).toHaveLength(0);
  });

  it("起播失败 ⇒ 还原起测前现场并清掉测试音行,异常仍上抛", async () => {
    resetSnap([item("s1"), item("s2")], 1, "loop");
    h.state.status = { state: "PLAYING", position: 5, duration: 60 };
    h.state.playFromThrowsOnce = true;
    await expect(startGroupDelayTest("gA", BASE)).rejects.toThrow("cast 失败");
    expect(isGroupDelayTestActive("gA")).toBe(false);
    expect(db.select().from(songs).where(eq(songs.id, TONE_SONG_ID)).all()).toHaveLength(0);
    // 起测那次抛错 + 还原那次正常
    expect(h.calls.filter((c) => c[0] === "playFrom")).toHaveLength(2);
  });

  it("songs 行用 upsert 而不是「先删后插」:有历史引用时二次起测不触发外键报错", async () => {
    await startGroupDelayTest("gA", BASE);
    seedRefs();
    db.insert(playHistory).values({ userId: "u1", songId: TONE_SONG_ID, playedAt: "" }).run();
    await stopGroupDelayTest("gA", BASE); // 停止会清掉历史行
    await expect(startGroupDelayTest("gB", BASE)).resolves.toMatchObject({ running: true });
  });
});
