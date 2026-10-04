// QA 独立验证附加测试(2026-10,Edward / software-qa-engineer)。
//
// 目的:对 commit 3cbd53c「预填充真实字节闸」做**独立**验证,补齐工程师
// `prefillByteGate.test.ts` 未覆盖的面:
//   ① 边界/反例:cap=25000(ESPHome 下限)/0x7FFFFFFF、三成员取最小、未宣告容量;
//   ② 逐出规则(pruneRecent)绝不会**低估**真实排队字节(团队存疑点);
//   ③ seedLateJoin 多成员不同容量取**最小**;
//   ④ ★ 运行时集成:streamEngine 的 `wantFill && byteOk` 真的会在占用达预算时**停灌**
//      —— 这是工程师 9 例完全没碰到的路径(它们只测 server.ts 的纯方法)。
//
// 本文件只读产品源码,不改任何产品逻辑。
import { describe, it, expect, afterEach } from "vitest";
import { SendspinGroup, DEVICE_BUFFER_HEADROOM_RATIO } from "./server.js";
import { setNowUsOverride } from "./clock.js";
import { GroupPump, overridePumpSource, type GroupAudio } from "./streamEngine.js";

const S = 1_000_000n; // 1 秒(微秒)

function makeGroup(caps: Array<number | undefined> = []): SendspinGroup {
  const g = new SendspinGroup("g", { log() {} } as any);
  for (const cap of caps) {
    (g.members as any).add({ bufferCapacityBytes: cap, codec: "flac" } as any);
  }
  return g;
}

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

afterEach(() => setNowUsOverride(null));

// ---------------------------------------------------------------------------
// ① 边界 / 反例(纯方法)
// ---------------------------------------------------------------------------
describe("QA①边界:prefillByteBudget 极端容量", () => {
  it("cap=25000(ESPHome buffer_size 下限)→ 预算 15000,不静默变 0", () => {
    const g = makeGroup([25_000]);
    expect(g.deviceCapacityBytes()).toBe(25_000);
    expect(g.prefillByteBudget()).toBe(15_000);
  });

  it("cap=0x7FFFFFFF(极大)→ 预算 = floor(cap×0.6),无溢出/无取整错", () => {
    const g = makeGroup([0x7fffffff]);
    expect(g.prefillByteBudget()).toBe(Math.floor(0x7fffffff * DEVICE_BUFFER_HEADROOM_RATIO));
  });

  it("三成员容量不同 → 取**最小**(1.6MB 那台说了算)", () => {
    const g = makeGroup([4_800_000, 1_600_000, 2_400_000]);
    expect(g.deviceCapacityBytes()).toBe(1_600_000);
    expect(g.prefillByteBudget()).toBe(Math.floor(1_600_000 * DEVICE_BUFFER_HEADROOM_RATIO));
  });

  it("未宣告容量(undefined / 0)→ 预算 0(字节闸关闭)", () => {
    expect(makeGroup([undefined, undefined]).prefillByteBudget()).toBe(0);
    expect(makeGroup([0]).prefillByteBudget()).toBe(0);
    expect(makeGroup([0, 4_800_000]).prefillByteBudget()).toBe(
      Math.floor(4_800_000 * DEVICE_BUFFER_HEADROOM_RATIO),
    ); // 0 视为未宣告,不参与取最小
  });
});

// ---------------------------------------------------------------------------
// ② 逐出规则绝不低估真实排队字节(团队最担心的漏算点)
// ---------------------------------------------------------------------------
describe("QA②pruneRecent 不低估未播字节", () => {
  it("过去 40s + 未来 30s 的缓存:逐出后**未播字节完整保留**,只是丢掉已播尾巴", () => {
    const now = 100_000_000_000n; // 100000s,避免 on的边界
    setNowUsOverride(() => now);
    const g = makeGroup([4_800_000]);
    // i=-40..30:ts = now + i 秒,每块 1s / 1000B
    const entries = Array.from({ length: 71 }, (_, k) => {
      const i = k - 40; // -40..30
      return { tsUs: now + BigInt(i) * S, durUs: 1_000_000, bytes: 1_000 };
    });
    seedRing(g, "flac:100", entries);

    // 逐出前:未播(i≥0)共 31 块 = 31000B
    expect(g.bufferedCompressedBytes()).toBe(31_000);
    (g as any).pruneRecent();
    // 逐出后**不得改变未播统计**(这正是「只留未来 1s 尾巴」是否漏算的判据)
    expect(g.bufferedCompressedBytes()).toBe(31_000);
  });

  it("35s 缓存上限 vs 30s 最深水位:未播 30s 段不会被 35s 封顶截断", () => {
    const now = 100_000_000_000n;
    setNowUsOverride(() => now);
    const g = makeGroup([4_800_000]);
    // 新成员起播后最深处:游标领先 now ≤30s。构造 now..now+30s 未播 + 更早的已播段。
    const entries = [
      ...Array.from({ length: 20 }, (_, k) => ({ tsUs: now - BigInt(20 - k) * S, durUs: 1_000_000, bytes: 500 })), // 过去 20s
      ...Array.from({ length: 30 }, (_, k) => ({ tsUs: now + BigInt(k) * S, durUs: 1_000_000, bytes: 1_000 })), // 未来 30s
    ];
    seedRing(g, "flac:100", entries);
    (g as any).pruneRecent();
    // 未来 30s 全部保留(35s 上限 > 30s 最深水位)
    expect(g.bufferedCompressedBytes()).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// ③ seedLateJoin:多成员不同容量 → 取最小容量做字节封顶
// ---------------------------------------------------------------------------
describe("QA③seedLateJoin 多成员取最小容量封顶", () => {
  function fixture(caps: Array<number | undefined>) {
    setNowUsOverride(() => 100_000_000n);
    const g = makeGroup(caps);
    (g as any).commonSendAheadUs = () => 800_000;
    const sent: Array<{ ts: bigint; bytes: number }> = [];
    const c: any = {
      clientId: "C:QA",
      codec: "flac",
      appliedGain: () => 100,
      clientWantsStream: () => true,
      announceStream: () => {},
      sendAudio: (ts: bigint, data: Uint8Array) => sent.push({ ts, bytes: data.length }),
    };
    // target = now + 800ms + 100ms = 100900000;每块 40KB。
    seedRing(g, "flac:100", Array.from({ length: 200 }, (_, i) => ({
      tsUs: 100_900_000n + BigInt(i) * 85_000n,
      durUs: 85_000,
      bytes: 40_000,
    })));
    return { g, c, sent };
  }

  it("4.8MB + 1.6MB 两成员 → 按 1.6MB×0.6 = 960000B 封顶(不是 4.8MB)", () => {
    const { g, c, sent } = fixture([4_800_000, 1_600_000]);
    const n = g.seedLateJoin(c);
    const total = sent.reduce((a, s) => a + s.bytes, 0);
    expect(n).toBeGreaterThan(0);
    expect(total).toBe(960_000); // 24 块 × 40KB
    expect(sent.length).toBe(24);
  });
});

// ---------------------------------------------------------------------------
// ④ ★ 运行时集成:streamEngine 的字节闸真的会「停灌」
//    工程师 9 例完全没覆盖此路径 —— 这里用最小桩 group 驱动 pushLoop。
// ---------------------------------------------------------------------------
describe("QA④集成:streamEngine 预填充字节闸在运行时生效(停灌)", () => {
  /** 桩 group:pushFrame 逐帧递增 frames;bufferedCompressedBytes 由 frames 派生。 */
  function stubGateGroup(budget: number, bytesPerFrame: number) {
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

  async function runBurst(budget: number): Promise<{ frames: number; logs: string[] }> {
    const { group, server, logs, frames } = stubGateGroup(budget, 100_000);
    overridePumpSource(async (): Promise<GroupAudio> => ({
      pcm: new Float32Array(20 * 48_000 * 2),
      durationMs: 20_000,
    }));
    const pump = new GroupPump(server, group);
    await pump.play(`integ-${budget}`);
    await new Promise((r) => setTimeout(r, 300)); // 观察突进阶段
    pump.stop();
    return { frames: frames(), logs: logs.slice() };
  }

  it("预算=100000、每帧派生 100000B:第 1 帧后即达预算 → 突进被压住(远少于无闸)", async () => {
    process.env.SENDSPIN_PREFILL_MS = "5000"; // 目标 5s:无闸会一次灌 ~168 帧
    try {
      const off = await runBurst(0); // 无闸(向后兼容路径)
      const on = await runBurst(100_000); // 有闸
      console.log(`[QA④] 突进帧数 无闸=${off.frames} 有闸=${on.frames}(300ms 窗口)`);
      // 无闸:一次性灌到 5s 水位 → 大量突进帧
      expect(off.frames).toBeGreaterThan(60);
      // 有闸:第 1 帧即达预算,停灌,之后实时配速 → 30ms 窗口内数量很小
      expect(on.frames).toBeLessThan(40);
      expect(on.frames).toBeLessThan(off.frames);
      // 一次性日志:证明「时长口径偏浅、已按真实排队字节闭环」
      expect(on.logs.some((m) => m.includes("真实排队字节"))).toBe(true);
    } finally {
      delete process.env.SENDSPIN_PREFILL_MS;
    }
  }, 20_000);
});
