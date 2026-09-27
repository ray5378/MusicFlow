import { beforeEach, describe, it, expect, vi } from "vitest";

const f = vi.hoisted(() => ({
  createAirPlaySession: vi.fn(),
  castToAirPlayDevice: vi.fn(async () => ({ mediaUri: "cast:legacy" })),
  stopAirPlay: vi.fn(async () => undefined),
  pauseAirPlay: vi.fn(async () => undefined),
  resumeAirPlay: vi.fn(async () => undefined),
  seekAirPlay: vi.fn(async () => undefined),
  setAirPlayVolume: vi.fn(async () => undefined),
  getAirPlayStatus: vi.fn(),
}));

vi.mock("../../src/services/airplay/session.js", () => ({ createAirPlaySession: f.createAirPlaySession }));
vi.mock("../../src/services/airplay/control.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  castToAirPlayDevice: f.castToAirPlayDevice,
  stopAirPlay: f.stopAirPlay,
  pauseAirPlay: f.pauseAirPlay,
  resumeAirPlay: f.resumeAirPlay,
  seekAirPlay: f.seekAirPlay,
  setAirPlayVolume: f.setAirPlayVolume,
  getAirPlayStatus: f.getAirPlayStatus,
}));

import type { PlaybackState } from "../../src/services/player/types.js";
import type { QueueItem } from "../../src/services/player/types.js";
import { createAirPlayProtocolPlayer } from "../../src/services/airplay/protocolPlayer.js";

const DEV = "airplay-dev-1";
const item = (over: Partial<QueueItem> = {}): QueueItem =>
  ({
    songId: "s1",
    title: "曲一",
    artist: "歌手",
    album: "专辑",
    coverArt: "http://cover/1.jpg",
    duration: 214,
    mime: "audio/mpeg",
    ...over,
  }) as QueueItem;

const STREAM = "http://127.0.0.1/rest/airplay/stream/tok-abc";

// 所有断言都基于"本条用例内的调用",故每条前清掉累积调用记录(用例顺序无关)。
beforeEach(() => {
  vi.clearAllMocks();
  f.createAirPlaySession.mockReturnValue({ streamUrl: STREAM });
});

describe("createAirPlayProtocolPlayer", () => {
  it("playerId 统一带 airplay: 前缀,与 DLNA 同类", () => {
    expect(createAirPlayProtocolPlayer(DEV).playerId).toBe(`airplay:${DEV}`);
  });
});

describe("playMedia", () => {
  it("用自己的 session 铸 token,并把整首元数据透传给 cast", async () => {
    f.createAirPlaySession.mockReturnValue({ streamUrl: STREAM });
    const p = createAirPlayProtocolPlayer(DEV);
    const got = await p.playMedia(item(), "http://host");
    expect(f.createAirPlaySession).toHaveBeenCalledWith("s1", DEV, "http://host");
    expect(f.castToAirPlayDevice).toHaveBeenCalledWith({
      deviceId: DEV,
      songId: "s1",
      title: "曲一",
      artist: "歌手",
      album: "专辑",
      coverArt: "http://cover/1.jpg",
      durationSec: 214,
      baseUrl: "http://host",
      streamUrl: STREAM,
    });
    expect(got.mediaUri).toBe(STREAM);
  });

  it("mediaUri 就是 streamUrl:track_changed 靠它识别当前曲(非 token 之外的身份)", async () => {
    f.createAirPlaySession.mockReturnValue({ streamUrl: STREAM });
    const p = createAirPlayProtocolPlayer(DEV);
    const got = await p.playMedia(item({ songId: "s9" }), "http://host");
    expect(got.mediaUri).toBe(STREAM);
    expect(got.mediaUri).not.toContain("s9");
  });

  it("duration 缺省时 durationSec 也是 undefined(不做补零)", async () => {
    f.createAirPlaySession.mockReturnValue({ streamUrl: STREAM });
    await createAirPlayProtocolPlayer(DEV).playMedia(item({ duration: undefined }), "http://host");
    expect(f.castToAirPlayDevice).toHaveBeenCalledWith(expect.objectContaining({ durationSec: undefined }));
  });

  it("cast 抛错:playMedia 整体失败,不吞异常", async () => {
    f.createAirPlaySession.mockReturnValue({ streamUrl: STREAM });
    f.castToAirPlayDevice.mockRejectedValueOnce(new Error("设备无响应"));
    await expect(createAirPlayProtocolPlayer(DEV).playMedia(item(), "http://host")).rejects.toThrow("设备无响应");
  });

  it("session 铸 token 失败:不发起 cast(先铸后投的顺序)", async () => {
    f.createAirPlaySession.mockImplementationOnce(() => {
      throw new Error("token 铸失败");
    });
    await expect(createAirPlayProtocolPlayer(DEV).playMedia(item(), "http://host")).rejects.toThrow("token 铸失败");
    expect(f.castToAirPlayDevice).not.toHaveBeenCalled();
  });
});

describe("transport 透传", () => {
  it("stop / pause / resume / setVolume 各自落到 control 对应函数", async () => {
    const p = createAirPlayProtocolPlayer(DEV);
    await p.stop();
    await p.pause();
    await p.resume();
    await p.setVolume(43);
    expect(f.stopAirPlay).toHaveBeenCalledWith(DEV);
    expect(f.pauseAirPlay).toHaveBeenCalledWith(DEV);
    expect(f.resumeAirPlay).toHaveBeenCalledWith(DEV);
    expect(f.setAirPlayVolume).toHaveBeenCalledWith(DEV, 43);
  });

  it("control 端抛错:协议层原样上抛(不吞)", async () => {
    const p = createAirPlayProtocolPlayer(DEV);
    f.stopAirPlay.mockRejectedValueOnce(new Error("stop 失败"));
    f.setAirPlayVolume.mockRejectedValueOnce(new Error("volume 失败"));
    await expect(p.stop()).rejects.toThrow("stop 失败");
    await expect(p.setVolume(1)).rejects.toThrow("volume 失败");
  });
});

describe("seek", () => {
  it("正常:下发到 control,调用方拿到 resolve", async () => {
    f.seekAirPlay.mockResolvedValueOnce(undefined);
    await expect(createAirPlayProtocolPlayer(DEV).seek(12.345)).resolves.toBeUndefined();
    expect(f.seekAirPlay).toHaveBeenCalledWith(DEV, 12.345);
  });

  it("失败:记录留痕后原样上抛(不是吞掉后继续)", async () => {
    const boom = new Error("seek 失败");
    f.seekAirPlay.mockRejectedValueOnce(boom);
    await expect(createAirPlayProtocolPlayer(DEV).seek(3)).rejects.toBe(boom);
    expect(f.seekAirPlay).toHaveBeenCalledWith(DEV, 3);
  });

  it("抛非 Error(裸字符串):同样上抛,留痕走 e?.message || e 兜底", async () => {
    f.seekAirPlay.mockRejectedValueOnce("boom-string");
    await expect(createAirPlayProtocolPlayer(DEV).seek(3)).rejects.toBe("boom-string");
  });
});

describe("pollState", () => {
  it("原样映射 control 的状态字段", async () => {
    f.getAirPlayStatus.mockReturnValue({
      playbackState: "PLAYING",
      position: 12,
      duration: 200,
      updatedAt: 1700000000000,
      available: true,
      name: DEV,
      volume: 80,
      muted: false,
    });
    const s = await createAirPlayProtocolPlayer(DEV).pollState();
    expect(f.getAirPlayStatus).toHaveBeenCalledWith(DEV);
    expect(s.playerId).toBe(`airplay:${DEV}`);
    expect(s.playbackState).toBe("PLAYING" as PlaybackState);
    expect(s.position).toBe(12);
    expect(s.duration).toBe(200);
    expect(s.updatedAt).toBe(1700000000000);
  });

  it("control 端抛错:pollState 整体失败(callers 会走降级)", async () => {
    f.getAirPlayStatus.mockImplementationOnce(() => {
      throw new Error("未知设备");
    });
    await expect(createAirPlayProtocolPlayer(DEV).pollState()).rejects.toThrow("未知设备");
  });
});

describe("协议契约完备性", () => {
  it("未实现 isAvailable:沿用引入该字段之前的行为(调用方按可用处理)", () => {
    const p = createAirPlayProtocolPlayer(DEV) as any;
    expect(p.isAvailable).toBeUndefined();
  });
});
