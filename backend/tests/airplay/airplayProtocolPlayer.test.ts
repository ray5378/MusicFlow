// AirPlay ProtocolPlayer 适配层定向单测(services/airplay/protocolPlayer.ts)。
//
// 基线覆盖率 25%(仅被 group 扇出测试间接摸到 2 行)。这里补的是契约层最容易
// 静默回归的三件事:
//   ① 起播即落位 —— startMs 必须编进**这一次** cast 的 seekSec,绝不"先起播再 seek"
//      (AirPlay seek = 完整重建会话,HiVi 类单会话设备第二次 RECORD 会挂死);
//   ② mediaUri 必须带 token 化地址,否则 PlaybackTracker 的「换歌」判据恒不可达;
//   ③ 各转发方法必须原样透传 deviceId / 参数,异常必须上抛(不能吞)。
// 全部走 mock:不建真实会话、不连设备。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const castCalls: any[] = [];
  const stopCalls: string[] = [];
  const pauseCalls: string[] = [];
  const resumeCalls: string[] = [];
  const seekCalls: Array<[string, number]> = [];
  const volumeCalls: Array<[string, number]> = [];
  const sessionCalls: Array<[string, string, string]> = [];
  const state: { seekError: Error | null; status: any; mediaUri: string | undefined } = {
    seekError: null,
    mediaUri: "http://h/rest/airplay/stream/tk-1",
    status: {
      available: true,
      name: "客厅",
      playbackState: "PLAYING",
      position: 12,
      duration: 200,
      volume: 55,
      muted: false,
      supportsRsa: true,
      updatedAt: 1_700_000_000_000,
    },
  };
  return { castCalls, stopCalls, pauseCalls, resumeCalls, seekCalls, volumeCalls, sessionCalls, state };
});

vi.mock("../../src/services/airplay/control.js", () => ({
  castToAirPlayDevice: async (opts: any) => { h.castCalls.push(opts); },
  stopAirPlay: async (deviceId: string) => { h.stopCalls.push(deviceId); },
  pauseAirPlay: async (deviceId: string) => { h.pauseCalls.push(deviceId); },
  resumeAirPlay: async (deviceId: string) => { h.resumeCalls.push(deviceId); },
  seekAirPlay: async (deviceId: string, seconds: number) => {
    h.seekCalls.push([deviceId, seconds]);
    if (h.state.seekError) throw h.state.seekError;
  },
  setAirPlayVolume: async (deviceId: string, vol: number) => { h.volumeCalls.push([deviceId, vol]); },
  getAirPlayStatus: () => h.state.status,
  getAirPlayMediaUri: () => h.state.mediaUri,
}));

vi.mock("../../src/services/airplay/session.js", () => ({
  createAirPlaySession: (songId: string, deviceId: string, baseUrl: string) => {
    h.sessionCalls.push([songId, deviceId, baseUrl]);
    const token = `tk-${songId}`;
    return { token, streamUrl: `${baseUrl}/rest/airplay/stream/${token}`, expiresAt: 0 };
  },
}));

import { createAirPlayProtocolPlayer } from "../../src/services/airplay/protocolPlayer.js";
import { PlaybackState } from "../../src/services/player/types.js";

const ITEM: any = {
  songId: "s1",
  title: "标题",
  artist: "歌手",
  album: "专辑",
  coverArt: "http://h/cover.jpg",
  mime: "audio/flac",
  duration: 200,
};

beforeEach(() => {
  h.castCalls.length = 0;
  h.stopCalls.length = 0;
  h.pauseCalls.length = 0;
  h.resumeCalls.length = 0;
  h.seekCalls.length = 0;
  h.volumeCalls.length = 0;
  h.sessionCalls.length = 0;
  h.state.seekError = null;
  h.state.mediaUri = "http://h/rest/airplay/stream/tk-1";
  h.state.status = { ...h.state.status, playbackState: "PLAYING", position: 12, duration: 200 };
  vi.clearAllMocks();
});

describe("playerId 与取流凭证", () => {
  it("playerId 带命名空间 airplay:<deviceId>(与 dlna:/group: 同口径)", () => {
    expect(createAirPlayProtocolPlayer("d1").playerId).toBe("airplay:d1");
  });

  it("playMedia 用 (songId, deviceId, baseUrl) mint 自己的 token,不复用 DLNA 通道", async () => {
    const p = createAirPlayProtocolPlayer("d1");
    await p.playMedia(ITEM, "http://base");
    expect(h.sessionCalls).toEqual([["s1", "d1", "http://base"]]);
  });

  it("playMedia 返回 token 化 mediaUri(供 tracker 判换歌)", async () => {
    const p = createAirPlayProtocolPlayer("d1");
    const r = await p.playMedia(ITEM, "http://base");
    expect(r).toEqual({ mediaUri: "http://base/rest/airplay/stream/tk-s1" });
  });
});

describe("起播即落位(seekSec 编进本次 cast)", () => {
  it("startMs=0:cast 参数不含 seekSec(缺省字段不出现)", async () => {
    const p = createAirPlayProtocolPlayer("d1");
    await p.playMedia(ITEM, "http://base", 0);
    expect(h.castCalls).toHaveLength(1);
    expect("seekSec" in h.castCalls[0]).toBe(false);
  });

  it("startMs 缺省:同样不传 seekSec", async () => {
    const p = createAirPlayProtocolPlayer("d1");
    await p.playMedia(ITEM, "http://base");
    expect("seekSec" in h.castCalls[0]).toBe(false);
  });

  it("startMs=4500 → seekSec 4.5(毫秒换秒),且只发一次 cast(不追加 seek)", async () => {
    const p = createAirPlayProtocolPlayer("d1");
    await p.playMedia(ITEM, "http://base", 4500);
    expect(h.castCalls[0].seekSec).toBe(4.5);
    expect(h.castCalls).toHaveLength(1);
    expect(h.seekCalls).toHaveLength(0);
  });

  it("负数 startMs 视为 0:不传 seekSec(不产生负偏移)", async () => {
    const p = createAirPlayProtocolPlayer("d1");
    await p.playMedia(ITEM, "http://base", -1000);
    expect("seekSec" in h.castCalls[0]).toBe(false);
  });

  it("cast 参数完整透传元数据/时长/streamUrl(缺一项设备侧就无标题无进度)", async () => {
    const p = createAirPlayProtocolPlayer("d1");
    await p.playMedia({ ...ITEM, duration: 0 }, "http://base");
    expect(h.castCalls[0]).toMatchObject({
      deviceId: "d1",
      songId: "s1",
      title: "标题",
      artist: "歌手",
      album: "专辑",
      coverArt: "http://h/cover.jpg",
      durationSec: 0,
      baseUrl: "http://base",
      streamUrl: "http://base/rest/airplay/stream/tk-s1",
    });
  });
});

describe("传输类方法透传", () => {
  it("stop/pause/resume 各自转发到对应 control 函数", async () => {
    const p = createAirPlayProtocolPlayer("d1");
    await p.stop();
    await p.pause();
    await p.resume();
    expect(h.stopCalls).toEqual(["d1"]);
    expect(h.pauseCalls).toEqual(["d1"]);
    expect(h.resumeCalls).toEqual(["d1"]);
  });

  it("seek 原样透传目标秒(不做钳制:钳制在 control 层)", async () => {
    const p = createAirPlayProtocolPlayer("d1");
    await p.seek(33.25);
    expect(h.seekCalls).toEqual([["d1", 33.25]]);
  });

  it("seek 失败必须上抛(调用方据此决定重投/报错,不可吞)", async () => {
    h.state.seekError = new Error("prepareSeek timeout");
    const p = createAirPlayProtocolPlayer("d1");
    await expect(p.seek(10)).rejects.toThrow("prepareSeek timeout");
  });

  it("setVolume 透传 0-100 标度原值", async () => {
    const p = createAirPlayProtocolPlayer("d1");
    await p.setVolume(0);
    await p.setVolume(100);
    expect(h.volumeCalls).toEqual([["d1", 0], ["d1", 100]]);
  });
});

describe("pollState 派生", () => {
  it("PLAYING 期间必须带 mediaUri(否则 tracker 换歌判据恒不可达)", async () => {
    const p = createAirPlayProtocolPlayer("d1");
    const s = await p.pollState();
    expect(s).toMatchObject({
      playerId: "airplay:d1",
      playbackState: PlaybackState.PLAYING,
      position: 12,
      duration: 200,
      mediaUri: "http://h/rest/airplay/stream/tk-1",
      updatedAt: 1_700_000_000_000,
    });
  });

  it("无活跃会话(mediaUri undefined)时不伪造 URI", async () => {
    h.state.mediaUri = undefined;
    h.state.status = { ...h.state.status, playbackState: "IDLE", position: 0, duration: 0 };
    const p = createAirPlayProtocolPlayer("d1");
    const s = await p.pollState();
    expect(s.playbackState).toBe(PlaybackState.IDLE);
    expect(s.mediaUri).toBeUndefined();
  });

  it("暂停态原样映射(paused → PAUSED,位置保留)", async () => {
    h.state.status = { ...h.state.status, playbackState: "PAUSED", position: 47 };
    const p = createAirPlayProtocolPlayer("d1");
    const s = await p.pollState();
    expect(s.playbackState).toBe(PlaybackState.PAUSED);
    expect(s.position).toBe(47);
  });
});
