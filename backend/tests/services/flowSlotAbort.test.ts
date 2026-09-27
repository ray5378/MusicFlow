// D24 回归:flow 会话在**转码槽排队中**被 abort ⇒ done 必须收敛。
//
// 这条用例锁的是「客户端断开 / 停投」这条路的**兜底契约**:abort 之后会话一定要收敛。
// 修复前:后建的会话解码器卡在 `await acquireTranscodeSlot("flow")` 的 FIFO 队列里,
// abort() 只杀了进程、叫不醒排队者 ⇒ `run()` 永不返回 ⇒ `done` 永不 resolve
// (实测 TIMEOUT,用例耗时 4247ms),而且那个槽也永远还不回来。
import "../plugins/_env.js";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterAll, vi } from "vitest";

/** 极简 WAV:只要时长够长、别自然结束就行,采样率压到 8k 让文件小、跑得快。 */
function makeWav(file: string, o: { seconds: number }): string {
  const p = path.join(os.tmpdir(), file);
  const rate = 8000;
  const ch = 1;
  const frames = Math.floor(rate * o.seconds);
  const buf = Buffer.alloc(44 + frames * ch * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + frames * ch * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(ch, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * ch * 2, 28);
  buf.writeUInt16LE(ch * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(frames * ch * 2, 40);
  for (let i = 0; i < frames; i++) {
    const v = Math.sin((2 * Math.PI * 220 * i) / rate) * 0.3;
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * ch * 2);
  }
  fs.writeFileSync(p, buf);
  return p;
}

const OPTS = {
  codec: { codec: "mp3", bitrateKbps: 128, container: "mp3", mime: "audio/mpeg" },
  crossfade: false,
} as any;

// SLOT_LIMITS 在 transcode.ts **模块加载时**按 env 算一次,所以必须在 import 之前设好,
// 并借 vi.resetModules() 让这次 import 拿到全新的一份模块实例。
const OLD_ENV = process.env.TRANSCODE_FLOW_MAX_CONCURRENT;
afterAll(() => {
  if (OLD_ENV === undefined) delete process.env.TRANSCODE_FLOW_MAX_CONCURRENT;
  else process.env.TRANSCODE_FLOW_MAX_CONCURRENT = OLD_ENV;
});

async function loadFlowMod() {
  vi.resetModules();
  process.env.TRANSCODE_FLOW_MAX_CONCURRENT = "1"; // 池子压到 1 ⇒ 第二个会话必然排队
  const mod: any = await import("../../src/services/audio/flow.js");
  const tr: any = await import("../../src/services/transcode.js");
  return { startFlowSession: mod.startFlowSession, activeTranscodeCount: tr.activeTranscodeCount };
}

describe("flow 会话:转码槽排队中被 abort", () => {
  it("abort 之后 done 必须收敛(不能把 run() 永久吊在槽队列里)", async () => {
    const { startFlowSession, activeTranscodeCount } = await loadFlowMod();

    // ① 先占满唯一的槽(30 分钟不来完,只能靠后面的 abort 收场)
    const a = makeWav("d24-a.wav", { seconds: 1800 });
    const held = await startFlowSession(
      [{ id: "a", input: a, headers: [], durationSec: 1800 } as any], OPTS,
    );
    expect(activeTranscodeCount("flow")).toBe(1);

    // ② 第二个会话:**不 await 到解码器起来** —— startFlowSession 本身立即返回,
    //    它的 run() 会停在 acquireTranscodeSlot 的 FIFO 队列里等那个唯一的槽。
    const b = makeWav("d24-b.wav", { seconds: 1800 });
    const queued = await startFlowSession(
      [{ id: "b", input: b, headers: [], durationSec: 1800 } as any], OPTS,
    );

    // ③ 排队中 abort ⇒ 必须是「取消」,不是「永远等下去」
    queued.abort();
    const settled = await Promise.race([
      queued.done.then(() => "done"),
      new Promise((r) => setTimeout(() => r("timeout"), 5000)),
    ]);
    expect(settled).toBe("done");
    // 顺带确认没把额度吃掉:被取消的那次申请不该还占着槽
    expect(activeTranscodeCount("flow")).toBe(1);

    held.abort();
    await held.done;
    expect(activeTranscodeCount("flow")).toBe(0);
  }, 30000);
});
