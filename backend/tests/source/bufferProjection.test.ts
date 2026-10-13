// ==================== 2026-10-13:投影早退 + 冷播放搭车 回归守卫 ====================
//
// 背景:起播有界等待分档(总大小已知 8s / 未知 6s,env 钳 ≤8000)之后,慢源(在线源
// 实测 0.85~2.3MB/s)不能傻等到上界 —— bufferNetworkSource 读 single-flight 循环的
// 取流进度(bufferedFetch 的 progress sink),按 100ms tick 推算「照此速率整曲还要
// 多久」,超上界立即回退直通(后台循环照常跑);同一首(解析后 id)有预取正在飞时,
// 冷播放搭车等这一份落地,不起第二份下载。
//
// 本文件两组:
//   一、纯函数单测(projectedTotalMs / shouldBailEarly,不摸 DB/网络);
//   二、集成(过 resolveTranscodeInput 真路径 + 假上游):
//      (i)   快源:上界内落地 ⇒ membuf 回环(与改造前一致);
//      (ii)  慢源:投影超上界 ⇒ 远早于上界回退直通,后台循环不取消、可再命中;
//      (iii) 搭车:预取在途 ⇒ 冷播放零额外上游(calls 不 +1)。
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { sqlite } from "../../src/db/index.js";
import {
  PROJECTION_MIN_OBSERVE_MS,
  PROJECTION_MIN_SAMPLE_BYTES,
  PROJECTION_TICK_MS,
  projectedTotalMs,
  shouldBailEarly,
} from "../../src/services/source/bufferedFetch.js";
import {
  bindLoopbackBase,
  prefetchInFlight,
  prefetchSong,
  resetPrefetchForTest,
} from "../../src/services/source/prefetchCache.js";
import {
  resetMemStreamsForTest,
  resetRetryLoopsForTest,
  retryLoopKeysForTest,
} from "../../src/services/source/bufferedFetch.js";
import { resolveTranscodeInput } from "../../src/routes/rest/index.js";

// 与 bufferHeadWait.test.ts 同款 hoisted mock:探活/播放优选可确定性触发,不摸真实
// 文件系统 / 不发 HEAD。⚠ localSourceProbe 只**部分** mock —— 保留真实的 parseSongPath。
const ph = vi.hoisted(() => ({
  probeOk: vi.fn(async (_song: any) => true),
  active: true,
  preferLocal: true,
  fallbackToWeb: true,
}));

vi.mock("../../src/utils/localSourceProbe.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, probeLocalSourceOk: (song: any) => ph.probeOk(song) };
});

vi.mock("../../src/services/plugin/core/playPreference.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    playPreferenceActive: () => ph.active,
    preferLocalEnabled: () => ph.preferLocal,
    fallbackToWebEnabled: () => ph.fallbackToWeb,
  };
});

const MB = 1024 * 1024;
const DAV_ORIGIN = "http://127.0.0.1:18779";
const ROW_W = { id: "bp-w", type: "local", path: "w:bpsrc:/dav/a.flac", size: 5 * MB, url: null, streamHeaders: null, cachePath: null };

// ---------------- 假上游(可编排:总大小 + chunk 间隔) ----------------
let calls: Array<{ url: string }> = [];
let totalBytes = 2 * MB;
let gapMs = 0;
const CHUNK = 300 * 1024;

function installFetchStub(): void {
  vi.stubGlobal("fetch", vi.fn(async (url: any) => {
    calls.push({ url: String(url) });
    const total = totalBytes;
    let sent = 0;
    return {
      status: 200,
      headers: { get: (k: string) => (String(k).toLowerCase() === "content-length" ? String(total) : null) },
      body: {
        getReader: () => ({
          read: async () => {
            if (sent >= total) return { done: true, value: undefined };
            const n = Math.min(CHUNK, total - sent);
            const first = sent === 0;
            sent += n;
            // 首 chunk 立即可得(模拟 TTFB 快);后续 chunk 按 gapMs 节流(慢源编排)。
            if (!first && gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
            // 合法 FLAC 头 + 零填充:预取完整性判官的 sniffMagic 认音频;parseBuffer
            // 对假头解析失败 ⇒ 判官保守放过(与 bufferHeadWait.test.ts 同款语义)。
            const value = first
              ? Buffer.concat([Buffer.from("fLaC", "latin1"), Buffer.alloc(n - 4, 0)])
              : Buffer.alloc(n, 0);
            return { done: false, value };
          },
          cancel: async () => {},
        }),
        cancel: async () => {},
      },
    };
  }));
}

beforeAll(() => {
  bindLoopbackBase(() => "http://127.0.0.1:1");
  sqlite
    .prepare("INSERT INTO media_sources (id, name, type, config) VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING")
    .run("bpsrc", "bp", "webdav", JSON.stringify({ url: DAV_ORIGIN + "/dav", username: "u", password: "p" }));
  sqlite
    .prepare("INSERT INTO songs (id, title, path, type, size, duration, suffix) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING")
    .run(ROW_W.id, "t-" + ROW_W.id, ROW_W.path, ROW_W.type, ROW_W.size, 200, "flac");
});

beforeEach(() => {
  resetPrefetchForTest();
  resetMemStreamsForTest();
  resetRetryLoopsForTest();
  installFetchStub();
  calls = [];
  totalBytes = 2 * MB;
  gapMs = 0;
  ph.probeOk.mockReset();
  ph.probeOk.mockImplementation(async () => true);
  ph.active = true;
  ph.preferLocal = true;
  ph.fallbackToWeb = true;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.STREAM_BUFFER_HEAD_WAIT_MS;
});

/** 轮询等待条件成立(超时即失败)。 */
async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ==================== 一、投影推算纯函数 ====================

describe("投影推算纯函数(projectedTotalMs / shouldBailEarly)", () => {
  it("护栏常量:最少观察 1200ms / 最少采样 256KB / tick 100ms", () => {
    expect(PROJECTION_MIN_OBSERVE_MS).toBe(1_200);
    expect(PROJECTION_MIN_SAMPLE_BYTES).toBe(256 * 1024);
    expect(PROJECTION_TICK_MS).toBe(100);
  });

  it("size 未知(无 Content-Length)⇒ null(不得据此早退,按固定上界等)", () => {
    expect(projectedTotalMs(5 * MB, 5_000, null)).toBeNull();
  });

  it("size 非正 ⇒ null", () => {
    expect(projectedTotalMs(5 * MB, 5_000, 0)).toBeNull();
    expect(projectedTotalMs(5 * MB, 5_000, -1)).toBeNull();
  });

  it("观测不足:elapsed < 1200ms ⇒ null(刚下一点,速率没有意义)", () => {
    expect(projectedTotalMs(900 * 1024, 1_199, 56 * MB)).toBeNull();
  });

  it("观测不足:downloaded < 256KB ⇒ null(样本不足,速率不可信)", () => {
    expect(projectedTotalMs(256 * 1024 - 1, 5_000, 56 * MB)).toBeNull();
  });

  it("边界值刚好达标即参与推算(1200ms / 256KB)", () => {
    // rate = 262144/1200 ≈ 218.45 B/ms;剩余 786432B ⇒ 3600ms;合计 4800ms。
    expect(projectedTotalMs(256 * 1024, 1_200, 1 * MB)).toBe(4_800);
  });

  it("已下完(downloaded ≥ size)⇒ 直接返回 elapsed", () => {
    expect(projectedTotalMs(2 * MB, 1_500, 2 * MB)).toBe(1_500);
    expect(projectedTotalMs(3 * MB, 1_500, 2 * MB)).toBe(1_500);
  });

  it("快源投影小:1MB@1200ms、总 2MB ⇒ 共 2400ms", () => {
    expect(projectedTotalMs(1 * MB, 1_200, 2 * MB)).toBe(2_400);
  });

  it("NaN 防护( downloaded / elapsed 任一非有限数 ⇒ null )", () => {
    expect(projectedTotalMs(NaN, 5_000, 56 * MB)).toBeNull();
    expect(projectedTotalMs(5 * MB, NaN, 56 * MB)).toBeNull();
  });

  it("shouldBailEarly:无进度 ⇒ false(没观测不赌)", () => {
    expect(shouldBailEarly(null, 8_000)).toBe(false);
  });

  it("shouldBailEarly:投影低于上界 ⇒ false(等得到,继续等)", () => {
    expect(shouldBailEarly({ downloaded: 1 * MB, elapsedMs: 1_200, sizeBytes: 2 * MB }, 8_000)).toBe(false);
  });

  it("shouldBailEarly:投影高于上界 ⇒ true(立即回退直通)", () => {
    // 2MB/s 源、56MB 文件:1200ms 观测 ⇒ 共 ~28s,远超 8s 上界。
    expect(shouldBailEarly({ downloaded: 2 * MB, elapsedMs: 1_000 + 200, sizeBytes: 56 * MB }, 8_000)).toBe(true);
  });

  it("shouldBailEarly:观测不足/size 未知 ⇒ false(宁可多等,不可误判)", () => {
    expect(shouldBailEarly({ downloaded: 100 * 1024, elapsedMs: 5_000, sizeBytes: 56 * MB }, 8_000)).toBe(false);
    expect(shouldBailEarly({ downloaded: 5 * MB, elapsedMs: 100, sizeBytes: 56 * MB }, 8_000)).toBe(false);
    expect(shouldBailEarly({ downloaded: 5 * MB, elapsedMs: 5_000, sizeBytes: null }, 8_000)).toBe(false);
  });
});

// ==================== 二、集成(真路径 + 假上游) ====================

describe("投影早退 + 冷播放搭车(过 resolveTranscodeInput)", () => {
  it("(i) 快源:上界内整曲落地 ⇒ membuf 回环供流(与改造前一致)", async () => {
    totalBytes = 2 * MB;
    gapMs = 0; // 首字节后瞬间填完
    const src = await resolveTranscodeInput({}, ROW_W, { buffering: true });
    expect(src?.source).toContain("/rest/membuf/");
    expect(calls.length).toBe(1); // 正常整曲缓冲打了一路上游
    await waitFor(() => retryLoopKeysForTest().length === 0);
  });

  it("(ii) 慢源:投影超上界 ⇒ 远早于上界回退直通,后台循环不取消", async () => {
    totalBytes = 56 * MB;
    gapMs = 1_500; // 300KB/1.5s ≈ 0.2MB/s ⇒ 整曲 ~4.6min,投影必超 8s 上界
    const t0 = Date.now();
    const src = await resolveTranscodeInput({}, ROW_W, { buffering: true });
    const elapsed = Date.now() - t0;
    // 投影早退:观测满 1200ms 后几个 tick 内退出 —— 必须远小于 8s 固定上界,
    // 且不小于最小观察窗(证明不是没判断就退)。
    expect(elapsed).toBeGreaterThanOrEqual(PROJECTION_MIN_OBSERVE_MS);
    expect(elapsed).toBeLessThan(4_000);
    expect(src?.source).not.toContain("/rest/membuf/");
    expect(src?.source).toContain("/rest/dlna/stream/"); // loopbackRawStreamUrl 直通
    // 后台 single-flight 循环仍在跑(key 未注销 ⇒ 未被取消),缓冲落地后下一个请求可命中。
    expect(retryLoopKeysForTest()).toContain(`song:${ROW_W.id}`);

    // 上游转快 ⇒ 后台循环落地(仍只此一路,没有第二份下载)。
    gapMs = 0;
    await waitFor(() => retryLoopKeysForTest().length === 0, 15_000);
    expect(calls.length).toBe(1);
  });

  it("(iii) 搭车:预取在途 ⇒ 冷播放零额外上游(calls 不 +1)", async () => {
    totalBytes = 1 * MB;
    gapMs = 400; // 4 chunk ≈ 1.2s 落地 —— 冷播放进来时预取必定还在飞
    const pPref = prefetchSong(ROW_W.id);
    await waitFor(() => prefetchInFlight(ROW_W.id) !== null); // 预取真正开跑后再冷播放
    const src = await resolveTranscodeInput({}, ROW_W, { buffering: true });
    // 搭车命中:直接用预取那一份的内存回环,没有起第二份下载。
    expect(src?.source).toContain("/rest/membuf/");
    expect(calls.length).toBe(1);
    await pPref;
  });

  it("(iii-b) 预取未在途(未触发)⇒ 不走搭车,冷路径照常", async () => {
    totalBytes = 2 * MB;
    gapMs = 0;
    expect(prefetchInFlight(ROW_W.id)).toBeNull();
    const src = await resolveTranscodeInput({}, ROW_W, { buffering: true });
    expect(src?.source).toContain("/rest/membuf/");
    expect(calls.length).toBe(1);
    // 冷路径自己走 single-flight(与改造前一致),播完即注销。
    await waitFor(() => retryLoopKeysForTest().length === 0);
  });
});
