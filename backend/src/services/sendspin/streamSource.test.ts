// PcmWindow 滑动窗口单测:对拍整包解码 / seek 窗口内外 / EOF / 杀进程无残留 / 背压界。
// 全部走真实 ffmpeg(ffmpeg-static),无 mock —— 与 encoding.test.ts 同策略。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { PcmWindow, WindowClosedError, WindowEvictedError, WINDOW_HIGH_SEC, resolveSendspinAf } from "./streamSource.js";
import { decodeToF32, ffmpegBin, SAMPLE_RATE, CHANNELS } from "./encoding.js";
import { saveAnalysis, deleteAnalysis } from "../audio/analysisStore.js";
import { parseLoudnorm } from "../audio/loudness.js";
import { db } from "../../db/index.js";
import { songs } from "../../db/schema.js";
import { eq } from "drizzle-orm";

const SR = SAMPLE_RATE;
const CH = CHANNELS;
const SPOOK = (sec: number) => Math.floor(sec * SR * CH); // 秒 → 绝对交错样本

let tmpDir = "";
let wav30 = "";
let wav120 = "";
let ref30: Float32Array | null = null;

function maxAbsDiff(a: Float32Array, b: Float32Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > m) m = d;
  }
  return m;
}

async function readAll(w: PcmWindow, step = 2400): Promise<Float32Array> {
  const parts: Float32Array[] = [];
  let total = 0;
  for (;;) {
    const seg = await w.slice(total, total + step, 10_000);
    if (seg.length === 0) break;
    parts.push(seg);
    total += seg.length;
    if (w.eof && total >= w.decoded) break;
  }
  const out = new Float32Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

async function pidDead(pid: number, ms = 5000): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    try { process.kill(pid, 0); } catch { return true; }
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcmwindow-"));
  wav30 = path.join(tmpDir, "tone-30s.wav");
  execFileSync(ffmpegBin(), [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=30:sample_rate=48000",
    "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", "-y", wav30,
  ]);
  ref30 = await decodeToF32(new Uint8Array(fs.readFileSync(wav30)));
  // 重定位代数用例需要一条**远长于背压高水位(30s)**的素材:
  // 窗口只在消费前沿之后攒 WINDOW_HIGH_SEC=30s 就 pause stdout,所以 30s 素材会被
  // 一次解完(decoded 直接到 EOF),根本拦不住 slice,断言就变成"看 ffmpeg 手速"。
  // 120s 素材下 decoded 恒定被压在 ~30s,seek 到 50s 必然是"窗口外重定位",确定可复现。
  wav120 = path.join(tmpDir, "tone-120s.wav");
  execFileSync(ffmpegBin(), [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=120:sample_rate=48000",
    "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", "-y", wav120,
  ]);
}, 60_000);

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("PcmWindow 流式对拍整包解码", () => {
  it("30s 全曲顺序读与 decodeToF32 二进制一致", async () => {
    const w = new PcmWindow({ input: wav30, loudness: { enabled: false } });
    try {
      await w.ready();
      const got = await readAll(w);
      expect(got.length).toBe(ref30!.length);
      expect(maxAbsDiff(got, ref30!)).toBeLessThan(1e-6);
    } finally {
      w.close();
    }
  }, 60_000);

  it("seek 窗口内返回 false,数据与整包同下标一致", async () => {
    const w = new PcmWindow({ input: wav30, loudness: { enabled: false } });
    try {
      await w.ready();
      await w.slice(0, 4800); // 消费 2 片,推进水位
      expect(await w.seekTo(1000)).toBe(false);
      const seg = await w.slice(SPOOK(1), SPOOK(1) + 2400);
      expect(seg.length).toBe(2400);
      expect(maxAbsDiff(seg, ref30!.subarray(SPOOK(1), SPOOK(1) + 2400))).toBeLessThan(1e-6);
    } finally {
      w.close();
    }
  }, 60_000);

  it("seek 窗口外返回 true,按 -ss 重起后绝对偏移连续", async () => {
    const w = new PcmWindow({ input: wav30, loudness: { enabled: false } });
    try {
      // 解码刚起步即跳 25s:远超已解范围,必走重起路径
      expect(await w.seekTo(25000)).toBe(true);
      await w.ready();
      const lo = SPOOK(25);
      const seg = await w.slice(lo, lo + 9600, 15_000);
      expect(seg.length).toBe(9600);
      expect(maxAbsDiff(seg, ref30!.subarray(lo, lo + 9600))).toBeLessThan(1e-6);
    } finally {
      w.close();
    }
  }, 60_000);

  it("EOF:超尾返回短片/空,EOF 标志置位", async () => {
    const w = new PcmWindow({ input: wav30, loudness: { enabled: false } });
    try {
      const all = await readAll(w);
      expect(w.eof).toBe(true);
      const tail = await w.slice(all.length - 100, all.length + 10_000);
      expect(tail.length).toBe(100);
      const past = await w.slice(all.length + 1000, all.length + 2000);
      expect(past.length).toBe(0);
    } finally {
      w.close();
    }
  }, 60_000);
});

describe("PcmWindow 输出恒 48k 立体声(P1-4)", () => {
  it("44.1k 源经链内 aresample 后输出为 48k(长度比≈48000/44100)", async () => {
    const wav44 = path.join(tmpDir, "tone-44k.wav");
    execFileSync(ffmpegBin(), [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=5:sample_rate=44100",
      "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", "-y", wav44,
    ]);
    // loudness 关掉:只验证重采样,不掺增益
    const w = new PcmWindow({ input: wav44, loudness: { enabled: false } });
    try {
      await w.ready();
      const got = await readAll(w);
      const expectLen = SPOOK(5);
      // 允许重采样边界 ±0.5% 误差
      expect(Math.abs(got.length - expectLen) / expectLen).toBeLessThan(0.005);
      // 有声(非静音):均方根显著大于 0
      let s = 0;
      for (let i = 0; i < got.length; i += 100) s += got[i] * got[i];
      expect(Math.sqrt(s / Math.ceil(got.length / 100))).toBeGreaterThan(0.05);
    } finally {
      w.close();
    }
  }, 60_000);
});

describe("PcmWindow 进程与背压", () => {  it("close 杀掉 ffmpeg、无残留,等待中 slice 抛 Closed", async () => {
    const w = new PcmWindow({ input: wav30, loudness: { enabled: false } });
    try {
      await w.ready();
      const pid = w.pid;
      expect(pid).toBeDefined();
      const pending = w.slice(SPOOK(25), SPOOK(25) + 2400, 10_000);
      w.close();
      await expect(pending).rejects.toThrow(WindowClosedError);
      expect(await pidDead(pid!, 8000)).toBe(true);
    } finally {
      w.close();
    }
  }, 30_000);

  it("不消费时解码停在高水位附近,不无限缓冲", async () => {
    const w = new PcmWindow({
      input: "sine=frequency=440:duration=300:sample_rate=48000",
      inputFormat: "lavfi",
    });
    try {
      // lavfi 合成远快于实时:无背压 3 秒能解完整首;有背压应停在 ~60s
      await new Promise((r) => setTimeout(r, 3000));
      const d1 = w.decoded;
      await new Promise((r) => setTimeout(r, 1000));
      const d2 = w.decoded;
      const cap = SPOOK(WINDOW_HIGH_SEC + 10);
      expect(d2).toBeLessThanOrEqual(cap);
      // 停滞证明(1 秒内零增长,允许管道余量):已在水位憋住而非仍在狂解
      expect(d2 - d1).toBeLessThanOrEqual(SPOOK(5));
      expect(w.bufferedBytes).toBeLessThanOrEqual((WINDOW_HIGH_SEC + 10) * SR * CH * 4);
    } finally {
      w.close();
    }
  }, 30_000);
});

describe("resolveSendspinAf 响度链决策(P1-2)", () => {
  it("逃生舱/单源关闭 → 空链(与旧命令逐字节一致)", () => {
    process.env.SENDSPIN_LOUDNESS = "0";
    try {
      expect(resolveSendspinAf({})).toEqual([]);
    } finally {
      delete process.env.SENDSPIN_LOUDNESS;
    }
    expect(resolveSendspinAf({ loudness: { enabled: false } })).toEqual([]);
  });

  it("缺省:实时 loudnorm ＋ 限制器", () => {
    const af = resolveSendspinAf({});
    expect(af.length).toBe(2);
    expect(af[0]).toContain("loudnorm=I=-14");
    expect(af[1]).toContain("alimiter=limit=-1dB");
  });

  it("有测量值走静态 volume(播过一次的本地行)", () => {
    db.insert(songs).values({
      id: "af-measured", title: "af", artist: "a", duration: 10,
      path: "/music/af.mp3", contentType: "audio/mpeg", type: "local",
    } as any).run();
    saveAnalysis("af-measured", "local", { loudnessIntegrated: -9 });
    try {
      const af = resolveSendspinAf({ rowId: "af-measured" });
      expect(af.length).toBe(2);
      expect(af[0]).toBe("volume=-5dB"); // -14 - (-9),限幅内
      expect(af[1]).toContain("alimiter");
    } finally {
      deleteAnalysis("af-measured");
      db.delete(songs).where(eq(songs.id, "af-measured")).run();
    }
  });
});

describe("PcmWindow 响度链实际生效", () => {
  it("开 loudnorm 的输出为人声响度归一(不再是直解字节)", async () => {
    // 30s 正弦直解作参照;窗口开链重读:逐样本必不同(增益已变),
    // 但能量级向 -14 LUFS 收敛且 stderr 打出 input_i(链确实在命令里)。
    const w = new PcmWindow({ input: wav30 });
    try {
      await w.ready();
      const got = await readAll(w);
      expect(got.length).toBe(ref30!.length);
      // 增益动了:逐字节不再一致
      expect(maxAbsDiff(got, ref30!)).toBeGreaterThan(1e-3);
      // 同一信号只做整体增益:归一化互相关 ≈1(形状不变,防滤镜配错)
      let dot = 0, na = 0, nb = 0;
      for (let i = 0; i < got.length; i++) {
        dot += got[i] * ref30![i]; na += got[i] * got[i]; nb += ref30![i] * ref30![i];
      }
      expect(dot / Math.sqrt(na * nb)).toBeGreaterThan(0.999);
      expect(w.stderrText()).toContain("input_i");
    } finally {
      w.close();
    }
  }, 60_000);
});

describe("stderr 尾部保留(P1-2 修复):长曲边播边测不再静默失效", () => {
  // 真 ffmpeg 攒够 128KB stderr 要**实时**播约 11 分钟(上机实测 ≈190 B/s),
  // 测试里不可能真等 —— 用一个「假 ffmpeg」直接刷 >128KB,开头放哨兵、末尾打报告,
  // 锁住「超限丢开头、末尾永远在」这个方向(旧写法有 `length < KEEP` 守卫 → 冻结在开头)。
  it("stderr 超上限后仍保留末尾的 loudnorm 报告(旧写法只能拿到流开头)", async () => {
    const fake = path.join(tmpDir, "fake-ffmpeg.sh");
    fs.writeFileSync(
      fake,
      [
        "#!/bin/sh",
        "# 开头哨兵:超限后必须被淘汰",
        'echo "HEAD_SENTINEL_SHOULD_BE_EVICTED" >&2',
        "i=0",
        'while [ $i -lt 2500 ]; do echo "padding-$i-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" >&2; i=$((i+1)); done',
        "# 末尾:loudnorm 报告(parseLoudnorm 用 lastIndexOf 找它)",
        'echo "[Parsed_loudnorm_0 @ 0x55f0] {" >&2',
        "echo '    \"input_i\" : \"-13.98\",' >&2",
        "echo '    \"input_tp\" : \"-1.31\"' >&2",
        "echo '}' >&2",
        "# 多活一会儿:避免 proc.stdin.end() 撞上已退出的进程回 EPIPE",
        "sleep 2",
        "exit 0",
      ].join("\n") + "\n",
    );
    fs.chmodSync(fake, 0o755);

    const prev = process.env.FFMPEG_PATH;
    process.env.FFMPEG_PATH = fake; // 必须在 PcmWindow 构造(spawn)之前生效
    const w = new PcmWindow({ input: path.join(tmpDir, "ignored.wav"), loudness: { enabled: false } });
    try {
      // 轮询等假进程把 stderr 写完(窗口本身 EOF/失败都无所谓,只取 stderrText)
      const deadline = Date.now() + 10_000;
      let text = "";
      while (Date.now() < deadline) {
        text = w.stderrText();
        if (text.includes("input_i")) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      // 上限仍在(不是把 stderr 全量囤着)—— streamSource.ts 的 STDERR_KEEP_BYTES = 128KB
      expect(text.length).toBeLessThanOrEqual(128 * 1024);
      expect(text.length).toBeGreaterThan(64 * 1024); // 确实攒下了很多,否则测不到「超限」这条路径
      // 丢的是**开头**
      expect(text).not.toContain("HEAD_SENTINEL_SHOULD_BE_EVICTED");
      expect(text).toContain("[Parsed_loudnorm_");
      // 末尾报告端到端可解析 —— 这正是长曲边播边测要拿的东西
      expect(parseLoudnorm(text)?.inputI).toBeCloseTo(-13.98, 2);
      expect(parseLoudnorm(text)?.inputTp).toBeCloseTo(-1.31, 2);
    } finally {
      w.close();
      if (prev === undefined) delete process.env.FFMPEG_PATH;
      else process.env.FFMPEG_PATH = prev;
    }
  }, 30_000);
});

// ==================== 重定位代数(拖动风暴回归) ====================
//
// 真机实测:连续拖动 86 次 seek 后
//   `[sendspin] sendspin pushLoop 异常终止: PcmWindow 等数超时(15000ms)`
// → running=false,进度条**永久停住**。根因:seekTo 把 decodedSamples 重置到更小值,
// 而先前发出的 slice() 还在等一个按**旧位置**算出的 hi,永远等不到 → 15s 超时外抛。
// 修法:窗口带重定位代数,在飞等待立刻失效并抛 WindowEvictedError(主循环 continue 重取)。
// ---- 亚帧错位(2026-09-22 240 事故):调用方帧栅格 vs 窗口毫秒基准的量化差 ----
//
// 现象:HA 卡片拖到 31.178s(毫秒精度)→ 子进程事件循环饿死 → 看门狗 SIGKILL →
// 无声、进度冻死;客户端拖整秒(62.00/108.00/…)却完全正常。
// 机理:pushLoop 的 `lo = floor(pos/25)*2400` 与窗口 `base = floor(pos/1000*96000)`
// 只在 pos 为 25ms 整数倍时相等,否则 lo 比 base 小最多 2399 个样本。
// 旧实现无条件 `throw WindowEvictedError` → 主循环 continue 后游标不变 → 微任务自旋。
// 修法:**只差不到一帧**时钳到 base 返回短帧(数据确实只缺开头几十个样本);
// 请求段与窗口全无交集才仍算真淘汰。
describe("PcmWindow 亚帧错位(毫秒精度 seek)", () => {
  // 31.178s:base = floor(31178*96) = 2_993_088,而帧栅格 lo = 1247*2400 = 2_992_800
  const POS_MS = 31178;
  const BASE = Math.floor((POS_MS / 1000) * SR * CH);
  const FRAME = 2400;

  it("lo 落在 base 之前不足一帧 → 钳到 base 返回短帧,绝不抛 WindowEvictedError", async () => {
    // ⚠️ 素材必须够长(wav120):起点 31.178s 已越过 wav30 的 EOF,
    //    那样窗口立刻 EOF,断言会退化成"看素材长度"而不是"看钳制行为"。
    const w = new PcmWindow({ input: wav120, loudness: { enabled: false } }, POS_MS);
    try {
      await w.ready(10_000);
      const lo = Math.floor(POS_MS / 25) * FRAME; // 2_992_800
      expect(lo).toBeLessThan(BASE); // 前提:确实错位(否则用例失去意义)
      expect(BASE - lo).toBeLessThan(FRAME);
      // 旧实现:这里 rejects WindowEvictedError → pushLoop 自旋 → 事件循环饿死。
      const seg = await w.slice(lo, lo + FRAME, 10_000);
      // 返回**剩余部分**(从 base 起),内容取自窗口自己的数据,长度=FRAME-(base-lo)。
      expect(seg.length).toBe(FRAME - (BASE - lo));
      expect(seg.length).toBeGreaterThan(0);
    } finally {
      w.close();
    }
  }, 30_000);

  it("请求段整体落在 base 之前(真淘汰)→ 仍抛 WindowEvictedError(不得静默跳位)", async () => {
    const w = new PcmWindow({ input: wav120, loudness: { enabled: false } }, POS_MS);
    try {
      await w.ready(10_000);
      // 回跳到 1s:整段远在 base(=31.178s 起)之前 → 必须抛错,由调用方重定位,
      // 而不是"贴到 base 悄悄播 31.178s 的内容"(那会把回跳变成静默跳位)。
      const far = SPOOK(1);
      await expect(w.slice(far, far + FRAME, 10_000)).rejects.toBeInstanceOf(WindowEvictedError);
    } finally {
      w.close();
    }
  }, 30_000);
});

describe("PcmWindow 重定位代数", () => {
  it("slice 等待期间 seekTo 重定位 → 立刻抛 WindowEvictedError,不等满 15s", async () => {
    const w = new PcmWindow({ input: wav120, loudness: { enabled: false } });
    await w.ready(10_000);
    // decoded 被背压高水位压在 ~30s,所以 @60s 一定拦得住(必然进入等待)
    expect(w.decoded).toBeLessThan(SPOOK(60));
    const far = SPOOK(60);
    const pending = w.slice(far, far + 2400, 15_000);
    // 让它真正挂进等待队列,再重定位到窗口外(@50s 远超已解前沿 → 走重起 ffmpeg 那条路)
    await new Promise((r) => setTimeout(r, 200));
    const t0 = Date.now();
    expect(await w.seekTo(50_000)).toBe(true);
    await expect(pending).rejects.toBeInstanceOf(WindowEvictedError);
    // 关键断言:是"立刻失效"而不是撑到 15s 超时(那样 pushLoop 就被打死了)
    expect(Date.now() - t0).toBeLessThan(3000);
    w.close();
  }, 30_000);

  it("seekTo 重定位后窗口水位恰好等于目标(旧进程残留 stdout 不得灌进来)", async () => {
    const w = new PcmWindow({ input: wav120, loudness: { enabled: false } });
    await w.ready(10_000);
    expect(w.decoded).toBeGreaterThan(SPOOK(1));
    // @50s 在已解前沿(~30s)之外 → 必然走重定位
    expect(await w.seekTo(50_000)).toBe(true);
    // 重定位瞬间水位必须精确落在目标(SPOOK(50));若旧 ffmpeg 的缓冲 stdout 漏进来,
    // 这里会立刻偏大 —— 那正是 decodedSamples 被抬到错位置的老 bug。
    expect(w.decoded).toBe(SPOOK(50));
    // 且新进程随后能正常续上
    const seg = await w.slice(SPOOK(50), SPOOK(50) + 2400, 15_000);
    expect(seg.length).toBe(2400);
    w.close();
  }, 30_000);
});
