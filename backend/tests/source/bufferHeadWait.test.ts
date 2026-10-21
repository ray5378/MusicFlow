// ==================== batch44-R:整曲缓冲有界等待(首字节优先)回归守卫 ====================
//
// 主线:首字节优先 —— bufferNetworkSource 对 single-flight 共享循环只做**有界等待**
// (STREAM_BUFFER_HEAD_WAIT_MS,默认 6s),超时回退既有直通路径,且**不取消**后台
// 循环(缓冲落地后下一个请求 join 在途循环即可命中)。本文件三条用例:
//   (a) 缓冲在 head-wait 内完成 ⇒ 行为与改造前完全一致(membuf 回环供流);
//   (b) 缓冲超 head-wait ⇒ ~N ms 返回直通 URL,后台循环仍在跑且可被 join 命中;
//   (c) prefetchHit 命中路径零等待,不受 head-wait 影响;
//   (d)(e) 大文件直通:默认关闭(全缓冲),只有 DLNA 插件开关+DLNA 链路才生效;
//   (f)(g)(h) 播放路径完整性判官:preview/not-audio 判死并跳,too-small 直通不记负缓存。
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { sqlite } from "../../src/db/index.js";
import {
  bindLoopbackBase,
  prefetchHit,
  prefetchSong,
  resetPrefetchForTest,
} from "../../src/services/source/prefetchCache.js";
import {
  fetchSongWithRetryWindow,
  PROJECTION_MIN_OBSERVE_MS,
  PROJECTION_MIN_SAMPLE_BYTES,
  PROJECTION_TICK_MS,
  resetMemStreamsForTest,
  resetRetryLoopsForTest,
  retryLoopKeysForTest,
} from "../../src/services/source/bufferedFetch.js";
import {
  clearStreamFallbackCache,
  getCachedPlayability,
} from "../../src/services/source/online/streamFallback.js";
import {
  resolveTranscodeInput,
  STREAM_BUFFER_HEAD_WAIT_MS,
  STREAM_BUFFER_HEAD_WAIT_UNKNOWN_MS,
  STREAM_BUFFER_SKIP_OVER_MB,
  headWaitCeilingMs,
  streamBufferSkipOverBytes,
} from "../../src/routes/rest/index.js";

// 判官用的 metadata:默认 200s(与库内基准一致 ⇒ 不判死);各用例单独覆写。
const mm = vi.hoisted(() => ({ duration: 200 }));
vi.mock("music-metadata", () => ({
  parseBuffer: async () => ({ format: { duration: mm.duration, bitrate: 0, container: "flac" }, common: {} }),
}));

// 与 prefetchCache.test.ts 同款 hoisted mock:探活/播放优选可确定性触发,不摸真实
// 文件系统 / 不发 HEAD。⚠ localSourceProbe 只**部分** mock —— 保留真实的 parseSongPath,
// 否则 networkInput 的路径解析会被打断。
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
const DAV_ORIGIN = "http://127.0.0.1:18778";

const ROW_W = { id: "hw-w", type: "local", path: "w:hwsrc:/dav/a.flac", size: 5 * MB, duration: 200, url: null, streamHeaders: null, cachePath: null };

// ---------------- 假上游 ----------------
type Mode = "ok" | "500";
let mode: Mode = "ok";
let calls: Array<{ url: string }> = [];
/** 第一路取流是否卡住(证明 head-wait 超时后共享循环没有被取消)。 */
let blockFirst = false;
let releaseFirst: () => void = () => {};
/** 假上游返回的字节数(>64KB 才过 too-small 档;判官用例会单独改小/改 HTML)。 */
let payloadBytes = 128 * 1024;
/** true = 返回「HTML 错误页当 200」(判官 magic 档)。 */
let htmlPayload = false;

function installFetchStub(): void {
  vi.stubGlobal("fetch", vi.fn(async (url: any, _init: any) => {
    calls.push({ url: String(url) });
    if (blockFirst && calls.length === 1) {
      await new Promise<void>((r) => { releaseFirst = r; });
    }
    if (mode === "500") {
      return { status: 500, headers: { get: () => null }, body: { cancel: async () => {} } };
    }
    let i = 0;
    // 合法 FLAC 头 + 填充(或 HTML 错误页)。metadata 由 music-metadata mock 控制。
    const head = htmlPayload ? Buffer.from("<html><body>403 Forbidden</body></html>", "utf8") : Buffer.from("fLaC", "latin1");
    const body = Buffer.concat([head, Buffer.alloc(Math.max(1, payloadBytes - head.length), 0x20)]);
    const chunks = [body];
    return {
      status: 200,
      headers: { get: (_: string) => null },
      body: {
        getReader: () => ({
          read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }),
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
    .run("hwsrc", "hw", "webdav", JSON.stringify({ url: DAV_ORIGIN + "/dav", username: "u", password: "p" }));
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
  mode = "ok";
  blockFirst = false;
  releaseFirst = () => {};
  payloadBytes = 128 * 1024;
  htmlPayload = false;
  mm.duration = 200;
  clearStreamFallbackCache();
  ph.probeOk.mockReset();
  ph.probeOk.mockImplementation(async () => true);
  ph.active = true;
  ph.preferLocal = true;
  ph.fallbackToWeb = true;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.STREAM_BUFFER_HEAD_WAIT_MS;
  delete process.env.STREAM_BUFFER_SKIP_OVER_MB;
});

/** 轮询等待条件成立(不用 vi.waitUntil,避免版本差异;超时即失败)。 */
async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("batch44-R:整曲缓冲有界等待(首字节优先)", () => {
  it("(a) 缓冲在 head-wait 内完成 ⇒ 与现在一致(membuf 回环供流)", async () => {
    process.env.STREAM_BUFFER_HEAD_WAIT_MS = "2000";
    const src = await resolveTranscodeInput({}, ROW_W, { buffering: true });
    expect(calls.length).toBe(1); // 正常整曲缓冲打了一路上游
    expect(src?.source).toContain("/rest/membuf/");
  });

  it("(b) 缓冲超 head-wait ⇒ ~N ms 返回直通,后台循环不取消且可被 join 命中", async () => {
    process.env.STREAM_BUFFER_HEAD_WAIT_MS = "60";
    blockFirst = true;
    const p = resolveTranscodeInput({}, ROW_W, { buffering: true });
    await waitFor(() => calls.length === 1); // 上游已被打到(此刻被卡住)
    const t0 = Date.now();
    const src = await p;
    const elapsed = Date.now() - t0;
    // ~60ms 量级返回(远小于 18s 单次 deadline / 30min 重试窗口),走既有直通路径。
    expect(elapsed).toBeLessThan(2000);
    expect(src?.source).not.toContain("/rest/membuf/");
    expect(src?.source).toContain("/rest/dlna/stream/"); // loopbackRawStreamUrl 直通
    // 后台共享循环仍在跑(key 未注销 ⇒ 循环未被取消)
    expect(retryLoopKeysForTest()).toContain(`song:${ROW_W.id}`);

    // 下一个请求 join 在途循环;释放上游 ⇒ 缓冲落地,join 命中(只此一路,无第二次取流)。
    const joiner = fetchSongWithRetryWindow(`song:${ROW_W.id}`, DAV_ORIGIN + "/dav/a.flac", {}, {});
    await new Promise((r) => setTimeout(r, 30));
    releaseFirst();
    const jr = await joiner;
    expect(jr.ok).toBe(true);
    expect(calls.length).toBe(1);
    await waitFor(() => retryLoopKeysForTest().length === 0); // 循环结束 ⇒ key 正常注销
  });

  it("(c) prefetchHit 命中路径零等待,不受 head-wait 影响", async () => {
    process.env.STREAM_BUFFER_HEAD_WAIT_MS = "1"; // 极小:命中路径若被波及会立刻露馅
    await prefetchSong(ROW_W.id);
    expect(calls.length).toBe(1);
    const hit = prefetchHit(ROW_W.id);
    expect(hit).toBeTruthy();
    const src = await resolveTranscodeInput({}, ROW_W, { buffering: true });
    expect(src?.source).toBe(hit); // 预取命中 ⇒ 直接内存回环,零上游往返
    expect(calls.length).toBe(1);
  });

  it("(d) DLNA 开关打开 + 已知总字节超阈值 ⇒ 连整曲缓冲都不起,直接直通", async () => {
    process.env.STREAM_BUFFER_SKIP_OVER_MB = "1"; // ROW_W.size = 5MB > 1MB
    const src = await resolveTranscodeInput({}, ROW_W, { buffering: true, largeFileDirect: true });
    expect(calls.length).toBe(0); // 一次上游都没打:不浪费 1.5~8s
    expect(src?.source).toContain("/rest/dlna/stream/"); // 既有直通通道
    expect(src?.source).not.toContain("/rest/membuf/");
  });

  it("(e) 默认关闭:HTTP 链路即便 env=1 也全缓冲;阈值只有 DLNA 开关+链路才生效", async () => {
    // 未传 largeFileDirect(HTTP / AirPlay 链路)⇒ 即便 env 给了阈值也必须整曲缓冲。
    process.env.STREAM_BUFFER_SKIP_OVER_MB = "1";
    const http = await resolveTranscodeInput({}, ROW_W, { buffering: true });
    expect(calls.length).toBe(1);
    expect(http?.source).toContain("/rest/membuf/");

    // 阈值函数:清掉 env 后再验证"默认关"语义(env 是运维覆盖,优先级最高)。
    delete process.env.STREAM_BUFFER_SKIP_OVER_MB;
    expect(streamBufferSkipOverBytes(false)).toBe(0);
    expect(streamBufferSkipOverBytes(true)).toBe(STREAM_BUFFER_SKIP_OVER_MB * 1024 * 1024);
    expect(STREAM_BUFFER_SKIP_OVER_MB).toBe(20);
    process.env.STREAM_BUFFER_SKIP_OVER_MB = "0";
    expect(streamBufferSkipOverBytes(true)).toBe(0);
  });

  it("(f) 播放路径判官:试听片段(实际 30s vs 期望 200s)⇒ 判死 + 负缓存 + 显式失败", async () => {
    mm.duration = 30;
    const src = await resolveTranscodeInput({}, ROW_W, { buffering: true });
    expect(src).toBeNull();                       // 显式失败 ⇒ 客户端跳下一首
    expect(getCachedPlayability(ROW_W.id)).toBe("unplayable");
    expect(prefetchHit(ROW_W.id)).toBeNull();     // 判死的缓存不登记
  });

  it("(g) 播放路径判官:HTML 错误页当 200(>64KB)⇒ not-audio 判死 + 负缓存", async () => {
    htmlPayload = true;
    const src = await resolveTranscodeInput({}, ROW_W, { buffering: true });
    expect(src).toBeNull();
    expect(getCachedPlayability(ROW_W.id)).toBe("unplayable");
  });

  it("(h) 播放路径判官:too-small 是弱信号 ⇒ 不判死、不记负缓存、回退直通", async () => {
    payloadBytes = 1024; // <64KB
    const src = await resolveTranscodeInput({}, ROW_W, { buffering: true });
    expect(src?.source).toContain("/rest/dlna/stream/"); // 落既有直通通道
    expect(src?.source).not.toContain("/rest/membuf/");
    expect(getCachedPlayability(ROW_W.id)).toBe("unknown"); // 绝不能误标无源
  });
});

// ==================== 跨仓契约:首字节等待 ↔ 客户端看门狗判死上界 ====================
//
// 客户端「平台未接管音源(idle)」一档的判死上界必须**严格大于**本服务的整曲缓冲
// 首字节等待,否则服务端仍在合法缓冲窗口内、客户端已抢先判死 → 无谓 reload/跳歌
// (还会拆掉在途请求、让服务端重开重试窗口)。客户端权威常量:
//   MusicFlow-client/lib/providers/player/player_watchdog_policy.dart
//     kStreamLoadIdleCeilingMs = 10000
//     kStreamLoadHeadWaitAlignmentMarginMs = 1500
// 对应客户端侧守卫:b50g_watchdog_queue_policy_test.dart「六、跨仓契约」组。
describe("跨仓契约:整曲缓冲首字节等待 ↔ 客户端 idle 判死上界", () => {
  it("默认 head-wait 须严格低于客户端 idle 判死上界,且留 ≥1500ms 余量", () => {
    const CLIENT_IDLE_STUCK_CEILING_MS = 10_000; // = 客户端 kStreamLoadIdleCeilingMs
    const MARGIN_MS = 1_500; // = 客户端 kStreamLoadHeadWaitAlignmentMarginMs
    expect(STREAM_BUFFER_HEAD_WAIT_MS).toBeLessThan(CLIENT_IDLE_STUCK_CEILING_MS);
    expect(STREAM_BUFFER_HEAD_WAIT_MS + MARGIN_MS).toBeLessThanOrEqual(
      CLIENT_IDLE_STUCK_CEILING_MS,
    );
  });

  it("2026-10-13 分档:已知 8s / 未知 6s,两档都满足跨仓契约", () => {
    // 客户端镜像 kServerStreamBufferHeadWaitMs 必须等于已知档 8000 —— v5.8.4 起
    // 对齐;客户端侧等值守卫在 b50g_watchdog_queue_policy_test.dart「六、跨仓契约」组。
    expect(STREAM_BUFFER_HEAD_WAIT_MS).toBe(8_000);
    expect(STREAM_BUFFER_HEAD_WAIT_UNKNOWN_MS).toBe(6_000);
    expect(headWaitCeilingMs(true)).toBe(8_000);
    expect(headWaitCeilingMs(false)).toBe(6_000);
    const CLIENT_IDLE_STUCK_CEILING_MS = 10_000;
    const MARGIN_MS = 1_500;
    for (const ceiling of [STREAM_BUFFER_HEAD_WAIT_MS, STREAM_BUFFER_HEAD_WAIT_UNKNOWN_MS]) {
      expect(ceiling).toBeLessThan(CLIENT_IDLE_STUCK_CEILING_MS);
      expect(ceiling + MARGIN_MS).toBeLessThanOrEqual(CLIENT_IDLE_STUCK_CEILING_MS);
    }
  });

  it("env 覆写被钳 ≤8000(反代 ~10s 超时线前的安全余量),且两档统一", () => {
    process.env.STREAM_BUFFER_HEAD_WAIT_MS = "99999";
    expect(headWaitCeilingMs(true)).toBe(8_000);
    expect(headWaitCeilingMs(false)).toBe(8_000);
    process.env.STREAM_BUFFER_HEAD_WAIT_MS = "3000"; // 调低允许(测试/运维注入)
    expect(headWaitCeilingMs(true)).toBe(3_000);
    expect(headWaitCeilingMs(false)).toBe(3_000);
  });

  it("投影判据护栏值(最小观测窗 / 最小采样 / tick)", () => {
    expect(PROJECTION_MIN_OBSERVE_MS).toBe(1_200);
    expect(PROJECTION_MIN_SAMPLE_BYTES).toBe(256 * 1024);
    expect(PROJECTION_TICK_MS).toBe(100);
  });
});
