// Sendspin 控制面补测(listSendspinPlayers / castSendspin / controlSendspin):
// 枚举出来的设备是「可投屏播放器」列表的唯一来源,available 必须如实反映客户端
// ready 状态 —— 卡在这里会表现为「列表里有一个点了没反应的假播放器」。
//
// MUST be the first import: re-exports the isolated DATA_DIR env for this file.
import "../plugins/_env.js";

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

const h = vi.hoisted(() => ({
  front: null as null | { clients: Map<string, { ready: boolean }> },
  started: 0,
  baseUrl: "http://127.0.0.1:46400",
  players: new Map<string, { getProtocol: () => unknown }>(),
}));

vi.mock("../../src/services/sendspin/index.js", () => ({
  getSendspinFront: () => h.front,
  startSendspinService: async () => {
    h.started += 1;
  },
}));

// baseUrl 只关心「有没有正确交到 playMedia 手里」,具体拼法归 dlna/control 管。
vi.mock("../../src/services/dlna/control.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  getEffectiveBaseUrl: () => h.baseUrl,
}));

// control.ts 靠 `require("../player/index.js").getQueueController()` 拿协议 player。
// 这是 Node 的 CJS require,vitest 的 vi.mock 拦不住(模块 id 是运行时拼出来的,
// 且 Node 的 MODULE_NOT_FOUND 直接来自文件系统);所以打在 Module.prototype.require 上。
// 只拦这一个 id,其余原样转发,不影响同进程里 vitest 自己的加载。
import Module from "node:module";
// 拦在 Module._load 这一层:require 无论经过 makeRequireFunction 还是 createRequire,
// 最终都到这里,是 Node 侧唯一稳定的落点。
const origLoad = (Module as any)._load;
(Module as any)._load = function (id: string) {
  if (typeof id === "string" && id.endsWith("player/index.js")) {
    return { getQueueController: () => ({ players: h.players }) };
  }
  return origLoad.apply(this, arguments as any);
};

import { db, initDatabase } from "../../src/db/index.js";
import { songs } from "../../src/db/schema.js";
import { castSendspin, controlSendspin, listSendspinPlayers } from "../../src/services/sendspin/control.js";

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
});

beforeEach(() => {
  h.started = 0;
  h.players.clear();
  h.front = { clients: new Map() };
});

afterEach(() => {
  vi.restoreAllMocks();
});

// 打桩只在本测试文件的进程内有效(forks 池每个测试文件独立进程),
// 到文件结束再还原,中途还原会让后面的用例集体找不到 player。
afterAll(() => {
  (Module as any)._load = origLoad;
});

/** 造一台「已注册但协议 player 是给定对象」的客户端。 */
function registerClient(deviceId: string, proto: unknown) {
  h.players.set(deviceId, { getProtocol: () => proto });
}

/** 造一台「注册了但拿不到协议 player」的客户端(stub 返回 null)。 */
function registerProtocollessClient(deviceId: string) {
  h.players.set(deviceId, { getProtocol: () => null });
}

function makeProto() {
  return {
    playMedia: vi.fn(async (item: any, baseUrl: string) => ({
      songId: item.songId,
      mediaUri: `${baseUrl}/s/${item.songId}.mp3`,
    })),
    resume: vi.fn(async () => "resumed"),
    pause: vi.fn(async () => "paused"),
    stop: vi.fn(async () => "stopped"),
    seek: vi.fn(async (seconds: number) => `seek:${seconds}`),
    setVolume: vi.fn(async (volume: number) => `vol:${volume}`),
  };
}

function seedSong(id: string, extra: any = {}) {
  db.insert(songs)
    .values({
      id,
      title: `t-${id}`,
      // path 在 schema 里是 NOT NULL(本地文件才有,线上行是空串)。
      path: "",
      artistId: null,
      albumId: null,
      type: "local",
      url: null,
      cachePath: null,
      ...extra,
    })
    .run();
}

describe("listSendspinPlayers: 枚举已连接客户端", () => {
  it("服务未启动(getSendspinFront 为空)→ 空列表,不抛错", async () => {
    h.front = null;
    await expect(listSendspinPlayers()).resolves.toEqual([]);
  });

  it("按客户端 ID 逐个渲染为 sendspin 设备,available 取自 ready", async () => {
    h.front = {
      clients: new Map([
        ["phone-a", { ready: true }],
        ["desktop-b", { ready: false }],
      ]),
    };
    const out = await listSendspinPlayers();
    expect(out).toHaveLength(2);
    const byId = new Map(out.map((d) => [d.id, d]));
    expect(byId.get("phone-a")).toMatchObject({
      id: "phone-a",
      name: "phone-a",
      type: "sendspin",
      available: true,
      meta: { manufacturer: "Sendspin", model: "Sendspin client", hasVolumeControl: true },
    });
    expect(byId.get("desktop-b")?.available).toBe(false);
  });

  it("无客户端 → 空列表(不要把上次连接的残留渲染出来)", async () => {
    h.front = { clients: new Map() };
    await expect(listSendspinPlayers()).resolves.toEqual([]);
  });
});

describe("castSendspin: 把一首歌投到指定客户端", () => {
  const DEV = "cast-dev";

  it("服务还没起来时先拉起,再把 baseUrl 交给 playMedia", async () => {
    h.front = null;
    const proto = makeProto();
    registerClient(DEV, proto);
    seedSong("s-cast-1");

    await castSendspin(DEV, "s-cast-1");
    expect(h.started).toBe(1);
    // 拉起服务这件事只做一次:第二次进来 front 已就绪,不该再起一遍。
    expect(proto.playMedia).toHaveBeenCalledTimes(1);
    expect(proto.playMedia.mock.calls[0][1]).toBe(h.baseUrl);
    // 投歌只走 playMedia,不碰 play/pause/stop 这些控制面入口。
    expect(proto.resume).not.toHaveBeenCalled();
    expect(proto.pause).not.toHaveBeenCalled();
    expect(proto.stop).not.toHaveBeenCalled();
  });

  it("服务已在跑 → 不去拉起,只投歌", async () => {
    const proto = makeProto();
    registerClient(DEV, proto);
    seedSong("s-cast-1b");

    await castSendspin(DEV, "s-cast-1b");
    expect(h.started).toBe(0);
    expect(proto.playMedia).toHaveBeenCalledTimes(1);
  });

  it("歌曲不存在 → 抛『歌曲不存在』,且完全不碰 playMedia", async () => {
    const proto = makeProto();
    registerClient(DEV, proto);

    await expect(castSendspin(DEV, "s-cast-missing")).rejects.toThrow("歌曲不存在");
    expect(proto.playMedia).not.toHaveBeenCalled();
    for (const fn of [proto.resume, proto.pause, proto.stop, proto.seek, proto.setVolume]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it("构造出的 QueueItem:mime 固定 audio/mpeg,字段缺失交给调用方兜底", async () => {
    const proto = makeProto();
    registerClient(DEV, proto);
    seedSong("s-cast-2", {
      title: "标题",
      artist: "歌手",
      album: "专辑",
      coverArt: "cover.jpg",
      duration: 214,
    });

    await castSendspin(DEV, "s-cast-2");
    expect(proto.playMedia).toHaveBeenCalledTimes(1);
    expect(proto.playMedia.mock.calls[0][0]).toMatchObject({
      songId: "s-cast-2",
      title: "标题",
      artist: "歌手",
      album: "专辑",
      coverArt: "cover.jpg",
      duration: 214,
    });
  });

  it("【兜底】曲库行的空字段与脏 duration 不能原样喂给播放器", async () => {
    const proto = makeProto();
    registerClient(DEV, proto);
    seedSong("s-cast-3", {
      title: "",
      artist: null,
      album: null,
      coverArt: "",
      duration: "不是数字",
    });

    await castSendspin(DEV, "s-cast-3");
    const item = proto.playMedia.mock.calls[0][0];
    expect(item).toMatchObject({
      title: "未知",
      artist: undefined,
      album: undefined,
      coverArt: undefined,
      duration: undefined,
    });
    expect(item.mime).toBe("audio/mpeg");
  });

  it("客户端未注册 → 抛『Sendspin 客户端未注册』(不带设备名则更难排查)", async () => {
    seedSong("s-cast-4");
    await expect(castSendspin(DEV, "s-cast-4")).rejects.toThrow(`Sendspin 客户端未注册: ${DEV}`);
  });

  it("注册了但取不到协议 player → 同样按未注册处理(null 兜底)", async () => {
    registerProtocollessClient(DEV);
    seedSong("s-cast-5");
    await expect(castSendspin(DEV, "s-cast-5")).rejects.toThrow(`Sendspin 客户端未注册: ${DEV}`);
  });

  it("playMedia 的返回值原样透传给调用方", async () => {
    const proto = makeProto();
    registerClient(DEV, proto);
    seedSong("s-cast-6");

    // playMedia 已经用 baseUrl 拼过绝对地址,调用方拿到的就是这个。
    await expect(castSendspin(DEV, "s-cast-6")).resolves.toEqual({
      songId: "s-cast-6",
      mediaUri: `${h.baseUrl}/s/s-cast-6.mp3`,
    });
  });
});

describe("controlSendspin: 控制指令分发", () => {
  const DEV = "ctl-dev";

  it("play / pause / stop 分别落到 ProtocolPlayer 的对应入口", async () => {
    const proto = makeProto();
    registerClient(DEV, proto);

    await expect(controlSendspin(DEV, "play")).resolves.toBe("resumed");
    await expect(controlSendspin(DEV, "pause")).resolves.toBe("paused");
    await expect(controlSendspin(DEV, "stop")).resolves.toBe("stopped");
    expect(proto.resume).toHaveBeenCalledTimes(1);
    expect(proto.pause).toHaveBeenCalledTimes(1);
    expect(proto.stop).toHaveBeenCalledTimes(1);
  });

  it("seek 取 payload.seconds;没带 payload 或字段缺失都按 0", async () => {
    const proto = makeProto();
    registerClient(DEV, proto);

    await controlSendspin(DEV, "seek", { seconds: 42 });
    expect(proto.seek).toHaveBeenLastCalledWith(42);
    await controlSendspin(DEV, "seek");
    expect(proto.seek).toHaveBeenLastCalledWith(0);
    await controlSendspin(DEV, "seek", {});
    expect(proto.seek).toHaveBeenLastCalledWith(0);
  });

  it("volume 取 payload.volume;没带 payload 或字段缺失都按 0", async () => {
    const proto = makeProto();
    registerClient(DEV, proto);

    await expect(controlSendspin(DEV, "volume", { volume: 73 })).resolves.toBe("vol:73");
    await expect(controlSendspin(DEV, "volume")).resolves.toBe("vol:0");
    await expect(controlSendspin(DEV, "volume", {})).resolves.toBe("vol:0");
  });

  it("未支持的 action → 抛错,而且不会去动播放器", async () => {
    const proto = makeProto();
    registerClient(DEV, proto);

    await expect(controlSendspin(DEV, "mute")).rejects.toThrow("不支持的 Sendspin 操作: mute");
    for (const fn of [proto.resume, proto.pause, proto.stop, proto.seek, proto.setVolume]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it("客户端无协议 player → 抛『Sendspin 客户端无协议 player』", async () => {
    registerProtocollessClient(DEV);
    await expect(controlSendspin(DEV, "play")).rejects.toThrow(`Sendspin 客户端无协议 player: ${DEV}`);
  });
});
