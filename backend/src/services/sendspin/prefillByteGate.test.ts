// 预填充「真实字节闸」回归守卫(2026-10)。
//
// 事故(v4.0.85 生产,根因见本文件与 server.ts 注释):
//   Sendspin 群组里在线播放器播放**中途突然无声**,设备侧起播后约**一个预填充
//   水位**(≈30s)开始逐帧 `Failed to send audio chunk`,并发 `SYNC LOST(state=error)`,
//   服务端全绿。现场:4.8MB 容量设备 + 30s 档 + 服务端自认占用「60%」。
//
// 根因:预填充水位判定用的是**时长口径** `0.6·cap ÷ 实测**平均**码率`
//   (server.ts `capacityLimitedPrefillMs` / `depth = cursor − now`),而设备环形缓冲
//   的硬上限是**压缩字节数**(spec:buffer_capacity is a hard per-player byte limit)。
//   二者只有在「窗口瞬时码率 == 整首平均码率」时才相等;FLAC 瞬时码率随内容起伏
//   (坑 B12),深档位(30s)撞上比平均码率更密的段落 → 真实占用 > 估算,吃穿 0.6 余量。
//   协议头/一帧过冲是**固定量**(长窗口反而更安全),真正的放大器是这条**码率估计偏差**。
//
// 修复:再叠一道**真实累计压缩字节**闸 —— 从 late-join 缓存数「尚未播到的字节」
//   (= 设备 BufferTracker 口径),达到 `cap × 0.6` 即停灌(`prefillByteBudget` /
//   `bufferedCompressedBytes`),同时把 seedLateJoin 的回填也按真实字节封顶。
//
// 本文件钉住:① 预算 = cap×0.6;② 真实占用 = 未播字节之和、跨组取最大;
//   ③ 「时长口径说 OK、真实字节已爆」时字节闸必须拦住(核心回归);
//   ④ seedLateJoin 按真实字节封顶(而非只按时长)。
import { describe, it, expect, afterEach } from "vitest";
import { SendspinGroup, DEVICE_BUFFER_HEADROOM_RATIO } from "./server.js";
import { setNowUsOverride } from "./clock.js";
import { GroupPump, overridePumpSource, type GroupAudio } from "./streamEngine.js";

/** 造一个只用于「纯方法」测试的组:server 只被日志路径用到,给个 no-op 桩即可。 */
function makeGroup(capBytes?: number): SendspinGroup {
  const g = new SendspinGroup("g", { log() {} } as any);
  if (capBytes !== undefined) {
    (g.members as any).add({ bufferCapacityBytes: capBytes, codec: "flac" } as any);
  }
  return g;
}

/** 直接往 late-join 缓存塞条目(等价于 pushFrame 真正发出去的那些 chunk)。 */
function seedRing(
  g: SendspinGroup,
  key: string,
  entries: Array<{ tsUs: bigint; durUs: number; bytes: number }>,
): void {
  (g as any).recentByGroup.set(
    key,
    entries.map((e) => ({ tsUs: e.tsUs, durUs: e.durUs, data: new Uint8Array(e.bytes) })),
  );
}

/** 造一串「起点 = ts0、每块 durUs、每块 bytes」的条目(模拟 FLAC 块流)。 */
function ringSeq(ts0: bigint, n: number, durUs: number, bytes: number) {
  return Array.from({ length: n }, (_, i) => ({
    tsUs: ts0 + BigInt(i * durUs),
    durUs,
    bytes,
  }));
}

afterEach(() => setNowUsOverride(null));

describe("SendspinGroup.prefillByteBudget:预算 = 容量 × 余量", () => {
  it("宣告 4.8MB → 预算 = floor(4800000 × 0.6) = 2880000(字节口径硬上限的权威换算)", () => {
    const g = makeGroup(4_800_000);
    expect(g.prefillByteBudget()).toBe(Math.floor(4_800_000 * DEVICE_BUFFER_HEADROOM_RATIO));
    expect(g.prefillByteBudget()).toBe(2_880_000);
  });

  it("未宣告容量(0) → 预算 0(闸关闭,行为与旧版一致)", () => {
    expect(makeGroup().prefillByteBudget()).toBe(0);
    expect(makeGroup(0).prefillByteBudget()).toBe(0);
  });

  it("多成员取**最小**容量(以最装不下的那台为准)", () => {
    const g = makeGroup(4_800_000);
    (g.members as any).add({ bufferCapacityBytes: 1_600_000, codec: "flac" });
    expect(g.prefillByteBudget()).toBe(Math.floor(1_600_000 * DEVICE_BUFFER_HEADROOM_RATIO));
  });
});

describe("SendspinGroup.bufferedCompressedBytes:只数「尚未播到」的真实字节", () => {
  it("ts+dur ≤ now(已播完)不计;ts+dur > now(还没播到/正在播)计入", () => {
    setNowUsOverride(() => 10_000_000n); // now = 10s
    const g = makeGroup(4_800_000);
    seedRing(g, "flac:100", [
      { tsUs: 5_000_000n, durUs: 1_000_000, bytes: 9_999 }, // 5s+1s=6s ≤ 10s → 已播完
      { tsUs: 9_000_000n, durUs: 2_000_000, bytes: 3_000 }, // 9s+2s=11s > 10s → 还没播完
      { tsUs: 12_000_000n, durUs: 1_000_000, bytes: 2_000 }, // 未来帧
    ]);
    expect(g.bufferedCompressedBytes()).toBe(5_000);
  });

  it("多个编码组取**最大**占用(同组字节逐字节相同;多组并存以最满的一组为准,保守)", () => {
    setNowUsOverride(() => 0n);
    const g = makeGroup(4_800_000);
    seedRing(g, "flac:100", ringSeq(1_000_000n, 3, 1_000_000, 1_000)); // 3000
    seedRing(g, "flac:50", ringSeq(1_000_000n, 2, 1_000_000, 2_500)); // 5000
    expect(g.bufferedCompressedBytes()).toBe(5_000);
  });

  it("空缓存 → 0(起播未发任何字节)", () => {
    const g = makeGroup(4_800_000);
    expect(g.bufferedCompressedBytes()).toBe(0);
  });
});

describe("核心回归:时长口径说「30s 没问题」,真实字节已爆 → 字节闸必须拦住", () => {
  it("4.8MB / 实测平均 96011B/s:cap 换算 ≈29996ms(自认 60%),但窗口内是更密的段落 → 真实占用 4.8MB ≥ 预算 2.88MB", () => {
    // 现场数字:cap=4800000, 实测平均码率=96011B/s → 时长口径 29996ms(≈30s,自认 60%)。
    setNowUsOverride(() => 100_000_000n);
    const g = makeGroup(4_800_000);
    (g as any).pushedBytes = Math.round(96_011 * 30); // 30s 的累计字节 → 平均码率 96011
    (g as any).pushedSamples = 30 * 48_000;

    // 时长口径:照旧给出 ≈30s 的「安全」水位(这正是旧判据误判之处)。
    expect(g.capacityLimitedPrefillMs()).toBeGreaterThan(29_000);

    // 真实窗口:30s 里是**比平均更密**的段落(160000B/s → 30s ≈ 4.8MB)。
    const dense = ringSeq(101_000_000n, 353, 85_000, 13_600); // 353×13.6KB ≈ 4.80MB,全部未播到
    seedRing(g, "flac:100", dense);

    const realBytes = g.bufferedCompressedBytes();
    const budget = g.prefillByteBudget();
    expect(realBytes).toBeGreaterThanOrEqual(4_700_000); // ≈4.8MB 真实占用
    expect(budget).toBe(2_880_000);
    // ★ 旧判据只看 `depth < 时长目标`,会继续灌 → 爆;新字节闸在此判 false → 停灌。
    expect(realBytes >= budget).toBe(true);
  });

  it("对照:同样 30s 时长、但内容不密(≈平均码率)→ 真实占用 < 预算,字节闸放行", () => {
    setNowUsOverride(() => 100_000_000n);
    const g = makeGroup(4_800_000);
    (g as any).pushedBytes = Math.round(96_011 * 30);
    (g as any).pushedSamples = 30 * 48_000;
    // 30s、96011B/s → ≈2.88MB,恰好 ≈ 预算 → 用略低一点的密度确保「< 预算」。
    const normal = ringSeq(101_000_000n, 353, 85_000, 8_000); // 353×8KB ≈ 2.82MB
    seedRing(g, "flac:100", normal);
    expect(g.bufferedCompressedBytes()).toBeLessThan(g.prefillByteBudget());
  });
});

describe("seedLateJoin:回填也按**真实压缩字节**封顶(而非只按时长)", () => {
  function seedJoinFixture(capBytes: number) {
    setNowUsOverride(() => 100_000_000n); // now = 100s
    const g = makeGroup(capBytes);
    // 打桩:send_ahead 固定 800ms(避开 group.js 内部对成员形状的依赖)。
    (g as any).commonSendAheadUs = () => 800_000;
    const sent: Array<{ ts: bigint; bytes: number }> = [];
    const c: any = {
      clientId: "C:TEST",
      codec: "flac",
      appliedGain: () => 100,
      clientWantsStream: () => true,
      announceStream: () => {},
      sendAudio: (ts: bigint, data: Uint8Array) => sent.push({ ts, bytes: data.length }),
    };
    return { g, c, sent };
  }

  it("字节预算 < 时长预算 → 回填到**真实字节**上限即停(72×40KB = 2880000B)", () => {
    const { g, c, sent } = seedJoinFixture(4_800_000);
    // target = now + sendAhead(800ms) + margin(100ms) = 100900000。
    // 缓存从 target 起、每块 85ms/40KB、共 200 块(≈17s / 8MB,远大于预算)。
    seedRing(g, "flac:100", ringSeq(100_900_000n, 200, 85_000, 40_000));
    const n = g.seedLateJoin(c);
    const totalBytes = sent.reduce((a, s) => a + s.bytes, 0);
    expect(n).toBeGreaterThan(0);
    // 预算 = 0.6×4.8MB = 2,880,000;每块 40KB → 正好 72 块(第 73 块会超预算 → break)。
    expect(totalBytes).toBe(2_880_000);
    expect(sent.length).toBe(72);
    // 首帧必须**不在过去**:ts ≥ now + send_ahead(+margin) —— 贴住既有时间轴。
    expect(sent[0].ts).toBeGreaterThanOrEqual(100_900_000n);
    // 未宣告容量时不做字节闸,应回填更多(时长口径上限)。
    const fixture2 = seedJoinFixture(4_800_000);
    seedRing(fixture2.g, "flac:100", ringSeq(100_900_000n, 200, 85_000, 40_000));
    (fixture2.g as any).members.clear(); // 清成员 → 未宣告容量
    const n2 = fixture2.g.seedLateJoin(fixture2.c);
    expect(n2).toBeGreaterThan(n);
  });
});

// ---------------------------------------------------------------------------
// 运行时集成(★ 本体修复的判别力所在)
//
// 上面的纯方法测试**钉不住**真正的运行时改动 —— `streamEngine` 里的
// `wantFill && byteOk`。若把 `&& byteOk` 整段删掉,纯方法测试仍全绿。
// 故这里用最小桩 group 驱动 `GroupPump.play`(pushLoop),实测:
//   · 无闸(budget=0,= 未宣告容量的向后兼容路径)→ 预填充一次性猛灌到水位;
//   · 有闸(budget 被派生占用在第 1 帧顶满)→ 立即停灌,之后按 1x 配速。
// 撤掉 `&& byteOk` ⇒ 有闸与无闸帧数相同 ⇒ 本用例变红。
// ---------------------------------------------------------------------------
describe("运行时集成:streamEngine 的字节闸真会「停灌」(撤掉 `&& byteOk` 即变红)", () => {
  /** 桩 group:pushFrame 逐帧递增 frames;bufferedCompressedBytes 由 frames 派生。 */
  function gateStub(budget: number, bytesPerFrame: number) {
    let frames = 0;
    const logs: string[] = [];
    const group: any = {
      name: "g",
      positionMs: 0,
      timelineBaseUs: 0n,
      current: { songId: "s", durationMs: 0 },
      commonSendAheadUs: () => 800_000,
      resetPushMeter: () => {},
      hasMeasuredRate: () => true,
      encodedBytesPerSec: () => 96_011,
      deviceCapacityBytes: () => 4_800_000,
      capacityLimitedPrefillMs: () => 30_000,
      prefillByteBudget: () => budget,
      bufferedCompressedBytes: () => frames * bytesPerFrame,
      async pushFrame(_ts: bigint, pcm: Float32Array) {
        frames++;
        return Math.floor(pcm.length / 2);
      },
    };
    const server: any = { log: (_lvl: string, msg: string) => logs.push(String(msg)) };
    return { group, server, logs, frames: () => frames };
  }

  async function burst(budget: number, bytesPerFrame = 100_000) {
    const { group, server, logs, frames } = gateStub(budget, bytesPerFrame);
    overridePumpSource(async (): Promise<GroupAudio> => ({
      pcm: new Float32Array(20 * 48_000 * 2),
      durationMs: 20_000,
    }));
    const pump = new GroupPump(server, group);
    await pump.play(`gate-${budget}-${bytesPerFrame}`);
    await new Promise((r) => setTimeout(r, 300)); // 观察预填充突进阶段
    pump.stop();
    return { frames: frames(), logs };
  }

  afterEach(() => overridePumpSource(null));

  it("预算 100000、每帧派生 100000B:第 1 帧即达预算 → 突进被压住(远少于无闸)", async () => {
    process.env.SENDSPIN_PREFILL_MS = "5000"; // 目标 5s:无闸会一次灌到水位(≈200 帧)
    try {
      const off = await burst(0); // 无闸(向后兼容路径)
      const on = await burst(100_000); // 有闸
      // 无闸:一次性灌到 5s 水位 → 大量突进帧
      expect(off.frames).toBeGreaterThan(60);
      // 有闸:第 1 帧即达预算 → 停灌,之后实时配速 → 窗口内帧数远小
      expect(on.frames).toBeLessThan(40);
      expect(on.frames).toBeLessThan(off.frames);
      // 一次性日志:证明确实走了「按真实排队字节封顶」分支
      expect(on.logs.some((m) => m.includes("真实排队字节"))).toBe(true);
    } finally {
      delete process.env.SENDSPIN_PREFILL_MS;
    }
  }, 20_000);
});
