/**
 * player/playerWebhook.ts —— 通用播放器 Webhook(URL 参数即配置)。
 *
 * 覆盖:渠道 token 的 CRUD/校验/归属解析;device 参数 → cast peerId 的三种解析
 * (精确 peerId / all / 名字模糊匹配);以及 handlePlayerWebhook 的四段式执行
 * (mode → 传输 → 音量 → 收藏)与逐项失败聚合。
 *
 * 外部副作用(DLNA 控制、群组协议、队列控制器、peer 队列快照)全部桩掉;
 * 只保留真实 DB(隔离测试库)用于 token / 收藏断言。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const M = vi.hoisted(() => {
  // 最小但语义正确的 peerId 解析器(与真实实现的 kind 白名单一致)
  const parsePeerId = (s: string) => {
    const i = s.indexOf(":");
    if (i <= 0) return null;
    const kind = s.slice(0, i);
    const id = s.slice(i + 1);
    if (!id) return null;
    if (!["dlna", "group", "airplay", "local", "web"].includes(kind)) return null;
    return { kind, id };
  };

  const state = {
    devices: [] as any[],
    groups: [] as any[],
    airplay: [] as any[],
    deviceVolume: 30,
    groupVolume: 50,
    volumeReadable: true,
    snapshot: null as any,
    throwOn: {} as Record<string, Error>,
  };

  const qmCalls: any[] = [];
  const qcCalls: any[] = [];
  const dlnaCalls: any[] = [];

  return { parsePeerId, state, qmCalls, qcCalls, dlnaCalls };
});

vi.mock("../../src/services/peer.js", () => ({
  parsePeerId: M.parsePeerId,
  getPeerManager: () => ({
    getQueueSnapshot: () => M.state.snapshot,
  }),
}));

vi.mock("../../src/services/dlna/queue.js", () => ({
  getQueueManager: () => ({
    setPlayMode: (id: string, mode: string) => M.qmCalls.push(["setPlayMode", id, mode]),
    next: async (id: string, baseUrl: string) => {
      M.qmCalls.push(["next", id, baseUrl]);
      if (M.state.throwOn.next) throw M.state.throwOn.next;
    },
    prev: async (id: string, baseUrl: string) => {
      M.qmCalls.push(["prev", id, baseUrl]);
      if (M.state.throwOn.prev) throw M.state.throwOn.prev;
    },
  }),
}));

vi.mock("../../src/services/player/index.js", () => ({
  getQueueController: () => ({
    resumePlayback: (id: string) => M.qcCalls.push(["resumePlayback", id]),
    stopPlayback: (id: string) => M.qcCalls.push(["stopPlayback", id]),
    next: async (id: string, baseUrl: string) => M.qcCalls.push(["next", id, baseUrl]),
    prev: async (id: string, baseUrl: string) => M.qcCalls.push(["prev", id, baseUrl]),
    transport: async (id: string, op: string, arg?: unknown) => {
      M.qcCalls.push(["transport", id, op, arg]);
      if (M.state.throwOn.transport) throw M.state.throwOn.transport;
    },
  }),
}));

vi.mock("../../src/services/group/index.js", () => ({
  getGroupManager: () => ({ list: () => M.state.groups }),
}));

vi.mock("../../src/services/group/protocolPlayer.js", () => ({
  getGroupStatus: async () => ({ volume: M.state.volumeReadable ? M.state.groupVolume : undefined }),
}));

vi.mock("../../src/services/dlna/control.js", () => ({
  getCachedDevices: () => M.state.devices,
  getDeviceStatus: async () => ({ volume: M.state.volumeReadable ? M.state.deviceVolume : undefined }),
  playDevice: async (id: string) => M.dlnaCalls.push(["playDevice", id]),
  pauseDevice: async (id: string) => M.dlnaCalls.push(["pauseDevice", id]),
  stopDevice: async (id: string) => M.dlnaCalls.push(["stopDevice", id]),
  setDeviceVolume: async (id: string, v: number) => M.dlnaCalls.push(["setDeviceVolume", id, v]),
}));

vi.mock("../../src/services/airplay/control.js", () => ({
  listAirPlayDevices: () => M.state.airplay,
}));

import {
  listPlayerWebhookTokens,
  createPlayerWebhookToken,
  deletePlayerWebhookToken,
  setPlayerWebhookTokenEnabled,
  validatePlayerWebhookToken,
  getPlayerWebhookTokenById,
  resolvePlayerWebhookOwnerName,
  resolvePlayerDevicePeers,
  handlePlayerWebhook,
  PLAY_MODES,
} from "../../src/services/player/playerWebhook.js";
import { db, sqlite } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { upsertSong } from "../../src/services/source/scanner.js";

function seedUser(id: string, username: string) {
  db.insert(users).values({
    id, username, password: "x", salt: "s", subsonicSalt: "ss",
  }).run();
}

beforeEach(() => {
  sqlite.prepare("DELETE FROM player_webhook_tokens").run();
  sqlite.prepare("DELETE FROM user_favorite_songs").run();
  M.state.devices = [];
  M.state.groups = [];
  M.state.airplay = [];
  M.state.deviceVolume = 30;
  M.state.groupVolume = 50;
  M.state.volumeReadable = true;
  M.state.snapshot = null;
  M.state.throwOn = {};
  M.qmCalls.length = 0;
  M.qcCalls.length = 0;
  M.dlnaCalls.length = 0;
});

describe("渠道 token 管理", () => {
  it("新建 token:32 位无横线、默认启用、绑定 owner,并可被 list 读到", () => {
    const token = createPlayerWebhookToken("u1", "HA 自动化");

    expect(token).toMatch(/^[0-9a-f]{32}$/);
    const all = listPlayerWebhookTokens();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ name: "HA 自动化", token, enabled: true, ownerUserId: "u1" });
  });

  it("校验 token:启用时返回归属用户;停用/不存在 -> undefined", () => {
    const token = createPlayerWebhookToken("u1", "t");
    expect(validatePlayerWebhookToken(token)).toEqual({ ownerUserId: "u1" });

    const id = listPlayerWebhookTokens()[0].id;
    setPlayerWebhookTokenEnabled(id, false);
    expect(validatePlayerWebhookToken(token)).toBeUndefined();
    expect(validatePlayerWebhookToken("deadbeef")).toBeUndefined();
  });

  it("启用/停用与删除都按受影响行数返回布尔", () => {
    const token = createPlayerWebhookToken("u1", "t");
    const id = listPlayerWebhookTokens()[0].id;

    expect(setPlayerWebhookTokenEnabled(id, false)).toBe(true);
    expect(listPlayerWebhookTokens()[0].enabled).toBe(false);
    expect(setPlayerWebhookTokenEnabled("nope", false)).toBe(false);

    expect(deletePlayerWebhookToken(id)).toBe(true);
    expect(deletePlayerWebhookToken(id)).toBe(false);
    expect(validatePlayerWebhookToken(token)).toBeUndefined();
  });

  it("按 id 取单条:空 id / 不存在 -> undefined,存在则回全字段", () => {
    expect(getPlayerWebhookTokenById("")).toBeUndefined();
    expect(getPlayerWebhookTokenById("missing")).toBeUndefined();
    createPlayerWebhookToken("u9", "音流");
    const id = listPlayerWebhookTokens()[0].id;
    expect(getPlayerWebhookTokenById(id)).toMatchObject({ id, name: "音流", enabled: true, ownerUserId: "u9" });
  });

  it("归属用户名:有用户返回 username,无用户/空 id 返回空串", () => {
    seedUser("u-name", "ray");
    expect(resolvePlayerWebhookOwnerName("u-name")).toBe("ray");
    expect(resolvePlayerWebhookOwnerName("ghost")).toBe("");
    expect(resolvePlayerWebhookOwnerName("")).toBe("");
  });
});

describe("resolvePlayerDevicePeers", () => {
  it("空 device -> 抛错", () => {
    expect(() => resolvePlayerDevicePeers("")).toThrow("缺少 device 参数");
    expect(() => resolvePlayerDevicePeers("   ")).toThrow("缺少 device 参数");
  });

  it("精确 peerId:dlna / group / airplay 原样返回", () => {
    expect(resolvePlayerDevicePeers("dlna:d1")).toEqual(["dlna:d1"]);
    expect(resolvePlayerDevicePeers("group:g1")).toEqual(["group:g1"]);
    expect(resolvePlayerDevicePeers("airplay:a1")).toEqual(["airplay:a1"]);
  });

  it("前缀合法但 id 为空 -> 无效 peerId", () => {
    expect(() => resolvePlayerDevicePeers("dlna:")).toThrow("无效的 peerId");
    expect(() => resolvePlayerDevicePeers("group:")).toThrow("无效的 peerId");
  });

  it("all:只收在线 DLNA 设备 + 全部群组", () => {
    M.state.devices = [
      { id: "d1", name: "客厅", available: true },
      { id: "d2", name: "书房", available: false },
    ];
    M.state.groups = [{ id: "g1", name: "全屋" }];
    expect(resolvePlayerDevicePeers("all")).toEqual(["dlna:d1", "group:g1"]);
  });

  it("all:一个可用播放器都没有 -> 抛错", () => {
    M.state.devices = [{ id: "d2", name: "书房", available: false }];
    expect(() => resolvePlayerDevicePeers("all")).toThrow("没有可用的播放器");
  });

  it("名字模糊匹配(大小写不敏感):DLNA / AirPlay / 群组都能命中", () => {
    M.state.devices = [{ id: "d1", name: "Living Room" }];
    M.state.airplay = [{ id: "a1", name: "卧室 HomePod" }];
    M.state.groups = [{ id: "g1", name: "全屋" }];

    expect(resolvePlayerDevicePeers("living")).toEqual(["dlna:d1"]);
    expect(resolvePlayerDevicePeers("卧室")).toEqual(["airplay:a1"]);
    expect(resolvePlayerDevicePeers("全屋")).toEqual(["group:g1"]);
  });

  it("模糊匹配不到 / 匹配到多个 -> 分别抛错", () => {
    M.state.devices = [
      { id: "d1", name: "客厅音箱" },
      { id: "d2", name: "客厅音箱 Pro" },
    ];
    expect(() => resolvePlayerDevicePeers("厨房")).toThrow("找不到播放器");
    expect(() => resolvePlayerDevicePeers("客厅")).toThrow(/匹配到多个播放器/);
  });
});

describe("handlePlayerWebhook / 入口校验", () => {
  it("非 cast 类型 peerId 直接抛错", async () => {
    await expect(handlePlayerWebhook("local:u1", {}, "http://h")).rejects.toThrow(/仅支持/);
    await expect(handlePlayerWebhook("bad-id", {}, "http://h")).rejects.toThrow(/仅支持/);
  });

  it("mode 非法抛错;合法则写入队列管理器并记为成功", async () => {
    await expect(handlePlayerWebhook("dlna:d1", { mode: "bogus" }, "http://h")).rejects.toThrow(/无效的 mode/);

    const r = await handlePlayerWebhook("dlna:d1", { mode: "shuffle" }, "http://h");
    expect(M.qmCalls).toContainEqual(["setPlayMode", "d1", "shuffle"]);
    expect(r.results[0]).toMatchObject({ op: "mode", ok: true, detail: "shuffle" });
    expect(r.success).toBe(true);
    expect(PLAY_MODES).toContain("shuffle");
  });

  it("什么参数都不给:成功但零操作", async () => {
    const r = await handlePlayerWebhook("dlna:d1", {}, "http://h");
    expect(r.results).toEqual([]);
    expect(r.success).toBe(true);
    expect(r.device).toBe("dlna:d1");
  });
});

describe("handlePlayerWebhook / 传输控制", () => {
  it("DLNA:play = 恢复播放 + 设备 play;pause/stop 各自落到 DLNA 控制", async () => {
    const r = await handlePlayerWebhook("dlna:d1", { play: "1", pause: "true", stop: "yes" }, "http://h/base");

    expect(M.qcCalls).toContainEqual(["resumePlayback", "d1"]);
    expect(M.qcCalls).toContainEqual(["stopPlayback", "d1"]);
    expect(M.dlnaCalls).toEqual([
      ["playDevice", "d1"],
      ["pauseDevice", "d1"],
      ["stopDevice", "d1"],
    ]);
    // 固定顺序 play -> pause -> stop
    expect(r.results.map((x) => x.op)).toEqual(["play", "pause", "stop"]);
    expect(r.results.every((x) => x.ok)).toBe(true);
  });

  it("DLNA:next / prev 走队列管理器并带上 baseUrl", async () => {
    await handlePlayerWebhook("dlna:d1", { next: "on", prev: "1" }, "http://h/base");
    expect(M.qmCalls).toContainEqual(["next", "d1", "http://h/base"]);
    expect(M.qmCalls).toContainEqual(["prev", "d1", "http://h/base"]);
  });

  it("AirPlay:play/stop 走队列控制器,next/prev 走控制器,其余落 transport", async () => {
    await handlePlayerWebhook("airplay:a1", { play: "1", stop: "1", next: "1", pause: "1" }, "http://h");

    expect(M.qcCalls).toContainEqual(["resumePlayback", "a1"]);
    expect(M.qcCalls).toContainEqual(["stopPlayback", "a1"]);
    expect(M.qcCalls).toContainEqual(["next", "airplay:a1", "http://h"]);
    expect(M.qcCalls).toContainEqual(["transport", "a1", "pause", undefined]);
  });

  it("群组:play/stop 先切控制器状态再统一走 transport", async () => {
    await handlePlayerWebhook("group:g1", { play: "1", stop: "1" }, "http://h");

    expect(M.qcCalls).toContainEqual(["resumePlayback", "g1"]);
    expect(M.qcCalls).toContainEqual(["stopPlayback", "g1"]);
    expect(M.qcCalls).toContainEqual(["transport", "g1", "play", undefined]);
    expect(M.qcCalls).toContainEqual(["transport", "g1", "stop", undefined]);
  });

  it("单个传输动作失败:该项 ok=false 且整体 success=false,后续动作继续执行", async () => {
    M.state.throwOn.transport = new Error("device offline");
    const r = await handlePlayerWebhook("group:g1", { play: "1", stop: "1" }, "http://h");

    expect(r.success).toBe(false);
    const ops = Object.fromEntries(r.results.map((x) => [x.op, x]));
    expect(ops.play).toMatchObject({ ok: false, detail: "device offline" });
    expect(ops.stop.ok).toBe(false);
  });

  it("布尔参数只认 1/true/yes/on(0/空串/false 一律不触发)", async () => {
    const r = await handlePlayerWebhook("dlna:d1", { play: "0", pause: "", stop: "false" }, "http://h");
    expect(r.results).toEqual([]);
  });
});

describe("handlePlayerWebhook / 音量", () => {
  it("绝对值:DLNA 走 setDeviceVolume", async () => {
    const r = await handlePlayerWebhook("dlna:d1", { volume: "42" }, "http://h");
    expect(M.dlnaCalls).toContainEqual(["setDeviceVolume", "d1", 42]);
    expect(r.results[0]).toMatchObject({ op: "volume", ok: true, detail: "42%" });
  });

  it("绝对值:群组/AirPlay 走队列控制器 transport(id,'volume',n)", async () => {
    await handlePlayerWebhook("group:g1", { volume: "7" }, "http://h");
    expect(M.qcCalls).toContainEqual(["transport", "g1", "volume", 7]);
  });

  it("相对值:+N/-N 基于当前音量并在 0..100 夹取", async () => {
    M.state.deviceVolume = 95;
    let r = await handlePlayerWebhook("dlna:d1", { volume: "+20" }, "http://h");
    expect(M.dlnaCalls).toContainEqual(["setDeviceVolume", "d1", 100]);
    expect(r.results[0].detail).toBe("100%");

    M.dlnaCalls.length = 0;
    M.state.deviceVolume = 5;
    r = await handlePlayerWebhook("dlna:d1", { volume: "-20" }, "http://h");
    expect(M.dlnaCalls).toContainEqual(["setDeviceVolume", "d1", 0]);
    expect(r.results[0].detail).toBe("0%");
  });

  it("相对值但当前音量读不到 -> 明确失败提示,不做写入", async () => {
    M.state.volumeReadable = false;
    const r = await handlePlayerWebhook("dlna:d1", { volume: "+5" }, "http://h");
    expect(r.results[0]).toMatchObject({ op: "volume", ok: false, detail: "无法读取当前音量,不支持相对调节" });
    expect(M.dlnaCalls).toEqual([]);
  });

  it("非法音量(非数字 / 越界)-> 失败项,不抛整体异常", async () => {
    let r = await handlePlayerWebhook("dlna:d1", { volume: "abc" }, "http://h");
    expect(r.results[0].ok).toBe(false);
    expect(r.results[0].detail).toContain("无效的 volume");

    r = await handlePlayerWebhook("dlna:d1", { volume: "101" }, "http://h");
    expect(r.results[0].ok).toBe(false);
  });

  it("音量写入抛错 -> 捕获为失败项", async () => {
    M.state.throwOn.transport = new Error("volume rejected");
    const r = await handlePlayerWebhook("group:g1", { volume: "10" }, "http://h");
    expect(r.results[0]).toMatchObject({ op: "volume", ok: false, detail: "volume rejected" });
  });
});

describe("handlePlayerWebhook / 收藏与曲目摘要", () => {
  /** user_favorite_songs.song_id 有 FK 指向 songs.id —— 必须真实建行。 */
  function seedSong(title: string, artist: string): string {
    const p = `l:wf:/${title}.mp3`;
    upsertSong(
      p,
      {
        title, artist, album: "AL", duration: 100, bitRate: 320, genre: "", year: 0,
        track: 0, discNumber: 1, contentType: "audio/mpeg", suffix: "mp3", size: 1,
        albumArtist: "", composer: "", comment: "",
      } as any,
      "wf",
    );
    return (sqlite.prepare("SELECT id FROM songs WHERE path = ?").get(p) as any).id;
  }

  function snapshot(): { s0: string; s1: string } {
    // user_favorite_songs 对 users(id) 与 songs(id) 都有 FK:两边都得真实存在
    if (!sqlite.prepare("SELECT 1 FROM users WHERE id = 'u1'").get()) seedUser("u1", "u1");
    const s0 = seedSong("Zero", "A0");
    const s1 = seedSong("One", "A1");
    M.state.snapshot = {
      currentIndex: 1,
      items: [
        { songId: s0, title: "Zero", artist: "A0" },
        { songId: s1, title: "One", artist: "A1" },
      ],
    };
    return { s0, s1 };
  }

  it("favorite:把当前曲写入该 token 归属用户的收藏,重复执行不产生重复行", async () => {
    snapshot();
    const r = await handlePlayerWebhook("dlna:d1", { favorite: "1" }, "http://h", "u1");

    expect(r.results[0]).toMatchObject({ op: "favorite", ok: true, detail: "One - A1" });
    expect(sqlite.prepare("SELECT COUNT(*) c FROM user_favorite_songs WHERE user_id = 'u1'").get()).toMatchObject({ c: 1 });

    await handlePlayerWebhook("dlna:d1", { favorite: "1" }, "http://h", "u1");
    expect(sqlite.prepare("SELECT COUNT(*) c FROM user_favorite_songs WHERE user_id = 'u1'").get()).toMatchObject({ c: 1 });
  });

  it("favorite:token 没有归属用户 / 当前没有播放曲 -> 明确失败", async () => {
    snapshot();
    let r = await handlePlayerWebhook("dlna:d1", { favorite: "1" }, "http://h", "");
    expect(r.results[0]).toMatchObject({ ok: false, detail: "该 token 未绑定归属用户" });

    M.state.snapshot = { currentIndex: -1, items: [] };
    r = await handlePlayerWebhook("dlna:d1", { favorite: "1" }, "http://h", "u1");
    expect(r.results[0]).toMatchObject({ ok: false, detail: "当前没有正在播放的歌曲" });
  });

  it("返回体附带当前曲目摘要(无播放曲/索引越界时三个字段均为 undefined)", async () => {
    const { s1 } = snapshot();
    let r = await handlePlayerWebhook("dlna:d1", {}, "http://h");
    expect(r.song).toEqual({ songId: s1, title: "One", artist: "A1" });

    M.state.snapshot = {
      currentIndex: 5,
      items: [{ songId: s1, title: "One", artist: "A1" }],
    };
    r = await handlePlayerWebhook("dlna:d1", {}, "http://h");
    expect(r.song).toEqual({ songId: undefined, title: undefined, artist: undefined });
  });
});
