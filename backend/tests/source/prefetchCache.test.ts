// ==================== 下一首预缓冲(prefetchCache)回归守卫 ====================
//
// 第一优先级是「绝不能影响正在播放的流」。本文件按这条主线组织:
//   ① 命中后不再触发上游取流(预取真的被用上了,且播放路径更短);
//   ② 正在播的 membuf 条目不会被预取顶掉(驱逐策略双向变异);
//   ③ 预取与播放不共用 single-flight(红线:播放请求不得继承预取的 cfg);
//   ④ 五道闸门各自生效(不做无意义的预取);
//   ⑤ 失败全静默(不抛、不写 streamFallback 可播性缓存);
//   ⑥ 出流与预取对同一首歌推导出完全相同的 url + headers。
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { sqlite } from "../../src/db/index.js";
import {
  PREFETCH_LOOKAHEAD,
  bindLoopbackBase,
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
import { getCachedPlayability } from "../../src/services/source/online/streamFallback.js";
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

const MB = 1024 * 1024;
const DAV_ORIGIN = "http://127.0.0.1:18777";

// ---------------- 库内行 ----------------
const ROW_W = { id: "pf-w", type: "local", path: "w:davsrc:/dav/a.flac", size: 5 * MB, url: null, streamHeaders: null, cachePath: null };
const ROW_L = { id: "pf-l", type: "local", path: "l:localdisk:/MUSIC/a.flac", size: 5 * MB, url: null, streamHeaders: null, cachePath: null };
const ROW_BIG = { id: "pf-big", type: "local", path: "w:davsrc:/dav/big.flac", size: 200 * MB, url: null, streamHeaders: null, cachePath: null };
const ROW_WEB = { id: "pf-web", type: "web", path: "web:plugin:x", url: "http://up.example/1.mp3", streamHeaders: null, cachePath: null, size: 0 };

// ---- 同曲多源组(队列 web 行 + 组内 WebDAV 兄弟行) ----
// 复刻 240 实测:队列里是 web 行(type=web),组内兄弟是「核心曲库源」行 —— 这里用
// type=local + path `w:`(WebDAV) 复刻(resolvePreferredSong 的 alt 查询取 type∈{local,webdav},
// 而 networkInput 靠 path 前缀 `w:` 判定它是网络源)。
const GRP = "pf-grp";
const ROW_G_WEB = { id: "pf-gweb", type: "web", path: "web:plugin:x", url: "http://up.example/g.mp3", streamHeaders: null, cachePath: null, size: 0 };
const ROW_G_DAV = { id: "pf-gdav", type: "local", path: "w:davsrc:/dav/g.flac", size: 5 * MB };

// ---------------- 假上游 ----------------
type Mode = "ok" | "500";
let mode: Mode = "ok";
let calls: Array<{ url: string; headers: any }> = [];
/** 第一路取流是否卡住(用于「并发闸门」:证明第二路没有提前起飞)。 */
let blockFirst = false;
let releaseFirst: () => void = () => {};

function installFetchStub(): void {
  vi.stubGlobal("fetch", vi.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), headers: init?.headers });
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
    .run("davsrc", "dav", "webdav", JSON.stringify({ url: DAV_ORIGIN + "/dav", username: "u", password: "p" }));
  for (const r of [ROW_W, ROW_L, ROW_BIG, ROW_WEB]) {
    sqlite
      .prepare("INSERT INTO songs (id, title, path, type, size, duration, suffix) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING")
      .run(r.id, "t-" + r.id, r.path, r.type, r.size, 200, "flac");
  }
  // 同曲多源组两行(带 group_id;web 行带 url)。
  const seedGrouped = sqlite.prepare(
    "INSERT INTO songs (id, title, path, type, size, duration, suffix, group_id, url) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
  );
  seedGrouped.run(ROW_G_WEB.id, "t-" + ROW_G_WEB.id, ROW_G_WEB.path, ROW_G_WEB.type, 0, 200, "flac", GRP, ROW_G_WEB.url);
  seedGrouped.run(ROW_G_DAV.id, "t-" + ROW_G_DAV.id, ROW_G_DAV.path, ROW_G_DAV.type, ROW_G_DAV.size, 200, "flac", GRP, null);
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
  delete process.env.MEMBUF_MAX_ENTRIES;
  delete process.env.STREAM_BUFFER_BUDGET_MB;
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
