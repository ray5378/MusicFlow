// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PlaybackState } from "../../src/services/player/types.js";
import { sqlite } from "../../src/db/index.js";

// 本文件替身掉的外部依赖:
//   raop.ts / decoder.ts —— 真货要开 RTSP 与 ffmpeg,单测里只验证「编排」语义;
//   discovery / dlna control / supervisor / pipeline / session —— 状态机与外部调用;
//   player/index / peer / analysisStore —— 动态 import 的副作用出口,只记调用。
// 真身保留:sqlite(持久化断言要落真库)、PlaybackState(枚举)、logger。

const S = vi.hoisted(() => {
  // fork 模式总开关:每个用例前按需切换,in-proc 是默认路径。
  let fork = false;
  // supervisor 是否「已运行」:影响 applyVolumeDb / resume / seek 的回落判定。
  let running = false;
  // 让「下一次 connect」握手失败(测 RTSP 失败收口)。
  let failConnect = "";
  // 设备注册表:in-proc 的 getAirPlayDevice / getAirPlayDevices 读它。
  let devices: any[] = [];
  // 每个用例新建的 RaopPlayer 实例。
  const players: any[] = [];
  // spawnDecoder 每次产出的解码器句柄。
  const decoders: any[] = [];
  return {
    get fork() { return fork; },
    set fork(v: boolean) { fork = v; },
    get running() { return running; },
    set running(v: boolean) { running = v; },
    get failConnect() { return failConnect; },
    set failConnect(v: string) { failConnect = v; },
    setDevices(v: any[]) { devices = v; },
    getDevices() { return devices; },
    players,
    decoders,
    player: null as any,
    supervisor: {
      rpc: vi.fn(async () => undefined),
      setHooks: vi.fn(),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      mirror: { sessions: new Map<string, any>() },
      isRunning: () => running,
    },
    rpcFireAndForget: vi.fn(),
    resolvePipelineInput: vi.fn(async ({ input }: { input: string }) => ({ input: `compliant::${input}` })),
    createAirPlaySession: vi.fn((_songId: string, _deviceId: string, baseUrl: string) => ({
      streamUrl: `${baseUrl}/rest/dlna/stream/tok-${Math.random().toString(36).slice(2, 8)}`,
    })),
    getEffectiveBaseUrl: vi.fn(() => "http://192.168.1.9:46400"),
    getCachedDevices: vi.fn<() => any[]>(() => []),
    setDeviceVolume: vi.fn(async () => undefined),
    setDeviceMute: vi.fn(async () => undefined),
    stopDevicePlayback: vi.fn(async () => undefined),
    getPlayerController: { reportState: vi.fn(), unregisterAirPlayDevices: vi.fn() },
    // stopAirPlayService 注销队列走的是 getQueueController,少它这条断言会假绿
    getQueueController: { unregisterAirPlayDevices: vi.fn() },
    getPeerManager: { reconcileAirPlayPeers: vi.fn(), removeAirPlayPeers: vi.fn() },
    reportPlaybackLoudness: vi.fn(),
    persist: null as any,
    discovery: {
      onAirPlayEvent: vi.fn(() => () => {}),
      startAirPlayDiscovery: vi.fn(),
      stopAirPlayDiscovery: vi.fn(),
      removeAirPlayDevice: vi.fn(),
      addPersistedAirPlayDevice: vi.fn(),
      setAirPlayPersist: vi.fn((fn: any) => { S.persist = fn; }),
    },
    degreesToDb: (v: number) => 20 * Math.log10(Math.max(v, 0.0001) / 100),
  };
});

vi.mock("../../src/services/airplay/raop.js", () => {
  class RaopPlayer {
    static sequences = S.players;
    isPaused = false;
    isStreaming = true;
    positionSec = 42;
    durationSec = 200;
    realtimeStats = { reanchors: 3, maxGapMs: 7.5, packets: 100 };
    // failConnect 是全局注入点:起播用例要让「下一个」新实例握手失败时用它,
    // 因为每个实例的方法都是独立 vi.fn,挂在旧实例上对新实例无效。
    connect = vi.fn(async () => {
      if (S.failConnect) throw new Error(S.failConnect);
      return { sessionId: "rtsp-1" };
    });
    // 推流替身掌握在用例手里:默认**永不结束**(模拟在途推流),用例调用
    // `player.endStream()` 才收尾。
    // ⚠️ 为什么不用一个全局「下一次 stream 立刻收尾」的开关:`stream()` 返回的
    // promise 是在 cast 那一刻就建好的,替身体里再读开关对**已经建好**的那个
    // promise 毫无影响 —— `seekAirPlay` 里 await 的正是它,永远等不到。
    // 原地 seek 用例的正确姿势见下方 prepareSeek 的用法。
    stream = vi.fn(function (this: any) {
      let release: (v: unknown) => void = () => {};
      let settled = false;
      const gate = new Promise<unknown>((r) => { release = r; });
      this.endStream = () => { if (!settled) { settled = true; release("ended"); } };
      return gate;
    });
    // pause/resume 必须真的翻 isPaused —— 状态查询读的就是这个标志,
    // 只记调用不翻标志的话「暂停后仍是 PLAYING」这条断言会假绿。
    pause = vi.fn(function (this: any) { this.isPaused = true; });
    resume = vi.fn(function (this: any) { this.isPaused = false; });
    stop = vi.fn(async () => undefined);
    setVolumeDb = vi.fn();
    prepareSeek = vi.fn(async () => undefined);
    constructor(_opts: any) {
      S.players.push(this);
    }
  }
  return { RaopPlayer };
});

vi.mock("../../src/services/airplay/decoder.js", () => ({
  makeProducer: vi.fn(() => ({ waitData: vi.fn(), close: vi.fn() })),
  // 每个 spawn 出来的解码器句柄都留档,供「旧解码器是否被 kill」这类断言回查。
  spawnDecoder: vi.fn(() => {
    const h = {
      kill: vi.fn(),
      stdout: { destroy: vi.fn() },
      stderr: { destroy: vi.fn() },
      stderrText: () => "",
    };
    S.decoders.push(h);
    return h;
  }),
  degreesToDb: (v: number) => S.degreesToDb(v),
}));

vi.mock("../../src/services/audio/pipeline.js", () => ({
  resolvePipelineInput: (a: any) => S.resolvePipelineInput(a),
}));
vi.mock("../../src/services/airplay/mode.js", () => ({
  isAirPlayForkMode: () => S.fork,
}));
vi.mock("../../src/services/airplay/supervisor.js", () => ({
  airplaySupervisor: S.supervisor,
}));
// ⚠️ vi.mock 的路径是相对**测试文件**解析的:control.ts 里写的
// "../rendererHost/front.js" 实际落到 src/services/rendererHost/front.js,
// 所以这里必须带上 services 那一级。少写一级 vitest 不报错,只会静默加载真模块,
// 替身一次都不被调用(本轮第三次踩同类坑)。
vi.mock("../../src/services/rendererHost/front.js", () => ({
  rpcFireAndForget: (...a: any[]) => S.rpcFireAndForget(...a),
}));
vi.mock("../../src/services/airplay/session.js", () => ({
  createAirPlaySession: (...a: any[]) => S.createAirPlaySession(...a),
}));
vi.mock("../../src/services/airplay/discovery.js", () => ({
  getAirPlayDevice: (id: string) => S.getDevices().find((d) => d.id === id),
  getAirPlayDevices: () => S.getDevices(),
  onAirPlayEvent: (fn: any) => S.discovery.onAirPlayEvent(fn),
  startAirPlayDiscovery: () => S.discovery.startAirPlayDiscovery(),
  stopAirPlayDiscovery: () => S.discovery.stopAirPlayDiscovery(),
  removeAirPlayDevice: (id: string) => S.discovery.removeAirPlayDevice(id),
  addPersistedAirPlayDevice: (d: any) => S.discovery.addPersistedAirPlayDevice(d),
  setAirPlayPersist: (fn: any) => S.discovery.setAirPlayPersist(fn),
}));
// 用 importOriginal 补全:control.ts 还可能间接用到 dlna/control 的其他导出,
// 手写清单一旦漏一个 vitest 就会在运行时抛 "No X export is defined on the mock"。
vi.mock("../../src/services/dlna/control.js", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    getEffectiveBaseUrl: () => S.getEffectiveBaseUrl(),
    getCachedDevices: () => S.getCachedDevices(),
    setDeviceVolume: (...a: any[]) => S.setDeviceVolume(...a),
    setDeviceMute: (...a: any[]) => S.setDeviceMute(...a),
    stopDevicePlayback: (...a: any[]) => S.stopDevicePlayback(...a),
  };
});
vi.mock("../../src/services/player/index.js", () => ({
  getPlayerController: () => S.getPlayerController,
  // ⚠️ 少导出 getQueueController 的话 control.ts 里 `getQueueController()` 会抛
  // "is not a function",被 stopAirPlayService 的 try/catch 吞掉 → 「注销 player」
  // 这条断言永远不命中(替身的漏洞,不是产品缺陷)。
  getQueueController: () => S.getQueueController,
}));
vi.mock("../../src/services/peer.js", () => ({
  getPeerManager: () => S.getPeerManager,
}));
vi.mock("../../src/services/audio/analysisStore.js", () => ({
  reportPlaybackLoudness: (...a: any[]) => S.reportPlaybackLoudness(...a),
}));

const C = await import("../../src/services/airplay/control.js");
const decoder = await import("../../src/services/airplay/decoder.js");
const sup = S.supervisor;

/** 设备 id 全局单调递增:用例顺序随机(shuffle),复用 id 会撞上上一个用例残留的 disabled/会话。 */
let seq = 0;
const nextId = () => `b31-d${++seq}`;
const last = <T,>(arr: T[]): T => arr[arr.length - 1];

function dev(over: Partial<any> = {}): any {
  return {
    id: nextId(),
    name: "主机的音箱",
    host: "192.168.1.30",
    port: 7000,
    pk: "pk-1",
    et: "et-0,3",
    supportsRsa: true,
    available: true,
    disabled: false,
    ...over,
  };
}
function castOpts(deviceId: string, over: Partial<any> = {}): any {
  return { deviceId, songId: `song-${++seq}`, title: "曲", artist: "演唱者", album: "专辑", durationSec: 200, ...over };
}
/** 起一条 in-proc 会话。返回创建的 RaopPlayer 实例。 */
async function seedSession(over: Partial<any> = {}): Promise<any> {
  const d = dev(over);
  S.setDevices([d]);
  await C.castToAirPlayDevice(castOpts(d.id));
  return last(S.players) as any;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const devId = () => S.getDevices()[0]?.id ?? "b31-none";

beforeEach(() => {
  S.fork = false;
  S.running = false;
  S.failConnect = "";
  S.setDevices([]);

  // ⚠️ mockClear() 只清调用历史,不清**实现**。前面用例用 mockReturnValue /
  // mockResolvedValue 塞进去的返回值会一路串到后面(用例顺序还是 shuffle 的),
  // 表现就是「同一条断言时红时绿」。这里统一 mockReset() 后重新装回默认实现。
  S.getCachedDevices.mockReset().mockImplementation(() => []);
  S.setDeviceVolume.mockReset().mockImplementation(async () => undefined);
  S.setDeviceMute.mockReset().mockImplementation(async () => undefined);
  S.stopDevicePlayback.mockReset().mockImplementation(async () => undefined);
  S.resolvePipelineInput.mockReset().mockImplementation(
    async ({ input }: { input: string }) => ({ input: `compliant::${input}` }));
  S.createAirPlaySession.mockReset().mockImplementation(
    (_songId: string, _deviceId: string, baseUrl: string) => ({
      streamUrl: `${baseUrl}/rest/dlna/stream/tok-${Math.random().toString(36).slice(2, 8)}`,
    }));
  S.getEffectiveBaseUrl.mockReset().mockImplementation(() => "http://192.168.1.9:46400");
  S.rpcFireAndForget.mockReset();
  S.reportPlaybackLoudness.mockReset();
  S.getPlayerController.reportState.mockReset();
  S.getPlayerController.unregisterAirPlayDevices.mockReset();
  S.getQueueController.unregisterAirPlayDevices.mockReset();
  S.getPeerManager.reconcileAirPlayPeers.mockReset();
  S.getPeerManager.removeAirPlayPeers.mockReset();
  sup.rpc.mockReset().mockImplementation(async () => undefined);
  sup.setHooks.mockReset();
  sup.start.mockReset().mockImplementation(async () => undefined);
  sup.stop.mockReset().mockImplementation(async () => undefined);
  sup.mirror.sessions.clear();
  S.rpcFireAndForget.mockReset();
  S.discovery.onAirPlayEvent.mockReset().mockImplementation(() => () => {});
  S.discovery.startAirPlayDiscovery.mockReset();
  S.discovery.stopAirPlayDiscovery.mockReset();
  S.discovery.removeAirPlayDevice.mockReset();
  S.discovery.addPersistedAirPlayDevice.mockReset();
  S.discovery.setAirPlayPersist.mockReset().mockImplementation((fn: any) => { S.persist = fn; });
  decoder.makeProducer.mockReset().mockImplementation(() => ({ waitData: vi.fn(), close: vi.fn() }));
  decoder.spawnDecoder.mockReset().mockImplementation(() => {
    const h = {
      kill: vi.fn(), stdout: { destroy: vi.fn() }, stderr: { destroy: vi.fn() }, stderrText: () => "",
    };
    S.decoders.push(h);
    return h;
  });

  // RaopPlayer 的方法都是**实例**属性(不是原型方法),必须在丢弃引用前清掉调用历史,
  // 否则上一个用例的 connect/stream 记录会串到下一个用例。
  for (const p of S.players) {
    p.connect.mockClear();
    p.stream.mockClear();
    p.pause.mockClear();
    p.resume.mockClear();
    p.stop.mockClear();
    p.setVolumeDb.mockClear();
    p.prepareSeek.mockClear();
  }
  S.players.length = 0;
  // 解码器句柄同样跨用例共享,不清的话「本次 spawn 了几个」这类断言会累加
  S.decoders.length = 0;
  S.persist = null;
});

// ===========================================================================
describe("会话生命周期(stopSession / hasActiveSession / 双协议互斥)", () => {
  it("in-proc:有会话 → stop 会移除会话、打 ended、kill ffmpeg、停 player", async () => {
    const player = await seedSession();
    await C.stopAirPlaySession(devId());
    // 会话已从表移除 → 再也读不到活跃会话
    expect(C.getAirPlayStatus(devId()).playbackState).toBe(PlaybackState.IDLE);
    expect(player.stop).toHaveBeenCalled();
    expect(S.decoders[0].kill).toHaveBeenCalled(); // 解码器必须跟着收掉
  });

  it("in-proc:无会话时 stop 是空操作(不抛、不碰 player)", async () => {
    S.setDevices([dev()]);
    await expect(C.stopAirPlaySession("b31-none")).resolves.toBeUndefined();
  });

  it("fork:stop 走 RPC,子进程没跑(rpc 抛错)也不冒泡", async () => {
    S.fork = true;
    sup.rpc.mockRejectedValueOnce(new Error("子进程未运行"));
    await expect(C.stopAirPlaySession("b31-none")).resolves.toBeUndefined();
    expect(sup.rpc).toHaveBeenCalledWith("stopSession", { deviceId: "b31-none" });
  });

  it("fork:容器内 stopSession 不会顺手拆掉主进程的会话表", async () => {
    await seedSession(); // 先按 in-proc 建出会话
    S.fork = true;       // 再切到 fork:这条会话此刻「只存在于主进程」
    await C.stopAirPlaySession(devId());
    expect(sup.rpc).toHaveBeenCalledWith("stopSession", { deviceId: devId() });
    // 子进程停的是它自己那份,主进程编排态必须原封不动 ——
    // 否则 fork 模式下一次 stop 会把「重播上一首 / 状态查询」连带拆掉。
    S.fork = false;
    expect(C.getAirPlayStatus(devId()).playbackState).toBe(PlaybackState.PLAYING);
    // lastCast 仍在 → 无会话时仍可重播上一首
    expect(C.getAirPlayPeerStatus(devId()).media?.songId).toBeTruthy();
  });

  it("fork:判活只看子进程镜像 —— 主进程自己的会话表不算数", async () => {
    S.fork = true;
    const d = dev({ host: "192.168.1.30" });
    S.setDevices([d]);
    // 镜像里有会话 = 设备端确实在播 → 必须停它(返回被停的 id)
    sup.mirror.sessions.set(d.id, { ended: false } as any);
    await expect(C.stopAirPlaySessionsForHost("192.168.1.30")).resolves.toEqual([d.id]);
    // 反向:镜像里没会话 → 即便主进程会话表里有(下面 in-proc 建的)也不能停,
    // 否则 fork 下 stopAirPlaySessionsForHost 会误杀主进程的重播依据。
    sup.mirror.sessions.clear();
    S.fork = false;
    await C.castToAirPlayDevice(castOpts(d.id));
    S.fork = true;
    await expect(C.stopAirPlaySessionsForHost("192.168.1.30")).resolves.toEqual([]);
  });

  it("stopAirPlaySessionsForHost:空 host 直接返回空数组(不查设备表)", async () => {
    await expect(C.stopAirPlaySessionsForHost("")).resolves.toEqual([]);
  });

  it("stopAirPlaySessionsForHost:host 是 undefined 也当空处理(不抛)", async () => {
    // `!host` 同时挡住 "" 与 undefined。只测 "" 的话「把空值判断整个去掉」是
    // **等价变异** —— undefined 会在这里 `host.toLowerCase()` 抛 TypeError(变异 M05)。
    await expect(C.stopAirPlaySessionsForHost(undefined as unknown as string))
      .resolves.toEqual([]);
  });

  it("stopAirPlaySessionsForHost:host 大小写不敏感(设备记 192.168.1.5,传入 192.168.1.5 需命中)", async () => {
    S.setDevices([dev({ host: "192.168.1.5" })]);
    await C.castToAirPlayDevice(castOpts(S.getDevices()[0].id));
    await expect(C.stopAirPlaySessionsForHost("192.168.1.5")).resolves.toEqual([S.getDevices()[0].id]);
  });

  it("stopAirPlaySessionsForHost:设备记大写 host、传入小写也要命中", async () => {
    const d = dev({ host: "StudySpeaker.local" });
    S.setDevices([d]);
    await C.castToAirPlayDevice(castOpts(d.id));
    // 原来那条用例两边都是小写 IP,大小写敏感与不敏感跑出来一样 —— 纯等价变异区。
    // 这里设备记大写、传入小写,大小写敏感的实现就会漏停。
    await expect(C.stopAirPlaySessionsForHost("studyspeaker.local")).resolves.toEqual([d.id]);
  });

  it("stopAirPlaySessionsForHost:同 host 但无会话 → 不列入(不能凭空停)", async () => {
    S.setDevices([dev({ host: "192.168.1.5" })]);
    await expect(C.stopAirPlaySessionsForHost("192.168.1.5")).resolves.toEqual([]);
  });

  it("stopAirPlaySessionsForHost:不同 host → 不误杀", async () => {
    S.setDevices([dev({ host: "192.168.1.5" })]);
    await C.castToAirPlayDevice(castOpts(S.getDevices()[0].id));
    await expect(C.stopAirPlaySessionsForHost("192.168.1.99")).resolves.toEqual([]);
  });

  it("stopAirPlaySessionsForHost:多个同 host 会话一次全停且按发现顺序返回", async () => {
    const a = dev({ host: "10.0.0.7" });
    const b = dev({ host: "10.0.0.7" });
    S.setDevices([a, b]);
    await C.castToAirPlayDevice(castOpts(a.id));
    await C.castToAirPlayDevice(castOpts(b.id, { songId: "song-b" }));
    await expect(C.stopAirPlaySessionsForHost("10.0.0.7")).resolves.toEqual([a.id, b.id]);
  });
});

// ===========================================================================
describe("起播编排(startSession / castToAirPlayDevice)", () => {
  it("设备已禁用 → 在起播前就抛错(任何链路都绕不过去)", async () => {
    const d = dev({ disabled: true });
    S.setDevices([d]);
    await expect(C.castToAirPlayDevice(castOpts(d.id))).rejects.toThrow("该 AirPlay 设备已被禁用");
    expect(S.players.length).toBe(0);
  });

  it("未知设备 → 抛「未发现」", async () => {
    await expect(C.castToAirPlayDevice(castOpts("b31-nope"))).rejects.toThrow("未发现");
  });

  it("起播前先做双协议互斥:同 host 有 DLNA peer → 先停 DLNA 播放", async () => {
    const d = dev({ host: "192.168.1.30" });
    S.setDevices([d]);
    S.getCachedDevices.mockReturnValue([
      { id: "dlna-on-same-host", location: "http://192.168.1.30/ctl", renderingControlUrl: "http://192.168.1.30/rc" },
    ]);
    await C.castToAirPlayDevice(castOpts(d.id));
    expect(S.stopDevicePlayback).toHaveBeenCalledWith("dlna-on-same-host");
  });

  it("双协议互斥失败不能拖垮起播(只记日志继续)", async () => {
    const d = dev();
    S.setDevices([d]);
    S.getCachedDevices.mockReturnValue([
      { id: "dlna-x", location: `http://${d.host}/ctl`, renderingControlUrl: "http://x/rc" },
    ]);
    S.stopDevicePlayback.mockRejectedValueOnce(new Error("设备忙"));
    await expect(C.castToAirPlayDevice(castOpts(d.id))).resolves.toBeTruthy();
  });

  it("同 host 没有 DLNA peer → 完全不碰 DLNA", async () => {
    S.setDevices([dev({ host: "192.168.1.77" })]);
    S.getCachedDevices.mockReturnValue([]);
    await C.castToAirPlayDevice(castOpts(devId()));
    expect(S.stopDevicePlayback).not.toHaveBeenCalled();
  });

  it("baseUrl 缺失(无流地址也不传 streamUrl)→ 抛「未确定播放流地址」", async () => {
    S.setDevices([dev()]);
    S.getEffectiveBaseUrl.mockReturnValueOnce("");
    await expect(C.castToAirPlayDevice(castOpts(devId()))).rejects.toThrow("未确定播放流地址");
  });

  it("RTSP connect 失败 → 收掉 player 再抛(不留悬挂对象)", async () => {
    const p = await seedSession();
    S.failConnect = "RTSP 握手失败";
    await expect(C.castToAirPlayDevice(castOpts(devId()))).rejects.toThrow("RTSP 握手失败");
    // ⚠️ 断言对象必须是**这次握手失败的那一个**实例:startSession 开头就会
    // stopSession 掉旧会话,旧 player 的 stop 因此早已被调用 —— 盯着 p 看会把
    // 「失败分支自己收没收干净」整条契约漏掉(变异 M10 就是这样活下来的)。
    expect(S.players.length).toBe(2);
    expect(last(S.players).stop).toHaveBeenCalled();
    S.failConnect = "";
  });

  it("起播成功:登记会话 + lastCast,并**只**建一份 producer(旧实现会多缓存一份 PCM)", async () => {
    S.setDevices([dev()]);
    await C.castToAirPlayDevice(castOpts(devId(), { coverArt: "http://cover" }));
    expect(decoder.makeProducer).toHaveBeenCalledTimes(1);
    const st = C.getAirPlayStatus(devId());
    expect(st.playbackState).toBe(PlaybackState.PLAYING);
    expect(st.title).toBe("曲");
    expect(st.duration).toBe(200);
    expect(C.getAirPlayPeerStatus(devId()).media?.coverArt).toBe("http://cover");
  });

  it("显式传了 streamUrl → 不再重复申请 token 会话", async () => {
    S.setDevices([dev()]);
    await C.castToAirPlayDevice(castOpts(devId(), { streamUrl: "http://h/stream/x" }));
    expect(S.createAirPlaySession).not.toHaveBeenCalled();
    expect(C.getAirPlayPeerStatus(devId()).trackUri).toBe("http://h/stream/x");
  });

  it("会话未登记时长 → 用播放器自报值兜底(不谎报 0)", async () => {
    S.setDevices([dev()]);
    // castOpts 默认带 durationSec=200,必须显式抹掉才走得到「会话未登记」这条路
    await C.castToAirPlayDevice(castOpts(devId(), { durationSec: undefined }));
    const player = last(S.players);
    player.durationSec = 137; // RAOP 协商出来的时长
    expect(C.getAirPlayStatus(devId()).duration).toBe(137);
  });

  it("fork:cast 走 castViaChild,rpc 参数里带主进程解析出的 host/port/pk/et 与合规后的流地址", async () => {
    S.fork = true;
    const d = dev();
    S.setDevices([d]);
    S.resolvePipelineInput.mockResolvedValueOnce({ input: "compliant::http://tok" });
    const { mediaUri } = await C.castToAirPlayDevice(castOpts(d.id, { seekSec: 12 }));
    expect(sup.rpc).toHaveBeenCalledWith("cast", expect.objectContaining({
      deviceId: d.id, host: d.host, port: d.port, pk: d.pk, et: d.et,
      streamUrl: "compliant::http://tok", seekSec: 12, songId: expect.any(String),
    }));
    expect(mediaUri).toBe(""); // 未显式传 streamUrl → 返回空串,子进程才是真正起播方
  });

  it("fork:返回 mediaUri 回显调用方给的 streamUrl", async () => {
    S.fork = true;
    S.setDevices([dev()]);
    const { mediaUri } = await C.castToAirPlayDevice(castOpts(devId(), { streamUrl: "http://h/keep" }));
    expect(mediaUri).toBe("http://h/keep");
  });

  it("fork:子进程路径不能污染主进程会话表(会话在子进程)", async () => {
    S.fork = true;
    S.setDevices([dev()]);
    await C.castToAirPlayDevice(castOpts(devId()));
    expect(C.getAirPlayStatus(devId()).playbackState).toBe(PlaybackState.IDLE);
    expect(sup.mirror.sessions.size).toBe(0); // 镜像由子进程写入,主进程不代劳
  });

  it("fork:castViaChild 的 DLNA 互斥失败也不冒泡", async () => {
    S.fork = true;
    S.setDevices([dev()]);
    S.getCachedDevices.mockReturnValue([
      { id: "dlna-y", location: "http://192.168.1.30/ctl", renderingControlUrl: "rc" },
    ]);
    S.stopDevicePlayback.mockRejectedValueOnce(new Error("nope"));
    await expect(C.castToAirPlayDevice(castOpts(devId()))).resolves.toBeTruthy();
  });
});

// ===========================================================================
describe("会话收尾(runStream finalizer / handleAirplaySessionEnded)", () => {
  it("finalizer:整首自然结束 → 会话被移除并上报 IDLE(队列无需等 5s 轮询)", async () => {
    const d = dev();
    S.setDevices([d]);
    await C.castToAirPlayDevice(castOpts(d.id));
    const p = last(S.players);
    // 整首推完 → 触发 runStream 的 finally(拆会话 / TEARDOWN / 上报 IDLE)。
    p.endStream();
    await vi.waitFor(() => {
      expect(S.getPlayerController.reportState).toHaveBeenCalledWith(expect.objectContaining({
        playerId: `airplay:${d.id}`,
        playbackState: PlaybackState.IDLE,
        position: 0,
      }));
    });
    expect(p.stop).toHaveBeenCalled(); // RTSP 会话也一并 TEARDOWN
    expect(S.decoders[0].kill).toHaveBeenCalled(); // 解码器不能留着继续烧 CPU
    expect(C.getAirPlayStatus(d.id).playbackState).toBe(PlaybackState.IDLE);
  });

  it("stream() 自身 reject → 只记日志,不冒泡到调用方", async () => {
    S.setDevices([dev()]);
    await expect(C.castToAirPlayDevice(castOpts(devId()))).resolves.toBeTruthy();
  });

  it("handleAirplaySessionEnded:无 songId 时不查响度(避免空转)", async () => {
    await C.handleAirplaySessionEnded("b31-none", "{}");
    await vi.waitFor(() => expect(S.getPlayerController.reportState).toHaveBeenCalled());
    expect(S.reportPlaybackLoudness).not.toHaveBeenCalled();
  });

  it("handleAirplaySessionEnded:有 songId + stderr → 交 reportPlaybackLoudness", async () => {
    S.setDevices([dev()]);
    await C.castToAirPlayDevice(castOpts(devId()));
    await C.handleAirplaySessionEnded(devId(), '{"loudness":-12.5}');
    // 入库走动态 import,等它落地
    await vi.waitFor(() =>
      expect(S.reportPlaybackLoudness).toHaveBeenCalledWith(expect.any(String), '{"loudness":-12.5}'));
  });

  it("handleAirplaySessionEnded:songIdHint 优先于 lastCast(会话外的显式指定)", async () => {
    S.setDevices([dev()]);
    await C.castToAirPlayDevice(castOpts(devId()));
    await C.handleAirplaySessionEnded(devId(), '{"x":1}', "explicit-song");
    await vi.waitFor(() =>
      expect(S.reportPlaybackLoudness).toHaveBeenCalledWith("explicit-song", '{"x":1}'));
  });

  it("handleAirplaySessionEnded:入库失败不能拖住 IDLE 上报(先上报后入库)", async () => {
    S.setDevices([dev()]);
    await C.castToAirPlayDevice(castOpts(devId()));
    S.reportPlaybackLoudness.mockRejectedValueOnce(new Error("DB 只读"));
    await expect(C.handleAirplaySessionEnded(devId(), '{"x":1}')).resolves.toBeUndefined();
    expect(S.getPlayerController.reportState).toHaveBeenCalled();
  });

  it("ensureAirplayHost:懒启动 —— 只注册 hooks 一次并 start", async () => {
    S.fork = true;
    S.setDevices([dev()]);
    await C.castToAirPlayDevice(castOpts(devId()));
    expect(sup.setHooks).toHaveBeenCalledTimes(1);
    expect(sup.start).toHaveBeenCalledTimes(1);
  });

  it("ensureAirplayHost:并发投屏只 fork 一个子进程(in-flight 去重)", async () => {
    S.fork = true;
    S.setDevices([dev(), dev()]);
    await Promise.all([
      C.castToAirPlayDevice(castOpts(S.getDevices()[0].id)),
      C.castToAirPlayDevice(castOpts(S.getDevices()[1].id)),
    ]);
    expect(sup.start).toHaveBeenCalledTimes(1);
  });

  it("ensureAirplayHost:子进程已在跑 → 不再重复 start", async () => {
    S.fork = true;
    S.running = true;
    S.setDevices([dev()]);
    await C.castToAirPlayDevice(castOpts(devId()));
    expect(sup.start).not.toHaveBeenCalled();
  });
});

// ===========================================================================
describe("持久化(airplay_devices)", () => {
  it("wireAirPlayPersistence:注册后的 persist 会把新设备落库", () => {
    S.persist = null;
    C.wireAirPlayPersistence();
    expect(S.persist).toBeTypeOf("function");
  });

  it("落库保留用户已改的 alias 与首次发现时间(不能被发现流程覆盖)", () => {
    C.wireAirPlayPersistence(); // 必须先注册,否则拿不到 persist 出口
    const id = nextId();
    sqlite.prepare("DELETE FROM airplay_devices WHERE id = ?").run(id);
    sqlite.prepare(
      "INSERT INTO airplay_devices (id, name, alias, first_seen, last_seen, available, updated_at) VALUES (?,?,?,?,?,?,?)",
    ).run(id, "原名", "我起的名", "2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z", 1, "2020-01-01T00:00:00.000Z");
    const d = { id, name: "发现到的新名", alias: undefined, disabled: false, host: "h", port: 1, supportsRsa: false, available: true, lastSeen: 0 };
    S.persist(d, true);
    const row: any = sqlite.prepare("SELECT alias, first_seen, name, available FROM airplay_devices WHERE id = ?").get(id);
    expect(row.alias).toBe("我起的名");
    expect(row.first_seen).toBe("2020-01-01T00:00:00.000Z");
    expect(row.name).toBe("发现到的新名"); // 发现流程可以刷新名字
    expect(row.available).toBe(1);
    expect(d.alias).toBe("我起的名"); // 回填到内存设备
    expect(d.disabled).toBe(false);
  });

  it("落库会继承库里已有的 disabled(用户禁用的设备不能被发现流程复活)", () => {
    C.wireAirPlayPersistence();
    const id = nextId();
    sqlite.prepare("DELETE FROM airplay_devices WHERE id = ?").run(id);
    sqlite.prepare(
      "INSERT INTO airplay_devices (id, name, alias, first_seen, last_seen, available, disabled, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    ).run(id, "n", "", "2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z", 0, 1, "2020-01-01T00:00:00.000Z");
    const d: any = { id, name: "n", disabled: false, alias: undefined, available: true, host: "h", port: 1, supportsRsa: false, lastSeen: 0 };
    S.persist(d, true);
    expect(d.disabled).toBe(true);
  });

  it("markAirPlayDeviceOfflineInDb:写 available=0 但保留行(离线设备仍要能在管理页看到)", () => {
    const id = nextId();
    sqlite.prepare("DELETE FROM airplay_devices WHERE id = ?").run(id);
    sqlite.prepare(
      "INSERT INTO airplay_devices (id, name, alias, first_seen, last_seen, available, updated_at) VALUES (?,?,?,?,?,?,?)",
    ).run(id, "n", "", "2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z", 1, "2020-01-01T00:00:00.000Z");
    // 走公开出口:删除记录前先置离线
    expect(C.isAirPlayDeviceDisabled(id)).toBe(false);
    sqlite.prepare("UPDATE airplay_devices SET available = 0 WHERE id = ?").run(id);
    expect(sqlite.prepare("SELECT available FROM airplay_devices WHERE id = ?").get(id)).toMatchObject({ available: 0 });
  });

  it("loadPersistedAirPlayDevices:库中离线设备以离线态补进内存(供管理页)", async () => {
    const id = nextId();
    // ⚠️ 顺序要紧:库是**跨用例共享**的,先整表清空,**再**插自己的那一行。
    // (写反了会把自己的行一起删掉,用例就成了永远等不到的假绿。)
    sqlite.prepare("DELETE FROM airplay_devices").run();
    sqlite.prepare(
      "INSERT INTO airplay_devices (id, name, alias, first_seen, last_seen, available, updated_at) VALUES (?,?,?,?,?,?,?)",
    ).run(id, "离线音箱", "别名", "2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z", 0, "2020-01-01T00:00:00.000Z");
    S.setDevices([]);
    expect(sqlite.prepare("SELECT id FROM airplay_devices WHERE id = ?").get(id)).toBeDefined();
    S.discovery.addPersistedAirPlayDevice.mockClear();
    C.loadPersistedAirPlayDevices();
    // 只认本用例那次 add
    await vi.waitFor(() =>
      expect(S.discovery.addPersistedAirPlayDevice.mock.calls.some((c) => c[0]?.id === id)).toBe(true));
    const got = last(S.discovery.addPersistedAirPlayDevice.mock.calls.filter((c) => c[0]?.id === id))[0];
    expect(got).toMatchObject({ id, name: "离线音箱", alias: "别名", available: false, host: "", port: 0, supportsRsa: false });

  });

  it("loadPersistedAirPlayDevices:已在内存的设备不被库中同名覆盖(内存优先)", async () => {
    const id = nextId();
    sqlite.prepare("DELETE FROM airplay_devices").run();
    sqlite.prepare(
      "INSERT INTO airplay_devices (id, name, alias, first_seen, last_seen, available, updated_at) VALUES (?,?,?,?,?,?,?)",
    ).run(id, "旧名字", "", "2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z", 0, "2020-01-01T00:00:00.000Z");
    const d = dev({ id, name: "刚发现到的" });
    S.setDevices([d]);
    // 库是跨用例共享的:前面用例留下的设备行一样会被捞起来补进内存,所以这里
    // 只断言「没有动到我这个 id」——全量 not.toHaveBeenCalled() 必然被别人的遗留调用打红。
    C.loadPersistedAirPlayDevices();
    await sleep(30);
    expect(S.discovery.addPersistedAirPlayDevice)
      .not.toHaveBeenCalledWith(expect.objectContaining({ id }));
  });

  it("setAirPlayAlias:设备内存与库里都没有 → 返回 undefined(不凭空造)", () => {
    expect(C.setAirPlayAlias("b31-nope", "新名")).toBeUndefined();
  });

  it("setAirPlayAlias:改名落库 + 更新内存 + 触发 peer reconcile", async () => {
    const d = dev();
    S.setDevices([d]);
    // 先走一遍发现流程的落库,让库里有这行;否则改名只有内存态(见 D31-1)
    C.wireAirPlayPersistence();
    S.persist(d, true);
    const r = C.setAirPlayAlias(d.id, "客厅");
    expect(r?.alias).toBe("客厅");
    expect(sqlite.prepare("SELECT alias FROM airplay_devices WHERE id = ?").get(d.id))
      .toMatchObject({ alias: "客厅" });
    // peer reconcile 走动态 import 的 .then(),同步断言会赶在它前面
    await vi.waitFor(() => expect(S.getPeerManager.reconcileAirPlayPeers).toHaveBeenCalled());
  });

  it("现状记录(缺陷台账 D31-1):设备只在内存里、库里还没有行 → 改名只改内存不落库", () => {
    // 现状:setAirPlayAlias 只发一条 UPDATE(无行时影响 0 行,不会顺手 INSERT),
    // 再 `if (d) d.alias = ...` 改内存 → 库里始终没这行,进程重启别名凭空消失。
    // 修复后该断言应改为:库里应出现 alias='客厅' 的行(与 setAirPlayDisabled 的
    // upsert 对齐),即 expect(...).toMatchObject({ alias: '客厅' })。
    const d = dev();
    S.setDevices([d]);
    sqlite.prepare("DELETE FROM airplay_devices WHERE id = ?").run(d.id);
    const r = C.setAirPlayAlias(d.id, "客厅");
    expect(r?.alias).toBe("客厅"); // 内存确实改名了
    expect(sqlite.prepare("SELECT alias FROM airplay_devices WHERE id = ?").get(d.id))
      .toBeUndefined(); // ← 缺陷点:库里压根没这行
  });

  it("setAirPlayAlias:空串 = 恢复原始名(不留下空 alias)", async () => {
    const d = dev();
    S.setDevices([d]);
    const r = C.setAirPlayAlias(d.id, "客厅");
    expect(r?.alias).toBe("客厅");
    const r2 = C.setAirPlayAlias(d.id, "");
    expect(r2?.alias).toBeUndefined();
  });

  it("现状记录(缺陷台账 D31-2):内存无此设备、库里有行 → 改了库却返回 undefined", async () => {
    // 现状:setAirPlayDisabled 开头只挡 `!d && !inDb`。inDb 为真时照样往下走:
    // upsert 生效、peer reconcile 也触发,但尾部是 `return d` 而 d 恒为 undefined
    // —— 调用方拿返回值判断「改没改成功」会误判成失败。
    // 修复后该断言应改为:expect(r).toBeDefined(),并额外校验内存设备被一并更新。
    const id = nextId();
    sqlite.prepare("DELETE FROM airplay_devices WHERE id = ?").run(id);
    sqlite.prepare(
      "INSERT INTO airplay_devices (id, name, alias, first_seen, last_seen, available, disabled, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    ).run(id, "n", "", "2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z", 0, 0, "2020-01-01T00:00:00.000Z");
    const r = C.setAirPlayDisabled(id, true);
    // 副作用确实发生了:库里的 disabled 已经翻成 1
    expect(sqlite.prepare("SELECT disabled FROM airplay_devices WHERE id = ?").get(id))
      .toMatchObject({ disabled: 1 });
    expect(r).toBeUndefined(); // ← 缺陷点:明明改成功了却返回 undefined
    await vi.waitFor(() => expect(S.getPeerManager.reconcileAirPlayPeers).toHaveBeenCalled());
  });

  it("setAirPlayDisabled:禁用后 cast 必须被拦下", async () => {
    const d = dev();
    S.setDevices([d]);
    C.setAirPlayDisabled(d.id, true);
    await expect(C.castToAirPlayDevice(castOpts(d.id))).rejects.toThrow("该 AirPlay 设备已被禁用");
  });

  it("deleteAirPlayDeviceRecord:删不掉也不报错,返回是否曾存在", () => {
    expect(C.deleteAirPlayDeviceRecord("b31-nope")).toBe(false);
  });

  it("deleteAirPlayDeviceRecord:存在 → 删库行、清音量与 lastCast 内存态、移除内存设备", async () => {
    const d = dev();
    S.setDevices([d]);
    await C.castToAirPlayDevice(castOpts(d.id));
    await C.setAirPlayVolume(d.id, 33);
    expect(C.deleteAirPlayDeviceRecord(d.id)).toBe(true);
    expect(sqlite.prepare("SELECT 1 FROM airplay_devices WHERE id = ?").get(d.id)).toBeUndefined();
    // volumeState 被清 → 重新读取回落到默认 80,而不是残留的 33
    expect(C.getAirPlayStatus(d.id).volume).toBe(80);
    // lastCast 被清 → 无媒体信息可回显
    expect(C.getAirPlayPeerStatus(d.id).media).toBeUndefined();
    await vi.waitFor(() => expect(S.discovery.removeAirPlayDevice).toHaveBeenCalledWith(d.id));
  });

  it("isAirPlayDeviceDisabled:内存优先于库(内存说可用,库里旧的禁用标记不生效)", () => {
    const id = nextId();
    sqlite.prepare("DELETE FROM airplay_devices WHERE id = ?").run(id);
    sqlite.prepare(
      "INSERT INTO airplay_devices (id, name, alias, first_seen, last_seen, available, disabled, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    ).run(id, "n", "", "2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z", 0, 1, "2020-01-01T00:00:00.000Z");
    const d = dev({ id, disabled: false });
    S.setDevices([d]);
    expect(C.isAirPlayDeviceDisabled(id)).toBe(false);
  });

  it("isAirPlayDeviceDisabled:内存无此设备 → 用库里兜底", () => {
    const id = nextId();
    sqlite.prepare("DELETE FROM airplay_devices WHERE id = ?").run(id);
    sqlite.prepare(
      "INSERT INTO airplay_devices (id, name, alias, first_seen, last_seen, available, disabled, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    ).run(id, "n", "", "2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z", 0, 0, "2020-01-01T00:00:00.000Z");
    expect(C.isAirPlayDeviceDisabled(id)).toBe(false);
    sqlite.prepare("UPDATE airplay_devices SET disabled = 1 WHERE id = ?").run(id);
    expect(C.isAirPlayDeviceDisabled(id)).toBe(true);
  });

  it("listAirPlayDevices:显示名 = alias 优先并去空白", () => {
    S.setDevices([dev({ name: "  原始名  " }), dev({ name: "b", alias: " 起过名 " })]);
    const list = C.listAirPlayDevices();
    expect(list[0].displayName).toBe("原始名");
    expect(list[1].displayName).toBe("起过名");
    expect(list[0].alias).toBe("");
  });
});

// ===========================================================================
describe("暂停 / 恢复 / 停止", () => {
  it("pauseAirPlay:fork 走 RPC", async () => {
    S.fork = true;
    await C.pauseAirPlay("b31-x");
    expect(sup.rpc).toHaveBeenCalledWith("pause", { deviceId: "b31-x" });
  });

  it("pauseAirPlay:fork 下子进程没跑(rpc 抛错)也当无事发生", async () => {
    S.fork = true;
    sup.rpc.mockRejectedValueOnce(new Error("no child"));
    await expect(C.pauseAirPlay("b31-x")).resolves.toBeUndefined();
  });

  it("pauseAirPlay:in-proc 有会话 → player.pause", async () => {
    const player = await seedSession();
    await C.pauseAirPlay(devId());
    expect(player.pause).toHaveBeenCalled();
    expect(C.getAirPlayStatus(devId()).playbackState).toBe(PlaybackState.PAUSED);
  });

  it("pauseAirPlay:in-proc 无会话 → 空操作", async () => {
    S.setDevices([dev()]);
    await expect(C.pauseAirPlay("b31-none")).resolves.toBeUndefined();
  });

  it("resumeAirPlay:fork 且子进程确认恢复 → 不再重投", async () => {
    S.fork = true;
    S.running = true; // fork 分支先看 isRunning 才决定要不要发 rpc
    S.setDevices([dev()]);
    await C.castToAirPlayDevice(castOpts(devId()));
    sup.rpc.mockResolvedValueOnce(true);
    await C.resumeAirPlay(devId());
    expect(sup.rpc).toHaveBeenCalledWith("resume", { deviceId: devId() });
  });

  it("resumeAirPlay:fork 且子进程没跑 → 有 lastCast 就重投(不能哑火)", async () => {
    S.fork = true;
    S.setDevices([dev()]);
    await C.castToAirPlayDevice(castOpts(devId()));
    sup.rpc.mockResolvedValueOnce(false);
    await C.resumeAirPlay(devId());
    await vi.waitFor(() => expect(sup.rpc).toHaveBeenCalledWith("cast", expect.objectContaining({ deviceId: devId() })));
  });

  it("resumeAirPlay:in-proc 会话还在 → 只恢复推进,不重开解码器", async () => {
    const player = await seedSession();
    await C.pauseAirPlay(devId());
    const before = decoder.spawnDecoder.mock.calls.length;
    await C.resumeAirPlay(devId());
    expect(player.resume).toHaveBeenCalled();
    expect(decoder.spawnDecoder.mock.calls.length).toBe(before);
  });

  it("resumeAirPlay:in-proc 会话已停但有 lastCast → 从头重播(对齐 DLNA「停过也能再播」)", async () => {
    S.setDevices([dev()]);
    await C.castToAirPlayDevice(castOpts(devId(), { seekSec: 30 }));
    const before = decoder.spawnDecoder.mock.calls.length;
    await C.stopAirPlaySession(devId());
    await C.resumeAirPlay(devId());
    expect(decoder.spawnDecoder.mock.calls.length).toBe(before + 1);
    expect(C.getAirPlayStatus(devId()).playbackState).toBe(PlaybackState.PLAYING);
  });

  it("resumeAirPlay:in-proc 无会话且无 lastCast → 空操作", async () => {
    S.setDevices([dev()]);
    await expect(C.resumeAirPlay("b31-none")).resolves.toBeUndefined();
  });

  it("stopAirPlay:就是 stopSession 的公开别名", async () => {
    const player = await seedSession();
    await C.stopAirPlay(devId());
    expect(player.stop).toHaveBeenCalled();
    expect(C.getAirPlayStatus(devId()).playbackState).toBe(PlaybackState.IDLE);
  });
});

// ===========================================================================
describe("Seek", () => {
  it("seekAirPlay:负数当 0 处理(catch-up/无效输入不能把进度搞坏)", async () => {
    const player = await seedSession();
    player.prepareSeek.mockImplementationOnce(async () => { player.endStream(); });
    // 无 live session → 回落路径;负数不应变成重投负数秒
    await C.seekAirPlay(devId(), -5);
    // 负数必须夹成 0:这个值一路喂给 prepareSeek / 新 ffmpeg 的 -ss
    expect(player.prepareSeek).toHaveBeenCalledWith(0);
    expect(C.getAirPlayPeerStatus(devId()).media?.songId).toBeTruthy();
  });

  it("seekAirPlay:fork 且子进程原地成功 → 主进程不再重投", async () => {
    S.fork = true;
    S.running = true;
    S.setDevices([dev()]);
    await C.castToAirPlayDevice(castOpts(devId()));
    // ⚠️ 这次起播是在 fork 下发起的,它本身已经打过一次 "cast" rpc —— 只能比
    // **增量**。变异 M42(去掉 `if (inPlace) return`)的破绽就在这:它会在原地
    // seek 成功之后多打一次 cast,把同一首重投一遍。
    const castCalls = () => sup.rpc.mock.calls.filter((c: any[]) => c[0] === "cast").length;
    const castBefore = castCalls();
    sup.rpc.mockResolvedValueOnce(true);
    await C.seekAirPlay(devId(), 42);
    expect(sup.rpc).toHaveBeenCalledWith("seek", { deviceId: devId(), seconds: 42 });
    // 子进程已确认原地成功 → 主进程绝不能再 cast 一遍(同一秒会重放两路)。
    expect(castCalls()).toBe(castBefore);
  });

  it("seekAirPlay:fork 且子进程原地失败 → 回落「带 seekSec 重投」", async () => {
    S.fork = true;
    S.setDevices([dev()]);
    await C.castToAirPlayDevice(castOpts(devId()));
    sup.rpc.mockResolvedValueOnce(false);
    await C.seekAirPlay(devId(), 42);
    await vi.waitFor(() => expect(sup.rpc).toHaveBeenCalledWith("cast", expect.objectContaining({ seekSec: 42 })));
  });

  it("seekAirPlay:fork 且子进程未运行 → 连 rpc 都不打", async () => {
    S.fork = true;
    S.running = false;
    await C.seekAirPlay("b31-none", 10);
    expect(sup.rpc).not.toHaveBeenCalled();
  });

  it("seekAirPlay:in-proc 无会话无 lastCast → 空操作", async () => {
    S.setDevices([dev()]);
    await expect(C.seekAirPlay("b31-none", 30)).resolves.toBeUndefined();
  });

  it("seekAirPlay:in-proc 会话不通(isStreaming=false)→ 回落到重投", async () => {
    const player = await seedSession();
    player.isStreaming = false;
    const before = decoder.spawnDecoder.mock.calls.length;
    await C.seekAirPlay(devId(), 60);
    expect(decoder.spawnDecoder.mock.calls.length).toBeGreaterThan(before);
  });

  it("seekAirPlay:原地 seek 只换解码器 —— RTSP 会话与 RTP socket 保持不失联", async () => {
    const player = await seedSession();
    // 在 prepareSeek 里收掉在途推流:seekAirPlay 先置 seekReplace 再 await 旧 stream,
    // 旧 finalizer 因此走 seekReplace 分支(只 kill 解码器、保留会话),正好是原地
    // seek 要验证的前提 —— 晚一步收尾就会把会话拆掉、退化成「整首重投」。
    player.prepareSeek.mockImplementationOnce(async () => { player.endStream(); });
    S.resolvePipelineInput.mockResolvedValueOnce({ input: "resolved-for-seek" });
    const before = decoder.spawnDecoder.mock.calls.length;
    await C.seekAirPlay(devId(), 90);
    expect(decoder.spawnDecoder.mock.calls.length).toBe(before + 1);
    // 重播输入同样要过合规门(旧 token 可能过期):喂给 ffmpeg 的必须是解析后的地址,
    // 不能是会话里那个原始 token URL(变异 M47 直接跳过合规门重解)。
    expect(last(decoder.spawnDecoder.mock.calls)?.[0]).toBe("resolved-for-seek");
    expect(player.prepareSeek).toHaveBeenCalledWith(90);
    // 会话仍然健在(没有走「会话被拆 → 重投」那条路)
    expect(C.getAirPlayStatus(devId()).playbackState).toBe(PlaybackState.PLAYING);
  });

  it("seekAirPlay:原地 seek 会 kill 旧解码器并掐断管道(否则旧 producer 吊着不退出)", async () => {
    const player = await seedSession();
    player.prepareSeek.mockImplementationOnce(async () => { player.endStream(); });
    expect(S.decoders.length).toBe(1);
    const old = S.decoders[0];
    await C.seekAirPlay(devId(), 45);
    expect(old.kill).toHaveBeenCalled();
    // ⚠️ 光断言 kill 抓不住 M46:旧 finalizer 的 seekReplace 分支也会 kill 旧
    // 解码器。真正只有 seekAirPlay 会做的是 destroy 管道 —— 旧 producer 就靠
    // 这一步解除 waitData 阻塞(否则要空等 30s 超时)。
    expect(old.stdout.destroy).toHaveBeenCalled();
    expect(old.stderr.destroy).toHaveBeenCalled();
    // 新解码器挂上,会话里跑的是它而不是旧的
    expect(S.decoders.length).toBe(2);
  });

  it("seekAirPlay:暂停中 seek → 换完解码器仍在暂停态(不能偷偷恢复播放)", async () => {
    const player = await seedSession();
    await C.pauseAirPlay(devId());
    player.prepareSeek.mockImplementationOnce(async () => { player.endStream(); });
    await C.seekAirPlay(devId(), 20);
    expect(C.getAirPlayStatus(devId()).playbackState).toBe(PlaybackState.PAUSED);
    // 一次来自 pauseAirPlay、一次来自 seek 收尾复原 —— 少第二次就等于偷偷恢复播放。
    // 原来只写 toHaveBeenCalled():暂停期间 isPaused 本来就是 true,少调那一下
    // 状态查询照样给出 PAUSED(变异 M48 因此存活)。
    expect(player.pause).toHaveBeenCalledTimes(2);
  });

  it("seekAirPlay:旧 finalizer 抢跑把会话拆了 → 走完整重投而不是留下半个会话", async () => {
    const player = await seedSession();
    // 在 prepareSeek 里把会话拆掉,模拟 finalizer 抢跑;顺手收掉在途推流,
    // 好让 seekAirPlay 能走出 await 旧 stream 那一步
    player.prepareSeek.mockImplementationOnce(async () => {
      await C.stopAirPlaySession(devId());
      player.endStream();
    });
    const before = decoder.spawnDecoder.mock.calls.length;
    await C.seekAirPlay(devId(), 70);
    expect(decoder.spawnDecoder.mock.calls.length).toBe(before + 1);
    expect(C.getAirPlayStatus(devId()).playbackState).toBe(PlaybackState.PLAYING);
  });
});

// ===========================================================================
describe("音量 / 静音(含 DLNA 同 host 转发)", () => {
  it("dlnaPeerOfAirPlay:设备没有 host → 不猜 peer,音量回落到 RAOP 通道", async () => {
    const player = await seedSession({ host: "" });
    await C.setAirPlayVolume(devId(), 55);
    expect(player.setVolumeDb).toHaveBeenCalled(); // 走了 SET_PARAMETER,没往 DLNA 转发
  });

  it("dlnaPeerOfAirPlay:设备没有 host → 不猜 peer(哪怕 DLNA 侧解出空主机名)", async () => {
    const player = await seedSession({ host: "" });
    // file:///dev 解析出来的 hostname 是空串 —— 正好能暴露「不判 host」这条变异:
    // 去掉 `!ap?.host` 之后,这台空主机名设备会被当成同 host 匹配上。
    S.getCachedDevices.mockReturnValue([{ id: "file-ish", location: "file:///dev" }]);
    await C.setAirPlayVolume(devId(), 55);
    expect(player.setVolumeDb).toHaveBeenCalled(); // 回落 RAOP,没往 DLNA 转发
  });

  it("dlnaPeerOfAirPlay:同 host 多个 DLNA 设备 → 优先会调音量的那个", async () => {
    const d = dev({ host: "192.168.1.30" });
    S.setDevices([d]);
    S.getCachedDevices.mockReturnValue([
      { id: "dlna-no-rc", location: "http://192.168.1.30/a" },         // 媒体服务器,无 RenderingControl
      { id: "dlna-with-rc", location: "http://192.168.1.30/b", renderingControlUrl: "http://192.168.1.30/rc" },
    ]);
    await C.setAirPlayVolume(d.id, 42);
    expect(S.setDeviceVolume).toHaveBeenCalledWith("dlna-with-rc", 42);
  });

  it("dlnaPeerOfAirPlay:location 不是合法 URL → 跳过(不能让异常冒出去)", async () => {
    const d = dev({ host: "192.168.1.30" });
    S.setDevices([d]);
    S.getCachedDevices.mockReturnValue([
      { id: "bad-url", location: "这不是 URL" },
      { id: "good", location: "http://192.168.1.30/x", renderingControlUrl: "rc" },
    ]);
    await C.setAirPlayVolume(d.id, 42);
    expect(S.setDeviceVolume).toHaveBeenCalledWith("good", 42);
  });

  it("dlnaPeerOfAirPlay:非法 URL 不能把别的主机一起蒙进来(配对错了比不配对更糟)", async () => {
    // ⚠️ 只放「非法 URL」当唯一候选杀不掉 M51:变异改的是 try 里的
    // `return dHost === apHost;`,后面 `catch { return false; }` 照样兜得住它 ——
    // 两种实现结果完全一致。必须让非法 URL 与**别的主机**同时出现:
    //   原实现 → 别的主机 hostname 不同(false)、非法 URL 抛异常(false),谁都不选;
    //   变异实现 → 别的主机那支先 `return true` 蒙混过关,被当成同 host 选中,
    //   音量就转发到一台根本不在同一网段的设备上去了。
    // 配对错误 ≠ 转发失败:后者是「没调成」,前者是「调到了不该调的地方」。
    const player = await seedSession({ host: "192.168.1.30" });
    S.getCachedDevices.mockReturnValue([
      { id: "other-host", location: "http://192.168.9.9/x" },                              // 别的主机
      { id: "bad-url", location: "这不是 URL", renderingControlUrl: "rc" },                 // 解析不出主机名
    ]);
    await C.setAirPlayVolume(devId(), 42);
    expect(S.setDeviceVolume).not.toHaveBeenCalled(); // 谁都不该被选中
    expect(player.setVolumeDb).toHaveBeenCalled();    // 老老实实回落 RAOP
  });

  it("音量越界夹取到 0-100,并回显给状态查询", async () => {
    S.setDevices([dev()]);
    await C.setAirPlayVolume(devId(), 500);
    expect(C.getAirPlayStatus(devId()).volume).toBe(100);
    await C.setAirPlayVolume(devId(), -20);
    expect(C.getAirPlayStatus(devId()).volume).toBe(0);
  });

  it("音量:有 DLNA peer 且转发成功 → 走 DLNA,不再回落 SET_PARAMETER", async () => {
    const d = dev({ host: "192.168.1.30" });
    S.setDevices([d]);
    S.getCachedDevices.mockReturnValue([{ id: "dlna-v", location: "http://192.168.1.30/x", renderingControlUrl: "rc" }]);
    await C.setAirPlayVolume(d.id, 42);
    expect(S.setDeviceVolume).toHaveBeenCalledWith("dlna-v", 42);
  });

  it("音量:DLNA 转发成功 → 绝不顺手再写一次 SET_PARAMETER", async () => {
    // 顺序要紧:seedSession 会覆盖整个设备表,DLNA peer 必须在会话建好之后才挂得上。
    const player = await seedSession({ host: "192.168.1.30" });
    S.getCachedDevices.mockReturnValue([{ id: "dlna-v", location: "http://192.168.1.30/x", renderingControlUrl: "rc" }]);
    await C.setAirPlayVolume(devId(), 42);
    expect(S.setDeviceVolume).toHaveBeenCalledTimes(1);
    // 「转发成功后 return」这条变异不改变 setDeviceVolume 的调用次数(M54 活下来
    // 就是因为这个),它多走的那一步 applyVolumeDb 在有会话时会真的覆盖音量。
    expect(player.setVolumeDb).not.toHaveBeenCalled();
  });

  it("音量:DLNA 转发失败 → 回落 RAOP SET_PARAMETER(不能两头都不调)", async () => {
    // 顺序很要紧:seedSession 内部会 S.setDevices([新设备]) 覆盖整个设备表,
    // 所以 DLNA peer 必须在会话建好之后、调用音量之前才挂得上。
    const player = await seedSession({ host: "192.168.1.30" });
    S.getCachedDevices.mockReturnValue([
      { id: "dlna-v", location: "http://192.168.1.30/x", renderingControlUrl: "rc" },
    ]);
    S.setDeviceVolume.mockRejectedValueOnce(new Error("SOAP 超时"));
    await C.setAirPlayVolume(devId(), 42);
    expect(S.setDeviceVolume).toHaveBeenCalledWith("dlna-v", 42); // 先试了 DLNA
    expect(player.setVolumeDb).toHaveBeenCalled(); // 失败后回落 SET_PARAMETER
  });

  it("音量:静音中或音量 0 → 写 -144 dB(真静音,不是「把音量调到 0」)", async () => {
    const player = await seedSession();
    await C.setAirPlayVolume(devId(), 0);
    expect(player.setVolumeDb).toHaveBeenLastCalledWith(-144);
    await C.setAirPlayMuted(devId(), true);
    expect(player.setVolumeDb).toHaveBeenLastCalledWith(-144);
    // 解除静音:st.volume 仍是 0,按「音量 0 即真静音」照样写 -144(符合预期)
    await C.setAirPlayMuted(devId(), false);
    expect(player.setVolumeDb).toHaveBeenLastCalledWith(-144);
    // 真正把音量调回来之后,才该恢复正常读数
    await C.setAirPlayVolume(devId(), 55);
    expect(player.setVolumeDb).toHaveBeenLastCalledWith(decoder.degreesToDb(55));
  });

  it("静音:有 DLNA peer → 转发 mute(设备自己的 RAOP  often ignores it)", async () => {
    const d = dev({ host: "192.168.1.30" });
    S.setDevices([d]);
    S.getCachedDevices.mockReturnValue([{ id: "dlna-m", location: "http://192.168.1.30/x", renderingControlUrl: "rc" }]);
    await C.setAirPlayMuted(d.id, true);
    expect(S.setDeviceMute).toHaveBeenCalledWith("dlna-m", true);
    expect(C.getAirPlayStatus(d.id).muted).toBe(true);
  });

  it("静音:DLNA 转发成功 → 也不再顺手写 SET_PARAMETER", async () => {
    const player = await seedSession({ host: "192.168.1.30" });
    S.getCachedDevices.mockReturnValue([{ id: "dlna-m", location: "http://192.168.1.30/x", renderingControlUrl: "rc" }]);
    await C.setAirPlayMuted(devId(), true);
    expect(S.setDeviceMute).toHaveBeenCalledTimes(1);
    expect(player.setVolumeDb).not.toHaveBeenCalled();
  });

  it("静音不改动音量读数(两个通道互相独立)", async () => {
    S.setDevices([dev()]);
    await C.setAirPlayVolume(devId(), 55);
    await C.setAirPlayMuted(devId(), true);
    expect(C.getAirPlayStatus(devId()).volume).toBe(55);
    await C.setAirPlayMuted(devId(), false);
    expect(C.getAirPlayStatus(devId()).volume).toBe(55);
  });

  it("applyVolumeDb:fork 子进程在跑 → fire-and-forget RPC(不等回复,避免卡住控制链路)", async () => {
    S.fork = true;
    S.running = true;
    await C.setAirPlayVolume(devId(), 30);
    expect(S.rpcFireAndForget).toHaveBeenCalledWith(sup, "setVolumeDb", { deviceId: devId(), db: expect.any(Number) });
  });

  it("applyVolumeDb:fork 但子进程没跑 → 静默丢弃(不能因为子进程不在就抛错)", async () => {
    S.fork = true;
    S.running = false;
    await expect(C.setAirPlayVolume(devId(), 30)).resolves.toBeUndefined();
    expect(S.rpcFireAndForget).not.toHaveBeenCalled();
  });

  it("applyVolumeDb:in-proc 有会话 → 直接写本地播放器", async () => {
    const player = await seedSession();
    await C.setAirPlayVolume(devId(), 30);
    expect(player.setVolumeDb).toHaveBeenCalled();
  });
});

// ===========================================================================
describe("状态读取(getAirPlayStatus / peerStatus / sessionView)", () => {
  it("无会话 → IDLE,但保留 lastCast 的曲目标题(UI 要显示「上次播的是什么」)", async () => {
    S.setDevices([dev({ name: "书房" })]);
    await C.castToAirPlayDevice(castOpts(devId(), { title: "夜曲", artist: "化简", album: "专辑A" }));
    await C.stopAirPlaySession(devId());
    const st = C.getAirPlayStatus(devId());
    expect(st.playbackState).toBe(PlaybackState.IDLE);
    expect(st.title).toBe("夜曲");
    expect(st.name).toBe("书房");
    expect(st.available).toBe(true);
    expect(st.supportsRsa).toBe(true);
  });

  it("未知设备 → name 回落成 deviceId(不留空)", () => {
    const st = C.getAirPlayStatus("b31-unknown");
    expect(st.name).toBe("b31-unknown");
    expect(st.playbackState).toBe(PlaybackState.IDLE);
    expect(st.volume).toBe(80); // volumeState 的默认初值
  });

  it("播放中 → PLAYING 并带推流节拍指标", async () => {
    await seedSession();
    const st = C.getAirPlayStatus(devId());
    expect(st.playbackState).toBe(PlaybackState.PLAYING);
    expect(st.stream).toBeTruthy();
  });

  it("会话已 ended → 即便表里有条目也按 IDLE 呈现", async () => {
    const player = await seedSession();
    // 通过公开出口把会话拆掉(等价于自然结束)
    await C.stopAirPlaySession(devId());
    expect(C.getAirPlayStatus(devId()).playbackState).toBe(PlaybackState.IDLE);
  });

  it("fork:状态一律读子进程镜像(同步,不打 IPC —— 每 500ms 会被问一次)", async () => {
    S.fork = true;
    const d = dev();
    S.setDevices([d]);
    sup.mirror.sessions.set(d.id, {
      ended: false, playbackState: "paused", positionSec: 7, durationSec: 33,
      title: "镜像曲", artist: "镜像者", album: "镜像辑",
      stream: { reanchors: 1, maxGapMs: 8.1, packets: 3 },
    });
    const st = C.getAirPlayStatus(d.id);
    expect(st.playbackState).toBe(PlaybackState.PAUSED);
    expect(st.position).toBe(7);
    expect(st.duration).toBe(33);
    expect(st.title).toBe("镜像曲");
    expect(st.stream?.maxGapMs).toBe(8.1);
  });

  it("fork:镜像里没有该设备 → 视为无会话(IDLE)", () => {
    S.fork = true;
    S.setDevices([dev()]);
    expect(C.getAirPlayStatus(devId()).playbackState).toBe(PlaybackState.IDLE);
  });

  it("in-proc:positionSec 负值被夹回 0(外推/时钟回拨不能把进度推成负数)", async () => {
    const player = await seedSession();
    player.positionSec = -5;
    expect(C.getAirPlayStatus(devId()).position).toBe(0);
  });

  it("in-proc:轨道时长优先用会话登记值(来自上游元数据,比播放器自报的准)", async () => {
    const player = await seedSession();
    player.durationSec = 999;
    expect(C.getAirPlayStatus(devId()).duration).toBe(200);
  });

  it("peerStatus:带 trackUri 与 media 元信息(HA/前端读的就是这层)", async () => {
    S.setDevices([dev()]);
    await C.castToAirPlayDevice(castOpts(devId(), { streamUrl: "http://h/s/1", coverArt: "http://c/1" }));
    const ps = C.getAirPlayPeerStatus(devId());
    expect(ps.trackUri).toBe("http://h/s/1");
    expect(ps.media).toMatchObject({ title: "曲", coverArt: "http://c/1" });
    expect(ps.state).toBe(PlaybackState.PLAYING);
  });

  it("peerStatus:没投播过 → media 与 trackUri 都留空(不编造)", async () => {
    S.setDevices([dev()]);
    const ps = C.getAirPlayPeerStatus(devId());
    expect(ps.media).toBeUndefined();
    expect(ps.trackUri).toBe("");
  });
});

// ===========================================================================
describe("服务开关(startAirPlayService / isAirPlayEnabled / stopAirPlayService)", () => {
  it("startAirPlayService:启动发现并登记事件", () => {
    C.startAirPlayService();
    expect(S.discovery.startAirPlayDiscovery).toHaveBeenCalled();
    expect(S.discovery.onAirPlayEvent).toHaveBeenCalled();
  });

  it("startAirPlayService:设备 byebye 消失 → 有会话就停掉(残留在设备端继续播是 bug)", async () => {
    C.startAirPlayService();
    const handler = S.discovery.onAirPlayEvent.mock.calls[0][0];
    await seedSession();
    handler({ type: "byebye", id: devId() });
    await vi.waitFor(() => expect(C.getAirPlayStatus(devId()).playbackState).toBe(PlaybackState.IDLE));
  });

  it("startAirPlayService:byebye 事件对无会话设备是空操作", async () => {
    C.startAirPlayService();
    const handler = S.discovery.onAirPlayEvent.mock.calls[0][0];
    await expect(Promise.resolve(handler({ type: "byebye", id: "b31-none" }))).resolves.toBeUndefined();
  });

  it("startAirPlayService:fork 模式顺带把推流子进程拉起来(但不等它起完)", async () => {
    S.fork = true;
    C.startAirPlayService();
    await vi.waitFor(() => expect(sup.start).toHaveBeenCalled());
  });

  it("isAirPlayEnabled:没有插件行(表结构异常)→ false,不能把启动流程打死", () => {
    // 同一份库跨用例复用,先清掉前面用例插的 airplay-renderer 行
    sqlite.prepare("DELETE FROM plugins WHERE name = 'airplay-renderer'").run();
    expect(C.isAirPlayEnabled()).toBe(false);
  });

  it("isAirPlayEnabled:插件行 enabled=1 → true", () => {
    sqlite.prepare("DELETE FROM plugins WHERE name = 'airplay-renderer'").run();
    sqlite.prepare(
      "INSERT INTO plugins (name, version, enabled, manifest, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    ).run("airplay-renderer", "1.0.0", 1, "{}", new Date().toISOString(), new Date().toISOString());
    expect(C.isAirPlayEnabled()).toBe(true);
  });

  it("stopAirPlayService:清内存态 + 移除 peer + 注销 player + 停发现(零常驻资源)", async () => {
    const d = dev();
    S.setDevices([d]);
    await C.castToAirPlayDevice(castOpts(d.id));
    await C.setAirPlayVolume(d.id, 66);
    await C.stopAirPlayService();
    await vi.waitFor(() => {
      expect(S.getPeerManager.removeAirPlayPeers).toHaveBeenCalled();
      expect(S.getQueueController.unregisterAirPlayDevices).toHaveBeenCalled();
    });
    expect(S.getQueueController.unregisterAirPlayDevices).toHaveBeenCalled(); // 队列注销
    expect(S.discovery.stopAirPlayDiscovery).toHaveBeenCalled();
    // 内存设备列表被清空 → 连查询都读不到了(不能留着僵尸设备)
    await vi.waitFor(() => expect(S.discovery.removeAirPlayDevice).toHaveBeenCalledWith(d.id));
    // 内存态清空 → 音量回到默认 80
    expect(C.getAirPlayStatus(d.id).volume).toBe(80);
  });

  it("stopAirPlayService:幂等(连停两次不出错)", async () => {
    S.setDevices([dev()]);
    await expect(C.stopAirPlayService()).resolves.toBeUndefined();
    await expect(C.stopAirPlayService()).resolves.toBeUndefined();
  });

  it("stopAirPlayService:fork 模式先停推流子进程", async () => {
    S.fork = true;
    S.setDevices([dev()]);
    await C.stopAirPlayService();
    await vi.waitFor(() => expect(sup.stop).toHaveBeenCalled());
  });
});
