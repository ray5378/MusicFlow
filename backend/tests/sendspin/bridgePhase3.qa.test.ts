// ==================== 【QA 对抗性用例】Phase 3 组泵出声(独立于实现者自测) ====================
//
// ① BLK-01 组合反例:members=∅ + 2 桥 + flac 编码器在场 → pushFrame>0、两桥收**同一份**
//    PCM 字节(不吃 flac);单桥 pushAudio 抛错不连累另一桥与组泵返回值;
// ② stop→play(epoch+2)→ 重锚钩子恰各发 1 次代次通知,generation 跳变 = epoch 差 × 1_000_003,
//    组桩 bridges/bridgeSpecs 全程不被泵触碰(桥生命周期只归 sync/clear 管理);
// ③ prepareBridgeRoute 路由状态机:全成功=bridge / 单失败=degraded(失败者回落 solo cast)/
//    全失败=legacy-cast(bridge 参数不出现);stop → 逐设备 bridgeStopDevice;
// ④ BridgeSessionManager:同 deviceId 二次 prepare → 旧会话拆除(socket 文件被摘)、
//    会话计数 == 1;isAirplayBridgeEnabled flag 门控(=0 关死,其余开)。
import "../plugins/_env.js";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---- GroupPump 夹具(与 bridgePumpGeneration.test.ts 同款:PcmWindow 挂起可控)----
const H = vi.hoisted(() => ({
  rows: [] as any[],
  readyImpl: (() => Promise.resolve()) as () => Promise<any>,
  instances: [] as any[],
  sliceWaits: [] as Array<(v: Float32Array) => void>,
  resolveInput: { input: "https://example.invalid/a.flac" } as any,
}));

vi.mock("../../src/services/source/resolveAudio.js", () => ({
  resolvePlayableRow: async () => ({ row: H.rows.shift(), reason: "ok" }),
  fetchRowBytes: async () => null,
  resolveRowInput: () => H.resolveInput,
}));
vi.mock("../../src/services/audio/pipeline.js", () => ({
  resolvePipelineInput: async (d: any) => d,
}));
vi.mock("../../src/services/playerDsp.js", () => ({
  playerDspFilters: () => [],
}));
vi.mock("../../src/services/sendspin/streamSource.js", () => {
  class WindowEvictedError extends Error {}
  class PcmWindow {
    baseMs = 0;
    pid = 4242;
    eof = false;
    failedReason: string | null = null;
    decoded = 0;
    closed = false;
    opts: any;
    startMs: number;
    constructor(opts: any, startMs: number) {
      this.opts = opts;
      this.startMs = startMs;
      H.instances.push(this);
    }
    ready(): Promise<void> {
      return H.readyImpl();
    }
    close(): void {
      this.closed = true;
    }
    slice(): Promise<Float32Array> {
      return new Promise<Float32Array>((res) => H.sliceWaits.push(res));
    }
    stderrText(): string {
      return "";
    }
  }
  return { PcmWindow, WindowEvictedError, WINDOW_HIGH_SEC: 300 };
});

import { existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { SendspinGroup } from "../../src/services/sendspin/server.js";
import { GroupPump } from "../../src/services/sendspin/streamEngine.js";
import { SAMPLE_RATE, type EncodedChunk } from "../../src/services/sendspin/encoding.js";
import { nowUs } from "../../src/services/sendspin/clock.js";
import { BridgeSessionManager } from "../../src/services/airplay/bridgeSession.js";
import { isAirplayBridgeEnabled } from "../../src/services/airplay/control.js";
import { createGroupProtocolPlayer } from "../../src/services/group/protocolPlayer.js";

// ===========================================================================
// ① BLK-01 组合反例 + 单桥故障隔离
// ===========================================================================

class PhaseEncoder {
  calls = 0;
  constructor(
    private readonly plan: number[],
    private readonly fill = 0xab,
  ) {}
  async encode(): Promise<EncodedChunk[]> {
    const n = this.plan[this.calls++] ?? 0;
    return n > 0 ? [{ frameSamples: n, data: new Uint8Array(Math.max(1, n / 100)).fill(this.fill) }] : [];
  }
  async flush(): Promise<EncodedChunk[]> {
    return [];
  }
  close(): void {}
  get encodeCalls(): number {
    return this.calls;
  }
}

function bridgeStub(deviceId: string, opts: { pushThrows?: boolean } = {}) {
  const pushed: { data: Uint8Array; ts: bigint }[] = [];
  let pushFailures = 0;
  return {
    deviceId,
    pushed,
    get pushFailures() {
      return pushFailures;
    },
    pushAudio(data: Uint8Array, ts: bigint) {
      if (opts.pushThrows) {
        pushFailures++;
        throw new Error(`bridge ${deviceId} push 失败`);
      }
      pushed.push({ data: Uint8Array.from(data), ts });
    },
    notifyGeneration() {},
    sendBoundary() {},
    start() {},
    stop() {},
  };
}

const PCM = (n = 1200) => new Float32Array(n);

const liveGroups: SendspinGroup[] = [];

describe("QA① BLK-01 组合反例:members=∅ + 2 桥 + flac 编码器在场", () => {
  afterEach(() => {
    // 窗口化迁移注:pushFrame(桥在场)会起每组 250ms 补投定时器,测试收尾显式停表。
    for (const g of liveGroups.splice(0)) g.stopBridgePushTimer();
  });

  it("pushFrame>0;帧入 ring 后由补投 tick 派发:两桥各收同一份 PCM(0xcd)、ts 已减 sendAhead、窗外帧不收", async () => {
    const g = new SendspinGroup("g-qa3", { log() {} } as any);
    liveGroups.push(g);
    const flac = new PhaseEncoder([800], 0xab);
    const pcm = new PhaseEncoder([1000], 0xcd);
    (g as any).encoders.set("flac:100", flac);
    (g as any).encoders.set("pcm:100", pcm);
    const b1 = bridgeStub("ap-1");
    const b2 = bridgeStub("ap-2");
    g.bridges.set("ap-1", b1 as any);
    g.bridges.set("ap-2", b2 as any);
    const ahead = BigInt(g.commonSendAheadUs()); // 无成员 → 回落 DEFAULT_MIN_BUFFER_MS(800ms)
    const ts0 = nowUs() + 2_000_000n; // 投递窗口 [now+FLOOR 1.5s, now+HORIZON 2.5s] 内

    const got = await g.pushFrame(ts0, PCM());
    g.bridgePushTick(); // §6.2 窗口化:pushFrame 只入 ring,投递由补投 tick(单写者)完成

    expect(got).toBe(1000); // >0:虚拟组让编码与「有无真实成员」解耦
    expect(pcm.encodeCalls).toBe(1);
    expect(flac.encodeCalls).toBe(0); // 无 flac 成员 → flac 组不参与
    expect(b1.pushed).toHaveLength(1);
    expect(b2.pushed).toHaveLength(1);
    expect(Buffer.from(b1.pushed[0]!.data).equals(b2.pushed[0]!.data)).toBe(true);
    expect(b1.pushed[0]!.data[0]).toBe(0xcd); // 桥吃 PCM,不吃 flac(0xab)
    expect(b1.pushed[0]!.ts).toBe(ts0 - ahead); // 可听域转换 ts' = ts − sendAhead
    // 窗外帧不收:horizon 外(+5s)与 floor 下(+0.5s)均不投,且不污染水位
    await g.pushFrame(nowUs() + 5_000_000n, PCM());
    await g.pushFrame(nowUs() + 500_000n, PCM());
    g.bridgePushTick();
    expect(b1.pushed).toHaveLength(1);
    expect(b2.pushed).toHaveLength(1);
  });

  it("单桥 pushAudio 抛错 → 另一桥照常收流,pushFrame 返回值不受损,补投定时器续投", async () => {
    const g = new SendspinGroup("g-qa3b", { log() {} } as any);
    liveGroups.push(g);
    (g as any).encoders.set("pcm:100", new PhaseEncoder([1000, 1000], 0xcd));
    const bad = bridgeStub("ap-bad", { pushThrows: true });
    const good = bridgeStub("ap-good");
    g.bridges.set("ap-bad", bad as any);
    g.bridges.set("ap-good", good as any);

    const got = await g.pushFrame(nowUs() + 2_000_000n, PCM());
    g.bridgePushTick();

    expect(got).toBe(1000);
    expect(bad.pushFailures).toBe(1); // 单桥失败不连累组泵与另一桥
    expect(good.pushed).toHaveLength(1);
    // 下一帧进窗 → tick 续投:好桥继续收,坏桥继续被隔离,组泵无感
    await g.pushFrame(nowUs() + 2_100_000n, PCM());
    g.bridgePushTick();
    expect(good.pushed).toHaveLength(2);
    expect(bad.pushFailures).toBe(2);
  });
});

// ===========================================================================
// ② stop→play(epoch+2):恰各 1 次代次通知,generation 跳变正确
// ===========================================================================

const server = { log: () => {} } as any;
const ENV = {
  SENDSPIN_PREFILL: process.env.SENDSPIN_PREFILL,
  SENDSPIN_PUSH_SPEED: process.env.SENDSPIN_PUSH_SPEED,
};

function makeGroup(overrides: Record<string, unknown> = {}) {
  const genCalls: Array<[number, string]> = [];
  const g: any = {
    name: "g",
    id: "g",
    positionMs: 0,
    timelineBaseUs: 0n,
    current: null,
    finished: 0,
    members: new Set<any>(),
    bridgeSpecs: [],
    hasBridges: () => false,
    notifyBridgeGeneration: (gen: number, reason: string) => {
      genCalls.push([gen, reason]);
    },
    commonSendAheadUs: () => 800_000,
    capacityLimitedPrefillMs: () => 3_000,
    resetPushMeter: () => {},
    pushFrame: async () => 480,
    finishPlayback: () => {
      g.finished++;
    },
    close: () => {},
    ...overrides,
  };
  return { g, genCalls };
}

const FRAME_DATA = new Float32Array(4800);
const releaseOne = (): void => {
  const r = H.sliceWaits.shift();
  if (r) r(FRAME_DATA);
};
const releaseSlices = (): void => {
  for (const r of H.sliceWaits.splice(0)) r(new Float32Array(0));
};
const waitSlices = async (n: number, timeoutMs = 5000): Promise<void> => {
  const t0 = Date.now();
  while (H.sliceWaits.length < n) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`slice 未挂起(等 ${n} 个)`);
    await new Promise((r) => setTimeout(r, 5));
  }
};
const waitGen = async (genCalls: Array<[number, string]>, n: number, timeoutMs = 5000): Promise<void> => {
  const t0 = Date.now();
  while (genCalls.length < n) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`重锚未发生(等第 ${n} 拍,现有 ${genCalls.length})`);
    await new Promise((r) => setTimeout(r, 5));
  }
};
const waitInactive = async (pump: GroupPump, ms: number): Promise<void> => {
  const t0 = Date.now();
  while (pump.active) {
    if (Date.now() - t0 > ms) throw new Error("pump 未结束");
    await new Promise((r) => setTimeout(r, 20));
  }
};

beforeEach(() => {
  process.env.SENDSPIN_PREFILL = "0";
  process.env.SENDSPIN_PUSH_SPEED = "100";
  H.rows = [];
  H.instances = [];
  H.sliceWaits = [];
  H.readyImpl = () => Promise.resolve();
});

afterEach(async () => {
  releaseSlices();
  for (const [k, v] of Object.entries(ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("QA② stop→play:重锚钩子恰 1 次/流,generation 跳变 = epoch 差 × 1_000_003", () => {
  it("play→stop→play:两流各恰 1 次通知(track),gen 1_000_003 → 2_000_006(epoch+2)", async () => {
    H.rows = [{ id: "row-qa-1", duration: 10 }];
    const { g, genCalls } = makeGroup();
    const pump = new GroupPump(server, g);

    await pump.play("song-qa");
    await waitSlices(1);
    releaseOne();
    await waitGen(genCalls, 1);
    expect(genCalls[0]).toEqual([1_000_003, "track"]); // epoch 1 × 1_000_003 + 0

    pump.stop(); // seek/切歌等价:stop 后重建流
    releaseSlices(); // 放行 stop 时残留挂起的 slice(空片=EOF),避免污染下一流的等待
    await waitInactive(pump, 5000);
    expect(genCalls).toHaveLength(1); // stop 本身不发代次通知
    expect(H.sliceWaits.length).toBe(0); // 夹具干净:无残留挂起

    H.rows.push({ id: "row-qa-2", duration: 10 }); // 第二流曲目行(首次 play 已消耗一条)
    await pump.play("song-qa2");
    await waitSlices(1);
    releaseOne();
    await waitGen(genCalls, 2);
    expect(genCalls).toHaveLength(2); // 恰 1 次/流,无中间多余 BOUNDARY
    expect((pump as any).epoch).toBe(3); // play1=1 → stop()=2 → play2=3(stop 也 ++,见 streamEngine L1207)
    expect(genCalls[1]).toEqual([3_000_009, "track"]); // 3×1_000_003+0
    expect(genCalls[1]![0]! - genCalls[0]![0]!).toBe(2 * 1_000_003); // stop→play:epoch+2 的代次跳变
    releaseSlices();
    await waitInactive(pump, 5000);
  }, 30_000);
});

// ===========================================================================
// ③ prepareBridgeRoute:bridge / degraded / legacy-cast 三态可区分
// ===========================================================================

const R = vi.hoisted(() => ({
  prepareBehavior: new Map<string, "ok" | "fail">(),
  prepared: [] as Array<{ deviceId: string; token: string }>,
  stopped: [] as Array<{ token: string; deviceId?: string }>,
  spinPlayCalls: [] as Array<{ item: any; baseUrl: string; bridge: any }>,
  apSoloCalls: [] as Array<{ id: string; startMs: any }>,
}));

vi.mock("../../src/services/airplay/control.js", () => ({
  isAirPlayDeviceDisabled: () => false,
  getAirPlayStatus: (id: string) => ({ available: true, name: `ap-${id}`, playbackState: "IDLE", position: 0, duration: 0, volume: 40, muted: false }),
  isAirplayBridgeEnabled: () => process.env.MUSICFLOW_AIRPLAY_BRIDGE !== "0",
  isBridgeOwned: () => false,
  bridgePrepareDevice: async (deviceId: string, token: string) => {
    if (R.prepareBehavior.get(deviceId) === "fail") throw new Error(`prepare 失败(deviceId=${deviceId})`);
    R.prepared.push({ deviceId, token });
    return { listening: true as const, socketPath: `/tmp/mfab-qa3-${deviceId}-${token}.sock` };
  },
  bridgeStopDevice: async (token: string, deviceId?: string) => {
    R.stopped.push({ token, deviceId });
  },
}));

vi.mock("../../src/services/airplay/protocolPlayer.js", () => ({
  createAirPlayProtocolPlayer: (id: string) => ({
    playerId: `airplay:${id}`,
    playMedia: async (item: any, _baseUrl: string, startMs?: number) => {
      R.apSoloCalls.push({ id, startMs });
      return { mediaUri: `http://apcast/${id}` };
    },
    stop: async () => {},
    pause: async () => {},
    resume: async () => {},
    seek: async () => {},
    setVolume: async () => {},
    pollState: async () => ({ playerId: `airplay:${id}`, playbackState: "PLAYING", position: 0, duration: 100, updatedAt: 0 }),
  }),
}));

vi.mock("../../src/services/sendspin/index.js", () => ({
  getSendspinFront: () => ({ clients: new Map([["c1", { ready: true }]]), groups: new Map() }),
  sendspinGroupPoll: async () => ({}),
}));

vi.mock("../../src/services/sendspin/protocolPlayer.js", () => ({
  createSendspinGroupPlayer: (gid: string) => ({
    playerId: `sendspin:${gid}`,
    playMedia: async (item: any, baseUrl: string, startMs?: number, bridge?: any) => {
      R.spinPlayCalls.push({ item, baseUrl, bridge });
      return { mediaUri: "http://spin/group" };
    },
    stop: async () => {},
    pause: async () => {},
    resume: async () => {},
    seek: async () => {},
    setVolume: async () => {},
    pollState: async () => ({ playerId: `sendspin:${gid}`, playbackState: "PLAYING", position: 0, duration: 100, updatedAt: 0 }),
  }),
}));

vi.mock("../../src/services/sendspin/playerCore.js", () => ({
  sendspinGroupName: (gid: string) => `ug:${gid}`,
}));

vi.mock("../../src/utils/logger.js", () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

const ITEM = { songId: "s-qa", title: "qa" } as any;

describe("QA③ prepareBridgeRoute 三态路由", () => {
  let getGroupManager: (id: string) => any;
  const groups = new Map<string, any>();

  beforeEach(() => {
    R.prepareBehavior.clear();
    R.prepared.length = 0;
    R.stopped.length = 0;
    R.spinPlayCalls.length = 0;
    R.apSoloCalls.length = 0;
    groups.clear();
    delete process.env.MUSICFLOW_AIRPLAY_BRIDGE;
  });

  // group/index 需按用例注入;用 vi.mock 工厂读 R.groupsMap —— 见文件底部 mock。
  // (为可读性,这里通过模块内 getGroupManager 的桩实现:_groups 由下方 helper 填。)

  it("全成功 → bridge:solo cast 零调用,sockets 含全部 airplay 设备", async () => {
    const player = createGroupProtocolPlayer("g-qa3-ok");
    R.prepareBehavior.set("ap-1", "ok");
    R.prepareBehavior.set("ap-2", "ok");
    setTestGroup("g-qa3-ok", ["sendspin:c1", "airplay:ap-1", "airplay:ap-2"]);

    await player.playMedia(ITEM, "http://base");

    expect(R.prepared.map((p) => p.deviceId).sort()).toEqual(["ap-1", "ap-2"]);
    expect(R.spinPlayCalls).toHaveLength(1);
    expect(R.spinPlayCalls[0]!.bridge?.sockets).toHaveLength(2);
    expect(R.spinPlayCalls[0]!.bridge!.sockets.map((s: any) => s.deviceId).sort()).toEqual(["ap-1", "ap-2"]);
    expect(R.apSoloCalls).toHaveLength(0); // 桥成功者绝不 solo cast
  });

  it("单设备失败 → degraded:sockets 仅含成功者,失败者回落 solo cast", async () => {
    const player = createGroupProtocolPlayer("g-qa3-deg");
    R.prepareBehavior.set("ap-1", "ok");
    R.prepareBehavior.set("ap-2", "fail");
    setTestGroup("g-qa3-deg", ["sendspin:c1", "airplay:ap-1", "airplay:ap-2"]);

    await player.playMedia(ITEM, "http://base");

    expect(R.spinPlayCalls[0]!.bridge?.sockets).toHaveLength(1);
    expect(R.spinPlayCalls[0]!.bridge!.sockets[0].deviceId).toBe("ap-1");
    expect(R.apSoloCalls.map((c) => c.id)).toEqual(["ap-2"]); // 失败者回落
  });

  it("全失败 → legacy-cast:bridge 参数不出现,全部 airplay solo cast", async () => {
    const player = createGroupProtocolPlayer("g-qa3-leg");
    R.prepareBehavior.set("ap-1", "fail");
    R.prepareBehavior.set("ap-2", "fail");
    setTestGroup("g-qa3-leg", ["sendspin:c1", "airplay:ap-1", "airplay:ap-2"]);

    await player.playMedia(ITEM, "http://base");

    expect(R.spinPlayCalls[0]!.bridge).toBeUndefined();
    expect(R.apSoloCalls.map((c) => c.id).sort()).toEqual(["ap-1", "ap-2"]);
  });

  it("stop → teardown:逐设备 bridgeStopDevice(token+deviceId),幂等", async () => {
    const player = createGroupProtocolPlayer("g-qa3-stop");
    R.prepareBehavior.set("ap-1", "ok");
    setTestGroup("g-qa3-stop", ["sendspin:c1", "airplay:ap-1"]);

    await player.playMedia(ITEM, "http://base");
    await player.stop();

    expect(R.stopped).toHaveLength(1);
    expect(R.stopped[0]!.deviceId).toBe("ap-1");
    expect(R.stopped[0]!.token).toBe(R.prepared[0]!.token);
    await player.stop(); // 幂等
    expect(R.stopped).toHaveLength(1);
  });
});

// ---- group/index mock:用最小组管理器承载测试组 ----
const G = vi.hoisted(() => {
  const groups = new Map<string, any>();
  return {
    groups,
    set: (id: string, memberIds: string[]) => groups.set(id, { id, name: id, memberIds, volume: 50 }),
  };
});
function setTestGroup(id: string, memberIds: string[]): void {
  G.set(id, memberIds);
}
vi.mock("../../src/services/group/index.js", () => ({
  getGroupManager: () => ({
    get: (id: string) => G.groups.get(id),
    setVolume: () => {},
    getVolume: () => 50,
  }),
  splitMemberId: (m: any) => {
    if (typeof m !== "string" || !m) return null;
    if (m.startsWith("group:") || m.startsWith("local:")) return null;
    if (m.startsWith("sendspin:")) {
      const id = m.slice("sendspin:".length);
      return id ? { kind: "sendspin", id } : null;
    }
    if (m.startsWith("airplay:")) {
      const id = m.slice("airplay:".length);
      return id ? { kind: "airplay", id } : null;
    }
    if (m.startsWith("dlna:")) {
      const id = m.slice("dlna:".length);
      return id ? { kind: "dlna", id } : null;
    }
    return { kind: "dlna", id: m };
  },
}));

// ===========================================================================
// ④ BridgeSessionManager:同 deviceId 二次 prepare 拆旧 + flag 门控
// ===========================================================================

let pathSeq = 0;
function qaSocketPath(): string {
  const dir = path.join(os.tmpdir(), "mfab-qa3");
  mkdirSync(dir, { recursive: true });
  return path.join(dir, `s-${process.pid}-${pathSeq++}.sock`);
}

describe("QA④ BridgeSessionManager 同 deviceId 拆旧 + flag 门控", () => {
  it("同 deviceId 二次 prepare → 旧 socket 文件被摘、list().length===1、新会话独立路径", async () => {
    const mgr = new BridgeSessionManager();
    const p1 = qaSocketPath();
    const p2 = qaSocketPath();

    await mgr.prepare({ deviceId: "dev-qa", token: "t1", protocol: "raop", socketPath: p1, dry: true });
    expect(mgr.list()).toHaveLength(1);
    expect(mgr.has("dev-qa")).toBe(true);
    expect(existsSync(p1)).toBe(true);

    await mgr.prepare({ deviceId: "dev-qa", token: "t2", protocol: "raop", socketPath: p2, dry: true });
    expect(mgr.list()).toHaveLength(1); // 旧会话已拆,恰 1 座
    expect(mgr.list()[0]!.deviceId).toBe("dev-qa");
    expect(mgr.list()[0]!.socketPath).toBe(p2);
    expect(existsSync(p1)).toBe(false); // 旧 listener 已 close + unlink
    expect(existsSync(p2)).toBe(true);

    await mgr.stop("t2");
    expect(mgr.list()).toHaveLength(0);
    expect(mgr.has("dev-qa")).toBe(false);
  }, 15000);

  it("不同 token 的 stop:未知 token 幂等;stopAll 清全部", async () => {
    const mgr = new BridgeSessionManager();
    await mgr.prepare({ deviceId: "d1", token: "t1", protocol: "raop", socketPath: qaSocketPath(), dry: true });
    await mgr.prepare({ deviceId: "d2", token: "t2", protocol: "raop", socketPath: qaSocketPath(), dry: true });
    expect(mgr.list()).toHaveLength(2);
    await mgr.stop("nope"); // 未知 token 幂等
    expect(mgr.list()).toHaveLength(2);
    await mgr.stopAll();
    expect(mgr.list()).toHaveLength(0);
  }, 15000);

  it("isAirplayBridgeEnabled:=0 关死,未设/其他值开(默认开)", () => {
    process.env.MUSICFLOW_AIRPLAY_BRIDGE = "0";
    expect(isAirplayBridgeEnabled()).toBe(false);
    process.env.MUSICFLOW_AIRPLAY_BRIDGE = "1";
    expect(isAirplayBridgeEnabled()).toBe(true);
    delete process.env.MUSICFLOW_AIRPLAY_BRIDGE;
    expect(isAirplayBridgeEnabled()).toBe(true);
  });
});
