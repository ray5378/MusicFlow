// ==================== 泵移交(流转借流)契约 ====================
//
// 用户在流转播放里要的是「目标端**立刻**出声,且出声位置与流转前秒级对齐」。
// sendspin 是服务端**推**流:泵握有已解码窗口 + 时间线,所以「把这条流交给另一个组」
// 只需要换下发目标 —— 零额外 PCM、不多起 ffmpeg、不 seek、不预缓冲。
//
// 本文件把这条路上的**不可见不变量**逐条钉住。每一条写错都表现为「能播但听感错」,
// 不抛异常、不打错误日志,只能靠断言圈住:
//
//   ① 落点必须回退到**可听位置**,不是已推送位置
//      —— 照搬已推送位置,目标端会从"源端还排在设备缓冲里、用户还没听到"的那段开头。
//   ② 落点必须夹在 [窗口底, 已推送] 内
//      —— 低了会让 slice() 命中淘汰路径(抛 RangeError / 断流),高了等于重发同一段。
//   ③ WeakMap 的键必须真的换到目标组
//      —— 没换:源组被清理时 stopGroupPump(gFrom) 会把泵一起停掉,目标端当场哑。
//   ④ 时间线必须按**新组**重锚(timelineReseed 自增)
//      —— 不重锚,锚点还挂在旧组的 send_ahead 上,目标端持续抖动/漂移。
//   ⑤ 零重建:pump 实例、歌、窗口对象全不变(没重起 ffmpeg)
//      —— 一旦重建,"立刻出声"就没了,退化成普通起播。
//   ⑥ 判定不成立时必须**不改变现场**,调用方才能安全回退完整起播。
//
// determinism:自制长 WAV + 本地 `l:src:` 行走流式窗口,不碰外网、不碰真实曲库。
//
// ⚠️ 务必**不要**为了跑得快而加 `SENDSPIN_PUSH_SPEED`:那个开关让泵的推流速度快于
//    角色时钟,可听位置(已推送 − 缓冲深度)会被推到窗口底之下,于是 rehost 的下钳制
//    永远生效 —— 恰好把我们最想验证的「回退到可听位置」这条语义盖掉(实测:6 倍速下
//    可听位置 5.7s 却已落在窗口底 11.0s 之下,落点被抬成窗口底)。夹具必须用真实速率。
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { sqlite } from "../../src/db/index.js";
import { registerBuiltinPlugins } from "../../src/plugins/builtins.js";
import {
  pumpFor,
  peekPump,
  transferPumpTo,
  stopGroupPump,
  alignFrameMs,
  FRAME_MS,
} from "../../src/services/sendspin/streamEngine.js";
import type { GroupPump } from "../../src/services/sendspin/streamEngine.js";
import {
  armBorrowCore,
  handoverCore,
  sendspinGroupNameForPeer,
} from "../../src/services/sendspin/playerCore.js";

/** 预填充水位(ms)。落点回退的幅度直接等于它,钉住才能断言。 */
const PREFILL_MS = 1_000;
/** 等泵推到多深再动手:要留出 > PREFILL_MS + 一帧的余量,落点才不会贴到上钳制。 */
const READY_MS = 4_000;

/** 120s 440Hz 正弦 16bit 单声道 WAV(48k)。够长:整个用例期间泵不会自然播完。 */
function makeWav(seconds = 120): Buffer {
  const rate = 48000;
  const n = Math.floor(rate * seconds);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(Math.floor(28000 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + data.length, 4); head.write("WAVE", 8);
  head.write("fmt ", 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22); head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

/** 最小组桩:泵要读的成员面 + handoverCore 要写的会话语义面。 */
function groupStub(name: string) {
  const frames: bigint[] = [];
  const g: any = {
    name,
    id: name,
    positionMs: 0,
    timelineBaseUs: 0n,
    current: null as any,
    members: new Set<any>(),
    pendingAnnounces: [] as any[],
    closed: 0,
    finished: 0,
    commonSendAheadUs: () => 800_000,
    capacityLimitedPrefillMs: () => 3_000,
    add(c: any) { g.members.add(c); },
    close() { g.closed++; },
    finishPlayback() { g.finished++; },
    async pushFrame(ts: bigint, _pcm: Float32Array) { frames.push(ts); },
  };
  trackedGroups.push(g); // 失败路径上也要能被 afterEach 停掉,见 trackedGroups 注释
  return { g, frames };
}

/** 最小连接桩(handoverCore 会写 c.group、调 c.sendGroupUpdate)。 */
function connStub(clientId: string) {
  const c: any = { clientId, group: null as any, updates: 0 };
  c.sendGroupUpdate = () => { c.updates++; };
  return c;
}

function fakeServer(...groups: any[]) {
  const srv: any = { groups: new Map<string, any>() };
  for (const g of groups) srv.groups.set(g.name, g);
  return srv;
}

/** 夹具观测手段(私有字段),不是被测接口。 */
function cursorOf(pump: GroupPump): number {
  return (pump as any).playCursorMs as number;
}
function fieldOf<T>(pump: GroupPump, k: string): T {
  return (pump as any)[k] as T;
}

async function waitPushed(pump: GroupPump, minMs: number, timeoutMs: number): Promise<number> {
  const t0 = Date.now();
  for (;;) {
    const cur = cursorOf(pump);
    if (cur >= minMs) return cur;
    if (Date.now() - t0 > timeoutMs) throw new Error(`泵未推到 ${minMs}ms(当前 ${cur}ms)`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function waitNotBusy(pump: GroupPump, timeoutMs: number): Promise<void> {
  const t0 = Date.now();
  while (pump.busy) {
    if (Date.now() - t0 > timeoutMs) throw new Error("起播窗口未结束");
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** 起一个"正在播"的泵(夹具共用)。 */
async function startPlaying(srv: any, gFrom: any): Promise<GroupPump> {
  const pump = pumpFor(srv, gFrom);
  await pump.play("hs-src-song");
  await waitNotBusy(pump, 10_000);
  await waitPushed(pump, READY_MS, 20_000);
  return pump;
}

/**
 * 本用例期间起过的组 —— afterEach 一律停干净。
 *
 * 为什么必须做:一个泵在播 = 一个 PcmWindow(可达 300s PCM ≈ 115MB)。断言失败时
 * 用例会在 `stopGroupPump` 之前就抛出去,泵继续跑 → 后续用例又各起一个 → 堆爆 OOM,
 * **真实的断言信息被 OOM 盖掉**(实测:变异"不换 WeakMap 键"就是这样被掩盖的)。
 * 夹具必须在失败路径上也能收拾自己。
 */
const trackedGroups: any[] = [];

afterEach(() => {
  for (const g of trackedGroups.splice(0)) {
    try { stopGroupPump(g); } catch { /* ignore */ }
  }
});

const SRC = "hs-src";
const DST = "hs-dst";

/**
 * 身份类断言必须**只比较布尔**,不能把对象交给 `expect(actual).toBe(...)`。
 *
 * 为什么:断言失败时 vitest 会序列化 `actual` 来渲染 diff —— 而这里的 actual 可能是
 * 一个 `GroupPump` / `PcmWindow`(挂着最多 300s 的 PCM 分块,约 115MB)。序列化它直接
 * 把进程堆爆,报出来的是 `JavaScript heap out of memory` 而不是"泵没换组"这个真话。
 * (实测:变异"不换 WeakMap 键"就是这样被 OOM 掩盖的。)
 */
function expectSame(a: unknown, b: unknown): void {
  expect(a === b).toBe(true);
}

describe("泵移交(流转借流)", () => {
  let tmpDir = "";
  let wavPath = "";

  beforeAll(() => {
    if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
    // 真实速率(见文件头 ⚠️);预填充钉在 1s,让"可听位置 vs 已推送位置"的差可断言。
    process.env.SENDSPIN_PUSH_SPEED = "1";
    process.env.SENDSPIN_PREFILL_MS = String(PREFILL_MS);
    registerBuiltinPlugins();
    sqlite
      .prepare(
        "INSERT INTO plugins (id, name, enabled, config) VALUES ('core-play-preference', 'core-play-preference', 1, '{\"preferLocal\":true,\"fallbackToWeb\":true}') ON CONFLICT(id) DO UPDATE SET enabled=1, config=excluded.config",
      )
      .run();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pumphandover-"));
    wavPath = path.join(tmpDir, "long.wav");
    fs.writeFileSync(wavPath, makeWav());
    // 本地文件行:流式窗口把**路径**直接交给 ffmpeg 子进程,天然绕开 fetch(无需桩)。
    sqlite
      .prepare(
        "INSERT INTO songs (id, title, artist, type, url, plugin_entry, group_id, path, suffix, duration) VALUES " +
          "('hs-src-song','T','A','local','','','hs-fixture','l:src:" +
          wavPath.replace(/'/g, "''") +
          "','wav',120)",
      )
      .run();
  });

  afterAll(() => {
    delete process.env.SENDSPIN_PUSH_SPEED;
    delete process.env.SENDSPIN_PREFILL_MS;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---------- peerId → 组名 ----------

  it("peerId → 组名:sendspin 裸名 / 用户组加 ug: 前缀 / 其余端为 null", () => {
    expect(sendspinGroupNameForPeer("sendspin:dev-1")).toBe("dev-1");
    expect(sendspinGroupNameForPeer("group:g1")).toBe("ug:g1");
    // ⚠️ null 只表示"服务端侧没有可移交的**推送泵**",**不**代表那端不能复用服务端的
    //   解码结果 —— DLNA/客户端走 HTTP 拉流,复用它们要的是共享 PCM 窗口(buffer.ts 骨架),
    //   是另一套机制。这个区分写错会让人以为"DLNA 必须从头解码"。
    expect(sendspinGroupNameForPeer("dlna:abc")).toBeNull();
    expect(sendspinGroupNameForPeer("local:abc")).toBeNull();
    expect(sendspinGroupNameForPeer("airplay:abc")).toBeNull();
  });

  // ---------- 武装判定表(纯逻辑,不碰 ffmpeg) ----------

  it("武装判定:每一档不成立都给出可读 reason,且不成立时不留任何登记", () => {
    const { g: gFrom } = groupStub(SRC);
    const { g: gTo } = groupStub(DST);

    expect(armBorrowCore(null, DST, SRC).reason).toBe("no-server");
    // 目标组不在 —— 绝不能用 srv.group():那会凭空造一个空组,把判定糊过去
    expect(armBorrowCore(fakeServer(gFrom), DST, SRC).reason).toBe("target-group-absent");
    expect(armBorrowCore(fakeServer(gTo), DST, SRC).reason).toBe("source-group-absent");
    expect(armBorrowCore(fakeServer(gFrom), SRC, SRC).reason).toBe("source-group-absent");

    const srv = fakeServer(gFrom, gTo);
    // 源组没有泵(peekPump 不创建;用 pumpFor 会把"根本没在播"误判成"有个泵")
    expect(armBorrowCore(srv, DST, SRC).reason).toBe("source-not-playing");

    const idle = pumpFor(srv, gFrom);
    expect(armBorrowCore(srv, DST, SRC).reason).toBe("source-not-playing");

    // 在跑但在起播窗口里(半成品流,借过去会缺开头)
    (idle as any).running = true;
    (idle as any).playInFlight = true;
    expect(armBorrowCore(srv, DST, SRC).reason).toBe("source-starting");

    // 起播结束但 songId 还没落定
    (idle as any).playInFlight = false;
    (idle as any).songId = "";
    expect(armBorrowCore(srv, DST, SRC).reason).toBe("source-no-song");

    // 成立:落点取源端**可听位置**(gFrom.positionMs),不是已推送位置
    (idle as any).songId = "hs-src-song";
    gFrom.positionMs = 12_345;
    const ok = armBorrowCore(srv, DST, SRC);
    expect(ok.armed).toBe(true);
    expect(ok.songId).toBe("hs-src-song");
    expect(ok.positionMs).toBe(12_345);

    // overrideMs 优先(路由把用户显式给的起点传下来时)
    const ov = armBorrowCore(srv, DST, SRC, 7_000);
    expect(ov.armed).toBe(true);
    expect(ov.positionMs).toBe(7_000);

    stopGroupPump(gFrom);
  });

  // ---------- 真泵:transferPumpTo / rehost ----------

  it("移交:换 WeakMap 键、落点回退到可听位置、时间线按新组重锚、零重建", async () => {
    const { g: gFrom, frames: fFrom } = groupStub(SRC);
    const { g: gTo, frames: fTo } = groupStub(DST);
    const srv = fakeServer(gFrom, gTo);

    const pump = await startPlaying(srv, gFrom);

    const pumpInstance = pump;
    const songIdBefore = pump.playingSongId;
    const windowBefore = fieldOf<any>(pump, "window");
    const reseedBefore = fieldOf<number>(pump, "timelineReseed");

    const pushed = alignFrameMs(cursorOf(pump));
    const audible = gFrom.positionMs; // 可听位置 = 已推送 − 缓冲深度
    const winBase = Math.ceil((fieldOf<any>(pump, "window").baseMs as number) / FRAME_MS) * FRAME_MS;

    // 前置:这一对差值确实可观察 —— 可听位置必须严格落在 (窗口底, 已推送) 之间,
    // 否则下面的断言会退化成在验证钳制、而不是在验证"回退到可听位置"。
    expect(audible).toBeLessThan(pushed);
    expect(audible).toBeGreaterThan(winBase + PREFILL_MS / 2);

    const at = transferPumpTo(gFrom, gTo, audible);
    expect(at !== null).toBe(true);

    // ① 落点 = 可听位置对齐到帧栅格,**不是**已推送位置
    //    (容许一帧的对齐误差:rehost 内部先 Math.round 再 floor)
    expect(Math.abs(at! - alignFrameMs(audible))).toBeLessThanOrEqual(FRAME_MS);
    expect(at!).toBeLessThan(pushed);
    // ② 不越过窗口底(否则 slice 命中淘汰路径)
    expect(at!).toBeGreaterThanOrEqual(winBase);
    // ③ WeakMap 键真的换了:源组名下再无泵,目标组名下就是同一个 pump
    expect(peekPump(gFrom) === undefined).toBe(true);
    expectSame(peekPump(gTo), pumpInstance);
    // ④ 时间线按新组重锚;旧组时间线上游作废
    expect(fieldOf<number>(pump, "timelineReseed")).toBe(reseedBefore + 1);
    expect(gFrom.timelineBaseUs).toBe(0n);
    // ⑤ 零重建:pump 实例 / 歌 / 窗口对象一模一样(没重起 ffmpeg、没重建窗口)
    expect(fieldOf<string>(pump, "songId")).toBe(songIdBefore);
    expectSame(fieldOf<any>(pump, "window"), windowBefore);
    // 上报下界同步到落点:目标端 UI/歌词立刻显示正确位置
    expect(gTo.positionMs).toBe(at);
    expect(fieldOf<number>(pump, "reportedFloorMs")).toBe(at);

    // 移交之后音频只喂**新组**
    const fFromAt = fFrom.length;
    const fToAt = fTo.length;
    await new Promise((r) => setTimeout(r, 400));
    expect(fTo.length).toBeGreaterThan(fToAt);
    expect(fFrom.length).toBe(fFromAt);

    stopGroupPump(gTo);
  }, 40_000);

  it("落点钳制:要 0 秒抬到窗口底,要未来位置落在已推送", async () => {
    const { g: gFrom } = groupStub(SRC);
    const { g: gTo } = groupStub(DST);
    const srv = fakeServer(gFrom, gTo);
    const pump = await startPlaying(srv, gFrom);

    // 下钳制:真实淘汰在短夹具里不触发(窗口底恒 0),把 baseMs 顶到已推送下方一个
    // 已知位置,直接钉住「要的位置低于窗口底 → 抬到窗口底」这条契约(它是 slice() 的生命线)。
    const pushed = alignFrameMs(cursorOf(pump));
    const fakeBase = pushed - 2_000; // 已是 25ms 的整数倍
    const w: any = fieldOf<any>(pump, "window");
    Object.defineProperty(w, "baseMs", { get: () => fakeBase, configurable: true });
    try {
      const low = transferPumpTo(gFrom, gTo, 0);
      expect(low).toBe(fakeBase);
    } finally {
      delete w.baseMs; // 还原原型上的 getter,别把推流循环搞坏
    }

    // 上钳制:要一个远在未来的位置 —— 落在已推送(否则等于把同一段重发一遍)
    const pushedNow = alignFrameMs(cursorOf(pump));
    const high = transferPumpTo(gTo, gFrom, pushedNow + 60_000);
    expect(high !== null && high >= pushedNow).toBe(true);
    // 同一拍内不会被推进,故可以和调用后的游标精确对上
    expectSame(high, alignFrameMs(cursorOf(pump)));

    stopGroupPump(gFrom);
  }, 40_000);

  it("同组自移交 / 无泵可移交:返回 null(调用方据此回退完整起播)", () => {
    const { g: gFrom } = groupStub(SRC);
    const { g: gTo } = groupStub(DST);
    const srv = fakeServer(gFrom, gTo);
    expect(transferPumpTo(gFrom, gFrom, 0)).toBeNull();
    expect(transferPumpTo(gFrom, gTo, 0)).toBeNull();
    expect(peekPump(gTo) === undefined).toBe(true);
  });

  // ---------- handoverCore:会话语义 + 现场不变量 ----------

  it("handoverCore:目标组就位、源组收尾、成员先挂后搬泵(宣告先于音频)", async () => {
    const { g: gFrom } = groupStub(SRC);
    const { g: gTo, frames: fTo } = groupStub(DST);
    // 目标组残留旧现场:必须被清干净,否则新旧两泵并存 = 双流
    const stale = connStub("stale-dev");
    stale.group = gTo;
    gTo.members.add(stale);
    gTo.current = { songId: "old-song" };
    const srv = fakeServer(gFrom, gTo);

    const pump = await startPlaying(srv, gFrom);

    const member = connStub("dev-target");
    const item: any = {
      songId: "hs-src-song",
      title: "T",
      artist: "A",
      album: "B",
      coverArt: "",
      mime: "audio/flac",
      duration: 120,
    };

    const armed = armBorrowCore(srv, DST, SRC);
    expect(armed.armed).toBe(true);
    const spec = { fromGroup: SRC, positionMs: armed.positionMs!, songId: armed.songId! };

    const r = handoverCore(srv, spec, DST, item, [member]);
    expect(r.ok).toBe(true);
    expect(r.positionMs).toBeGreaterThan(0);
    expect(r.positionMs).toBe(fieldOf<number>(pump, "reportedFloorMs"));

    // ③ 泵归目标组
    expect(peekPump(gFrom) === undefined).toBe(true);
    expectSame(peekPump(gTo), pump);
    // 目标组旧现场已清(stopGroupPump 只停音频生产,不碰队列)
    expect(gTo.closed).toBeGreaterThan(0);
    expect(gTo.finished).toBeGreaterThan(0);
    // 新成员已挂进目标组,c.group 指向它
    expect(gTo.members.has(member)).toBe(true);
    expect(member.group).toBe(gTo);
    // 成员收到组更新,且排进了待宣告队列 —— 顺序铁律:必须在搬泵**之前**排好,
    // 否则 pushFrame 指向新组时没有可兑现的宣告,设备会把首帧当"无流数据"丢掉。
    expect(member.updates).toBeGreaterThan(0);
    expect(gTo.pendingAnnounces).toContain(member);
    // 目标组 current 已换成流转过来的这首
    expect(gTo.current?.songId).toBe("hs-src-song");
    // 源组已收尾
    expect(gFrom.current).toBeNull();
    expect(gFrom.finished).toBeGreaterThan(0);
    expect(gFrom.closed).toBeGreaterThan(0);

    // 音频继续流向新组
    const before = fTo.length;
    await new Promise((r) => setTimeout(r, 400));
    expect(fTo.length).toBeGreaterThan(before);

    stopGroupPump(gTo);
  }, 40_000);

  it("handoverCore 判定不成立时**不改变现场**(调用方才能安全回退完整起播)", async () => {
    const { g: gFrom } = groupStub(SRC);
    const { g: gTo } = groupStub(DST);
    const srv = fakeServer(gFrom, gTo);
    const pump = await startPlaying(srv, gFrom);

    const cursorBefore = cursorOf(pump);
    const reseedBefore = fieldOf<number>(pump, "timelineReseed");
    const member = connStub("dev-x");

    // 歌对不上(武装之后源端被换了歌):必须原样返回,泵仍归源组、没有被搬走
    const bad = { fromGroup: SRC, positionMs: 5_000, songId: "some-other-song" };
    const r = handoverCore(srv, bad, DST, { songId: "some-other-song" } as any, [member]);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("song-mismatch");
    expectSame(peekPump(gFrom), pump);
    expect(peekPump(gTo) === undefined).toBe(true);
    expect(fieldOf<number>(pump, "timelineReseed")).toBe(reseedBefore);
    // 游标没有被改写(没有偷偷 rehost 到目标组)
    expect(cursorOf(pump)).toBeGreaterThanOrEqual(cursorBefore);
    // 目标组一个字节都没多出来
    expect(gTo.members.size).toBe(0);
    expect(member.group).toBeNull();
    expect(gTo.finished).toBe(0);
    expect(gTo.closed).toBe(0);

    stopGroupPump(gFrom);
  }, 40_000);
});
