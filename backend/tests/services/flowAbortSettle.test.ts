// D25 回归：flow 会话 abort() 之后 `done` **必须收敛**，不能把收敛押在对端关 pipe 上。
//
// 修复前的实现只做 `proc.kill("SIGKILL")`。这在 Node 里有个隐蔽的坑：
// `ChildProcess` 的 `close` 事件要等**全部 stdio 流关闭**才发，而死掉的 ffmpeg 常常
// 正卡在写满的 stdout pipe 上（不可中断睡眠 / 我们把输出 pipe 留着没读），
// 于是 `exit` 到了、`close` 永远不来 —— `done = Promise.all([runPromise, encClosed])`
// 整条链就挂在 `encClosed` 上。**实测 24 次里挂 2 次（~8%）**，放到全量跑就是
// `flow.test.ts > abort 幂等且让 done 收敛` 那条偶发红。
// 修复：`abort()` / `killDecoder()` 改用 `reap()` —— SIGKILL **外加自己 destroy 掉
// 这三根 pipe**，把「等对端关管」变成「自己关」，与对端状态解耦。
//
// 为什么这条用例要**跑循环**：单发的命中率只有 ~8%，一次跑过说明不了问题。
// 这里连跑 ROUNDS 次，把回归重新引入时的漏检概率压下来（不追求 100%，
// 见下面 ROUNDS 的注释）。修复后实测 48/48 全绿、单轮用例从 10s 降到 <10ms。
import "../plugins/_env.js";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { startFlowSession, type FlowItem } from "../../src/services/audio/flow.js";
import { activeTranscodeCount } from "../../src/services/transcode.js";

/**
 * ### 为什么 ROUNDS = 8 而不是 1
 * 单发命中约 8%、关掉修复后实测 3/48 ≈ 6%，跑 8 次可把漏检压到 ~40%；
 * 继续加轮数会让这条用例在 CI 上变成「最慢的那个」，收益递减。
 * 想要更强的保险，靠的是 **`flow.test.ts` 里那条原本就偶发红的 P3-1 abort 用例**
 * —— 修复之后它本身也变成确定收敛，两条用例互为交叉验证。
 */
const ROUNDS = 8;
/** 每次 abort 后等的收敛上限：修复后实测 0~2ms，3s 是几十倍余量。 */
const SETTLE_TIMEOUT_MS = 3000;

/** 极简 WAV：只要时长够长、别自然结束就行，采样率压到 8k 让文件小、跑得快。 */
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

/** 每轮都用不同的文件名，避免下一轮读到上一轮的缓存/同名文件。 */
function itemOf(input: string, round: number): FlowItem {
  return { key: `d25-${round}`, input, af: [], title: `d25-${round}`, durationSec: 1800 };
}

describe("flow 会话：abort 之后 done 必须收敛（不等对端关 pipe）", () => {
  it(`连续 ${ROUNDS} 次 abort：每次都在 ${SETTLE_TIMEOUT_MS}ms 内收敛，且槽全还`, async () => {
    const wav = makeWav(`d25-long-${Date.now()}.wav`, { seconds: 1800 });
    const opts = {
      codec: { codec: "mp3", bitrateKbps: 128, container: "mp3", mime: "audio/mpeg" },
      crossfade: false,
    } as any;

    for (let round = 0; round < ROUNDS; round++) {
      const session = await startFlowSession([itemOf(wav, round)], opts);
      // 只读**一**块就撒手 —— 这正是客户端断开时的真实形态：调用方停在了半路。
      // 于是编码器的 stdout pipe 一直满着、没人接着读，abort 时 ffmpeg 说不定还卡在
      // write() 里（不可中断睡眠，SIGKILL 都未必立刻送达）。D25 的全部触发条件都在这。
      const itr = (session.stream as any)[Symbol.asyncIterator]();
      const first = await itr.next();
      expect(first.done).toBe(false);
      expect(Buffer.from(first.value).length).toBeGreaterThan(0);

      session.abort();
      session.abort(); // 幂等：第二次不该抛

      const settled = await Promise.race([
        session.done.then(() => "done"),
        new Promise((r) => setTimeout(() => r("timeout"), SETTLE_TIMEOUT_MS)),
      ]);
      expect(settled, `#${round} abort 之后 done 不收敛`).toBe("done");
      // 槽必须全部还回去，否则这个池子会被一笔笔慢慢吃光
      expect(activeTranscodeCount("flow"), `#${round} 泄漏转码槽`).toBe(0);
    }
  }, 120000);
});
