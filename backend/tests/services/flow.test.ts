// ==================== P3-7：flow 会话级（真 ffmpeg） ====================
//
// 纯数学在 fades.test.ts；这里锁**进程编排**那部分 —— 它错了同样"不报错、只是听感坏掉"
// 或"多烧一个进程"：
//   ① 两路解码**真的并存**（预取生效）→ `stats.decoders` > 曲数；
//   ② 交叉淡入**真的发生**→ 总时长 = 各曲之和 − 过渡窗口，且 `stats.crossfades` 计上；
//   ③ 关掉交叉淡入 = 直通拼接（**仍走管道**，D9）；
//   ④ 曲尾静音不进过渡窗口（P3-3 在会话里的表现）；
//   ⑤ af 链**一次算定**（P3-4）：解码命令带的就是调用方给的，会话不 import 任何
//      响度/分析模块 → 过渡途中不可能重算增益（结构上证明，比断言数字更结实）；
//   ⑥ abort 幂等且能让 `done` 收敛（客户端断开 / 停投时的唯一出路）。
//
// ⚠️ 输入一律用**本地临时 wav**：SPEC §1.8 的 ffmpeg 输入硬契约只有两种合法形态
// （回环 token URL / 本地文件），本地文件正是其一，且不需要起 HTTP 上游。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { resolveFfmpeg } from "../../src/services/transcode.js";
import {
  FLOW_DEFAULT_SAMPLE_RATE,
  flowDecodeArgs,
  flowEncodeArgs,
  startFlowSession,
  type FlowItem,
} from "../../src/services/audio/flow.js";

const RATE = FLOW_DEFAULT_SAMPLE_RATE;
const CH = 2;
const FRAME_BYTES = CH * 4;

let tmpDir = "";
const ffmpeg = () => resolveFfmpeg();

/** 造一段 wav:正弦 + 可选尾部静音(apad)。本地路径是 SPEC §1.8 许可的 ffmpeg 输入。 */
function makeWav(name: string, opts: { freq: number; seconds: number; padSec?: number }): string {
  const file = path.join(tmpDir, name);
  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `sine=frequency=${opts.freq}:duration=${opts.seconds}`,
    ...(opts.padSec ? ["-af", `apad=pad_dur=${opts.padSec}`] : []),
    "-ac", String(CH), "-ar", String(RATE), "-c:a", "pcm_s16le", file,
  ];
  const r = spawnSync(ffmpeg(), args, { encoding: "buffer" });
  if (r.status !== 0) throw new Error(`造 wav 失败: ${r.stderr?.toString().slice(0, 400)}`);
  return file;
}

/** 把流收完。 */
async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream as any) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
}

/** 解回 f32le 数帧数（比 ffprobe 少一个依赖，也顺带证明输出真的是可解音频）。 */
function outputSeconds(mp3: Buffer): number {
  const r = spawnSync(
    ffmpeg(),
    ["-hide_banner", "-loglevel", "error", "-f", "mp3", "-i", "pipe:0", "-f", "f32le", "-ar", String(RATE), "-ac", String(CH), "pipe:1"],
    { input: mp3, maxBuffer: 1 << 28 },
  );
  if (r.status !== 0) throw new Error(`解码 flow 输出失败: ${r.stderr?.toString().slice(0, 400)}`);
  return r.stdout.length / FRAME_BYTES / RATE;
}

function item(key: string, input: string, af: string[] = [], durationSec?: number): FlowItem {
  return { key, input, af, title: key, ...(durationSec ? { durationSec } : {}) };
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mf-flow-"));
});
afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
});

describe("P3-4 命令组装：af 一次算定、限制器只在编码段", () => {
  it("flowDecodeArgs：会话锚定采样率/声道 + 原样带上调用方给的 af（不自己解析增益）", () => {
    const args = flowDecodeArgs({
      input: "/tmp/x.flac",
      headers: { Authorization: "Basic zzz" },
      af: ["volume=6dB", "loudnorm=I=-14"],
      sampleRate: RATE,
      channels: CH,
    });
    const joined = args.join(" ");
    expect(joined).toContain("-ar 48000");
    expect(joined).toContain("-ac 2");
    expect(joined).toContain("volume=6dB,loudnorm=I=-14");
    // 每曲自己的链**不含**限制器(限幅落在混合之后,见 flow.ts 顶部注释)
    expect(joined).not.toContain("alimiter");
  });

  it("flowEncodeArgs：第一个 af 就是限制器（⑤ 在 ④ 之后），且不带响度滤镜", () => {
    const args = flowEncodeArgs({ sampleRate: RATE, channels: CH, codec: { codec: "mp3", bitrateKbps: 320, container: "mp3", mime: "audio/mpeg" } });
    const af = args[args.indexOf("-af") + 1];
    expect(af.startsWith("alimiter=")).toBe(true);
    expect(af).not.toContain("loudnorm");
    expect(args).toContain("-f");
    expect(args.slice(-1)).toEqual(["-"]);
  });

  it("结构锁：会话**不 import** 响度/分析/设置模块 → 过渡途中不可能重算增益", () => {
    const src = fs.readFileSync(
      fileURLToPath(new URL("../../src/services/audio/flow.ts", import.meta.url)),
      "utf8",
    );
    // 只看 import 语句（注释里提到 resolveLoudnessAf 是说明性的，不算依赖）。
    const importLines = src
      .split("\n")
      .filter((l) => /^\s*import\b/.test(l) || /\bfrom\s+"[^"]+"/.test(l))
      .join("\n");
    expect(importLines.length).toBeGreaterThan(0); // 防"筛空了所以通过"的假绿
    for (const forbidden of ["audio/loudness", "analysisStore", "audio/analysis", "services/settings"]) {
      expect(importLines).not.toContain(forbidden);
    }
  });
});

describe("P3-1 flow 会话：两路解码并存 + 交叉淡入", () => {
  it("两曲 5s、过渡 3s：总长 ≈ 5+5−3 = 7s，crossfades=1，decoders=2（预取真并存）", async () => {
    const a = makeWav("a.wav", { freq: 440, seconds: 5 });
    const b = makeWav("b.wav", { freq: 660, seconds: 5 });
    const statsTrace: number[] = [];
    const session = await startFlowSession([item("a", a, [], 5), item("b", b, [], 5)], {
      codec: { codec: "mp3", bitrateKbps: 192, container: "mp3", mime: "audio/mpeg" },
      crossfade: true,
      fade: { durationSec: 3 },
      onItemStart: (i) => statsTrace.push(i),
    });
    const out = await collect(session.stream);
    await session.done;
    const st = session.stats();

    expect(out.length).toBeGreaterThan(0);
    expect(outputSeconds(out)).toBeCloseTo(7, 0); // ±0.5s（编码器 padding 容差）
    expect(st.crossfades).toBe(1);
    // 有 durationSec → 预取拉起第二路，两路解码并存过
    expect(st.decoders).toBe(2);
    expect(st.skipped).toBe(0);
    expect(st.emittedFrames / RATE).toBeCloseTo(7, 0);
    expect(statsTrace).toEqual([0, 1]);
    expect(session.currentIndex()).toBe(1);
  });

  it("关掉交叉淡入 = 直通拼接（仍走管道）：总长 ≈ 10s、crossfades=0", async () => {
    const a = makeWav("a2.wav", { freq: 440, seconds: 5 });
    const b = makeWav("b2.wav", { freq: 660, seconds: 5 });
    const session = await startFlowSession([item("a", a, [], 5), item("b", b, [], 5)], {
      codec: { codec: "mp3", bitrateKbps: 192, container: "mp3", mime: "audio/mpeg" },
      crossfade: false,
    });
    const out = await collect(session.stream);
    await session.done;
    expect(outputSeconds(out)).toBeCloseTo(10, 0);
    expect(session.stats().crossfades).toBe(0);
  });

  it("曲尾静音不计入过渡窗口（P3-3）：尾部 3s 静音 → 不成过渡，静音被丢掉", async () => {
    // 4s 正弦 + 3s 静音（共 7s）。过渡窗口正好 3s，理应被静音吃光 → crossfades=0。
    const a = makeWav("a3.wav", { freq: 440, seconds: 4, padSec: 3 });
    const b = makeWav("b3.wav", { freq: 660, seconds: 5 });
    const session = await startFlowSession([item("a", a, [], 7), item("b", b, [], 5)], {
      codec: { codec: "mp3", bitrateKbps: 192, container: "mp3", mime: "audio/mpeg" },
      crossfade: true,
      fade: { durationSec: 3 },
    });
    const out = await collect(session.stream);
    await session.done;
    const st = session.stats();
    expect(st.crossfades).toBe(0); // 静音不该被"淡出"
    // 4s 有声 + 5s 次曲（尾部静音被剥离，但最后一曲尾段原样播出）
    expect(outputSeconds(out)).toBeCloseTo(4 + 5, 0);
  }, 30000);

  it("下一曲首段短于过渡窗口：上一曲尾段照常播出，不静默丢弃（P1-1 修复）", async () => {
    // 5s + 1s、过渡窗口 3s：下一曲只够混 1s，剩下 2s 的上一曲尾段必须**照常播出**。
    // 修复前这段既没 emit 也没参与混合，被 `carry = Buffer.alloc(0)` 静默吞掉
    // → 总长只剩 ≈3s，且**没有任何报错**（凭听感才知道少了一段）。
    const a = makeWav("a5.wav", { freq: 440, seconds: 5 });
    const b = makeWav("b5.wav", { freq: 660, seconds: 1 });
    const session = await startFlowSession([item("a", a, [], 5), item("b", b, [], 1)], {
      codec: { codec: "mp3", bitrateKbps: 192, container: "mp3", mime: "audio/mpeg" },
      crossfade: true,
      fade: { durationSec: 3 },
    });
    const out = await collect(session.stream);
    await session.done;
    const st = session.stats();
    expect(st.crossfades).toBe(1); // 交叉确实发生了（只是窗口被下一曲的长度卡短）
    // 上一曲完整 5s = 前 2s 直出 + 中间 2s 补播 + 末 1s 与下一曲交叉。修复前只有 ≈3s。
    expect(outputSeconds(out)).toBeCloseTo(5, 0);
    expect(st.emittedFrames / RATE).toBeCloseTo(5, 0);
    expect(st.skipped).toBe(0);
  }, 30000);

  it("单曲也走同一条实现（等价一次普通管道出流）", async () => {
    const a = makeWav("a4.wav", { freq: 440, seconds: 4 });
    const session = await startFlowSession([item("a", a, [], 4)], {
      codec: { codec: "mp3", bitrateKbps: 192, container: "mp3", mime: "audio/mpeg" },
      crossfade: true,
      fade: { durationSec: 3 },
    });
    const out = await collect(session.stream);
    await session.done;
    expect(outputSeconds(out)).toBeCloseTo(4, 0);
    expect(session.stats().crossfades).toBe(0);
    expect(session.stats().decoders).toBe(1);
  });

  it("abort 幂等且让 done 收敛（客户端断开 / 停投的唯一出路）", async () => {
    // 长输入：不会自然结束，只能靠 abort 收场。
    const a = makeWav("long.wav", { freq: 220, seconds: 30 });
    const session = await startFlowSession([item("a", a, [], 30)], {
      codec: { codec: "mp3", bitrateKbps: 128, container: "mp3", mime: "audio/mpeg" },
      crossfade: false,
    });
    // 读到一点就等于确认管道真的在出流
    const it = (session.stream as any)[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.done).toBe(false);
    expect(Buffer.from(first.value).length).toBeGreaterThan(0);

    session.abort();
    session.abort(); // 幂等：第二次不该抛
    const settled = await Promise.race([
      session.done.then(() => "done"),
      new Promise((r) => setTimeout(() => r("timeout"), 15000)),
    ]);
    expect(settled).toBe("done");
  }, 30000);
});
