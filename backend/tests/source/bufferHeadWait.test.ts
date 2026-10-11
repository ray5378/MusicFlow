// ==================== batch44-R:整曲缓冲有界等待(首字节优先)回归守卫 ====================
//
// 主线:首字节优先 —— bufferNetworkSource 对 single-flight 共享循环只做**有界等待**
// (STREAM_BUFFER_HEAD_WAIT_MS,默认 6s),超时回退既有直通路径,且**不取消**后台
// 循环(缓冲落地后下一个请求 join 在途循环即可命中)。本文件三条用例:
//   (a) 缓冲在 head-wait 内完成 ⇒ 行为与改造前完全一致(membuf 回环供流);
//   (b) 缓冲超 head-wait ⇒ ~N ms 返回直通 URL,后台循环仍在跑且可被 join 命中;
//   (c) prefetchHit 命中路径零等待,不受 head-wait 影响。
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
  resetMemStreamsForTest,
  resetRetryLoopsForTest,
  retryLoopKeysForTest,
} from "../../src/services/source/bufferedFetch.js";
import { resolveTranscodeInput } from "../../src/routes/rest/index.js";

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

const ROW_W = { id: "hw-w", type: "local", path: "w:hwsrc:/dav/a.flac", size: 5 * MB, url: null, streamHeaders: null, cachePath: null };

// ---------------- 假上游 ----------------
type Mode = "ok" | "500";
let mode: Mode = "ok";
let calls: Array<{ url: string }> = [];
/** 第一路取流是否卡住(证明 head-wait 超时后共享循环没有被取消)。 */
let blockFirst = false;
let releaseFirst: () => void = () => {};

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
    const chunks = [Buffer.alloc(4096, 7)];
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
});
