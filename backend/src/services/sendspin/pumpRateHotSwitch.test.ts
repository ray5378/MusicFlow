// 倍速热切换(GroupPump.switchRate):运行中改速**不重建泵 / 不换代 / ts 逐帧接续**。
//
// 判据源自 docs/倍速无缝切换-设计方案-20261125.md §8.1(单测 1/3/4/5/6/8/9)。
// 注入源走 lavfi 合成正弦(无 DB、无固件);推流节奏设为 4x 让循环快速推进,
// 同时保证「建窗期间前沿推进量」远小于 ready() 的 2s 预缓冲 —— 否则 seekTo 未命中
// 会走「放弃热换」分支(那是真机降级路径,不是本用例要验的主路径)。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  GroupPump,
  overridePumpSource,
  pumpFor,
  stopGroupPump,
  type GroupAudio,
} from "./streamEngine.js";
import { setPlaybackRateCore } from "./playerCore.js";
import { PcmWindow } from "./streamSource.js";

const SPEED = "4";
/** 一帧的微秒数(48k / 25ms):ts 相邻差必须恒等于它,出现别的值就是重锚跳变。 */
const FRAME_US = 25_000;

let oldSpeed: string | undefined;
const opened: PcmWindow[] = [];

/** 注入源:**从 0 建窗 + `seekTo` 定位**,不用 `-ss` 建窗。
 *
 *  为什么不给 `-ss`:lavfi 生成源对 `-ss` 的跳段支持不可靠(240 实测直接 EOF、零样本
 *  —— 诊断表现为「窗口基准 == 已解」)。而本用例验的是**泵的换源/重锚逻辑**,ffmpeg
 *  的真实 `-ss` 精度由 `streamSource.test.ts`(真实 wav fixture)覆盖。
 *  改走「0 起建窗 + ready(已解 2s 输出轴)+ seekTo 定位」:目标必然落在已解区间内,
 *  命中路径只改下标、零成本,不重起 ffmpeg。
 *
 *  `failOnCall` 用于造「建窗失败」用例。 */
function makeSource(failOnCall?: number, delayOnCall?: number, delayMs = 800) {
  let calls = 0;
  return async (songId: string, startMs = 0, opts?: { speed?: number }): Promise<GroupAudio> => {
    calls += 1;
    if (failOnCall !== undefined && calls === failOnCall) {
      throw new Error(`注入故障:第 ${calls} 次取源失败`);
    }
    const speed = opts?.speed ?? 1;
    const w = new PcmWindow(
      {
        input: "sine=frequency=440:duration=600:sample_rate=48000",
        inputFormat: "lavfi",
        ...(speed !== 1 ? { speed } : {}),
      },
      0,
      { meta: { songId } },
    );
    opened.push(w);
    await w.ready();
    // 「建窗慢」:真机 2026-11-25 远程源 + loudnorm 收敛实测 9.7s。放在 ready **之后**,
    // 这样 await 返回时推送前沿已经跑掉(delayMs × SENDSPIN_PUSH_SPEED 的内容秒)。
    if (delayOnCall !== undefined && calls === delayOnCall) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
    if (startMs > 0) {
      const respawned = await w.seekTo(startMs);
      if (respawned) await w.ready();
    }
    return { pcm: new Float32Array(0), durationMs: 600_000, stream: w };
  };
}

/** 最小组桩:记录**每一帧的时间戳**(ts 接续的唯一观测面)与桥代次调用。 */function stubGroup() {
  const frames: bigint[] = [];
  const notify: unknown[][] = [];
  const group: any = {
    name: "ug:test",
    positionMs: 0,
    timelineBaseUs: 0n,
    current: { songId: "s", durationMs: 0 },
    audibleStarted: false,
    displaySongId: "",
    displayLeadMs: 0,
    displayPositionMs: 0,
    displayDepthMs: null,
    commonSendAheadUs: () => 800_000,
    hasBridges: () => false,
    hasDirectMembers: () => true,
    notifyBridgeGeneration: (...a: unknown[]) => { notify.push(a); },
    async pushFrame(ts: bigint, pcm: Float32Array) {
      frames.push(ts);
      return Math.floor(pcm.length / 2);
    },
  };
  // ⚠️ logSafe 的调用形态是 `server.log(level, msg)`(不是 `server.log.info(msg)`)。
  //   写错成对象会让所有诊断被日志层的 try/catch 吞掉 —— 单测里就再也看不到拒绝原因。
  const server: any = {
    log: (level: string, msg: string) => {
      if (process.env.RATE_TEST_VERBOSE === "1") console.log(`[${level}] ${msg}`);
    },
  };
  return { group, frames, notify, server };
}

async function waitFor(cond: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - t0 > ms) throw new Error(`等待超时(${what})`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("GroupPump.switchRate 倍速热切换", () => {
  beforeEach(() => {
    oldSpeed = process.env.SENDSPIN_PUSH_SPEED;
    process.env.SENDSPIN_PUSH_SPEED = SPEED;
  });

  afterEach(() => {
    if (oldSpeed === undefined) delete process.env.SENDSPIN_PUSH_SPEED;
    else process.env.SENDSPIN_PUSH_SPEED = oldSpeed;
    overridePumpSource(null);
    for (const w of opened.splice(0)) { try { w.close(); } catch { /* ignore */ } }
  });

  it("运行中改速:泵不换代、不触发桥代次、ts 逐帧接续、内容位置不倒退", async () => {
    overridePumpSource(makeSource());
    const { group, frames, notify, server } = stubGroup();
    const pump = new GroupPump(server, group);
    await pump.play("song-a");
    await waitFor(() => frames.length >= 8, 30_000, "起播推帧");

    const epoch0 = (pump as any).epoch;
    const reseed0 = (pump as any).timelineReseed;
    const notify0 = notify.length;
    const nBefore = frames.length;
    const contentBefore = (pump as any).playCursorMs * pump.playbackRate;

    expect(await pump.switchRate(1.5)).toBe(true);
    await waitFor(
      () => pump.playbackRate === 1.5 && (pump as any).pendingSwap === null,
      30_000,
      "换源提交",
    );
    await waitFor(() => frames.length >= nBefore + 6, 30_000, "换源后继续推帧");

    // ① 同一个泵:epoch / timelineReseed 均未变 —— 它们一变桥就换代 = 断点(§4.4)
    expect((pump as any).epoch).toBe(epoch0);
    expect((pump as any).timelineReseed).toBe(reseed0);
    // ② 不触发桥代次钩子(no stream/start|clear|end 的等价断言)
    expect(notify.length).toBe(notify0);
    expect(pump.active).toBe(true);

    // ③ 内容位置绝不倒退:倒退即「把已推给设备的音频再推一遍」(§4.2 的 C1 取点)
    const contentAfter = (pump as any).playCursorMs * pump.playbackRate;
    expect(contentAfter).toBeGreaterThanOrEqual(contentBefore - 1);

    // ④ 时间戳逐帧接续:相邻差恒为一帧,出现别的值即时间轴被重锚
    const bad: number[] = [];
    for (let k = 1; k < frames.length; k++) {
      const d = Number(frames[k] - frames[k - 1]);
      if (d !== FRAME_US) bad.push(d);
    }
    expect(bad.length, `时间戳出现非等距跳变(前5个): ${JSON.stringify(bad.slice(0, 5))}`).toBe(0);

    // ⑤ 旧窗口必须**立刻**关闭:提交后 `this.window` 已指向新窗口,旧对象再无引用,
    //   不关就是一条孤儿 ffmpeg 陪跑到曲末(240 真机实测:改速后 `ps` 里 1x 与 1.5x
    //   两条解码进程并存,各吃一份 CPU/IO)。
    expect((opened[0] as any).closed, "旧窗口未关闭 ⇒ ffmpeg 泄漏").toBe(true);

    pump.stop();
  });

  it("建窗失败:返回 false、倍率与时间轴不变、泵继续推流", async () => {
    overridePumpSource(makeSource(2)); // 第 2 次取源 = 热换源那次,抛错
    const { group, frames, server } = stubGroup();
    const pump = new GroupPump(server, group);
    await pump.play("song-b");
    await waitFor(() => frames.length >= 5, 30_000, "起播推帧");

    const cursor0 = (pump as any).playCursorMs;
    const nBefore = frames.length;

    expect(await pump.switchRate(1.5)).toBe(false);
    expect(pump.playbackRate).toBe(1);
    expect((pump as any).playCursorMs).toBeGreaterThanOrEqual(cursor0);
    // 泵未被拖死:仍在出帧(失败必须是「原样继续」,不是「停住」)
    await waitFor(() => frames.length >= nBefore + 5, 30_000, "失败后继续推流");
    expect(pump.active).toBe(true);

    pump.stop();
  });

  it("未起播 / 同速率 / 非法值:一律返回 false(调用方据此回落整泵重投)", async () => {
    overridePumpSource(makeSource());
    const { group, server } = stubGroup();
    const pump = new GroupPump(server, group);

    expect(await pump.switchRate(1.5)).toBe(false); // 未起播

    await pump.play("song-c");
    await waitFor(() => (pump as any).running === true, 30_000, "起播");

    expect(await pump.switchRate(1)).toBe(false); // 同速率
    expect(await pump.switchRate(0)).toBe(false); // 非法
    expect(await pump.switchRate(Number.NaN)).toBe(false); // 非法
    expect(await pump.switchRate(-2)).toBe(false); // 非法

    pump.stop();
  });

  it("setPlaybackRateCore:有活泵 → true 且偏好落组;无泵/未知组 → false(绝不抛)", async () => {
    // P2 接线层的门控语义:主进程拿这个布尔决定「留泵」还是「回落整泵重投」。
    // 判断错方向的后果很具体 —— 返回 true 但实际没换,用户会「选了倍速却没变化」且无断点
    // 可察觉;返回 false 走了重投最多断一下,是安全侧。
    overridePumpSource(makeSource());
    const { group, frames, server } = stubGroup();
    const srv: any = { groups: new Map<string, any>([["ug:test", group]]), log: server.log };
    const pump = pumpFor(srv, group); // 必须走 pumpFor:peekPump 只认这张注册表
    try {
      // 未起播(泵空转):不可热换,但调用方仍拿到一个确定的 false。
      expect(await setPlaybackRateCore(srv, "ug:test", 1.5)).toBe(false);

      await pump.play("song-d");
      await waitFor(() => frames.length >= 6, 30_000, "起播推帧");

      expect(await setPlaybackRateCore(srv, "ug:test", 1.5)).toBe(true);
      // 偏好必须**立即**落组:seek 重建(playerCore 两处分派)与 poll 兜底都读它。
      expect(group.playbackRate).toBe(1.5);
      await waitFor(() => pump.playbackRate === 1.5, 30_000, "换源提交");

      // 幂等:重复设同一倍率必须回 true 且**不新建窗口**。
      // 回 false 的后果很具体:主进程会回落整泵重投 —— 明明不用改,却白断一次流
      // (240 真机 2026-11-25:重启后客户端回灌 1.5x,泵本来就是 1.5x,结果
      //  `gen=reason=track` + `newgen-skip` 白丢 984ms 音频)。
      const winCount = opened.length;
      expect(await setPlaybackRateCore(srv, "ug:test", 1.5)).toBe(true);
      expect(opened.length, "同倍率却建了新窗口").toBe(winCount);
      expect(pump.playbackRate).toBe(1.5);

      // 未注册的组名(dlna:/本机这类根本没有泵的目标在上一层就被挡掉,这里兜第二层)
      expect(await setPlaybackRateCore(srv, "ug:nope", 2)).toBe(false);
      // 没有 server(in-proc 未启动)
      expect(await setPlaybackRateCore(null, "ug:test", 2)).toBe(false);
    } finally {
      pump.stop();
      stopGroupPump(group);
    }
  });

  it("建窗慢到前沿跑掉(超过预缓冲):多轮校准仍热换成功,不许回落", async () => {
    // 真机 2026-11-25:远程源 + loudnorm 单遍收敛让「建窗 + ready」花了 9.7s,而旧流
    // 一直在推 —— 一次 seekTo 必然追不上已解前沿。上一版就在这里放弃热换回落整泵重投,
    // 于是桥换代 `reason=track` + `newgen-skip` 3777ms + 上百次 realign,正是本方案
    // 要消灭的断点。此用例把「慢建窗」钉死:必须靠多轮「重起→ready→再校准」收敛。
    overridePumpSource(makeSource(undefined, 2)); // 第 2 次取源(热换那次)追加 800ms
    const { group, frames, notify, server } = stubGroup();
    const pump = new GroupPump(server, group);
    await pump.play("song-slow");
    await waitFor(() => frames.length >= 8, 30_000, "起播推帧");

    const nBefore = frames.length;
    const notify0 = notify.length;
    expect(await pump.switchRate(1.5)).toBe(true);
    await waitFor(() => pump.playbackRate === 1.5, 60_000, "换源提交(含多轮校准)");
    await waitFor(() => frames.length >= nBefore + 6, 60_000, "换源后继续推帧");

    // 关键:仍然**不换代**(换代就是断点),且时间戳依然逐帧连续
    expect(notify.length).toBe(notify0);
    const bad: number[] = [];
    for (let k = 1; k < frames.length; k++) {
      const d = Number(frames[k] - frames[k - 1]);
      if (d !== FRAME_US) bad.push(d);
    }
    expect(bad.length, `时间戳出现非等距跳变(前5个): ${JSON.stringify(bad.slice(0, 5))}`).toBe(0);
    // 旧窗口(含多次校准重起的那个)都必须关掉:留在盘上就是孤儿 ffmpeg
    for (const w of opened.slice(0, -1)) {
      expect((w as any).closed, "旧/被弃窗口未关闭 ⇒ ffmpeg 泄漏").toBe(true);
    }

    pump.stop();
  });
});
