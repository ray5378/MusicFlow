// ==================== 下一首预缓冲(prefetchCache)回归守卫 ====================
//
// 第一优先级是「绝不能影响正在播放的流」。本文件按这条主线组织:
//   ① 命中后不再触发上游取流(预取真的被用上了,且播放路径更短);
//   ② 正在播的 membuf 条目不会被预取顶掉(驱逐策略双向变异);
//   ③ 预取与播放不共用 single-flight(红线:播放请求不得继承预取的 cfg);
//   ④ 五道闸门各自生效(不做无意义的预取);
//   ⑤ 取流失败全静默(不抛、不写 streamFallback 可播性缓存);
//   ⑥ 出流与预取对同一首歌推导出完全相同的 url + headers;
//   ⑦ 完整性判官:试听片段(实际时长比曲库基准短 >15s)/假成功(HTML 错误页)/过小文件
//      ⇒ 不登记预取 + 记无源负缓存;无基准/差值 ≤15s/开关关闭 ⇒ 一律放过。
//      码率推算路径(duration 缺失,ogg 等)判死线单独放宽到 80s(推算是近似值,防误杀)。
//   ⑧ 判官组内换源:首选行判死 ⇒ 试同组其他网络源(双写索引),全部判死才把队列行
//      也标负缓存(judgePlayable 按队列行 id 判跳);有候选没评估 ⇒ 不标队列行。
//   ⑨ 配置走 settings(UI「媒体获取」页保存即生效):enabled/lookahead/maxAltSources/delta。
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { sqlite } from "../../src/db/index.js";
import {
  PREFETCH_LOOKAHEAD,
  bindLoopbackBase,
  judgePrefetchedBuffer,
  prefetchAliasesForTest,
  prefetchHit,
  prefetchSong,
  prefetchStats,
  prefetchToken,
  prefetchUpcoming,
  resetPrefetchForTest,
} from "../../src/services/source/prefetchCache.js";
import {
  bufferedInFlightBytes,
  fetchSongWithRetryWindow,
  registerMemStream,
  resetMemStreamsForTest,
  resetRetryLoopsForTest,
  resolveMemStream,
  retryLoopKeysForTest,
} from "../../src/services/source/bufferedFetch.js";
import { resolveNetworkInput } from "../../src/services/source/networkInput.js";
import { getCachedPlayability, markUnplayable, clearStreamFallbackCache } from "../../src/services/source/online/streamFallback.js";
import { getPrefetchSettings, resetPrefetchSettings, setPrefetchSettings } from "../../src/services/source/prefetchConfig.js";
// 出流侧的解析函数(已 export 供本文件做一致性断言):它内部走的就是与预取同一份
// networkInput 推导,这里用「真实调用 + 抓 fetch 入参」证明两边没有漂移。
import { resolveTranscodeInput } from "../../src/routes/rest/index.js";

// 播放优选 + 探活用 hoisted mock:让「组内 web→local 优选」可确定性触发(真实探活要摸
// 文件系统 / 发 HEAD)。⚠ localSourceProbe 只**部分** mock —— 保留真实的 parseSongPath,
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

// music-metadata 的 parseBuffer 由本文件控制返回时长/码率（判官档 3/4 的输入）。
// fail=true 模拟「magic 认音频但 metadata 解析失败」——判官须保守放过。
// duration=0 且 bitrate>0 ⇒ 模拟 ogg 等「duration 缺失、只有码率」的容器（规则 6 兜底路径）。
// queue 非空 ⇒ 按调用序逐次返回（换源测试用：第一个候选判死、第二个放过）。
const mm = vi.hoisted(() => ({ duration: 200, fail: false, bitrate: 0, queue: [] as number[] }));
vi.mock("music-metadata", () => ({
  parseBuffer: async () => {
    if (mm.fail) throw new Error("mock parse failure");
    const d = mm.queue.length > 0 ? (mm.queue.shift() as number) : mm.duration;
    return { format: { duration: d, bitrate: mm.bitrate, container: "flac" }, common: {} };
  },
}));

const MB = 1024 * 1024;
const DAV_ORIGIN = "http://127.0.0.1:18777";

// ---------------- 库内行 ----------------
const ROW_W = { id: "pf-w", type: "local", path: "w:davsrc:/dav/a.flac", size: 5 * MB, url: null, streamHeaders: null, cachePath: null };
const ROW_L = { id: "pf-l", type: "local", path: "l:localdisk:/MUSIC/a.flac", size: 5 * MB, url: null, streamHeaders: null, cachePath: null };
const ROW_BIG = { id: "pf-big", type: "local", path: "w:davsrc:/dav/big.flac", size: 200 * MB, url: null, streamHeaders: null, cachePath: null };
const ROW_WEB = { id: "pf-web", type: "web", path: "web:plugin:x", url: "http://up.example/1.mp3", streamHeaders: null, cachePath: null, size: 0 };
/** 无时长基准行（曲库 duration=0）—— 判官应保守放过。 */
const ROW_NODUR = { id: "pf-nodur", type: "local", path: "w:davsrc:/dav/nodur.flac", size: 5 * MB };

// ---- 同曲多源组(队列 web 行 + 组内 WebDAV 兄弟行) ----
// 复刻 240 实测:队列里是 web 行(type=web),组内兄弟是「核心曲库源」行 —— 这里用
// type=local + path `w:`(WebDAV) 复刻(resolvePreferredSong 的 alt 查询取 type∈{local,webdav},
// 而 networkInput 靠 path 前缀 `w:` 判定它是网络源)。
const GRP = "pf-grp";
const ROW_G_WEB = { id: "pf-gweb", type: "web", path: "web:plugin:x", url: "http://up.example/g.mp3", streamHeaders: null, cachePath: null, size: 0 };
const ROW_G_DAV = { id: "pf-gdav", type: "local", path: "w:davsrc:/dav/g.flac", size: 5 * MB };
/** 组内本地磁盘行(l:)—— 换源测试复刻「队列行是本地行、出流回退组内 web」的形态。 */
const ROW_G_LOCAL = { id: "pf-gloc", type: "local", path: "l:localdisk:/MUSIC/g.flac", size: 5 * MB };

// ---------------- 假上游 ----------------
type Mode = "ok" | "500" | "html" | "tiny";
let mode: Mode = "ok";
let calls: Array<{ url: string; headers: any }> = [];
/** 第 N 次调用(1-based)返回 500;0=不启用(换源测试:制造「首个候选判死、次候选取流失败」)。 */
let failCall = 0;
/** 第一路取流是否卡住(用于「并发闸门」:证明第二路没有提前起飞)。 */
let blockFirst = false;
let releaseFirst: () => void = () => {};

function installFetchStub(): void {
  vi.stubGlobal("fetch", vi.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), headers: init?.headers });
    if (blockFirst && calls.length === 1) {
      await new Promise<void>((r) => { releaseFirst = r; });
    }
    if (mode === "500" || (failCall > 0 && calls.length === failCall)) {
      return { status: 500, headers: { get: () => null }, body: { cancel: async () => {} } };
    }
    let i = 0;
    // 判官专用假数据：html = 上游把错误页当 200 返回；tiny = 合法音频头但小得可怜。
    const chunks: Buffer[] =
      mode === "html"
        ? [Buffer.concat([Buffer.from('<html><body>403 Forbidden</body></html>', "utf8"), Buffer.alloc(80 * 1024, 0x20)])]
        : mode === "tiny"
          ? [Buffer.concat([Buffer.from("fLaC", "latin1"), Buffer.alloc(1024, 0)])]
          : [Buffer.concat([Buffer.from("fLaC", "latin1"), Buffer.alloc(128 * 1024, 0)])];
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
    .run("davsrc", "dav", "webdav", JSON.stringify({ url: DAV_ORIGIN + "/dav", username: "u", password: "p" }));
  for (const r of [ROW_W, ROW_L, ROW_BIG, ROW_WEB]) {
    sqlite
      .prepare("INSERT INTO songs (id, title, path, type, size, duration, suffix) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING")
      .run(r.id, "t-" + r.id, r.path, r.type, r.size, 200, "flac");
  }
  // 无基准行：duration=0（其余同 ROW_W）。
  sqlite
    .prepare("INSERT INTO songs (id, title, path, type, size, duration, suffix) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING")
    .run(ROW_NODUR.id, "t-" + ROW_NODUR.id, ROW_NODUR.path, ROW_NODUR.type, ROW_NODUR.size, 0, "flac");
  // 同曲多源组两行(带 group_id;web 行带 url)。
  const seedGrouped = sqlite.prepare(
    "INSERT INTO songs (id, title, path, type, size, duration, suffix, group_id, url) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
  );
  seedGrouped.run(ROW_G_WEB.id, "t-" + ROW_G_WEB.id, ROW_G_WEB.path, ROW_G_WEB.type, 0, 200, "flac", GRP, ROW_G_WEB.url);
  seedGrouped.run(ROW_G_DAV.id, "t-" + ROW_G_DAV.id, ROW_G_DAV.path, ROW_G_DAV.type, ROW_G_DAV.size, 200, "flac", GRP, null);
  seedGrouped.run(ROW_G_LOCAL.id, "t-" + ROW_G_LOCAL.id, ROW_G_LOCAL.path, ROW_G_LOCAL.type, ROW_G_LOCAL.size, 200, "flac", GRP, null);
});

beforeEach(() => {
  resetPrefetchForTest();
  resetMemStreamsForTest();
  resetRetryLoopsForTest();
  clearStreamFallbackCache(); // 判官写的负缓存跨用例会污染
  installFetchStub();
  calls = [];
  mode = "ok";
  failCall = 0;
  blockFirst = false;
  releaseFirst = () => {};
  ph.probeOk.mockReset();
  ph.probeOk.mockImplementation(async () => true);
  ph.active = true;
  ph.preferLocal = true;
  ph.fallbackToWeb = true;
  mm.duration = 200;
  mm.fail = false;
  mm.bitrate = 0;
  mm.queue = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MEMBUF_MAX_ENTRIES;
  delete process.env.STREAM_BUFFER_BUDGET_MB;
  delete process.env.PREFETCH_INTEGRITY_DELTA_SEC;
  delete process.env.PREFETCH_INTEGRITY_DELTA_SEC_BITRATE;
  delete process.env.PREFETCH_INTEGRITY_OFF;
});

/** 轮询等待条件成立(不用 vi.waitUntil,避免版本差异;超时即失败)。 */
async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** 等预取器彻底静默(无在途/无排队)后再断言「没有取流」。 */
async function quiesce(): Promise<void> {
  await waitFor(() => {
    const s = prefetchStats();
    return s.running === 0 && s.inflight === 0 && s.queued === 0;
  });
  await new Promise((r) => setTimeout(r, 30)); // 给「本就不该发生」的取流留出反悔窗口
}

describe("① 预取命中 ⇒ /rest/stream 不再触发上游取流", () => {
  it("命中后 resolveTranscodeInput 直接回 membuf 回环 URL,上游 fetch 次数不再增加", async () => {
    await prefetchSong(ROW_W.id);
    expect(calls.length).toBe(1); // 预取取了一次
    expect(calls[0].url).toBe(DAV_ORIGIN + "/dav/a.flac");

    const hit = prefetchHit(ROW_W.id);
    expect(hit).toBeTruthy();
    expect(hit!.startsWith("http://127.0.0.1:1/rest/membuf/")).toBe(true);

    const src = await resolveTranscodeInput({}, ROW_W, { buffering: true });
    expect(src?.source).toBe(hit);
    // 关键断言:播放路径没有再打上游(没有「整曲缓冲」那一步)。
    expect(calls.length).toBe(1);
  });

  it("预取条目被清扫回收后,索引同步失效(不会返回一个 403 的死 token)", async () => {
    await prefetchSong(ROW_W.id);
    const token = prefetchToken(ROW_W.id)!;
    expect(token).toBeTruthy();
    const stale = prefetchHit(ROW_W.id)!;
    // 模拟 sweepMemStreams 把条目清掉(TTL / 总字节上限都可能触发)。
    resetMemStreamsForTest();
    expect(prefetchToken(ROW_W.id)).toBeNull();
    expect(prefetchHit(ROW_W.id)).toBeNull();

    // 未命中 ⇒ 回落到既有行为:播放路径**照常自己取流**(而不是返回那个已经失效的回环 URL)。
    const src = await resolveTranscodeInput({}, ROW_W, { buffering: true });
    expect(calls.length).toBe(2);
    expect(src?.source).toContain("/rest/membuf/"); // 这次是播放路径自己缓冲出来的新 token
    expect(src?.source).not.toBe(stale);
  });
});

describe("② 正在播的 membuf 条目不会被驱逐(双向变异)", () => {
  it("注册表满且全部条目都在被消费 ⇒ 放弃登记,不踢任何在用条目", () => {
    // 双向变异:把驱逐改回「按插入序删最旧」后,下面第一个断言(live1 仍在)必然变红。
    process.env.MEMBUF_MAX_ENTRIES = "3";
    const live1 = registerMemStream(Buffer.alloc(1 * MB));
    resolveMemStream(live1); // 正在被 ffmpeg 读 ⇒ pinned
    const live2 = registerMemStream(Buffer.alloc(1 * MB));
    resolveMemStream(live2);
    const live3 = registerMemStream(Buffer.alloc(1 * MB));
    resolveMemStream(live3);

    const overflow = registerMemStream(Buffer.alloc(1 * MB));
    expect(overflow).toBe(""); // 放弃登记(返回空串)
    expect(resolveMemStream(live1)).not.toBeNull(); // 最旧的那条仍在 —— 旧策略会把它踢掉
    expect(resolveMemStream(live2)).not.toBeNull();
    expect(resolveMemStream(live3)).not.toBeNull();
  });

  it("有预取条目可腾位 ⇒ 优先驱逐预取条目,正在播的那条不动", () => {
    process.env.MEMBUF_MAX_ENTRIES = "2";
    const live = registerMemStream(Buffer.alloc(1 * MB));
    resolveMemStream(live); // 正在播
    const prefetched = registerMemStream(Buffer.alloc(1 * MB), undefined, { songId: "x", prefetched: true });

    const fresh = registerMemStream(Buffer.alloc(1 * MB));
    expect(fresh).not.toBe("");
    expect(resolveMemStream(live)).not.toBeNull(); // 正在播的保住了
    expect(resolveMemStream(prefetched)).toBeNull(); // 被踢的是预取那条
  });
});

describe("③ 预取与播放不共用 single-flight", () => {
  it("预取不进 fetchSongWithRetryWindow 的共享循环表,且只尝试一次(retries:0)", async () => {
    mode = "500";
    await prefetchSong(ROW_W.id);
    // 红线:预取绝不能占用播放路径的 single-flight key(`song:${songId}`)。
    expect(retryLoopKeysForTest()).toEqual([]);
    // 后台预取不走「瞬时错误重试」(retries:0)—— 失败一次即放弃,绝不长时间占着上游。
    expect(calls.length).toBe(1);

    // 播放路径自己的 single-flight 仍然照常工作(没被预取污染)。
    mode = "ok";
    const r = await fetchSongWithRetryWindow(`song:${ROW_W.id}`, DAV_ORIGIN + "/dav/a.flac", {}, { retries: 0, deadlineMs: 2000 });
    expect(r.ok).toBe(true);
    expect(calls.length).toBe(2);
  });
});

describe("④ 五道闸门", () => {
  it("l: 本地磁盘行不预取(它根本不走 membuf)", async () => {
    await prefetchSong(ROW_L.id);
    await quiesce();
    expect(calls.length).toBe(0);
    expect(prefetchHit(ROW_L.id)).toBeNull();
  });

  it("单曲超过 STREAM_BUFFER_MAX_MB(100MB)不预取(必然 too-big)", async () => {
    await prefetchSong(ROW_BIG.id);
    await quiesce();
    expect(calls.length).toBe(0);
    expect(prefetchHit(ROW_BIG.id)).toBeNull();
  });

  it("预算闸门:在途+预估 > 全局预算 × 0.5 ⇒ 放弃(给正在播的留一半)", async () => {
    process.env.STREAM_BUFFER_BUDGET_MB = "1"; // 1MB ⇒ 闸门阈值 0.5MB;本曲 5MB
    await prefetchSong(ROW_W.id);
    await quiesce();
    expect(calls.length).toBe(0);
    expect(prefetchHit(ROW_W.id)).toBeNull();
    expect(bufferedInFlightBytes()).toBe(0);
  });

  it("同曲去重:已在索引里 / 已在途 ⇒ 不重复取", async () => {
    await prefetchSong(ROW_W.id);
    expect(calls.length).toBe(1);
    await prefetchSong(ROW_W.id); // 已缓存
    expect(calls.length).toBe(1);
  });

  it("并发闸门:超出并发上限的排队不并发取流(第二路要等第一路取完才起飞)", async () => {
    // PREFETCH_CONCURRENCY = 1:第一路卡住上游 ⇒ 第二路必须**还在排队**、没有发起取流。
    const second = { id: "pf-w2", type: "local", path: "w:davsrc:/dav/b.flac", size: 5 * MB };
    sqlite
      .prepare("INSERT INTO songs (id, title, path, type, size, duration, suffix) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING")
      .run(second.id, "t", second.path, second.type, second.size, 200, "flac");

    blockFirst = true;
    const p1 = prefetchSong(ROW_W.id);
    await waitFor(() => calls.length === 1); // 第一路已打到上游(此刻被闸门卡住)
    const p2 = prefetchSong(second.id);
    await new Promise((r) => setTimeout(r, 80));
    expect(calls.length).toBe(1); // 第二路没起飞 —— 串行,不是并发
    expect(prefetchStats().queued).toBe(1);

    releaseFirst();
    await Promise.all([p1, p2]); // p2 被排队时立即 resolve,这里主要等 p1
    await waitFor(() => calls.length === 2); // 第二路在第一路取完后才串行跟上
    await quiesce();
    expect(calls.length).toBe(2);
    expect(prefetchStats()).toEqual({ cached: 2, inflight: 0, queued: 0, running: 0 });
  });
});

describe("⑤ 预取失败全静默", () => {
  it("上游 500:不抛错、不写可播性缓存、调用方行为不变", async () => {
    mode = "500";
    await expect(prefetchSong(ROW_W.id)).resolves.toBeUndefined();
    expect(prefetchHit(ROW_W.id)).toBeNull();
    // 「慢 / 取不到」绝不能被写成「无源」—— 那是 PreProbe 的地盘,混进去客户端会白跳歌。
    expect(getCachedPlayability(ROW_W.id)).toBe("unknown");
    expect(prefetchStats().running).toBe(0);
  });

  it("prefetchUpcoming 内部异常不外溢(队列写入路径不得被预取污染)", () => {
    expect(() => prefetchUpcoming(undefined, PREFETCH_LOOKAHEAD)).not.toThrow();
    expect(() => prefetchUpcoming({ items: [], currentIndex: -1, playMode: "order" }, PREFETCH_LOOKAHEAD)).not.toThrow();
  });
});

describe("⑥ 出流与预取的 URL 推导完全一致 + 尊重洗牌顺序", () => {
  it("resolveTranscodeInput 交给取流层的 url+headers = resolveNetworkInput 的结果", async () => {
    const expected = await resolveNetworkInput(ROW_W);
    expect(expected).not.toBeNull();

    await resolveTranscodeInput({}, ROW_W, { buffering: true });

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(expected!.url);
    expect(calls[0].headers).toEqual(expected!.headers);
  });

  it("web 行同样一致(带 streamHeaders 时)", async () => {
    sqlite
      .prepare("UPDATE songs SET url = ?, stream_headers = ? WHERE id = ?")
      .run("http://up.example/1.mp3", '{"Referer":"http://ref.example/"}', ROW_WEB.id);
    const expected = await resolveNetworkInput({ ...ROW_WEB, streamHeaders: '{"Referer":"http://ref.example/"}' });
    await resolveTranscodeInput({}, { ...ROW_WEB, streamHeaders: '{"Referer":"http://ref.example/"}' }, { buffering: true });
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(expected!.url);
    expect(calls[0].headers).toEqual(expected!.headers);
  });

  it("order 模式:预取的是 currentIndex+1 那一首(shuffle 序列为空时按序)", async () => {
    prefetchUpcoming(
      { items: [{ songId: ROW_L.id }, { songId: ROW_W.id }], currentIndex: 0, playMode: "order" },
      PREFETCH_LOOKAHEAD,
    );
    await waitFor(() => calls.length > 0);
    await quiesce();
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(DAV_ORIGIN + "/dav/a.flac"); // ROW_W(下标 1),不是 ROW_L
  });

  it("shuffle 模式:按服务端洗牌序列预取,而不是 currentIndex+1", async () => {
    // shuffleOrder=[1,0]、shufflePos=0 ⇒ 序列里的下一个位置是 order[1]=0 ⇒ ROW_L(本地行)。
    // 若实现错用 currentIndex+1,会去取 ROW_W(天翼行)⇒ 下面 calls 断言必然变红。
    prefetchUpcoming(
      {
        items: [{ songId: ROW_L.id }, { songId: ROW_W.id }],
        currentIndex: 0,
        playMode: "shuffle",
        shuffleOrder: [1, 0],
        shufflePos: 0,
      },
      PREFETCH_LOOKAHEAD,
    );
    await quiesce();
    expect(calls.length).toBe(0); // 预取的是 ROW_L(本地行)⇒ 被源类型闸门拦下,零取流
  });
});

describe("⑦ 预取按解析后的优选源 id 登记(同曲多源组 id 错位修复)", () => {
  it("(a) 队列 web 行 + 组内 WebDAV 兄弟行 ⇒ 条目登记在解析后 id 上", async () => {
    await prefetchSong(ROW_G_WEB.id);
    // 预取打的是**兄弟行**的上游(不是队列 web 行的 url)。
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(DAV_ORIGIN + "/dav/g.flac");

    // 索引登记在解析后的兄弟 id 上 —— 出流侧 prefetchHit(resolvedId) 必须命中。
    expect(prefetchToken(ROW_G_DAV.id)).toBeTruthy();
    expect(prefetchHit(ROW_G_DAV.id)).toContain("/rest/membuf/");
    // 钉住语义:队列 webId 本身**不**登记(出流总是先 resolve,永远查解析后 id)⇒ 未命中。
    expect(prefetchHit(ROW_G_WEB.id)).toBeNull();

    // 出流真实入口(拿的是解析后的行)命中 ⇒ 零上游。
    const src = await resolveTranscodeInput({}, { ...ROW_G_DAV }, { buffering: true });
    expect(src?.source).toBe(prefetchHit(ROW_G_DAV.id));
    expect(calls.length).toBe(1);
  });

  it("(b) 无 groupId ⇒ 走原路径,key 与行为逐字不变(解析 id == 队列 id)", async () => {
    await prefetchSong(ROW_W.id);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(DAV_ORIGIN + "/dav/a.flac");
    expect(prefetchToken(ROW_W.id)).toBeTruthy();
    expect(prefetchHit(ROW_W.id)).toContain("/rest/membuf/");
    expect(prefetchAliasesForTest()).toEqual([[ROW_W.id, ROW_W.id]]); // 别名自指 = 原行为
  });

  it("(c) 同一队列 id 触发两次 ⇒ 只抓一次(别名去重)", async () => {
    await prefetchSong(ROW_G_WEB.id);
    expect(calls.length).toBe(1);
    await prefetchSong(ROW_G_WEB.id); // 经别名命中已缓存
    expect(calls.length).toBe(1);
  });

  it("(d) 解析后条目被回收 ⇒ 别名同步清理(不悬空),且可重新预取", async () => {
    await prefetchSong(ROW_G_WEB.id);
    expect(prefetchAliasesForTest()).toEqual([[ROW_G_WEB.id, ROW_G_DAV.id]]);

    resetMemStreamsForTest(); // 模拟 sweepMemStreams 回收条目
    expect(prefetchToken(ROW_G_DAV.id)).toBeNull();
    expect(prefetchAliasesForTest()).toEqual([]); // 别名随之清掉,不留悬空条目

    await prefetchSong(ROW_G_WEB.id); // 无悬空别名 ⇒ 正确重新预取
    expect(calls.length).toBe(2);
    expect(prefetchAliasesForTest()).toEqual([[ROW_G_WEB.id, ROW_G_DAV.id]]);
  });
});

// ==================== ⑦ 完整性判官（试听片段 / 假成功 / 过小文件） ====================
describe("⑦ 完整性判官", () => {
  it("(a) 试听片段:实际 30s vs 曲库 200s ⇒ 判死:不登记预取 + 记无源负缓存", async () => {
    mm.duration = 30; // 平台只给 30 秒
    await prefetchSong(ROW_W.id);
    await quiesce();
    expect(calls.length).toBe(1); // 取流照常发生(判官在取流之后)
    expect(prefetchHit(ROW_W.id)).toBeNull(); // 不登记
    expect(getCachedPlayability(ROW_W.id)).toBe("unplayable"); // 负缓存已写
  });

  it("(b) 差值 ≤15s 放过(190 vs 200):正常登记", async () => {
    mm.duration = 190;
    await prefetchSong(ROW_W.id);
    await quiesce();
    expect(prefetchHit(ROW_W.id)).not.toBeNull();
    expect(getCachedPlayability(ROW_W.id)).toBe("unknown");
  });

  it("(c) 无基准(曲库 duration=0):再短也不杀", async () => {
    mm.duration = 30;
    await prefetchSong(ROW_NODUR.id);
    await quiesce();
    expect(prefetchHit(ROW_NODUR.id)).not.toBeNull();
    expect(getCachedPlayability(ROW_NODUR.id)).toBe("unknown");
  });

  it("(d) 假成功:上游把 HTML 错误页当 200 ⇒ magic 档判死", async () => {
    mode = "html";
    await prefetchSong(ROW_W.id);
    await quiesce();
    expect(prefetchHit(ROW_W.id)).toBeNull();
    expect(getCachedPlayability(ROW_W.id)).toBe("unplayable");
  });

  it("(e) 过小文件(<64KB):判死", async () => {
    mode = "tiny";
    await prefetchSong(ROW_W.id);
    await quiesce();
    expect(prefetchHit(ROW_W.id)).toBeNull();
    expect(getCachedPlayability(ROW_W.id)).toBe("unplayable");
  });

  it("(f) env PREFETCH_INTEGRITY_OFF=1:整体关闭判官,试听片段也正常登记(一键回退)", async () => {
    process.env.PREFETCH_INTEGRITY_OFF = "1";
    mm.duration = 30;
    await prefetchSong(ROW_W.id);
    await quiesce();
    expect(prefetchHit(ROW_W.id)).not.toBeNull();
  });

  it("(g) 判死线可调:delta=300 时 30s 片段不再判死", async () => {
    process.env.PREFETCH_INTEGRITY_DELTA_SEC = "300";
    mm.duration = 30;
    await prefetchSong(ROW_W.id);
    await quiesce();
    expect(prefetchHit(ROW_W.id)).not.toBeNull();
  });

  it("(h) markUnplayable 负缓存带 TTL:写入后 unplayable,推进 5 分钟后自动复活", async () => {
    vi.useFakeTimers();
    try {
      markUnplayable("pf-w");
      expect(getCachedPlayability("pf-w")).toBe("unplayable");
      vi.advanceTimersByTime(5 * 60 * 1000 + 1000); // 越过 MARK_UNPLAYABLE_TTL_MS
      expect(getCachedPlayability("pf-w")).toBe("unknown");
    } finally {
      vi.useRealTimers();
    }
  });

  it("(i) parseBuffer 解析失败(magic 是音频但 metadata 认不出):保守放过", async () => {
    mm.fail = true;
    await prefetchSong(ROW_W.id);
    await quiesce();
    expect(prefetchHit(ROW_W.id)).not.toBeNull();
    expect(getCachedPlayability(ROW_W.id)).toBe("unknown");
  });
});

// ==================== ⑦-K 判官单元:两条判死线(metadata 15s / 码率推算 80s) ====================
describe("⑦-K 判官单元:两条判死线", () => {
  // 与 fetch stub 的 ok 模式同款假数据(合法 flac 头 + 128KB);parseBuffer 被 mock,内容不参与判定。
  const buf = Buffer.concat([Buffer.from("fLaC", "latin1"), Buffer.alloc(128 * 1024, 0)]);
  const BYTES = buf.length; // 131076

  it("metadata 真值路径:差 16s 判死 / 差 14s 放过(线=15s)", async () => {
    mm.duration = 184; mm.bitrate = 0;
    const dead = await judgePrefetchedBuffer(buf, 200);
    expect(dead.dead).toBe(true);
    expect(dead.reason).toBe("preview");
    expect(dead.via).toBe("metadata");
    mm.duration = 186;
    const ok = await judgePrefetchedBuffer(buf, 200);
    expect(ok.dead).toBe(false);
  });

  it("码率推算路径:差 79s 放过 / 差 81s 判死(线=80s,比 metadata 宽一档)", async () => {
    // actual ≈ BYTES*8/bitrate:bitrate=BYTES*8/121 ⇒ actual≈121s,差 79s(<80) ⇒ 放过。
    mm.duration = 0; mm.bitrate = Math.round((BYTES * 8) / 121);
    const ok = await judgePrefetchedBuffer(buf, 200);
    expect(ok.dead).toBe(false);
    expect(ok.via).toBe("bitrate");
    // bitrate=BYTES*8/119 ⇒ actual≈119s,差 81s(>80) ⇒ 判死。
    mm.bitrate = Math.round((BYTES * 8) / 119);
    const dead = await judgePrefetchedBuffer(buf, 200);
    expect(dead.dead).toBe(true);
    expect(dead.reason).toBe("preview");
    expect(dead.via).toBe("bitrate");
    expect(dead.actualSec).toBeGreaterThan(100);
  });

  it("码率线 env 可调:PREFETCH_INTEGRITY_DELTA_SEC_BITRATE=10 ⇒ 差 30s 也判死", async () => {
    process.env.PREFETCH_INTEGRITY_DELTA_SEC_BITRATE = "10";
    mm.duration = 0; mm.bitrate = Math.round((BYTES * 8) / 170); // actual≈170s,差 30s
    const v = await judgePrefetchedBuffer(buf, 200);
    expect(v.dead).toBe(true);
    expect(v.via).toBe("bitrate");
  });

  it("同一条数据两条线互不干扰:差 30s 时 metadata 判死、码率推算放过", async () => {
    mm.duration = 170; mm.bitrate = 0; // metadata:差 30s > 15s ⇒ 判死
    expect((await judgePrefetchedBuffer(buf, 200)).dead).toBe(true);
    mm.duration = 0; mm.bitrate = Math.round((BYTES * 8) / 170); // 码率:actual≈170s,差 30s < 80s ⇒ 放过
    expect((await judgePrefetchedBuffer(buf, 200)).dead).toBe(false);
  });
});

// ==================== ⑦-L 码率推算路径的端到端(预取入口) ====================
describe("⑦-L 码率推算路径端到端", () => {
  it("(j) duration 缺失 + 码率推算出 30s(差 170s > 80s):判死 + 负缓存", async () => {
    mm.duration = 0;
    mm.bitrate = Math.round((131076 * 8) / 30); // actual≈30s
    await prefetchSong(ROW_W.id);
    await quiesce();
    expect(calls.length).toBe(1);
    expect(prefetchHit(ROW_W.id)).toBeNull();
    expect(getCachedPlayability(ROW_W.id)).toBe("unplayable");
  });

  it("(k) 码率推算差 30s(>15s 但 <80s):不判死,正常登记(放宽档的核心回归)", async () => {
    mm.duration = 0;
    mm.bitrate = Math.round((131076 * 8) / 170); // actual≈170s,差 30s
    await prefetchSong(ROW_W.id);
    await quiesce();
    expect(prefetchHit(ROW_W.id)).not.toBeNull();
    expect(getCachedPlayability(ROW_W.id)).toBe("unknown");
  });
});

// ==================== ⑧ 判官组内换源(先换源、全死才跳) ====================
describe("⑧ 判官组内换源", () => {
  it("(a) 首选行判死 ⇒ 换组内候选源:第二个候选抓取+登记,双写索引", async () => {
    mm.queue = [30, 200]; // 第 1 个候选(解析后 pf-gdav)判死;第 2 个(pf-gweb)放过
    await prefetchSong(ROW_G_WEB.id);
    await quiesce();
    expect(calls.length).toBe(2);
    expect(calls[0].url).toBe(DAV_ORIGIN + "/dav/g.flac"); // 首选(解析后)先试
    expect(calls[1].url).toBe("http://up.example/g.mp3"); // 判死 ⇒ 换组内 web 兄弟

    // 双写:出流侧解析到 pf-gdav 命中;候选 id 本身也可命中。
    expect(prefetchHit(ROW_G_DAV.id)).toContain("/rest/membuf/");
    expect(prefetchHit(ROW_G_WEB.id)).toContain("/rest/membuf/");
    // 判死的候选逐个记负缓存;队列行/存活候选不标。
    expect(getCachedPlayability(ROW_G_DAV.id)).toBe("unplayable");
    expect(getCachedPlayability(ROW_G_WEB.id)).toBe("unknown");

    // 出流真实入口(拿的是解析后的行)命中 ⇒ 零上游。
    const src = await resolveTranscodeInput({}, { ...ROW_G_DAV }, { buffering: true });
    expect(src?.source).toBe(prefetchHit(ROW_G_DAV.id));
    expect(calls.length).toBe(2);
  });

  it("(b) 全部候选判死 ⇒ 逐个标负缓存,队列行也标(judgePlayable 才能跳)", async () => {
    mm.queue = [30, 30]; // 两个网络候选都判死
    await prefetchSong(ROW_G_WEB.id);
    await quiesce();
    expect(calls.length).toBe(2);
    expect(prefetchHit(ROW_G_DAV.id)).toBeNull();
    expect(getCachedPlayability(ROW_G_DAV.id)).toBe("unplayable"); // 候选逐个标
    expect(getCachedPlayability(ROW_G_WEB.id)).toBe("unplayable"); // 队列行=最后一个候选,同样被标
  });

  it("(c) 队列行是本地行(非候选)时,全判死也要标队列行 —— 否则播 30s 试听而不是跳歌", async () => {
    // 本地行 probe 失败 ⇒ resolvePreferredSong 方向 2 回退组内 web 行(pf-gweb)。
    ph.probeOk.mockImplementation(async (s: any) => s?.id !== ROW_G_LOCAL.id);
    mm.queue = [30, 30]; // pf-gweb、pf-gdav 两个网络候选都判死
    await prefetchSong(ROW_G_LOCAL.id);
    await quiesce();
    expect(calls.length).toBe(2); // 本地行不抓,只抓两个网络候选
    expect(getCachedPlayability(ROW_G_WEB.id)).toBe("unplayable");
    expect(getCachedPlayability(ROW_G_DAV.id)).toBe("unplayable");
    // 关键:队列行(本地行,不在候选链里)也必须标 —— judgePlayable 按队列行 id 判跳。
    expect(getCachedPlayability(ROW_G_LOCAL.id)).toBe("unplayable");
    expect(prefetchHit(ROW_G_WEB.id)).toBeNull();
  });

  it("(d) 有候选没被评估(次候选取流失败)⇒ 只标判死的候选,不标队列行(未知不当死)", async () => {
    ph.probeOk.mockImplementation(async (s: any) => s?.id !== ROW_G_LOCAL.id);
    mm.queue = [30]; // 只有第一个候选走得到判官
    failCall = 2; // 第二个候选(pf-gdav)取流 500
    await prefetchSong(ROW_G_LOCAL.id);
    await quiesce();
    expect(calls.length).toBe(2);
    expect(getCachedPlayability(ROW_G_WEB.id)).toBe("unplayable"); // 判死的候选照标
    expect(getCachedPlayability(ROW_G_LOCAL.id)).toBe("unknown"); // 队列行不标:pf-gdav 还没评估
  });

  it("(e) 无组单行:判死后直接负缓存,无换源行为(与旧版一致)", async () => {
    mm.duration = 30;
    await prefetchSong(ROW_W.id);
    await quiesce();
    expect(calls.length).toBe(1);
    expect(prefetchHit(ROW_W.id)).toBeNull();
    expect(getCachedPlayability(ROW_W.id)).toBe("unplayable");
  });
});

// ==================== ⑨ 配置走 settings(UI 保存即生效,不靠 env) ====================
describe("⑨ 配置走 settings", () => {
  it("(a) settings integrityEnabled=false ⇒ 判官关闭(试听片段也登记)", async () => {
    setPrefetchSettings({ integrityEnabled: false });
    mm.duration = 30;
    await prefetchSong(ROW_W.id);
    await quiesce();
    expect(prefetchHit(ROW_W.id)).not.toBeNull();
    expect(getCachedPlayability(ROW_W.id)).toBe("unknown");
    resetPrefetchSettings();
  });

  it("(b) settings lookahead=2 ⇒ prefetchUpcoming(不传 n)预取前两首", async () => {
    const second = { id: "pf-w2", type: "local", path: "w:davsrc:/dav/b.flac", size: 5 * MB };
    sqlite
      .prepare("INSERT INTO songs (id, title, path, type, size, duration, suffix) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING")
      .run(second.id, "t", second.path, second.type, second.size, 200, "flac");
    setPrefetchSettings({ lookahead: 2 });
    // currentIndex=0 ⇒ order 模式窗口 = 下标 1、2(ROW_W + second);ROW_L(本地行)不取。
    prefetchUpcoming({
      items: [{ songId: ROW_L.id }, { songId: ROW_W.id }, { songId: second.id }],
      currentIndex: 0,
      playMode: "order",
    });
    await quiesce();
    expect(calls.length).toBe(2); // 前两首各取一次(本地行被源类型闸门拦下)
    expect(calls[0].url).toBe(DAV_ORIGIN + "/dav/a.flac");
    expect(calls[1].url).toBe(DAV_ORIGIN + "/dav/b.flac");
    resetPrefetchSettings();
  });

  it("(c) settings maxAltSources=0 ⇒ 关闭换源:组内首个判死即停", async () => {
    setPrefetchSettings({ maxAltSources: 0 });
    mm.queue = [30, 200]; // 即使第二个候选能过,也不该去抓
    await prefetchSong(ROW_G_WEB.id);
    await quiesce();
    expect(calls.length).toBe(1); // 不换源
    expect(getCachedPlayability(ROW_G_DAV.id)).toBe("unplayable");
    expect(prefetchHit(ROW_G_WEB.id)).toBeNull();
    resetPrefetchSettings();
  });

  it("(d) settings 判死线即时生效:integrityDeltaSec=300 ⇒ 30s 片段不判死", async () => {
    setPrefetchSettings({ integrityDeltaSec: 300 });
    mm.duration = 30;
    await prefetchSong(ROW_W.id);
    await quiesce();
    expect(prefetchHit(ROW_W.id)).not.toBeNull();
    resetPrefetchSettings();
  });
});

// ==================== ⑦-M 判官真机场景固化(240 实测样例 + 精确边界) ====================
// 判官档 3/4 的输入是「parseBuffer 的 format」+「sniffMagic 的结论」。既有用例全用
// fLaC 假数据,漏掉两件真机上的事:
//   · 平台试听片段真实容器是 **mp4/M4A**(汽水音乐 240 实测:泪海-许茹芸 0.89MB /
//     duration=29.0017s / 256kbps,基准 298s)。sniffMagic 必须认 `ftyp` 盒才是音频,
//     否则整档 3 永远走不到(且正常 mp4/m4a 全曲会被误判 not-audio —— 比原 bug 更糟)。
//   · 两条判死线都是 `> 严格大于`,边界值(15s / 80s 恰好等于)必须放过,否则会把
//     「只短一点点」的正常歌判死。既有用例只夹了 14/16 与 79/81,这里钉精确边界。
describe("⑦-M 判官真机场景固化(240 实测样例 + 精确边界)", () => {
  // 合法 flac 假数据(与 fetch stub 的 ok 模式同款:合法 flac 头 + 128KB,内容不参与判定)。
  const FLAC_BUF = Buffer.concat([Buffer.from("fLaC", "latin1"), Buffer.alloc(128 * 1024, 0)]);

  // 真实 M4A/mp4 容器头:size(4B BE) + "ftyp" + brand。sniffMagic 靠
  // `buf.subarray(4,8) === "ftyp"` 判音频(L82),与 flac/ogg/mp3 是**并列**的一条。
  const m4aHead = Buffer.alloc(16, 0);
  m4aHead.writeUInt32BE(24, 0);
  m4aHead.write("ftyp", 4, "latin1");
  m4aHead.write("M4A ", 8, "latin1");
  const M4A_BUF = Buffer.concat([m4aHead, Buffer.alloc(200 * 1024, 0)]);

  it("(l) 汽水试听样例:mp4/M4A 容器 + duration≈29s vs 基准 298s ⇒ 走时长档判死(不是 not-audio)", async () => {
    mm.duration = 29.0017; // 240 实测原值
    mm.bitrate = 0;
    const v = await judgePrefetchedBuffer(M4A_BUF, 298);
    expect(v.dead).toBe(true);
    // 关键:若 sniffMagic 收窄到只认 flac/ogg/mp3,这里会变成 "not-audio" —— 档 3 被旁路,
    // 且正常 mp4/m4a 全曲会被同一逻辑误杀。reason 必须是 preview。
    expect(v.reason).toBe("preview");
    expect(v.via).toBe("metadata");
    expect(v.actualSec).toBeCloseTo(29.0017, 3);
    expect(v.expectedSec).toBe(298);
  });

  it("(m) 同一 mp4/M4A 容器的正常全曲(290s vs 298s)不判死 —— 防 magic 收窄误杀正常 m4a", async () => {
    mm.duration = 290;
    mm.bitrate = 0;
    const v = await judgePrefetchedBuffer(M4A_BUF, 298);
    expect(v.dead).toBe(false);
    expect(v.via).toBe("metadata"); // 走过了时长档,只是差值不够
  });

  it("(n) metadata 判死线精确边界:差恰 15s 放过、差 15.1s 判死(> 是严格大于)", async () => {
    mm.duration = 185; mm.bitrate = 0; // 200 - 185 = 15 ⇒ 不大于 15
    expect((await judgePrefetchedBuffer(FLAC_BUF, 200)).dead).toBe(false);
    mm.duration = 184.9;               // 200 - 184.9 = 15.1 ⇒ 判死
    const dead = await judgePrefetchedBuffer(FLAC_BUF, 200);
    expect(dead.dead).toBe(true);
    expect(dead.reason).toBe("preview");
    expect(dead.via).toBe("metadata");
  });

  it("(o) 码率推算判死线精确边界:差恰 80s 放过、差 80.1s 判死(放宽档只到 80)", async () => {
    const bytes = FLAC_BUF.length;
    mm.duration = 0;
    mm.bitrate = (bytes * 8) / 120;   // actual=120s,差 80 ⇒ 不大于 80 ⇒ 放过
    const ok = await judgePrefetchedBuffer(FLAC_BUF, 200);
    expect(ok.dead).toBe(false);
    expect(ok.via).toBe("bitrate");
    mm.bitrate = (bytes * 8) / 119.9; // actual=119.9s,差 80.1 ⇒ 判死
    const dead = await judgePrefetchedBuffer(FLAC_BUF, 200);
    expect(dead.dead).toBe(true);
    expect(dead.reason).toBe("preview");
    expect(dead.via).toBe("bitrate");
  });

  it("(p) 无基准(expectedSec≤0):直接放过,且不回带 expectedSec(dead0 的两个分支)", async () => {
    mm.duration = 1; mm.bitrate = 0; // 再短也不杀
    for (const base of [0, -1]) {
      const v = await judgePrefetchedBuffer(FLAC_BUF, base);
      expect(v.dead).toBe(false);
      expect(v.expectedSec).toBeUndefined();
      expect(v.reason).toBeUndefined();
    }
    // 对照:有基准时回带 expectedSec(同一个 dead0 的另一个分支)。
    expect((await judgePrefetchedBuffer(FLAC_BUF, 200)).expectedSec).toBe(200);
  });

  it("(q) parseBuffer 解析失败:保守放过(不判死、不带 via)", async () => {
    mm.fail = true;
    const v = await judgePrefetchedBuffer(FLAC_BUF, 200);
    expect(v.dead).toBe(false);
    expect(v.via).toBeUndefined();
  });

  it("(r) 能解析出 metadata 但既无时长也无码率:信息不足,保守放过", async () => {
    mm.duration = 0; mm.bitrate = 0;
    const v = await judgePrefetchedBuffer(FLAC_BUF, 200);
    expect(v.dead).toBe(false);
    expect(v.via).toBeUndefined();
  });
});

// ==================== ⑧-F 换源链路边界(候选上限截断 / 双写同一 token) ====================
describe("⑧-F 换源链路边界", () => {
  it("(f) 候选上限 3:组内 5 个网络兄弟只评估 4 个(首选+3),超限的从未评估也不标负缓存", async () => {
    const gid = "pf-grp3";
    const rows = [
      { id: "pf-g3-q", path: "w:davsrc:/dav/q3.flac" },
      { id: "pf-g3-a", path: "w:davsrc:/dav/a3.flac" },
      { id: "pf-g3-b", path: "w:davsrc:/dav/b3.flac" },
      { id: "pf-g3-c", path: "w:davsrc:/dav/c3.flac" },
      { id: "pf-g3-d", path: "w:davsrc:/dav/d3.flac" },
      { id: "pf-g3-e", path: "w:davsrc:/dav/e3.flac" },
    ];
    const ins = sqlite.prepare(
      "INSERT INTO songs (id, title, path, type, size, duration, suffix, group_id) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
    );
    for (const r of rows) ins.run(r.id, "t-" + r.id, r.path, "local", 5 * MB, 200, "flac", gid);

    // 每个被评估的候选都判死 ⇒ 只应有 1(首选) + 3(换源上限) = 4 次取流。
    mm.queue = [30, 30, 30, 30, 30, 30];
    await prefetchSong("pf-g3-q");
    await quiesce();

    expect(calls.length).toBe(4); // 截断生效:不是 6
    expect(new Set(calls.map((c) => c.url)).size).toBe(4); // 4 个不同候选,没有重复抓
    expect(prefetchHit("pf-g3-q")).toBeNull(); // 全判死 ⇒ 不登记

    // 顺序无关地数:4 个被评估(全判死⇒负缓存),2 个超限从未评估(unknown)。
    const ids = rows.map((r) => r.id);
    const marked = ids.filter((id) => getCachedPlayability(id) === "unplayable");
    const untouched = ids.filter((id) => getCachedPlayability(id) === "unknown");
    expect(marked.length).toBe(4);
    expect(untouched.length).toBe(2); // 超上限的两个:知识不完整,不能把未知当死
  });

  it("(g) 换源成功时双写索引:cand.id 与 resolvedId 是同一条 token(内容只有一份)", async () => {
    mm.queue = [30, 200]; // 首选(解析后 pf-gdav)判死,次候选 pf-gweb 放过
    await prefetchSong(ROW_G_WEB.id);
    await quiesce();
    const tokCand = prefetchToken(ROW_G_WEB.id);    // 候选 id(实际供源的那行)
    const tokResolved = prefetchToken(ROW_G_DAV.id); // 解析后 id(出流侧查的那个 key)
    expect(tokCand).toBeTruthy();
    expect(tokResolved).toBe(tokCand); // 同一个 token,不是两份拷贝
    expect(prefetchHit(ROW_G_WEB.id)).toBe(prefetchHit(ROW_G_DAV.id));
  });
});
