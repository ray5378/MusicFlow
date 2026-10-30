// ==================== 桥接 producer:预填充 + 低水位补货 ====================
//
// 钉死(HiVi H5MKII 曲中失声根因修复):桥接 producer(pullChunk)此前直接消费 outBuf,
// 缺 decoder.ts 那层 prefill ⇒ outBuf 常驻 0~8ms(不到 1 个 352 帧块)⇒ 上游一阵供料
// 抖动就见底 ⇒ 352/44100 ≈ 7.98ms 的发送节拍被打断 ⇒ late 单调累积 ⇒ 设备 1.05s 缓冲
// 抽干 ⇒ 追赶模式 + 大量「未来包」重传 ⇒ 哑音数秒后自愈。
//
// 判别力:本文件每个 ★ 用例在「无预填充」的旧实现下都会失败(已用
// `git stash push -- backend/src/services/airplay/bridgeSession.ts` 实测确认),
// 不是恒过的假测试。
import "../plugins/_env.js";

import { afterEach, describe, expect, it } from "vitest";
import { bridgeSocketPath } from "../../src/services/airplay/bridgeChannel.js";
import { BridgeSession } from "../../src/services/airplay/bridgeSession.js";
import { PREFILL_BYTES } from "../../src/services/airplay/decoder.js";

const sessions: BridgeSession[] = [];

function mkSession(opts: Partial<ConstructorParameters<typeof BridgeSession>[0]> = {}): BridgeSession {
  const n = Math.floor(Math.random() * 1e9);
  const s = new BridgeSession({
    deviceId: `pf-${n}`,
    token: `pf-${n}`,
    protocol: "raop",
    socketPath: bridgeSocketPath(`pf-${n}`, `pf-${n}`),
    dry: true,
    waitDataMs: 50,
    ...opts,
  });
  sessions.push(s);
  return s;
}

afterEach(async () => {
  while (sessions.length > 0) await sessions.pop()!.stop().catch(() => {});
});

/** 48k s16le/2ch 的 ms 毫秒音频;marker 写进左声道,用于区分数据来源。 */
function pcm48k(ms: number, marker: number): Buffer {
  const frames = Math.round((ms / 1000) * 48000);
  const buf = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) buf.writeInt16LE(marker, i * 4);
  return buf;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 与实现同口径的目标水位(1500ms / 200ms × 本实例 outRate × 2ch × 2B)。 */
const prefillBytesOf = (s: BridgeSession): number => Math.round((1500 / 1000) * s.outRate * 2 * 2);
const lowWaterBytesOf = (s: BridgeSession): number => Math.round((200 / 1000) * s.outRate * 2 * 2);

const outBufLen = (s: BridgeSession): number => (s as any).outBuf.length;

describe("桥接 producer 预填充 / 低水位补货", () => {
  it("★ 预填充水位与 decoder.ts PREFILL_MS 对齐,且按本实例 outRate 换算(不硬编码 44100)", async () => {
    const s = mkSession(); // protocol=raop ⇒ outRate 44100
    // 与 decoder.ts 的 PREFILL_BYTES(1500ms @44100 s16le/2ch)逐字节相等 —— 钉死「对齐」。
    expect(prefillBytesOf(s)).toBe(PREFILL_BYTES);
    // 钉到实现方法本身(而不只是测试里的同口径公式)。
    expect((s as any).prefillTargetBytes()).toBe(PREFILL_BYTES);
    expect((s as any).lowWaterTargetBytes()).toBe(Math.round((200 / 1000) * s.outRate * 2 * 2));
    // 48k 直通实例(ap2-realtime)必须按 48000 换算 ⇒ 值不同 —— 钉死「不硬编码采样率」。
    const s48 = mkSession({ protocol: "ap2-realtime" });
    expect(s48.outRate).toBe(48000);
    expect(prefillBytesOf(s48)).toBe(Math.round((1500 / 1000) * 48000 * 2 * 2));
    expect((s48 as any).prefillTargetBytes()).toBe(Math.round((1500 / 1000) * 48000 * 2 * 2));
    expect(prefillBytesOf(s48)).not.toBe(PREFILL_BYTES);
    expect(prefillBytesOf(s48)).toBeGreaterThan(prefillBytesOf(s));
  });

  it("★ (a) 首次调用会预填充到目标水位才返回第一个 chunk", async () => {
    const s = mkSession({ waitDataMs: 3000 });
    await s.start();
    const target = prefillBytesOf(s);
    // 上游按远高于实时的速率小批量供料(40ms 音频 / ~2ms):无预填充时首块在 outBuf
    // 刚够 1408B 时就返回,出块后 outBuf ≈ 0;有预填充则应囤满 ≈1500ms 才出第一块。
    let stop = false;
    const feeder = (async () => {
      while (!stop) {
        s.ingest(pcm48k(40, 1234));
        await sleep(2);
      }
    })();
    const chunk = await s.pullOutChunk();
    stop = true;
    await feeder;

    expect(chunk).not.toBeNull();
    expect(chunk!.length).toBe(1408);
    expect(s.stats.silenceChunks).toBe(0);
    // 判别点:首个 chunk 出块后 outBuf 仍应接近满水位;旧实现这里只剩 ~0。
    expect(outBufLen(s)).toBeGreaterThanOrEqual(Math.floor(target * 0.9));
  });

  it("★ (b) 预填充期间 closed / streamAborted ⇒ 立即返回 null(不卡死发送循环)", async () => {
    // —— closed 分支 ——
    const s1 = mkSession({ waitDataMs: 5000 });
    await s1.start();
    s1.ingest(pcm48k(5, 7)); // 远不够水位 ⇒ 预填充会一直等(若无中止检查)
    const p1 = s1.pullOutChunk();
    await sleep(20);
    (s1 as any).closed = true;
    const t1 = Date.now();
    expect(await p1).toBeNull();
    expect(Date.now() - t1).toBeLessThan(100);

    // —— streamAborted 分支 ——
    const s2 = mkSession({ waitDataMs: 5000 });
    await s2.start();
    s2.ingest(pcm48k(5, 7));
    const p2 = s2.pullOutChunk();
    await sleep(20);
    (s2 as any).streamAborted = true;
    const t2 = Date.now();
    expect(await p2).toBeNull();
    expect(Date.now() - t2).toBeLessThan(100);
  }, 15000);

  it("★ (c) 预填充超时 ⇒ 降级(等满预算后走原有逻辑,不补静音、不报错、不死等)", async () => {
    const s = mkSession({ waitDataMs: 60 });
    await s.start();
    // 喂够一块但远不到预填充水位,之后断供 ⇒ 预填充必然超时降级。
    s.ingest(pcm48k(100, 3000));
    const t0 = Date.now();
    const chunk = await s.pullOutChunk();
    const dt = Date.now() - t0;

    expect(chunk).not.toBeNull();
    expect(chunk!.length).toBe(1408);
    // 走的是真实音频(降级到现有欠料路径前已有料),不是补静音。
    expect(s.stats.silenceChunks).toBe(0);
    // 判别点:确实等了预填充预算(旧实现 outBuf 已够一块 ⇒ ≈0ms 立即返回)。
    expect(dt).toBeGreaterThanOrEqual(40);
    // 不是死等:预算一过立刻降级。
    expect(dt).toBeLessThan(500);
  }, 15000);

  it("★ (e) 预填充只做一次:首块之后的调用不再等预填充水位", async () => {
    const s = mkSession({ waitDataMs: 60 });
    await s.start();
    // 完全不供料 ⇒ 首块:预填充等满 waitDataMs 后降级到原有欠料逻辑(再等 waitDataMs)。
    const t0 = Date.now();
    const first = await s.pullOutChunk();
    const dt1 = Date.now() - t0;
    expect(first).not.toBeNull();
    expect(first!.length).toBe(1408);
    expect(s.stats.silenceChunks).toBe(1); // 原有欠料补静音语义保持不变
    expect(dt1).toBeGreaterThanOrEqual(90); // ≈ 2 × waitDataMs:预填充确实发生了
    expect(dt1).toBeLessThan(600); // 不是死等

    // 第二块:预填充已完成 ⇒ 只走原有等料(≈1 × waitDataMs),不再叠一层预填充。
    const t1 = Date.now();
    const second = await s.pullOutChunk();
    const dt2 = Date.now() - t1;
    expect(second).not.toBeNull();
    expect(dt2).toBeLessThan(90);
  }, 15000);

  it("★ (d) 抖动场景:低水位保护会等补货到阈值再出块", async () => {
    const s = mkSession({ waitDataMs: 3000 });
    await s.start();
    const lowWater = lowWaterBytesOf(s);

    // ① 先给足量(单块 1700ms > 1500ms 水位)完成一次预填充 —— 一次 resampleIn 即达标,
    //    inQueue 不留残料,便于 ③ 精确观测「等突发」行为。
    s.ingest(pcm48k(1700, 9));
    await s.pullOutChunk();
    expect((s as any).prefillDone).toBe(true);
    expect(outBufLen(s)).toBeGreaterThan(lowWater);
    expect((s as any).inQueue.length).toBe(0);

    // ② 模拟上游抖动:断供,把 outBuf 抽到跌破低水位(但仍够一块)。
    let guard = 0;
    while (outBufLen(s) >= lowWater && guard++ < 600) await s.pullOutChunk();
    const before = outBufLen(s);
    expect(before).toBeLessThan(lowWater);
    expect(before).toBeGreaterThanOrEqual(1408);

    // ③ 20ms 后来一阵突发:有低水位保护 ⇒ 这次出块会等到突发到达、把水位补回阈值以上。
    setTimeout(() => s.ingest(pcm48k(600, 4242)), 20);
    const t0 = Date.now();
    const chunk = await s.pullOutChunk();
    const dt = Date.now() - t0;

    expect(chunk).not.toBeNull();
    expect(chunk!.length).toBe(1408);
    expect(s.stats.silenceChunks).toBe(0);
    // 判别点 1:确实等到了补货才出块(旧实现 outBuf 已够一块 ⇒ ≈0ms 立即返回)。
    expect(dt).toBeGreaterThanOrEqual(12);
    // 判别点 2:出块后水位已补回阈值以上(旧实现突发还压在 inQueue 里没被消费 ⇒ ≈0)。
    expect(outBufLen(s)).toBeGreaterThan(lowWater);
  }, 15000);
});
