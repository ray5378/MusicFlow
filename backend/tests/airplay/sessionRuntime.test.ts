// AirPlay 会话运行时(AirplaySessionRuntime)定向单测。
//
// 为什么单独补这份:该模块承载的恰是最容易出缺陷的三类分支 ——
//   ① 起播偏移口径(withOffset:必须把偏移编进回环流,不能对 live FLAC 做 -ss);
//   ② 会话收尾的「是否仍是当前会话」判定(stillCurrent:误判会把刚起播的新曲报 IDLE);
//   ③ 原地 seek 的 finalizer 抑制(seekReplace:漏抑制 = RTSP socket 泄漏 + 设备多会话)。
// 全部依赖 mock:RAOP 握手/推流、ffmpeg spawn/kill 都不碰真实网络、不 fork 子进程
// (历史教训:单测依赖真实 FS/特权路径在本机 root 过、CI 非 root 报 EACCES)。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => {
  interface FakeFf {
    url: string;
    rowId?: string;
    stderrTextImpl: () => string;
    stdout: { destroy: () => void };
    stderr: { destroy: () => void };
    stderrText: () => string;
  }

  const players: any[] = [];
  const decoders: FakeFf[] = [];
  const killed: FakeFf[] = [];
  const behavior: { connectError: string | null } = { connectError: null };

  function makeFf(url: string, rowId?: string): FakeFf {
    const ff: FakeFf = {
      url,
      rowId,
      stderrTextImpl: () => "",
      stdout: { destroy: () => {} },
      stderr: { destroy: () => {} },
      stderrText: () => ff.stderrTextImpl(),
    };
    decoders.push(ff);
    return ff;
  }

  class FakeRaopPlayer {
    opts: any;
    isPaused = false;
    isStreaming = true;
    positionSec = 42;
    durationSec = 180;
    realtimeStats: any = { chunks: 3, elapsedMs: 24_000, reanchors: 0, maxGapMs: 8, lossRequests: 0 };
    calls: string[] = [];
    streamResolvers: Array<() => void> = [];
    stopImpl: () => Promise<void> = async () => { this.calls.push("stop"); };

    constructor(opts: any) {
      this.opts = opts;
      players.push(this);
    }

    async connect(): Promise<any> {
      this.calls.push("connect");
      if (behavior.connectError) throw new Error(behavior.connectError);
      return { sessionId: "rtsp-1" };
    }

    setStartPosition(sec: number): void {
      this.calls.push(`setStartPosition:${sec}`);
    }

    stream(): Promise<void> {
      this.calls.push("stream");
      return new Promise<void>((resolve) => {
        this.streamResolvers.push(() => resolve());
      });
    }

    stop(): Promise<void> {
      return this.stopImpl();
    }

    forceClose(): void {
      this.calls.push("forceClose");
    }

    pause(): void {
      this.calls.push("pause");
      this.isPaused = true;
    }

    resume(): void {
      this.calls.push("resume");
      this.isPaused = false;
    }

    prepareSeek(t: number): Promise<void> {
      this.calls.push(`prepareSeek:${t}`);
      return Promise.resolve();
    }

    setVolumeDb(db: number): void {
      this.calls.push(`setVolumeDb:${db}`);
    }

    /** 结束第 i 次 stream(默认第 0 次)的推流 promise,驱动 finalizer。 */
    endStream(i = 0): void {
      const r = this.streamResolvers[i];
      if (r) r();
    }
  }

  return { players, decoders, killed, behavior, makeFf, FakeRaopPlayer };
});

vi.mock("../../src/services/airplay/raop.js", () => ({
  RaopPlayer: h.FakeRaopPlayer,
}));

vi.mock("../../src/services/airplay/decoder.js", () => ({
  spawnDecoder: (url: string, _opts: unknown, extra?: { rowId?: string }) => h.makeFf(url, extra?.rowId),
  makeProducer: () => ({ fake: "producer" }),
  killDecoder: (ff: any) => { h.killed.push(ff); },
}));

import { AirplaySessionRuntime } from "../../src/services/airplay/sessionRuntime.js";

const STREAM_URL = "http://h:8080/rest/airplay/stream/tk";

function castArgs(over: Record<string, unknown> = {}): any {
  return {
    deviceId: "d1",
    host: "192.168.1.10",
    port: 5000,
    streamUrl: STREAM_URL,
    songId: "s1",
    title: "标题",
    artist: "歌手",
    album: "专辑",
    durationSec: 200,
    ...over,
  };
}

const flush = (): Promise<void> => new Promise((r) => { setTimeout(r, 0); });

let runtimes: any[] = [];
let hooks: { onChanged: any; onSessionEnded: any };

function newRuntime(): any {
  hooks = { onChanged: vi.fn(), onSessionEnded: vi.fn() };
  const rt = new AirplaySessionRuntime(hooks);
  runtimes.push(rt);
  return rt;
}

beforeEach(() => {
  h.players.length = 0;
  h.decoders.length = 0;
  h.killed.length = 0;
  h.behavior.connectError = null;
  runtimes = [];
  vi.clearAllMocks();
});

afterEach(async () => {
  delete process.env.AIRPLAY_STOP_DEADLINE_MS;
  for (const rt of runtimes) {
    try { await rt.stopAll(); } catch { /* ignore */ }
  }
  runtimes = [];
  vi.useRealTimers();
});

describe("cast:起播与偏移口径", () => {
  it("带 seekSec:setStartPosition + 偏移编进回环流(timeOffset),不经 ffmpeg -ss", async () => {
    const rt = newRuntime();
    await rt.cast(castArgs({ seekSec: 12.5 }));

    expect(rt.has("d1")).toBe(true);
    expect(rt.activeIds()).toEqual(["d1"]);
    const p = h.players.at(-1)!;
    expect(p.opts).toEqual({ host: "192.168.1.10", port: 5000, pk: undefined, et: undefined });
    expect(p.calls).toContain("connect");
    expect(p.calls).toContain("setStartPosition:12.5");
    expect(p.calls).toContain("stream");
    expect(h.decoders).toHaveLength(1);
    expect(h.decoders[0].url).toBe(`${STREAM_URL}?timeOffset=12.5`);
    expect(h.decoders[0].rowId).toBe("s1");
    expect(hooks.onChanged).toHaveBeenCalledTimes(1);
  });

  it("不带 seekSec:URL 原样,且不调 setStartPosition(避免多一次 RTP 重锚)", async () => {
    const rt = newRuntime();
    await rt.cast(castArgs());
    const p = h.players.at(-1)!;
    expect(p.calls.some((c: string) => c.startsWith("setStartPosition"))).toBe(false);
    expect(h.decoders[0].url).toBe(STREAM_URL);
  });

  it("seekSec 为 0/负数/NaN:视为无偏移(早退分支)", async () => {
    const rt = newRuntime();
    await rt.cast(castArgs({ deviceId: "dz", seekSec: 0 }));
    await rt.cast(castArgs({ deviceId: "dn", seekSec: -5 }));
    await rt.cast(castArgs({ deviceId: "dnan", seekSec: Number.NaN }));
    for (const d of h.decoders) expect(d.url).toBe(STREAM_URL);
    expect(h.players.every((p) => !p.calls.some((c: string) => c.startsWith("setStartPosition")))).toBe(true);
  });

  it("URL 不属于 /rest/airplay/stream/:不注入参数(别的链路不允许被改)", async () => {
    const rt = newRuntime();
    await rt.cast(castArgs({ streamUrl: "http://h:8080/rest/dlna/stream/tk", seekSec: 30 }));
    expect(h.decoders[0].url).toBe("http://h:8080/rest/dlna/stream/tk");
    expect(rt.has("d1")).toBe(true);
  });

  it("非法 URL:withOffset 吞错返回原串,cast 不失败", async () => {
    const rt = newRuntime();
    await rt.cast(castArgs({ streamUrl: "not-a-url", seekSec: 5 }));
    expect(h.decoders[0].url).toBe("not-a-url");
    expect(rt.has("d1")).toBe(true);
  });

  it("RAOP connect 失败:静默收掉 player 半开资源并上抛,不留下僵尸会话", async () => {
    const rt = newRuntime();
    h.behavior.connectError = "rtsp refused";
    await expect(rt.cast(castArgs())).rejects.toThrow("rtsp refused");
    await flush();
    expect(rt.has("d1")).toBe(false);
    expect(h.decoders).toHaveLength(0); // 握手失败就不再拉起解码器
    expect(h.players.at(-1)!.calls).toContain("stop");
  });

  it("同设备再次 cast:旧会话先拆干净(幂等),最终只留一个会话", async () => {
    const rt = newRuntime();
    await rt.cast(castArgs());
    const first = h.players.at(-1)!;
    await rt.cast(castArgs({ songId: "s2" }));
    expect(rt.activeIds()).toEqual(["d1"]);
    expect(h.players).toHaveLength(2);
    expect(first.calls).toContain("stop");
    expect(h.decoders[1].rowId).toBe("s2");
  });
});

describe("会话收尾(finalizer 语义)", () => {
  it("自然结束:上报 current=true + 真实落点 + loudness stderr,并清会话/kill decoder/stop player", async () => {
    const rt = newRuntime();
    await rt.cast(castArgs({ durationSec: 200 }));
    const p = h.players.at(-1)!;
    h.decoders[0].stderrTextImpl = () => "loudnorm-json";
    p.endStream();
    await flush();

    expect(hooks.onSessionEnded).toHaveBeenCalledTimes(1);
    expect(hooks.onSessionEnded.mock.calls[0][0]).toBe("d1");
    expect(hooks.onSessionEnded.mock.calls[0][1]).toEqual({
      current: true,
      positionSec: 42,
      durationSec: 200,
      loudnessStderr: "loudnorm-json",
    });
    expect(rt.has("d1")).toBe(false);
    expect(h.killed).toHaveLength(1);
    expect(p.calls).toContain("stop");
  });

  it("无 stderr(被 stop/失败):不塞 loudnessStderr 字段", async () => {
    const rt = newRuntime();
    await rt.cast(castArgs());
    const p = h.players.at(-1)!;
    p.endStream();
    await flush();
    const info = hooks.onSessionEnded.mock.calls[0][1];
    expect("loudnessStderr" in info).toBe(false);
    expect(info.current).toBe(true);
  });

  it("被新起播取代的旧会话结束:current=false 且不得删掉新会话(误删=误切歌)", async () => {
    const rt = newRuntime();
    await rt.cast(castArgs({ songId: "s1" }));
    const first = h.players.at(-1)!;
    await rt.cast(castArgs({ songId: "s2" }));
    first.endStream(0);
    await flush();

    expect(hooks.onSessionEnded).toHaveBeenCalledTimes(1);
    expect(hooks.onSessionEnded.mock.calls[0][1].current).toBe(false);
    expect(rt.has("d1")).toBe(true); // 新会话仍在
    expect(rt.activeIds()).toEqual(["d1"]);
  });

  it("durationSec 缺省时回落到 player.durationSec", async () => {
    const rt = newRuntime();
    await rt.cast(castArgs({ durationSec: undefined }));
    const p = h.players.at(-1)!;
    p.endStream();
    await flush();
    expect(hooks.onSessionEnded.mock.calls[0][1].durationSec).toBe(180);
  });
});

describe("stop / stopAll / 收尾上限", () => {
  it("stop 未知设备:静默 no-op(不抛、不触发 onChanged)", async () => {
    const rt = newRuntime();
    await rt.stop("ghost");
    expect(hooks.onChanged).not.toHaveBeenCalled();
  });

  it("stop 已知设备:清会话 + kill decoder + TEARDOWN + onChanged", async () => {
    const rt = newRuntime();
    await rt.cast(castArgs());
    const p = h.players.at(-1)!;
    hooks.onChanged.mockClear();
    await rt.stop("d1");
    expect(rt.has("d1")).toBe(false);
    expect(h.killed).toHaveLength(1);
    expect(p.calls).toContain("stop");
    expect(hooks.onChanged).toHaveBeenCalledTimes(1);
  });

  it("收尾超时:强制关传输(forceClose),RPC 仍能回包", async () => {
    const rt = newRuntime();
    await rt.cast(castArgs());
    const p = h.players.at(-1)!;
    p.stopImpl = () => new Promise<void>(() => { /* 永不 resolve:模拟设备卡死 */ });
    process.env.AIRPLAY_STOP_DEADLINE_MS = "20";
    await rt.stop("d1");
    expect(p.calls).toContain("forceClose");
    expect(rt.has("d1")).toBe(false);
  });

  it("stopAll 逐设备收尾,单台收尾抛错不影响其它", async () => {
    const rt = newRuntime();
    await rt.cast(castArgs({ deviceId: "d1" }));
    await rt.cast(castArgs({ deviceId: "d2" }));
    const [p1, p2] = h.players;
    p1.stopImpl = async () => { throw new Error("boom"); };
    await rt.stopAll();
    expect(rt.activeIds()).toEqual([]);
    expect(p2.calls).toContain("stop");
  });
});

describe("pause / resume / setVolumeDb", () => {
  it("无会话返回 false(由主进程决定是否重播)", async () => {
    const rt = newRuntime();
    expect(rt.pause("ghost")).toBe(false);
    expect(rt.resume("ghost")).toBe(false);
    expect(rt.setVolumeDb("ghost", -6)).toBe(false);
  });

  it("有会话:转发到 player 并返回 true", async () => {
    const rt = newRuntime();
    await rt.cast(castArgs());
    const p = h.players.at(-1)!;
    expect(rt.pause("d1")).toBe(true);
    expect(rt.resume("d1")).toBe(true);
    expect(rt.setVolumeDb("d1", -6)).toBe(true);
    expect(p.calls).toEqual(expect.arrayContaining(["pause", "resume", "setVolumeDb:-6"]));
  });
});

describe("原地 seek(会话不重建)", () => {
  it("无会话 → false(调用方回落重播)", async () => {
    const rt = newRuntime();
    await expect(rt.seek("ghost", 10)).resolves.toBe(false);
  });

  it("未在推流 → false(不可原地 seek)", async () => {
    const rt = newRuntime();
    await rt.cast(castArgs());
    h.players.at(-1)!.isStreaming = false;
    await expect(rt.seek("d1", 10)).resolves.toBe(false);
  });

  it("原地 seek:prepareSeek + 只换 decoder(新 timeOffset),旧 stream 走 seekReplace 分支不拆会话", async () => {
    const rt = newRuntime();
    await rt.cast(castArgs());
    const p = h.players.at(-1)!;

    const seeking = rt.seek("d1", 30);
    p.endStream(0); // 旧推流收尾(finalizer 应识别 seekReplace)
    await expect(seeking).resolves.toBe(true);

    expect(p.calls).toContain("prepareSeek:30");
    expect(h.decoders).toHaveLength(2);
    expect(h.decoders[1].url).toBe(`${STREAM_URL}?timeOffset=30`);
    expect(rt.has("d1")).toBe(true);
    // seek 自己 kill 一次 + finalizer 的 seekReplace 分支再 kill 一次;不含 stop 收尾
    expect(h.killed).toHaveLength(2);
    expect(p.calls.filter((c: string) => c === "stop")).toHaveLength(0);
    // 新 runStream 已重新挂上推流
    expect(p.calls.filter((c: string) => c === "stream")).toHaveLength(2);
  });

  it("负数目标钳到 0(不产生 timeOffset=0 的无效参数)", async () => {
    const rt = newRuntime();
    await rt.cast(castArgs());
    const p = h.players.at(-1)!;
    const seeking = rt.seek("d1", -12);
    p.endStream(0);
    await expect(seeking).resolves.toBe(true);
    expect(p.calls).toContain("prepareSeek:0");
    expect(h.decoders[1].url).toBe(STREAM_URL);
  });
});

describe("snapshot / 节拍健康度定时器", () => {
  it("snapshot 反映播放/暂停态与时长回退", async () => {
    const rt = newRuntime();
    await rt.cast(castArgs({ durationSec: undefined }));
    const p = h.players.at(-1)!;

    let s = rt.snapshot().sessions[0];
    expect(s).toMatchObject({
      deviceId: "d1",
      playbackState: "playing",
      positionSec: 42,
      durationSec: 180,
      ended: false,
      title: "标题",
      artist: "歌手",
      album: "专辑",
      streamUrl: STREAM_URL,
    });
    expect(typeof s.startedAt).toBe("number");
    expect(s.stream).toEqual(p.realtimeStats);

    p.isPaused = true;
    s = rt.snapshot().sessions[0];
    expect(s.playbackState).toBe("paused");
  });

  it("健康度定时器:起播建立、stop 后清理(不留悬挂 interval)", async () => {
    vi.useFakeTimers();
    const rt = newRuntime();
    await rt.cast(castArgs());
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);
    vi.advanceTimersByTime(15_000); // 打一行趋势点,不应抛
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);
    await rt.stop("d1");
    expect(vi.getTimerCount()).toBe(0);
  });
});
