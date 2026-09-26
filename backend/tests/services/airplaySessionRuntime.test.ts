/**
 * AirplaySessionRuntime 单测。
 *
 * 该模块是 AirPlay 推流的「纯运行时」:从 control.ts 抽出、剥掉全部主进程态
 * (DB 设备记录 / DLNA 双协议互斥 / token 化 streamUrl / peer 注册),因此可以
 * 完全靠桩掉 RaopPlayer + spawnDecoder 驱动整套状态机。
 *
 * 覆盖点:
 *  - 起播:同设备幂等(旧会话先拆)/ RTSP 握手失败回滚 / 流失败只记日志不抛
 *  - 停播:stop / stopAll / 不存在的 device 静默返回
 *  - 暂停恢复:有会话 true、无会话 false
 *  - 原地 seek:RTSP 会话保持 + 只换解码器;会话被抢走时回落(返回 false)
 *  - 音量:setVolumeDb
 *  - 快照:playing / paused 镜像 + duration / position 归一
 *  - 节拍健康度:周期打点,reanchors>0 或 maxGap 超阈升级 warn
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const H = vi.hoisted(() => {
  interface FakeStream {
    player: any;
    resolve: () => void;
    reject: (e: unknown) => void;
  }
  const state = {
    players: [] as any[],
    decoders: [] as any[],
    streams: [] as FakeStream[],
    logs: [] as { level: string; msg: string }[],
    connectImpl: null as null | (() => Promise<any>),
    prepareSeekImpl: null as null | ((seekSec: number) => Promise<void>),
    stopImpl: null as null | (() => Promise<void>),
  };

  class FakeRaopPlayer {
    opts: any;
    calls: string[] = [];
    isStreaming = true;
    isPaused = false;
    positionSec = 0;
    durationSec = 0;
    realtimeStats: any = null;
    preparedSeek: number[] = [];
    volumeDb: number[] = [];
    constructor(opts: any) {
      this.opts = opts;
      state.players.push(this);
    }
    async connect(): Promise<any> {
      if (state.connectImpl) return state.connectImpl();
      return { sid: `sess-${state.players.length}` };
    }
    stream(_producer: any, _session: any): Promise<void> {
      this.calls.push("stream");
      return new Promise<void>((resolve, reject) => {
        state.streams.push({ player: this, resolve, reject });
      });
    }
    async stop(): Promise<void> {
      this.calls.push("stop");
      this.isStreaming = false;
      if (state.stopImpl) return state.stopImpl();
    }
    pause(): void {
      this.calls.push("pause");
      this.isPaused = true;
    }
    resume(): void {
      this.calls.push("resume");
      this.isPaused = false;
    }
    async prepareSeek(seekSec: number): Promise<void> {
      this.calls.push(`prepareSeek:${seekSec}`);
      this.preparedSeek.push(seekSec);
      if (state.prepareSeekImpl) return state.prepareSeekImpl(seekSec);
    }
    setVolumeDb(db: number): void {
      this.calls.push(`setVolumeDb:${db}`);
      this.volumeDb.push(db);
    }
  }

  function makeDecoder(): any {
    const ff: any = {
      killed: false,
      stdout: { destroy() {} },
      stderr: { destroy() {} },
      stderrText: () => "",
      kill() {
        ff.killed = true;
      },
    };
    state.decoders.push(ff);
    return ff;
  }

  return { state, FakeRaopPlayer, makeDecoder };
});

vi.mock("../../src/services/airplay/raop.js", () => ({ RaopPlayer: H.FakeRaopPlayer }));

vi.mock("../../src/services/airplay/decoder.js", () => ({
  spawnDecoder: () => H.makeDecoder(),
  makeProducer: () => async () => null,
}));

vi.mock("../../src/utils/logger.js", () => ({
  createLogger: () => ({
    info: (msg: string) => H.state.logs.push({ level: "info", msg }),
    warn: (msg: string) => H.state.logs.push({ level: "warn", msg }),
    error: (msg: string) => H.state.logs.push({ level: "error", msg }),
    debug: () => {},
  }),
}));

const { AirplaySessionRuntime } = await import("../../src/services/airplay/sessionRuntime.js");

const S = H.state;

/** 让所有已排队的 microtask 跑完(流的 catch/finally 链有多层)。 */
const flush = () => new Promise<void>((r) => setImmediate(r));

function makeHooks() {
  return { onSessionEnded: vi.fn(), onChanged: vi.fn() };
}

function castArgs(over: Record<string, unknown> = {}) {
  return {
    deviceId: "ap-1",
    host: "192.168.10.31",
    port: 5000,
    pk: "pk-1",
    et: "et-1",
    streamUrl: "http://192.168.10.240:46400/rest/dlna/stream/tok1",
    durationSec: 240,
    title: "T",
    artist: "A",
    album: "AL",
    songId: 42,
    ...over,
  } as any;
}

beforeEach(() => {
  S.players.length = 0;
  S.decoders.length = 0;
  S.streams.length = 0;
  S.logs.length = 0;
  S.connectImpl = null;
  S.prepareSeekImpl = null;
  S.stopImpl = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("AirplaySessionRuntime / 生命周期", () => {
  it("初始为空:has=false、activeIds 为空", () => {
    const rt = new AirplaySessionRuntime();
    expect(rt.has("ap-1")).toBe(false);
    expect(rt.activeIds()).toEqual([]);
    expect(rt.snapshot().sessions).toEqual([]);
  });

  it("cast 成功后会话入表、通知 onChanged、解码器已创建", async () => {
    const hooks = makeHooks();
    const rt = new AirplaySessionRuntime(hooks);
    await rt.cast(castArgs());

    expect(rt.has("ap-1")).toBe(true);
    expect(rt.activeIds()).toEqual(["ap-1"]);
    expect(hooks.onChanged).toHaveBeenCalledTimes(1);
    expect(S.players).toHaveLength(1);
    expect(S.players[0].opts).toMatchObject({ host: "192.168.10.31", port: 5000, pk: "pk-1", et: "et-1" });
    expect(S.players[0].calls).toContain("stream");
    expect(S.decoders).toHaveLength(1);
  });

  it("cast 同设备二次调用是幂等的:旧会话被 stop,且只留一条会话", async () => {
    const rt = new AirplaySessionRuntime();
    await rt.cast(castArgs());
    const first = S.players[0];
    await rt.cast(castArgs({ streamUrl: "http://x/tok2" }));

    expect(first.calls).toContain("stop");
    expect(rt.activeIds()).toEqual(["ap-1"]);
    expect(S.players).toHaveLength(2);
  });

  it("RTSP 握手失败:回滚已建连接并向上抛错,会话不入表", async () => {
    const rt = new AirplaySessionRuntime();
    S.connectImpl = () => Promise.reject(new Error("rtsp 453"));
    await expect(rt.cast(castArgs())).rejects.toThrow("rtsp 453");

    expect(rt.has("ap-1")).toBe(false);
    expect(S.players[0].calls).toContain("stop");
    expect(S.decoders).toHaveLength(0);
  });

  it("握手失败且回滚 stop 也失败时不掩盖原始错误", async () => {
    const rt = new AirplaySessionRuntime();
    S.connectImpl = () => Promise.reject(new Error("boom"));
    S.stopImpl = () => Promise.reject(new Error("socket already gone"));
    await expect(rt.cast(castArgs())).rejects.toThrow("boom");
  });

  it("推流 promise 失败:只记 error 日志,并走收尾(拆会话 + 通知 host)", async () => {
    const hooks = makeHooks();
    const rt = new AirplaySessionRuntime(hooks);
    await rt.cast(castArgs());
    S.streams[0].reject(new Error("rtp push failed"));
    await flush();

    expect(S.logs.some((l) => l.level === "error" && l.msg === "airplay stream failed")).toBe(true);
    expect(rt.has("ap-1")).toBe(false);
    expect(S.players[0].calls).toContain("stop");
    expect(hooks.onSessionEnded).toHaveBeenCalledWith("ap-1", undefined);
  });

  it("流自然结束:拆会话、杀解码器并透传 loudnorm stderr 给 host", async () => {
    const hooks = makeHooks();
    const rt = new AirplaySessionRuntime(hooks);
    await rt.cast(castArgs());
    S.decoders[0].stderrText = () => '{"input_i":"-14.2"}';
    S.streams[0].resolve();
    await flush();

    expect(S.decoders[0].killed).toBe(true);
    expect(S.players[0].calls).toContain("stop");
    expect(hooks.onSessionEnded).toHaveBeenCalledWith("ap-1", {
      loudnessStderr: '{"input_i":"-14.2"}',
    });
    // 收尾后再通知一次变更(用于推最终快照)
    expect(hooks.onChanged).toHaveBeenCalledTimes(2);
  });

  it("stop:拆会话 + 杀解码器 + stop 播放器 + 通知变更", async () => {
    const hooks = makeHooks();
    const rt = new AirplaySessionRuntime(hooks);
    await rt.cast(castArgs());
    await rt.stop("ap-1");

    expect(rt.has("ap-1")).toBe(false);
    expect(S.decoders[0].killed).toBe(true);
    expect(S.players[0].calls).toContain("stop");
    expect(hooks.onChanged).toHaveBeenCalledTimes(2);
  });

  it("stop 不存在的设备:静默返回,不触发 onChanged", async () => {
    const hooks = makeHooks();
    const rt = new AirplaySessionRuntime(hooks);
    await rt.stop("nope");
    expect(hooks.onChanged).not.toHaveBeenCalled();
  });

  it("stopAll:清掉全部会话", async () => {
    const rt = new AirplaySessionRuntime();
    await rt.cast(castArgs({ deviceId: "ap-1" }));
    await rt.cast(castArgs({ deviceId: "ap-2", port: 5001 }));
    expect(rt.activeIds().sort()).toEqual(["ap-1", "ap-2"]);

    await rt.stopAll();
    expect(rt.activeIds()).toEqual([]);
    expect(S.players.every((p) => p.calls.includes("stop"))).toBe(true);
  });

  it("stopAll 在单个 stop 抛错时仍继续清理其余会话", async () => {
    const rt = new AirplaySessionRuntime();
    await rt.cast(castArgs({ deviceId: "ap-1" }));
    await rt.cast(castArgs({ deviceId: "ap-2" }));
    // stop 内部已 .catch 掉 player.stop 的拒绝,这里验证整体不被中断
    S.stopImpl = () => Promise.reject(new Error("nope"));
    await rt.stopAll();
    expect(rt.activeIds()).toEqual([]);
  });
});

describe("AirplaySessionRuntime / 暂停恢复与音量", () => {
  it("pause/resume 有会话时返回 true 并转发到播放器", async () => {
    const hooks = makeHooks();
    const rt = new AirplaySessionRuntime(hooks);
    await rt.cast(castArgs());

    expect(rt.pause("ap-1")).toBe(true);
    expect(S.players[0].isPaused).toBe(true);
    expect(rt.resume("ap-1")).toBe(true);
    expect(S.players[0].isPaused).toBe(false);
    // cast + pause + resume
    expect(hooks.onChanged).toHaveBeenCalledTimes(3);
  });

  it("pause/resume 无会话时返回 false(交主进程决定是否重播)", () => {
    const rt = new AirplaySessionRuntime();
    expect(rt.pause("ap-1")).toBe(false);
    expect(rt.resume("ap-1")).toBe(false);
  });

  it("setVolumeDb 转发给播放器;无会话返回 false", async () => {
    const rt = new AirplaySessionRuntime();
    expect(rt.setVolumeDb("ap-1", -12)).toBe(false);
    await rt.cast(castArgs());
    expect(rt.setVolumeDb("ap-1", -12)).toBe(true);
    expect(S.players[0].volumeDb).toEqual([-12]);
  });
});

describe("AirplaySessionRuntime / 原地 seek", () => {
  it("无会话时返回 false", async () => {
    const rt = new AirplaySessionRuntime();
    await expect(rt.seek("ap-1", 30)).resolves.toBe(false);
  });

  it("播放器已不在推流状态时返回 false(交调用方走重播)", async () => {
    const rt = new AirplaySessionRuntime();
    await rt.cast(castArgs());
    S.players[0].isStreaming = false;
    await expect(rt.seek("ap-1", 30)).resolves.toBe(false);
    // 未触发任何 seek 动作
    expect(S.players[0].preparedSeek).toEqual([]);
  });

  it("原地 seek:RTSP 会话保持,只换解码器,并保留原暂停态", async () => {
    const hooks = makeHooks();
    const rt = new AirplaySessionRuntime(hooks);
    await rt.cast(castArgs());
    const player = S.players[0];
    rt.pause("ap-1");
    const oldDecoder = S.decoders[0];

    const oldStream = S.streams[0];
    const seekPromise = rt.seek("ap-1", 42.6);
    // prepareSeek 已发出,等旧流收尾
    await flush();
    expect(player.preparedSeek).toEqual([42.6]);
    expect(oldDecoder.killed).toBe(true);

    oldStream.resolve();
    const ok = await seekPromise;

    expect(ok).toBe(true);
    // RTSP 会话没有重建:仍是同一个 player
    expect(rt.has("ap-1")).toBe(true);
    expect(S.players).toHaveLength(1);
    expect(player.calls.filter((c) => c === "stop")).toHaveLength(0);
    expect(player.calls).toContain("stream");
    // 新解码器已建(第 2 个)
    expect(S.decoders).toHaveLength(2);
    // 原来暂停着 → 新流起播后重新暂停
    expect(player.isPaused).toBe(true);
    expect(hooks.onChanged).toHaveBeenCalled();
  });

  it("旧流收尾时把会话抢走(已不在表内)→ 回落重播,返回 false", async () => {
    const rt = new AirplaySessionRuntime();
    await rt.cast(castArgs());
    const oldStream = S.streams[0];
    S.prepareSeekImpl = async () => {
      // 模拟:收尾竞态中会话被别处拆掉
      await rt.stop("ap-1");
    };

    const seekPromise = rt.seek("ap-1", 10);
    await flush();
    oldStream.resolve();
    await expect(seekPromise).resolves.toBe(false);
    expect(rt.has("ap-1")).toBe(false);
  });

  it("seek 负数被夹到 0", async () => {
    const rt = new AirplaySessionRuntime();
    await rt.cast(castArgs());
    const seekPromise = rt.seek("ap-1", -5);
    await flush();
    S.streams[0].resolve();
    await expect(seekPromise).resolves.toBe(true);
    expect(S.players[0].preparedSeek).toEqual([0]);
  });
});

describe("AirplaySessionRuntime / 快照镜像", () => {
  it("playing:镜像 title/artist/album/streamUrl/startedAt 与进度", async () => {
    const rt = new AirplaySessionRuntime();
    await rt.cast(castArgs());
    const player = S.players[0];
    player.positionSec = 12.5;
    player.durationSec = 200;
    player.realtimeStats = { chunks: 10, elapsedMs: 1000, reanchors: 0, maxGapMs: 2, lossRequests: 0 };

    const snap = rt.snapshot();
    expect(snap.sessions).toHaveLength(1);
    expect(snap.sessions[0]).toMatchObject({
      deviceId: "ap-1",
      playbackState: "playing",
      positionSec: 12.5,
      durationSec: 240, // cast 传入的 durationSec 优先
      ended: false,
      title: "T",
      artist: "A",
      album: "AL",
      streamUrl: "http://192.168.10.240:46400/rest/dlna/stream/tok1",
    });
    expect(snap.sessions[0].startedAt).toBeGreaterThan(0);
    expect(snap.sessions[0].stream).toMatchObject({ chunks: 10 });
  });

  it("paused:playbackState 反映暂停;负数位置被夹到 0;cast 未给 duration 时回落播放器时长", async () => {
    const rt = new AirplaySessionRuntime();
    await rt.cast(castArgs({ durationSec: undefined }));
    const player = S.players[0];
    player.positionSec = -3;
    player.durationSec = 187;
    rt.pause("ap-1");

    const row = rt.snapshot().sessions[0];
    expect(row.playbackState).toBe("paused");
    expect(row.positionSec).toBe(0);
    expect(row.durationSec).toBe(187);
  });

  it("无实时统计时 stream 字段缺省(不写 undefined 以外的脏值)", async () => {
    const rt = new AirplaySessionRuntime();
    await rt.cast(castArgs());
    expect(rt.snapshot().sessions[0].stream).toBeUndefined();
  });
});

describe("AirplaySessionRuntime / 节拍健康度打点", () => {
  it("周期打点:指标正常走 info", async () => {
    vi.useFakeTimers();
    const rt = new AirplaySessionRuntime();
    await rt.cast(castArgs());
    S.players[0].realtimeStats = { chunks: 100, elapsedMs: 15000, reanchors: 0, maxGapMs: 3, lossRequests: 0 };

    vi.advanceTimersByTime(15000);
    const lines = S.logs.filter((l) => l.msg.includes("节拍健康度"));
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe("info");
    expect(lines[0].msg).toContain("reanchors=0");
  });

  it("有补发(reanchors>0)时升级为 warn", async () => {
    vi.useFakeTimers();
    const rt = new AirplaySessionRuntime();
    await rt.cast(castArgs());
    S.players[0].realtimeStats = { chunks: 100, elapsedMs: 15000, reanchors: 2, maxGapMs: 9, lossRequests: 1 };

    vi.advanceTimersByTime(15000);
    const lines = S.logs.filter((l) => l.msg.includes("节拍健康度"));
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe("warn");
    expect(lines[0].msg).toContain("有抖动");
  });

  it("maxGap 超阈(>50ms)也升级为 warn;无统计时该周期静默", async () => {
    vi.useFakeTimers();
    const rt = new AirplaySessionRuntime();
    await rt.cast(castArgs());

    vi.advanceTimersByTime(15000); // realtimeStats 为 null → 不打点
    expect(S.logs.filter((l) => l.msg.includes("节拍健康度"))).toHaveLength(0);

    S.players[0].realtimeStats = { chunks: 50, elapsedMs: 30000, reanchors: 0, maxGapMs: 120, lossRequests: 0 };
    vi.advanceTimersByTime(15000);
    const lines = S.logs.filter((l) => l.msg.includes("节拍健康度"));
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe("warn");
  });

  it("会话结束后健康度定时器被清掉", async () => {
    vi.useFakeTimers();
    const rt = new AirplaySessionRuntime();
    await rt.cast(castArgs());
    S.players[0].realtimeStats = { chunks: 1, elapsedMs: 1000, reanchors: 0, maxGapMs: 1, lossRequests: 0 };
    await rt.stop("ap-1");

    vi.advanceTimersByTime(60000);
    expect(S.logs.filter((l) => l.msg.includes("节拍健康度"))).toHaveLength(0);
  });
});
