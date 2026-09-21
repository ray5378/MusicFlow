// 锁死对象:`GroupPump.seek` 的**时间轴重锚**(pacing 基准 + 时间戳锚点)。
//
// 回归现象:「sendspin 拖动进度条后无法播放」—— 位置改了、pump 还活着、就是不出声。
//
// 机理:`pushLoop` 的排程是 `dueMs = paceWallMs0 + i*FRAME_MS/speed`,而 `i` 由
// `positionMs` 算出。seek 改写 positionMs → `i` 跳变;旧实现**没有重设 paceWallMs0**,
// 于是向前拖 40s 时 dueMs 落到 40s 之后 → 主循环 `await sleep(40s)` 静默空转。
// 用户观感:拖动后彻底无声(且没有任何报错)。
//
// 本用例把这条钉死:向前 seek 后必须在很短时间内继续出新帧。
// 用整包 PCM(不带 stream)注入 —— 避开 ffmpeg 重起的耗时抖动,只测 pacing 本身。
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { GroupPump, overridePumpSource, type GroupAudio } from "./streamEngine.js";
import { SAMPLE_RATE, CHANNELS } from "./encoding.js";

const SONG_SEC = 60;

let oldSpeed: string | undefined;

beforeEach(() => {
  oldSpeed = process.env.SENDSPIN_PUSH_SPEED;
  // 显式锁 1 倍速:本用例的判据是「seek 后多久出新帧」,倍速会直接放大/缩小该值。
  delete process.env.SENDSPIN_PUSH_SPEED;
});

afterEach(() => {
  overridePumpSource(null);
  if (oldSpeed === undefined) delete process.env.SENDSPIN_PUSH_SPEED;
  else process.env.SENDSPIN_PUSH_SPEED = oldSpeed;
});

/** 整包静音 PCM(不带 stream → 走 `pcm.subarray` 路径,seek 零成本,无 ffmpeg)。 */
function injectSilencePcm(seconds: number): GroupAudio {
  const pcm = new Float32Array(seconds * SAMPLE_RATE * CHANNELS);
  return { pcm, durationMs: seconds * 1000 };
}

function stubGroup() {
  const frames: bigint[] = [];
  const group: any = {
    name: "seek-test-group",
    positionMs: 0,
    timelineBaseUs: 0n,
    current: { songId: "s", durationMs: SONG_SEC * 1000 } as any,
    commonSendAheadUs: () => 800_000,
    async pushFrame(ts: bigint, pcm: Float32Array) {
      frames.push(ts);
      return Math.floor(pcm.length / CHANNELS);
    },
  };
  return { group, frames };
}

async function waitFrames(frames: bigint[], target: number, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (frames.length < target) {
    if (Date.now() - t0 > ms) throw new Error(`等新帧超时(${what}):已 ${frames.length} 帧,期望 ≥ ${target}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("GroupPump seek 后时间轴重锚", () => {
  it("向前跳转后立刻继续按节奏出帧(旧实现会睡掉整个跳转距离)", async () => {
    overridePumpSource(async () => injectSilencePcm(SONG_SEC));
    const { group, frames } = stubGroup();
    const pump = new GroupPump({ log() {} } as any, group);
    await pump.play("seek-forward");

    await waitFrames(frames, 5, 5_000, "起播");
    const before = frames.length;

    // 向前跳 40s(留在 60s 内容内,避免触发自然结束)。
    // 旧实现:dueMs = 起播基准 + 40000ms → 主循环睡 ~40s。
    // ⚠️ 判据必须等**多帧**而不能只等 1 帧 —— seek 是从测试线程插进去的,
    // 主循环此刻正睡在"上一帧的 due 时刻"上,醒来后还会再推 1 帧才落进 40s 的睡眠,
    // 于是"等 1 帧"会被这一帧假性满足(本用例第一版就是这么漏掉回归的)。
    // 1 倍速 = 40 帧/秒,10 帧只需 ~250ms;旧实现连第 2 帧都出不来。
    pump.seek(40);
    expect(group.positionMs).toBe(40_000);

    await waitFrames(frames, before + 10, 2_000, "seek 之后按节奏出帧");
    pump.stop();
    expect(frames[frames.length - 1] > frames[0]).toBe(true); // 时间戳仍单调
  }, 20_000);

  it("向后跳转后不会失去节流(时间戳不得倒退,也不得无节制倒灌)", async () => {
    overridePumpSource(async () => injectSilencePcm(SONG_SEC));
    const { group, frames } = stubGroup();
    const pump = new GroupPump({ log() {} } as any, group);
    await pump.play("seek-back");

    // 先跑到 5s 之后(靠 1 倍速真实推进,等足够帧数即可)
    await waitFrames(frames, 220, 15_000, "跑到 5s");
    const framesAtSeek = frames.length;

    pump.seek(1);
    expect(group.positionMs).toBe(1_000);
    // 回跳后 300ms 内应产出 ~12 帧(1 倍速)。
    // 旧实现:pacing 基准不动 → dueMs 全部落在过去 → delayMs≤0 → 无 sleep 连发,
    // 300ms 内能倒灌上千帧(瞬间灌爆设备环形缓冲)。
    await new Promise((r) => setTimeout(r, 300));
    const produced = frames.length - framesAtSeek;
    expect(produced).toBeGreaterThan(2);       // 确实在出帧(没停摆)
    expect(produced).toBeLessThan(60);         // 但仍在节流(没倒灌)

    // 时间戳仍然单调 —— 回跳只换内容,不推翻时间轴(否则设备端按时间戳排程会失序)。
    // 收集全部违例再断言:只报「第一处」在排查时信息量太小(需要知道是 seek 边界
    // 还是稳态,以及倒退量级)。
    const regressions: string[] = [];
    for (let i = 1; i < frames.length; i++) {
      if (!(frames[i] > frames[i - 1])) {
        regressions.push(`#${i}: ${frames[i]} <= ${frames[i - 1]} (Δ=${frames[i] - frames[i - 1]}us)`);
      }
    }
    expect(
      regressions,
      `时间戳非单调(共 ${regressions.length} 处 / 总 ${frames.length} 帧,seek 边界序号≈${framesAtSeek}): ` +
        regressions.slice(0, 5).join(" | "),
    ).toEqual([]);
    pump.stop();
  }, 25_000);
});

// 240 真机实测复现的那一类:用户在「刚点播、音频还没出声」的窗口里拖动进度条。
// 此时 play() 正卡在 `await source(...)`(spawn ffmpeg + 预缓冲,实测数秒),
// pump 已存在但 running=false —— 旧实现把 positionMs 归零,那次拖动被整条吞掉:
// 接口返回 success、[pump][seek] 日志也打了,但音频从 0 开始播(观感「拖动无效」)。
describe("GroupPump 起播窗口内的 seek", () => {
  it("play() 解码/预缓冲期间的 seek 必须成为起播位置,而不是被归零", async () => {
    let sourceResolved = false;
    overridePumpSource(async () => {
      // 模拟真实起播耗时(ffmpeg spawn + 2s 预缓冲按下限取 400ms,够插入 seek)。
      await new Promise((r) => setTimeout(r, 400));
      sourceResolved = true;
      return injectSilencePcm(SONG_SEC);
    });
    const { group, frames } = stubGroup();
    const pump = new GroupPump({ log() {} } as any, group);

    const playing = pump.play("seek-during-start");
    // 等 play() 进入 await(仍 running=false),此刻插入拖动。
    await new Promise((r) => setTimeout(r, 80));
    expect(sourceResolved).toBe(false);
    expect(pump.active).toBe(false);
    pump.seek(20);

    await playing;
    // 关键断言:起播位置落在拖动目标上,绝不是 0。
    // (不断言 `toBe(20_000)`:play() 里 `void pushLoop()` 会同步跑完首帧到第一个 await,
    //  所以 play() 返回时 positionMs 已推进一个 FRAME_MS —— 断言只需钉住"起点≈目标"。)
    expect(group.positionMs).toBeGreaterThanOrEqual(20_000);
    expect(group.positionMs).toBeLessThan(20_100);
    const atStart = group.positionMs;
    await waitFrames(frames, 3, 5_000, "起播后出帧");
    // 且推流确实从 20s 之后继续推进(不是从头开始)。
    expect(group.positionMs).toBeGreaterThan(atStart);
    pump.stop();
  }, 20_000);
});
