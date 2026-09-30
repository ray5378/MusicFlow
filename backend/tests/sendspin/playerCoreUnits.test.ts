// ==================== playerCore 单元补测 ====================
//
// playerCore.ts 是 protocolPlayer(in-proc) 与 childMain(子进程) 共用的推流操作核心,
// 它只操作 SendspinServer / SendspinGroup 内存对象。既有 pumpHandover.test.ts 是
// **集成式**的(真起 server + 真泵 + 真 WAV),覆盖到了 handoverCore 本体,却够不到
// 下面这几块 —— 它们全是「登记/消费/回退/还原」这类**一次性状态机**分支:
//
//   ① 借流登记的**消费**(takeBorrow):武装 → 起播之间隔了一次调用,
//      登记必须一次性作废,否则一次失败的武装会污染很久以后的同目标起播(故有 TTL)。
//   ② 借流不成立时的**静默回退**:歌不同 / 移交失败都必须退回完整起播,
//      只许打日志,不许抛 —— 否则流转播放直接断在半路。
//   ③ 起播/播报**失败后的现场还原**:组 current 必须清空、播报临时改过的音量
//      必须还原并补发命令,否则设备永远停在播报音量上。
//
// 本文件把协作方(streamEngine 的泵、deviceState 的落库、logger)全部换成受控替身,
// 让这些分支在**不碰真实 server** 的前提下可断言。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------- 替身:logger / 泵 / 落库 ----------------
const log = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("../../src/utils/logger.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  createLogger: () => ({ info: log.info, warn: log.warn, error: log.error, debug: log.debug }),
}));

const eng = vi.hoisted(() => {
  const pumps = new Map<string, any>();
  const mk = (name: string) => ({
    name,
    active: false,
    busy: false,
    playingSongId: null as string | null,
    play: vi.fn(async () => undefined),
    stop: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    seek: vi.fn(),
    armSeek: vi.fn(),
  });
  return {
    pumps,
    mk,
    pumpFor: vi.fn((_srv: unknown, g: any) => {
      let p = pumps.get(g.name);
      if (!p) {
        p = mk(g.name);
        pumps.set(g.name, p);
      }
      return p;
    }),
    peekPump: vi.fn((g: any) => pumps.get(g.name) ?? null),
    transferPumpTo: vi.fn(() => 4242),
    stopGroupPump: vi.fn(),
    FIRST_FRAME_LEAD_US: 100_000,
    FRAME_MS: 20,
  };
});
vi.mock("../../src/services/sendspin/streamEngine.js", () => eng);

vi.mock("../../src/services/sendspin/deviceState.js", () => ({
  saveDeviceVolumeState: vi.fn(),
}));

import {
  ephemeralGroup,
  armBorrowCore,
  playCore,
  playGroupCore,
  stopCore,
  seekCore,
  announceCore,
} from "../../src/services/sendspin/playerCore.js";

// ---------------- 假 server / 组 / 连接 ----------------
function makeConn(clientId: string) {
  return {
    clientId,
    group: null as any,
    volume: 100,
    muted: false,
    sendJson: vi.fn(),
    sendGroupUpdate: vi.fn(),
    sendAudio: vi.fn(),
    announceStream: vi.fn(),
  };
}

function makeGroup(name: string) {
  const members = new Set<any>();
  return {
    name,
    members,
    current: null as any,
    positionMs: 0,
    volume: 100,
    muted: false,
    pendingAnnounces: [] as any[],
    empty: false,
    timelineBaseUs: 0n,
    add(c: any) {
      members.add(c);
    },
    remove(c: any) {
      members.delete(c);
    },
    close: vi.fn(),
    finishPlayback: vi.fn(),
    // P2 keep_stream 门禁(见 playCore/playGroupCore 切歌分支):stub 默认 false =
    // 保守退回 stream/end 旧路径,与 legacy 安全阀同语义;需要验证新路径的用例
    // 再显式 canKeepStream.mockReturnValue(true)。
    canKeepStream: vi.fn(() => false),
    clearPlayback: vi.fn(),
  };
}

function makeSrv() {
  const groups = new Map<string, any>();
  const clients = new Map<string, any>();
  return {
    groups,
    clients,
    group(name: string) {
      let g = groups.get(name);
      if (!g) {
        g = makeGroup(name);
        groups.set(name, g);
      }
      return g;
    },
    syncVolume: vi.fn(),
  };
}

/** 造一个「正在播 songId」的源组(泵 active + 组有 current)。 */
function seedPlaying(srv: any, name: string, songId: string, posMs = 0) {
  const g = srv.group(name);
  const p = eng.pumpFor(srv, g);
  p.active = true;
  p.playingSongId = songId;
  g.positionMs = posMs;
  g.current = { songId, title: songId, durationMs: 100_000 };
  return { g, p };
}

const item = (songId: string) => ({
  songId,
  title: "t",
  artist: "a",
  album: "",
  coverArt: "",
  mime: "audio/flac",
  duration: 100,
});

beforeEach(() => {
  eng.pumps.clear();
  eng.transferPumpTo.mockClear();
  eng.transferPumpTo.mockReturnValue(4242);
  eng.stopGroupPump.mockClear();
  log.info.mockClear();
  log.error.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

// ============================================================
describe("ephemeralGroup:服务未运行时的内存假组", () => {
  it("首次调用按缺省值建组", () => {
    const g = ephemeralGroup("eph-a");
    expect(g).toMatchObject({ positionMs: 0, volume: 100, muted: false, current: null });
  });

  it("同一 clientId 二次调用拿到同一个对象(改过的值留着)", () => {
    const g1 = ephemeralGroup("eph-b");
    g1.positionMs = 12_345;
    g1.volume = 42;
    const g2 = ephemeralGroup("eph-b");
    expect(g2).toBe(g1);
    expect(g2.positionMs).toBe(12_345);
    expect(g2.volume).toBe(42);
  });

  it("不同 clientId 各一份,互不影响", () => {
    const a = ephemeralGroup("eph-c1");
    const b = ephemeralGroup("eph-c2");
    a.volume = 11;
    expect(b.volume).toBe(100);
    expect(ephemeralGroup("eph-c2")).toBe(b);
  });
});

// ============================================================
describe("借流登记:一次性消费 + TTL", () => {
  it("武装成功后同曲起播 → 走移交,不再起 pump", () => {
    const srv = makeSrv();
    const src = seedPlaying(srv, "src", "s1", 12_000);
    srv.group("dst");
    expect(armBorrowCore(srv as any, "dst", "src")).toEqual({
      armed: true,
      positionMs: 12_000,
      songId: "s1",
    });

    playCore(srv as any, "dst", item("s1") as any);
    expect(eng.transferPumpTo).toHaveBeenCalledTimes(1);
    expect(eng.transferPumpTo.mock.calls[0][2]).toBe(12_000);
    // 成功即返回:目标组不许再起播。
    expect(eng.pumpFor(srv, srv.group("dst")).play).not.toHaveBeenCalled();
    // 源端不留半截状态。
    expect(src.g.current).toBeNull();
  });

  it("登记是一次性的:第二次同曲起播不再借流", () => {
    const srv = makeSrv();
    seedPlaying(srv, "src", "s1", 3_000);
    srv.group("dst");
    armBorrowCore(srv as any, "dst", "src");
    playCore(srv as any, "dst", item("s1") as any);
    const dstPump = eng.pumpFor(srv, srv.group("dst"));

    playCore(srv as any, "dst", item("s1") as any);
    expect(eng.transferPumpTo).toHaveBeenCalledTimes(1);
    expect(dstPump.play).toHaveBeenCalledTimes(1);
  });

  it("登记陈旧(超过 15s)→ 作废,走完整起播", () => {
    const srv = makeSrv();
    seedPlaying(srv, "src", "s1", 3_000);
    srv.group("dst");
    armBorrowCore(srv as any, "dst", "src");
    vi.useFakeTimers();
    vi.advanceTimersByTime(16_000);

    playCore(srv as any, "dst", item("s1") as any);
    expect(eng.transferPumpTo).not.toHaveBeenCalled();
    expect(eng.pumpFor(srv, srv.group("dst")).play).toHaveBeenCalledTimes(1);
  });

  it("歌不同 → 放弃借流(打 song-mismatch 日志)并走完整起播", () => {
    const srv = makeSrv();
    const src = seedPlaying(srv, "src", "s1", 3_000);
    srv.group("dst");
    armBorrowCore(srv as any, "dst", "src");
    // 武装之后源端换了歌:登记里的 songId 与本次要播的歌不符。必须在**登记层**就放弃
    // —— 不能指望移交层兜:那层比的是「源端此刻在播什么」,一旦源端也换成本次这首歌,
    // 放行就会把一条**不属于本次登记**的流搬过来(落点/归属全错)。
    src.p.playingSongId = "s2";

    playCore(srv as any, "dst", item("s2") as any);
    expect(eng.transferPumpTo).not.toHaveBeenCalled();
    expect(eng.pumpFor(srv, srv.group("dst")).play).toHaveBeenCalledTimes(1);
    expect(
      log.info.mock.calls.some((c) => String(c[0]).includes("song-mismatch(源端=")),
    ).toBe(true);
  });

  it("移交失败 → 静默回退完整起播(只打日志,不抛)", () => {
    const srv = makeSrv();
    seedPlaying(srv, "src", "s1", 3_000);
    srv.group("dst");
    armBorrowCore(srv as any, "dst", "src");
    eng.transferPumpTo.mockReturnValueOnce(null);

    expect(() => playCore(srv as any, "dst", item("s1") as any)).not.toThrow();
    expect(eng.pumpFor(srv, srv.group("dst")).play).toHaveBeenCalledTimes(1);
    expect(log.info.mock.calls.some((c) => String(c[0]).includes("借流放弃"))).toBe(true);
  });
});

// ============================================================
describe("playGroupCore:用户组的借流与失败", () => {
  it("成员按在线连接过滤后入组,离线成员跳过", () => {
    const srv = makeSrv();
    const c1 = makeConn("c1");
    const c2 = makeConn("c2");
    srv.clients.set("c1", c1);
    srv.clients.set("c2", c2);
    seedPlaying(srv, "src", "s1", 5_000);
    // ⚠️ 武装**不建组**(刻意:一律 groups.get,免得凭空建空组)→ 目标组必须先存在。
    srv.group("ug:g1");
    expect(armBorrowCore(srv as any, "ug:g1", "src").armed).toBe(true);

    playGroupCore(srv as any, "ug:g1", ["c1", "c2", "offline"], item("s1") as any);
    expect(eng.transferPumpTo).toHaveBeenCalledTimes(1);
    const g = srv.group("ug:g1");
    expect(Array.from(g.members)).toEqual([c1, c2]);
    // 宣告排进 pendingAnnounces(由 pushFrame 在首帧前兑现)。
    expect(g.pendingAnnounces).toEqual([c1, c2]);
    expect(eng.pumpFor(srv, g).play).not.toHaveBeenCalled();
  });

  it("用户组移交失败 → 同样静默回退完整起播", () => {
    const srv = makeSrv();
    seedPlaying(srv, "src", "s1", 5_000);
    srv.group("ug:g1");
    armBorrowCore(srv as any, "ug:g1", "src");
    eng.transferPumpTo.mockReturnValueOnce(null);

    playGroupCore(srv as any, "ug:g1", [], item("s1") as any);
    expect(eng.pumpFor(srv, srv.group("ug:g1")).play).toHaveBeenCalledTimes(1);
    expect(log.info.mock.calls.some((c) => String(c[0]).includes("借流放弃"))).toBe(true);
  });

  it("后台起播失败 → 清组状态 + 回调上抛(不 throw)", async () => {
    const srv = makeSrv();
    const g = srv.group("ug:g2");
    const p = eng.pumpFor(srv, g);
    p.play.mockRejectedValueOnce(new Error("无可用音源"));
    const onFailed = vi.fn();

    expect(() => playGroupCore(srv as any, "ug:g2", [], item("s9") as any, onFailed)).not.toThrow();
    await vi.waitFor(() => expect(onFailed).toHaveBeenCalledTimes(1));
    expect(onFailed.mock.calls[0][0]).toBe("ug:g2");
    expect(onFailed.mock.calls[0][1]).toBe("s9");
    expect(String(onFailed.mock.calls[0][2])).toContain("无可用音源");
    expect(g.current).toBeNull();
    expect(g.finishPlayback).toHaveBeenCalled();
  });
});

// ============================================================
describe("stopCore:打断 + 清状态", () => {
  it("有 server → 停泵 + 位置归零 + current 清空 + stream/end 收尾", () => {
    const srv = makeSrv();
    const g = srv.group("d1");
    g.current = { songId: "s1", durationMs: 1_000 };
    g.positionMs = 5_000;
    const p = eng.pumpFor(srv, g);

    stopCore(srv as any, "d1");
    expect(p.stop).toHaveBeenCalledTimes(1);
    expect(g.positionMs).toBe(0);
    expect(g.current).toBeNull();
    expect(g.finishPlayback).toHaveBeenCalledTimes(1);
  });

  it("无 server → 落 ephemeral 假组(同样清零)", () => {
    const g = ephemeralGroup("stop-offline");
    g.positionMs = 9_000;
    g.current = { songId: "x", durationMs: 1 } as any;

    stopCore(null, "stop-offline");
    expect(g.positionMs).toBe(0);
    expect(g.current).toBeNull();
    // 注:stopCore 里 `else srv?.clients.get(...)?.sendGroupUpdate()` 那条兜底**不可观测** ——
    // srv 为空时该语句确实会执行,但 `srv?.clients` 立刻短路,无任何副作用;
    // srv 非空时 SendspinServer.group() 永不返回空(不存在就建),else 永不进。
    // 故该分支无法用断言证伪,属防御性冗余。
  });
});

// ============================================================
describe("seekCore:三条走向", () => {
  it("空闲(无在播)→ 只记忆起播位置,不重建流", () => {
    const srv = makeSrv();
    const g = srv.group("d2");
    const p = eng.pumpFor(srv, g);

    seekCore(srv as any, "d2", 30);
    expect(p.seek).toHaveBeenCalledTimes(1);
    // 无在播曲时不钳制(durationMs 可能还是上一首的)。
    expect(p.seek.mock.calls[0][1]).toEqual({ clamp: false });
    expect(p.play).not.toHaveBeenCalled();
  });

  it("起播窗口内(busy)→ 只记起播位置,绝不起第二个 play", () => {
    const srv = makeSrv();
    const g = srv.group("d2");
    g.current = { songId: "s1", durationMs: 100_000 };
    const p = eng.pumpFor(srv, g);
    p.busy = true;

    seekCore(srv as any, "d2", 40);
    expect(p.seek.mock.calls[0][1]).toEqual({ clamp: false });
    // 两个 play 会各自 ++epoch 互掐窗口 → 零输出窗口被当成播完 → 从 0 重投。
    expect(p.play).not.toHaveBeenCalled();
  });

  it("ug: 用户组 → 走 playGroupCore,成员取组内 clientId", () => {
    const srv = makeSrv();
    const c1 = makeConn("m1");
    srv.clients.set("m1", c1);
    const g = srv.group("ug:g9");
    g.add(c1);
    c1.group = g;
    g.current = { songId: "s1", durationMs: 200_000 };
    const p = eng.pumpFor(srv, g);

    seekCore(srv as any, "ug:g9", 100);
    expect(p.play).toHaveBeenCalledTimes(1);
    expect(p.armSeek).toHaveBeenCalledWith(100_000);
    expect(Array.from(g.members)).toEqual([c1]);
    // 用户组路径会逐成员「组状态先行 + stream/start 延迟到首帧前」;
    // 单设备 playCore 只认 srv.clients 里同名的 conn(这里是 "ug:g9",取不到),
    // 故这两条是区分两条路径的判据。
    expect(c1.sendGroupUpdate).toHaveBeenCalledTimes(1);
    expect(g.pendingAnnounces).toEqual([c1]);
  });

  it("无 server → 落 ephemeral 标记(负数夹到 0)", () => {
    const g = ephemeralGroup("seek-offline");
    seekCore(null, "seek-offline", 12.5);
    expect(g.positionMs).toBe(12_500);
    seekCore(null, "seek-offline", -3);
    expect(g.positionMs).toBe(0);
  });
});

// ============================================================
describe("announceCore:失败也要还原现场", () => {
  /** TTS 是外链抓取,失败点只有 fetch 一处;从那里注入即可覆盖还原分支。 */
  async function withFetch(stub: unknown, run: () => Promise<unknown>) {
    const orig = globalThis.fetch;
    globalThis.fetch = stub as any;
    try {
      return await run();
    } finally {
      globalThis.fetch = orig;
    }
  }

  it("TTS 拉取非 2xx → 音量还原 + 补发命令 + 原样上抛", async () => {
    const srv = makeSrv();
    const c = makeConn("a1");
    srv.clients.set("a1", c);
    const g = srv.group("a1");
    g.volume = 77;
    c.volume = 55;

    await withFetch(vi.fn(async () => ({ ok: false, status: 500 })), () =>
      expect(
        announceCore(srv as any, "sendspin:a1", "http://tts/x", { volume: 20 }),
      ).rejects.toThrow(/TTS 拉取失败/),
    );
    // 播报音量(20)不是直接赋值还原的,必须显式补发一次命令,
    // 否则设备停在播报音量上再也回不来。
    expect(c.volume).toBe(55);
    expect(g.volume).toBe(77);
    expect(srv.syncVolume).toHaveBeenCalledTimes(1);
  });

  it("网络层直接抛(连不上)→ 同样还原,不吞异常", async () => {
    const srv = makeSrv();
    const c = makeConn("a2");
    srv.clients.set("a2", c);
    const g = srv.group("a2");
    g.volume = 66;
    c.volume = 44;

    await withFetch(vi.fn(async () => { throw new Error("ECONNREFUSED"); }), () =>
      expect(
        announceCore(srv as any, "sendspin:a2", "http://tts/y", { volume: 10 }),
      ).rejects.toThrow(/ECONNREFUSED/),
    );
    expect(c.volume).toBe(44);
    expect(g.volume).toBe(66);
    expect(srv.syncVolume).toHaveBeenCalledTimes(1);
  });
});
