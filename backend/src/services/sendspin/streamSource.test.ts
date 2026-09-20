// PcmWindow 滑动窗口单测:对拍整包解码 / seek 窗口内外 / EOF / 杀进程无残留 / 背压界。
// 全部走真实 ffmpeg(ffmpeg-static),无 mock —— 与 encoding.test.ts 同策略。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { PcmWindow, WindowClosedError, WINDOW_HIGH_SEC, resolveSendspinAf } from "./streamSource.js";
import { decodeToF32, ffmpegBin, SAMPLE_RATE, CHANNELS } from "./encoding.js";
import { saveAnalysis, deleteAnalysis } from "../audio/analysisStore.js";
import { db } from "../../db/index.js";
import { songs } from "../../db/schema.js";
import { eq } from "drizzle-orm";

const SR = SAMPLE_RATE;
const CH = CHANNELS;
const SPOOK = (sec: number) => Math.floor(sec * SR * CH); // 秒 → 绝对交错样本

let tmpDir = "";
let wav30 = "";
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

describe("PcmWindow 进程与背压", () => {
  it("close 杀掉 ffmpeg、无残留,等待中 slice 抛 Closed", async () => {
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
