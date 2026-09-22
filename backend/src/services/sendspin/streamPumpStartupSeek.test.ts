// 锁死:起播窗口内到达的 seek 必须**单飞**。
//
// 回归现象(240 日志 12:31 实锤):「刚切歌 1s 内拖进度条」→ 位置发布正确、拖动看似生效,
// 但**不出声**:两个 play 并发(一个消费 pendingSeek、seekCore 又走「完整起播路径重建」),
// 各自 ++epoch 后回来验世代 → 互掐对方**刚建好**的窗口 → 存活的 pump 拿到
// `eof=true / decoded == baseSample` 的零输出窗口 → 判成播完退出 → IDLE →
// 15s stalled → 从 0 重投 → 位置冻结 → **放行切歌**(整首歌被跳过)。
// ⚠️ 该故障在 A/E 都未部署的 v4.0.12 原生版本上就出现过,属存量缺陷。
//
// 两条锁:
//   ① `seekCore` 在 pump 处于起播中(`busy`)时**只记起播位置**,不再起第二个 play;
//   ② `play()` 在 `await source()` 回来后若发现起播期间来了新 seek,关掉刚建的窗口、
//      **带新起点重来一次**(音源必须以新起点被重新取一次)。
// 音源用 `overridePumpSource` 注入,避开 ffmpeg / DB,只观察取音源的入参与次数。
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { GroupPump, pumpFor, overridePumpSource, type GroupAudio } from "./streamEngine.js";
import { seekCore } from "./playerCore.js";
import { SAMPLE_RATE, CHANNELS } from "./encoding.js";

const SONG_SEC = 60;

beforeEach(() => {
  // 本用例的判据是「取了几次音源、起点是多少」,倍速会放大推流节奏、与判据无关。
  delete process.env.SENDSPIN_PUSH_SPEED;
});

afterEach(() => {
  overridePumpSource(null);
});

/** 整包静音 PCM(不带 stream):无 ffmpeg,用例只关心取音源的入参序列。 */
function silence(seconds = SONG_SEC): GroupAudio {
  return { pcm: new Float32Array(seconds * SAMPLE_RATE * CHANNELS), durationMs: seconds * 1000 };
}

/** 最小 server/group 替身:`seekCore` 只用到 `srv.group(id)`、`group.current` 与推流面。 */
function stubServer() {
  const group: any = {
    name: "startup-seek-group",
    positionMs: 0,
    timelineBaseUs: 0n,
    current: {
      songId: "s",
      title: "t",
      artist: "a",
      album: "b",
      coverArt: "",
      mime: "",
      durationMs: SONG_SEC * 1000,
    },
    commonSendAheadUs: () => 800_000,
    async pushFrame(_ts: bigint, pcm: Float32Array) {
      return Math.floor(pcm.length / CHANNELS);
    },
  };
  const srv: any = { log() {}, clients: new Map(), group: () => group };
  return { srv, group };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("起播窗口内的 seek(单飞 + 自纠)", () => {
  it("起播中拖动:不起第二个 play,由 in-flight play 带新起点重来一次", async () => {
    const starts: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    overridePumpSource(async (_songId, startMs) => {
      starts.push(startMs ?? 0);
      if (starts.length === 1) await gate; // 首次起播卡在取音源 = 正处起播窗口
      return silence();
    });

    const { srv, group } = stubServer();
    // ⚠️ 必须经 `pumpFor` 取池内实例 —— `seekCore` 内部就是 `pumpFor(srv, g)`,
    // 直接 `new GroupPump` 会拿到另一个 pump,busy 恒 false,守卫形同虚设。
    const pump = pumpFor(srv, group);

    const firstPlay = pump.play("s");
    await tick();
    expect(pump.busy).toBe(true);
    expect(starts).toEqual([0]);

    // 起播窗口内拖动到 40s
    seekCore(srv, "dev-1", 40);
    await tick();
    // ① 关键断言:seekCore **没有**再起一个 play(旧实现这里会变成 [0, 40000] 两个并发)
    expect(starts).toEqual([0]);

    release();
    await firstPlay;
    // ② in-flight play 自纠:带新起点重新取一次音源
    expect(starts).toEqual([0, 40_000]);
    expect(pump.busy).toBe(false);
    // 起播位置已按新起点发布(pushLoop 起了头,故允许已经推进了一帧)。
    expect(group.positionMs).toBeGreaterThanOrEqual(40_000);
    pump.stop();
  }, 20_000);

  it("起播期间没有新 seek:音源只取一次(不得无谓重来)", async () => {
    const starts: number[] = [];
    overridePumpSource(async (_songId, startMs) => { starts.push(startMs ?? 0); return silence(); });
    const { srv, group } = stubServer();
    const pump = new GroupPump(srv, group);
    await pump.play("s");
    expect(starts).toEqual([0]);
    expect(pump.busy).toBe(false);
    pump.stop();
  }, 20_000);

  it("stop() 打断起播:busy 必须立即清(否则后续 seek 全被跳过)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    overridePumpSource(async () => { await gate; return silence(); });
    const { srv, group } = stubServer();
    const pump = new GroupPump(srv, group);

    const p = pump.play("s");
    await tick();
    expect(pump.busy).toBe(true);

    pump.stop();
    expect(pump.busy).toBe(false);

    release();
    await p; // 被 stop 打掉世代的 play 走 supersede 分支直接返回
    expect(pump.busy).toBe(false);
  }, 20_000);

  it("取音源失败:busy 必须清(否则后续 seek 全被跳过)", async () => {
    overridePumpSource(async () => { throw new Error("boom"); });
    const { srv, group } = stubServer();
    const pump = pumpFor(srv, group);
    await expect(pump.play("s")).rejects.toThrow("boom");
    expect(pump.busy).toBe(false);
  }, 20_000);
});

describe("起播窗口内 seek 的两个收口(钳制用哪首歌的时长 / 源行复用)", () => {
  it("按**新歌**时长收口:不得沿用上一首的时长,也不得放行超尾位置", async () => {
    const starts: number[] = [];
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    overridePumpSource(async (_songId, startMs) => {
      starts.push(startMs ?? 0);
      calls++;
      if (calls === 1) return silence(60); // 上一首 60s:正常提交,durationMs 记成 60000
      if (calls === 2) { await gate; return silence(140); } // 新歌 140s:卡在取音源 = 起播窗口
      return silence(140);
    });
    const { srv, group } = stubServer();
    const pump = pumpFor(srv, group);

    await pump.play("old");
    expect(starts).toEqual([0]);
    pump.stop(); // 停旧歌:清 pendingSeekMs,但 durationMs 仍留在 60000
    const p = pump.play("s");
    await tick();
    expect(pump.busy).toBe(true);

    // 起播窗口内拖到 200s(超过新歌 140s)
    seekCore(srv, "dev-1", 200);
    await tick();
    release();
    await p;

    // 起点必须是新歌时长 140s:沿用上一首 → 60000;完全不钳制 → 200000。
    expect(starts).toEqual([0, 0, 140_000]);
    pump.stop();
  }, 20_000);

  it("自纠重来复用**刚拿到**的源行(不重跑播放优选)", async () => {
    const preferSeen: (string | undefined)[] = [];
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    overridePumpSource(async (_songId, _startMs, opts) => {
      calls++;
      preferSeen.push(opts?.preferRowId);
      if (calls === 1) await gate;
      return { ...silence(140), sourceRowId: "row-A" };
    });
    const { srv, group } = stubServer();
    const pump = pumpFor(srv, group);

    const p = pump.play("s");
    await tick();
    seekCore(srv, "dev-1", 40);
    await tick();
    release();
    await p;

    // 首次无记账 → 不复用;重来那轮必须带上**刚拿到**的 row-A(否则白跑一次完整优选)。
    expect(preferSeen).toEqual([undefined, "row-A"]);
    pump.stop();
  }, 20_000);

  it("seek(..., {clamp:false}) 按原始位置发布;默认按当前时长钳制", async () => {
    overridePumpSource(async () => silence(60));
    const { srv, group } = stubServer();
    const pump = pumpFor(srv, group);
    await pump.play("s");
    pump.seek(200);
    expect(group.positionMs).toBe(60_000);
    pump.seek(200, { clamp: false });
    expect(group.positionMs).toBe(200_000);
    pump.stop();
  }, 20_000);
});
