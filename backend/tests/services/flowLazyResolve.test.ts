// ==================== flow 懒解析(2026-10-21):起播不被整队预解析阻塞 ====================
//
// 240 现场:DLNA 拉 /rest/dlna/stream 后 12s 收不到任何响应头 —— 根因是起播前把
// 整条队列(上限 200 首)逐首 resolvePreferredSong + resolveTranscodeInput。
// 本文件锁三件事:
//   ① 只有首曲是**立即**解析的,后续曲目在上一首播放期间解析(不进首字节关键路径);
//   ② 解析失败(返回 null)的曲目被跳过,但**上一曲扣住的过渡尾段必须先吐出去**
//      (否则静默丢一个过渡窗口);
//   ③ 同一首只解析一次(预取点与循环开头都会调用,不能重复探源)。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveFfmpeg } from "../../src/services/transcode.js";
import { FLOW_DEFAULT_SAMPLE_RATE, startFlowSession, type FlowItem } from "../../src/services/audio/flow.js";

const RATE = FLOW_DEFAULT_SAMPLE_RATE;
const CH = 2;
const FRAME_BYTES = CH * 4;
const CODEC = { codec: "mp3" as const, bitrateKbps: 192, container: "mp3", mime: "audio/mpeg" };

let tmpDir = "";

/** 造一段 wav(本地路径是 SPEC §1.8 许可的 ffmpeg 输入)。 */
function makeWav(name: string, seconds: number): string {
  const file = path.join(tmpDir, name);
  const r = spawnSync(resolveFfmpeg(), [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`,
    "-ac", String(CH), "-ar", String(RATE), "-c:a", "pcm_s16le", file,
  ], { encoding: "buffer" });
  if (r.status !== 0) throw new Error(`造 wav 失败: ${r.stderr?.toString().slice(0, 400)}`);
  return file;
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream as any) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
}

/** 解回秒数(比 ffprobe 少一个依赖)。 */
function outputSeconds(mp3: Buffer): number {
  const r = spawnSync(resolveFfmpeg(), [
    "-hide_banner", "-loglevel", "error", "-f", "mp3", "-i", "pipe:0",
    "-f", "f32le", "-ar", String(RATE), "-ac", String(CH), "pipe:1",
  ], { input: mp3, maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`解码 flow 输出失败: ${r.stderr?.toString().slice(0, 400)}`);
  return r.stdout.length / FRAME_BYTES / RATE;
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mf-flow-lazy-"));
});
afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
});

describe("flow 懒解析", () => {
  it("首曲已就绪 + 后续懒解析 + 不可用曲目跳过仍保留上曲尾段", async () => {
    const a = makeWav("a.wav", 6);
    const b = makeWav("b.wav", 6);
    const d = makeWav("d.wav", 6);
    let bCalls = 0;
    let cCalls = 0;
    const starts: number[] = [];

    const items: FlowItem[] = [
      { key: "a", input: a, af: [], title: "a", durationSec: 6 },
      {
        key: "b", input: "", af: [], title: "b", durationSec: 6,
        resolve: async () => {
          bCalls++;
          await new Promise((r) => setTimeout(r, 30));
          return { input: b, af: [], key: "b" };
        },
      },
      {
        key: "c", input: "", af: [], title: "c", durationSec: 6,
        resolve: async () => {
          cCalls++;
          return null; // 源全挂 → 跳过
        },
      },
      { key: "d", input: d, af: [], title: "d", durationSec: 6 },
    ];

    const session = await startFlowSession(items, {
      codec: CODEC,
      // 1s 窗口 < 3s 下限 ⇒ 不做混合,但会话仍会**扣住**尾部 carry:
      // 跳过 c 时必须把 b 的尾段吐出去,否则总时长会少 1s。
      crossfade: true,
      fade: { durationSec: 1 },
      onItemStart: (i) => starts.push(i),
    });
    const out = await collect(session.stream);
    await session.done;
    const st = session.stats();

    expect(st.skipped).toBe(1);
    expect(starts).toEqual([0, 1, 3]);        // c 被跳过
    expect(bCalls).toBe(1);                    // 懒解析只发生一次(去重)
    expect(cCalls).toBe(1);                    // 失败的也只解析一次
    expect(st.decoders).toBe(3);               // c 从未起解码器
    expect(outputSeconds(out)).toBeCloseTo(18, 0); // a+b+d 完整(尾段没丢)
  }, 60000);

  it("解析抛异常 = 跳过该曲,不中断整条会话", async () => {
    const a = makeWav("e.wav", 5);
    const c = makeWav("f.wav", 5);
    const session = await startFlowSession([
      { key: "e", input: a, af: [], durationSec: 5 },
      {
        key: "boom", input: "", af: [], durationSec: 5,
        resolve: async () => { throw new Error("probe timeout"); },
      },
      { key: "f", input: c, af: [], durationSec: 5 },
    ], { codec: CODEC, crossfade: false });

    const out = await collect(session.stream);
    await session.done;
    expect(session.stats().skipped).toBe(1);
    expect(outputSeconds(out)).toBeCloseTo(10, 0);
  }, 60000);

  it("实时节流:8s 音频不会在 (8s - 5s lead) 之前发完(队列下标不跑到实际播放前面)", async () => {
    const a = makeWav("g.wav", 8);
    const t0 = Date.now();
    const session = await startFlowSession(
      [{ key: "g", input: a, af: [], durationSec: 8 }],
      { codec: CODEC, crossfade: false },
    );
    const out = await collect(session.stream);
    await session.done;
    const elapsed = Date.now() - t0;
    expect(outputSeconds(out)).toBeCloseTo(8, 0);
    // 默认 lead=5s ⇒ 约等 3s;留编码启动/调度余量,阈值取 2.2s(未节流时 <0.5s)。
    expect(elapsed).toBeGreaterThanOrEqual(2200);
  }, 60000);
});
