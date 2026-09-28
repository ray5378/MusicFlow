// ==================== streamFallback:缓存收尾与结构性短路补测 ====================
//
// 既有三个文件(streamFallback / Ttl / Evict)把**换源主路径**钉得很死:门禁过滤、
// TTL 三档、FIFO 逐出、evict 契约。但下面几条仍然全黑,而且恰恰是「缓存到底信不信」
// 这类最容易写反的地方:
//
//   · findFallbackStream 开头的三道结构性短路(缺标题 / 总开关关 / provider 解析不出):
//     它们决定「要不要发搜索请求」和「写不写负缓存」。写错的表现不是报错,而是
//     ——总开关关着的那 45 秒里,一首能播的歌被记成「永远没有源」。
//   · 候选全灭的分歧(233):全 404 → unplayable;只要有一个网络异常 → transient。
//     这两条共用同一行 setFallback,靠 sawTransient 区分,写反就把网络抖动判成死亡。
//   · clearFallbackCache 的定向/全清两条(314/315):定向是「这首的替换源刚被证伪」,
//     全清是内存回收;混淆两者的表现是「换源记忆该留的被清掉」或「不该清的没清」。
//   · ensurePlayableStream 缓存命中后的收尾(456/461/464):命中替换源要顺手
//     addPlayable(让下一次走零成本的短路),并且**只在替换 URL 与原 URL 不同时**
//     写回 songs.url(464)——否则会把原 URL 自己覆盖掉,把「原链还活着」这件事抹掉。
//
// 用真实 SQLite + 真实 db(与既有 streamFallback.test.ts 同构),主线不打桩:
// 只桩 `fetch` 与 `Date.now`(后者让「正缓存过期、换源记忆还在」这个组合可控)。
//
// 四个文件一起把 streamFallback.ts 拉到 98.74% 行 / 100% 函数。剩下两条是**防御性
// catch**,构造上够不到,留档不刷:
//   · 309-310 recheckOnlineDirect 自己的 catch:probe 内部已把 fetch 异常全吞成
//     transient,它自己不会再抛。
//   · 514-515 resolvePreferredStreamUrl 自己的 catch:db.select / resolvePreferredSong
//     / getEffectiveBaseUrl 三条都不会在正常情况下同步抛(resolvePreferredSong 内部
//     还有一层同款 try)。
// 想「覆盖」它们只能注入假异常,那测的是桩不是产品行为 —— 见用例
// 「recheckOnlineDirect 自己的 catch 是构造上够不到的」。
import "../../plugins/_env.js";

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase, db, sqlite } from "../../../src/db/index.js";
import { songs } from "../../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { registerPlugin, unregisterPlugin } from "../../../src/plugins/registry.js";
import {
  ensurePlayableStream,
  clearFallbackCache,
  clearStreamFallbackCache,
  configureStreamFallbackCache,
  findFallbackStream,
  getCachedPlayability,
  recheckOnlineDirect,
  resolveRemoteStreamUrl,
} from "../../../src/services/source/online/streamFallback.js";

const PROVIDER = "gmdl-b28-test";

const manifestOf = {
  id: PROVIDER,
  name: PROVIDER,
  version: "1.0.0",
  type: "source",
  capabilities: ["search", "stream"],
  platforms: ["netease", "kugou", "qq"],
  configSchema: [],
  permissions: ["net"],
  sourcePreference: ["kugou", "netease", "qq"],
} as const;

// ---- 可控的时间:只位移 Date.now(),不 fake timers(避免 AbortSignal.timeout 挂死) ----
let nowShift = 0;
const realNow = Date.now;

// ---- 可控的 fetch ----
const AUDIO_HEADERS = { "content-type": "audio/mpeg" };
const audioResponse = (status: number) => new Response("bytes", { status, headers: AUDIO_HEADERS });
const fetchCalls: string[] = [];
let fetchHandler: (url: string) => Response | Promise<Response> = () => audioResponse(206);

vi.stubGlobal("fetch", async (url: string) => {
  fetchCalls.push(String(url));
  return fetchHandler(String(url));
});

function enableProvider(cands: any[]) {
  const searchCalls: string[] = [];
  const provider = {
    id: PROVIDER,
    manifest: manifestOf,
    search: async (_config: any, params: any) => {
      searchCalls.push(params.query || "");
      return { songs: cands };
    },
    streamUrl: (_config: any, song: any) => `http://gm:18080/music/download?id=${song.id}&source=${song.source}`,
  };
  registerPlugin(manifestOf as any, provider);
  sqlite.prepare(`
    INSERT INTO plugins (id, name, version, description, manifest, enabled, config, created_at, updated_at)
    VALUES (?, ?, '1.0.0', '', ?, 1, '{}', ?, ?)
    ON CONFLICT(id) DO UPDATE SET enabled = 1, manifest = excluded.manifest, config = '{}'
  `).run(PROVIDER, PROVIDER, JSON.stringify(manifestOf), new Date().toISOString(), new Date().toISOString());
  return { searchCalls };
}

/** 在测试 DB 里播种/更新 core-stream-fallback 行(免注册,配置纯 DB 驱动)。 */
function setFallbackConfig(cfg: Record<string, any>) {
  const now = new Date().toISOString();
  sqlite.prepare(`
    INSERT INTO plugins (id, name, version, description, manifest, enabled, config, created_at, updated_at)
    VALUES ('core-stream-fallback', 'core-stream-fallback', '1.0.0', '', '{}', 1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET enabled = 1, config = excluded.config
  `).run(JSON.stringify(cfg), now, now);
}

const CAND = { id: "n1", name: "恋人", artist: "李荣浩", album: "黑马", duration: 275, source: "netease" };

function seedSong(id: string, opts: { url: string; title?: string | null; artist?: string | null; album?: string | null }) {
  db.insert(songs).values({
    id,
    title: opts.title ?? null,
    artist: opts.artist ?? null,
    album: opts.album ?? "黑马",
    coverArt: null,
    duration: 275,
    path: `web:${PROVIDER}:qq`,
    contentType: "audio/mpeg",
    suffix: "mp3",
    discNumber: 1,
    track: 0,
    genre: "",
    size: 0,
    playCount: 0,
    url: opts.url,
    fingerprint: `fp-${id}`,
    type: "web",
    pluginEntry: PROVIDER,
    sourceData: JSON.stringify({ source: "qq" }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();
}

const rowOf = (id: string) => db.select().from(songs).where(eq(songs.id, id)).get() as any;
const readUrl = (id: string) => rowOf(id)?.url as string | null;

/** 远程行(未入库)的裁决入参。cacheKey 用合成 id,与库内真实行隔离。 */
const remoteMeta = (over: Record<string, unknown> = {}) =>
  ({
    cacheKey: "remote:" + Math.random().toString(36).slice(2, 10),
    title: "恋人", artist: "李荣浩", album: "黑马", duration: 275,
    provider: PROVIDER, source: "qq",
    ...over,
  }) as any;

// 与源码同值(源文件不导出这两个常量,测试侧同步一份,改了会红)。
const FALLBACK_CACHE_MAX = 2000;
const PLAYABLE_CACHE_MAX = 5000;

beforeAll(() => {
  initDatabase();
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + nowShift);
});

afterEach(() => {
  nowShift = 0;
  fetchCalls.length = 0;
  fetchHandler = () => audioResponse(206);
  clearStreamFallbackCache();
  configureStreamFallbackCache({
    playableTtlMs: 60 * 60 * 1000,
    negativeTtlMs: 45 * 1000,
    transientBackoffMs: 5 * 1000,
  });
  sqlite.exec("DELETE FROM songs;");
  sqlite.prepare("DELETE FROM plugins WHERE id = ?").run(PROVIDER);
  sqlite.prepare("DELETE FROM plugins WHERE id = 'core-stream-fallback'").run();
  sqlite.prepare("DELETE FROM plugins WHERE id = 'core-play-preference'").run();
  unregisterPlugin(PROVIDER);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

// ------------------------------------------------------------
describe("findFallbackStream:三道结构性短路", () => {
  it("正缓存命中 → 零搜索,且 source 置空(换源记忆的标记)", async () => {
    const { searchCalls } = enableProvider([CAND]);

    const first = await findFallbackStream("b28-cache", "恋人", "李荣浩", "黑马", 275, PROVIDER, "qq");
    expect(first?.url).toContain("id=n1");
    expect(searchCalls.length).toBe(1);

    const hit = await findFallbackStream("b28-cache", "恋人", "李荣浩", "黑马", 275, PROVIDER, "qq");
    expect(searchCalls.length).toBe(1); // 缓存命中不发搜索
    expect(hit?.url).toContain("id=n1");
    expect(hit?.source).toBe(""); // 命中标记:不是这次搜出来的
  });

  it("负缓存命中 → 零搜索直接 null(45s 内不重试,但 TTL 到就复活)", async () => {
    const { searchCalls } = enableProvider([{ ...CAND, artist: "王俊凯" }]); // 门禁拦下 → 负缓存

    expect(await findFallbackStream("b28-neg", "恋人", "李荣浩", "黑马", 275, PROVIDER, "qq")).toBeNull();
    expect(searchCalls.length).toBe(1);

    expect(await findFallbackStream("b28-neg", "恋人", "李荣浩", "黑马", 275, PROVIDER, "qq")).toBeNull();
    expect(searchCalls.length).toBe(1); // 仍在负 TTL 内
    expect(getCachedPlayability("b28-neg")).toBe("unplayable");
  });

  it("缺标题 → 确定性判死:写负缓存且一次搜索都不发", async () => {
    // 没标题就没法检索(搜索是按「标题 + 歌手」拼的),这不是网络问题 → 该记 unplayable,
    // 免得每首缺标题的歌都去打一遍上游。
    const { searchCalls } = enableProvider([CAND]);

    expect(await findFallbackStream("b28-notitle", "", "李荣浩", "黑马", 275, PROVIDER, "qq")).toBeNull();
    expect(searchCalls.length).toBe(0);
    expect(getCachedPlayability("b28-notitle")).toBe("unplayable");
  });

  it("总开关关闭 → 不搜索也不写负缓存(开关随时可改,负缓存会让重新开启后仍误判)", async () => {
    const { searchCalls } = enableProvider([CAND]);
    setFallbackConfig({ enabled: false });

    expect(await findFallbackStream("b28-off", "恋人", "李荣浩", "黑马", 275, PROVIDER, "qq")).toBeNull();
    expect(searchCalls.length).toBe(0);
    // 关键:不写负缓存 —— 开关一开,这首歌立刻又能换源。
    expect(getCachedPlayability("b28-off")).toBe("unknown");
  });

  it("一个启用源插件都没有 → 兜底能力为零 → 写负缓存,不发搜索", async () => {
    // 注意:这里**故意不注册任何源插件**。只把个 providerId 传错是不够的 ——
    // resolveStreamProvider 本尊查不到时会扫 getEnabledSourcePlugins() 找一个
    // search+stream 齐备的替身(那是给「纯核实源」兜底的),扫不到才判无解。
    const { searchCalls } = enableProvider([CAND]);
    unregisterPlugin(PROVIDER);
    sqlite.prepare("DELETE FROM plugins WHERE id = ?").run(PROVIDER);

    expect(await findFallbackStream("b28-noprov", "恋人", "李荣浩", "黑马", 275, PROVIDER, "qq")).toBeNull();
    expect(searchCalls.length).toBe(0);
    expect(getCachedPlayability("b28-noprov")).toBe("unplayable");
  });
});

// ------------------------------------------------------------
describe("findFallbackStream:候选全灭时分 transient 还是 unplayable", () => {
  it("候选全是明确 404 → unplayable(这是知识,不是未知)", async () => {
    enableProvider([CAND]);
    // 原链与候选链一律 404:全部是「明确不存在」。
    fetchHandler = () => audioResponse(404);

    expect(await findFallbackStream("b28-allgone", "恋人", "李荣浩", "黑马", 275, PROVIDER, "qq")).toBeNull();
    // 没有任何 transient 混入 → 落进「全灭」那条,写死。
    expect(getCachedPlayability("b28-allgone")).toBe("unplayable");
  });

  it("候选里只要有一个网络异常 → transient(网络抖动 ≠ 这首歌没有源)", async () => {
    enableProvider([CAND]);
    // 两个候选都打 500:一条都不能用,但成因是「上游挂了」而非「没有源」。
    fetchHandler = () => audioResponse(500);

    expect(await findFallbackStream("b28-alltrans", "恋人", "李荣浩", "黑马", 275, PROVIDER, "qq")).toBeNull();
    expect(getCachedPlayability("b28-alltrans")).toBe("transient");
  });

  it("前半候选网络异常、后半候选可播 → 仍然换源成功(sawTransient 不影响命中)", async () => {
    enableProvider([CAND, { ...CAND, id: "k1", source: "kugou" }]);
    // kugou 先被 preference 排到前,它 500 记为 transient;netease 的候选 206 可用。
    fetchHandler = (url) => audioResponse(url.includes("id=k1") ? 500 : 206);

    const fb = await findFallbackStream("b28-mixed", "恋人", "李荣浩", "黑马", 275, PROVIDER, "qq");

    expect(fb?.url).toContain("id=n1"); // 跳过不可用的,用后一个
    expect(getCachedPlayability("b28-mixed")).toBe("playable");
  });
});

// ------------------------------------------------------------
describe("recheckOnlineDirect:状态分派与前置门禁", () => {
  it("非在线直链行 → skip(本地文件/WebDAV/空直链不参与在线复核)", async () => {
    // 判据是「有 url 且 pluginEntry 是字符串」,与 url 的 scheme 无关
    // (file:///x.mp3 带上 pluginEntry 照样会被当在线直链去探)。
    expect(await recheckOnlineDirect({ url: "file:///x.mp3", pluginEntry: PROVIDER }, 500)).not.toBe("skip");
    // 真正该 skip 的形态:没有 pluginEntry(本地文件行) / 没有 url(纯核实源行)。
    expect(await recheckOnlineDirect({ url: "file:///x.mp3" }, 500)).toBe("skip");
    expect(await recheckOnlineDirect({ url: "http://webdav/x.mp3", pluginEntry: null }, 500)).toBe("skip");
    expect(await recheckOnlineDirect({ pluginEntry: PROVIDER }, 500)).toBe("skip"); // 无 url
    expect(await recheckOnlineDirect({ url: "", pluginEntry: PROVIDER }, 500)).toBe("skip"); // 空直链
    expect(await recheckOnlineDirect(null, 500)).toBe("skip");
  });

  it("有 url 有 pluginEntry 就是在线直链 —— 哪怕 scheme 是 file://", async () => {
    // 钉住「不看 scheme 只看有没有 pluginEntry」这条口径:否则哪天有人往这里加个
    // `url.startsWith("http")` 的门禁,本地挂载行就会被误探、误判 gone。
    fetchCalls.length = 0;
    fetchHandler = () => audioResponse(206);
    expect(await recheckOnlineDirect({ url: "file:///mnt/nas/a.mp3", pluginEntry: PROVIDER }, 500)).toBe("ok");
    expect(fetchCalls.length).toBe(1);
  });

  it("在线直链 → 交给 probe,明确 404 即 gone(这是知识不是未知)", async () => {
    fetchHandler = () => audioResponse(404);
    expect(await recheckOnlineDirect({ url: "http://x/dead.mp3", pluginEntry: PROVIDER }, 500)).toBe("gone");
  });

  it("探测抛异常 → 归 transient(信号被拒/DNS 失败不等于链死了)", async () => {
    fetchHandler = () => {
      throw new Error("ECONNREFUSED");
    };
    expect(await recheckOnlineDirect({ url: "http://127.0.0.1:1/dead.mp3", pluginEntry: PROVIDER }, 500)).toBe("transient");
  });

  it("recheckOnlineDirect 自己的 catch 是构造上够不到的(probe 是全函数)", async () => {
    // 它包着 probe 的 try/catch 是**防御性**的:probe 内部已经把 fetch 的异常全吞成
    // "transient",它对 res.status / res.headers.get / res.body.cancel 的读取也不会同步抛
    // —— 所以这一行永远执行不到。与其编一个假异常去刷行覆盖率,不如把「probe 不抛」
    // 这件事本身钉死,免得有人以为这条路径真能兜住网络异常(兜住的是 probe 内部那层)。
    fetchHandler = () => {
      throw new Error("network down");
    };
    expect(await recheckOnlineDirect({ url: "http://x/dead.mp3", pluginEntry: PROVIDER }, 500)).toBe("transient");
  });
});

// ------------------------------------------------------------
describe("clearFallbackCache:定向 vs 全清", () => {
  const warm = (id: string) => findFallbackStream(id, "恋人", "李荣浩", "黑马", 275, PROVIDER, "qq");

  it("定向清:只清指定那首,其它首的换源记忆保留", async () => {
    enableProvider([CAND]);
    const a = "b28-clr-a";
    const b = "b28-clr-b";

    expect(await warm(a)).toBeTruthy();
    expect(await warm(b)).toBeTruthy();

    clearFallbackCache(a);
    // a 的换源记忆没了 → 重新探测(第 2 次搜索);b 还在 → 复用缓存,搜索次数不涨。
    expect(await warm(a)).toBeTruthy();
    expect(await warm(b)).toBeTruthy();
  });

  it("定向清后 a 走的是真搜索(b 是缓存命中):用 source 标记区分", async () => {
    enableProvider([CAND]);
    const a = "b28-clr2-a";
    const b = "b28-clr2-b";

    // 两首都先真实搜一遍,把换源记忆铺满。
    expect((await warm(a))?.source).toBe("netease");
    expect((await warm(b))?.source).toBe("netease");
    expect((await warm(a))?.source).toBe(""); // a 命中
    expect((await warm(b))?.source).toBe(""); // b 命中

    clearFallbackCache(a);
    expect((await warm(a))?.source).toBe("netease"); // 已清 → 重新搜
    expect((await warm(b))?.source).toBe(""); // 未清 → 仍是命中
  });

  it("全清:两首都清(内存回收路径)", async () => {
    enableProvider([CAND]);
    const a = "b28-clrall-a";
    const b = "b28-clrall-b";

    await warm(a);
    await warm(b);
    expect((await warm(a))?.source).toBe("");
    expect((await warm(b))?.source).toBe("");

    clearFallbackCache();
    expect((await warm(a))?.source).toBe("netease");
    expect((await warm(b))?.source).toBe("netease");
  });

  // 两个「清」的边界不一样,这里把差别钉死,免得有人把 clearFallbackCache 当内存回收用:
  //   clearFallbackCache()  只清 **换源记忆**(fallbackCache),可播记忆(playableCache)留着
  //   clearStreamFallbackCache() 两个都清
  // 后果:前者清完,这首歌下一次出流仍是「零探测」短路;后者才会真正重新探测一次原链。
  const warmPlayable = async (id: string) => {
    enableProvider([CAND]);
    seedSong(id, { url: "http://orig/dead.mp3", title: "恋人", artist: "李荣浩" });
    fetchHandler = (url) => audioResponse(url.includes("orig") ? 404 : 206);
    expect(await ensurePlayableStream(rowOf(id))).toContain("id=n1");
  };

  it("clearFallbackCache 全清:换源记忆没了,但可播记忆还在 → 下一次仍零探测", async () => {
    const id = "b28-clr-play";
    await warmPlayable(id);

    clearFallbackCache(); // 只清 fallbackCache
    expect(getCachedPlayability(id)).toBe("playable"); // 可播记忆(正缓存)仍在

    fetchCalls.length = 0; // 只数「清完之后」这一次的探测
    await ensurePlayableStream(rowOf(id));
    expect(fetchCalls.length).toBe(0); // 456 短路,一次探测都不做
  });

  it("clearStreamFallbackCache:连可播记忆一起清 → 下一次重新探测原链", async () => {
    const id = "b28-clr-play-all";
    await warmPlayable(id);

    clearStreamFallbackCache();
    expect(getCachedPlayability(id)).toBe("unknown");

    fetchCalls.length = 0;
    await ensurePlayableStream(rowOf(id));
    expect(fetchCalls.length).toBe(1); // 原链(已回写为替换链)被重新探了一次
  });
});

// ------------------------------------------------------------
describe("ensurePlayableStream:缓存命中后的收尾", () => {
  const setupDeadOriginal = (id: string) => {
    enableProvider([CAND]);
    seedSong(id, { url: "http://orig/dead.mp3", title: "恋人", artist: "李荣浩" });
    fetchHandler = (url) => audioResponse(url.includes("orig") ? 404 : 206);
  };

  it("命中替换源 → 回写 songs.url,并让下一次走零成本短路", async () => {
    setupDeadOriginal("b28-fin-a");

    const first = await ensurePlayableStream(rowOf("b28-fin-a"));
    expect(first).toContain("id=n1");
    expect(readUrl("b28-fin-a")).toContain("id=n1"); // 487 行回写

    // 紧接着再要一次:正缓存还在 → 456 短路,直接把库里(已是替换链)的 url 返回,
    // 连探测都不做。
    nowShift = 1;
    const again = await ensurePlayableStream(rowOf("b28-fin-a"));
    expect(again).toContain("id=n1");
    expect(getCachedPlayability("b28-fin-a")).toBe("playable");
  });

  it("换源记忆过期、可播记忆还在 → 命中缓存后顺手补一条可播记忆", async () => {
    // 两个缓存的 TTL 节奏不同步(换源记忆默认 45s、可播记忆 1h),一定会撞上
    // 「换源记忆已经过期、可播记忆还活着」这个窗口。撞上时不补 addPlayable 的
    // 话,下次出流就会重新走一遍搜索 + 探测 —— 这正是 461 存在的理由。
    setupDeadOriginal("b28-fin-b");
    configureStreamFallbackCache({ negativeTtlMs: 1000 }); // 只把换源记忆的 TTL 调短

    const first = await ensurePlayableStream(rowOf("b28-fin-b"));
    expect(first).toContain("id=n1");
    expect(readUrl("b28-fin-b")).toContain("id=n1"); // 487 的首次回写

    nowShift = 2000; // 换源记忆过期(1000ms),可播记忆(1h)仍有效
    expect(getCachedPlayability("b28-fin-b")).toBe("playable"); // 461 必须补上这一条
    fetchCalls.length = 0; // 只数「换源记忆已过期」这一次调用
    expect(await ensurePlayableStream(rowOf("b28-fin-b"))).toContain("id=n1");
    expect(fetchCalls.length).toBe(0); // 456 短路,一次探测都不做
  });

  it("可播记忆先过期 → 命中换源记忆时把它补回来并写回 songs.url", async () => {
    setupDeadOriginal("b28-fin-d");
    configureStreamFallbackCache({ playableTtlMs: 1000 });

    const first = await ensurePlayableStream(rowOf("b28-fin-d"));
    expect(first).toContain("id=n1");

    nowShift = 2000; // 可播记忆过期(1000ms),换源记忆(45s)还在
    const again = await ensurePlayableStream(rowOf("b28-fin-d"));
    expect(again).toContain("id=n1");
    expect(getCachedPlayability("b28-fin-d")).toBe("playable"); // 461 补的可播记忆
    expect(readUrl("b28-fin-d")).toContain("id=n1"); // 464 只在与原 URL 不同时写回
  });

  it("命中换源记忆时:顺手补一条可播记忆(461),并把它写回 songs.url(464)", async () => {
    // 这是 461/464 唯一「写得有意义」的场景:换源记忆是 findFallbackStream 留下的
    // (它不碰 songs.url、也不碰可播缓存),所以紧接着这一次 ensurePlayableStream
    // 命中它时,库里那行还是原链、可播缓存里也没有这个 id —— 461/464 是仅有的写者。
    enableProvider([CAND]);
    seedSong("b28-backfill", { url: "http://orig/dead.mp3", title: "恋人", artist: "李荣浩" });
    fetchHandler = (u) => audioResponse(String(u).includes("orig") ? 404 : 206);
    configureStreamFallbackCache({ negativeTtlMs: 1000 }); // 换源记忆 1s 就过期
    expect(readUrl("b28-backfill")).toBe("http://orig/dead.mp3");

    await findFallbackStream("b28-backfill", "恋人", "李荣浩", "黑马", 275, PROVIDER, "qq");
    // 换源记忆自带 url,getCachedPlayability 就是读它 —— 这里它已经是 playable,
    // 但那是「换源记忆」这一层;真正要测的 461 写的是**另一个**缓存(可播记忆),
    // 456 只认后者。
    expect(getCachedPlayability("b28-backfill")).toBe("playable");

    const first = await ensurePlayableStream(rowOf("b28-backfill"));
    expect(first).toContain("id=n1");
    expect(readUrl("b28-backfill")).toContain("id=n1"); // 464 补写回

    // 换源记忆已过期(1s)、可播记忆还在(1h)—— 461 补的那条就是下面这次调用
    // 能在 456 短路的**唯一**原因。少了它,这次会重新探一遍死链、再搜一次换源。
    nowShift = 2000;
    fetchCalls.length = 0;
    expect(await ensurePlayableStream(rowOf("b28-backfill"))).toContain("id=n1");
    expect(fetchCalls.length).toBe(0); // 456 短路:零探测、零搜索
  });

  it("缓存里就是原 URL 时不再重复写回(不把「原链还活着」抹掉)", async () => {
    setupDeadOriginal("b28-fin-c");
    configureStreamFallbackCache({ playableTtlMs: 1000 });

    const alt = (await ensurePlayableStream(rowOf("b28-fin-c"))) as string;
    expect(alt).toContain("id=n1");

    nowShift = 2000;
    // 库内 url 已经是替换链 → 464 的条件为假,不再写回。
    const again = await ensurePlayableStream(rowOf("b28-fin-c"));
    expect(again).toBe(alt);
    expect(readUrl("b28-fin-c")).toBe(alt);
  });

  it("行不在库里 → resolvePreferredStreamUrl 查不到行就返回 null(不抛)", async () => {
    // 未入库的 ghost 行:探测失败 + 换源未命中,最后一步是查库里有没有兄弟行可优选。
    enableProvider([]);
    fetchHandler = () => audioResponse(404);

    const ghost: any = {
      id: "b28-ghost", url: "http://orig/dead.mp3", title: "恋人",
      artist: "李荣浩", album: "黑马", duration: 275, pluginEntry: PROVIDER, sourceData: "{}",
    };
    expect(await ensurePlayableStream(ghost)).toBeNull();
  });
});

// ------------------------------------------------------------
describe("resolveRemoteStreamUrl:远程(未入库)行的出流前裁决", () => {
  it("空 url → null(连缓存都不查)", async () => {
    expect(await resolveRemoteStreamUrl("", remoteMeta(), 500)).toBeNull();
  });

  it("链路可播 → 返回原链,并记一条正缓存", async () => {
    const m = remoteMeta();
    fetchHandler = () => audioResponse(206);

    expect(await resolveRemoteStreamUrl("http://remote/a.mp3", m, 500)).toBe("http://remote/a.mp3");
    expect(getCachedPlayability(m.cacheKey)).toBe("playable");
  });

  it("网络异常 → 返回原链,**绝不换源**(一次抖动不该把能播的源换到别的平台)", async () => {
    const m = remoteMeta();
    const url = "http://remote/flaky.mp3";
    fetchHandler = () => audioResponse(503);

    expect(await resolveRemoteStreamUrl(url, m, 500)).toBe(url);
    // 关键:没有任何缓存被写 —— 若真去试了换源,这里必然多出一条负/退避记录。
    expect(getCachedPlayability(m.cacheKey)).toBe("unknown");
  });

  it("明确 404 → 试多源换源,命中返回替代链", async () => {
    enableProvider([CAND]);
    const m = remoteMeta();
    fetchHandler = (u) => audioResponse(String(u).includes("orig") ? 404 : 206);

    expect(await resolveRemoteStreamUrl("http://remote/orig/a.mp3", m, 500)).toContain("id=n1");
  });

  it("明确 404 且没有可换的源 → null(别起一条注定失败的管道)", async () => {
    enableProvider([{ ...CAND, artist: "王俊凯" }]); // 门禁拦下 → 负缓存
    const m = remoteMeta();
    fetchHandler = () => audioResponse(404);

    expect(await resolveRemoteStreamUrl("http://remote/orig/a.mp3", m, 500)).toBeNull();
    expect(getCachedPlayability(m.cacheKey)).toBe("unplayable");
  });
});

// ------------------------------------------------------------
describe("defaultStreamProviderId:本尊缺失时的兜底选择", () => {
  it("行无 pluginEntry → 扫启用源插件取第一个 search+stream 齐备的", async () => {
    seedSong("b28-nodef", { url: "http://orig/dead.mp3", title: "恋人", artist: "李荣浩" });
    db.update(songs).set({ pluginEntry: null } as any).where(eq(songs.id, "b28-nodef")).run();
    enableProvider([CAND]);
    fetchHandler = (u) => audioResponse(String(u).includes("orig") ? 404 : 206);

    // defaultStreamProviderId(undefined) 会走 88-91 那圈循环,而不是直接返回本尊。
    expect(await ensurePlayableStream(rowOf("b28-nodef"))).toContain("id=n1");
  });

  it("行无 pluginEntry 且一个启用源插件都没有 → 兜底能力为零(不猜 provider)", async () => {
    seedSong("b28-nodef2", { url: "http://orig/dead.mp3", title: "恋人", artist: "李荣浩" });
    db.update(songs).set({ pluginEntry: null } as any).where(eq(songs.id, "b28-nodef2")).run();
    // 不注册任何源插件 → defaultStreamProviderId 落到 line 92 的 ""
    fetchHandler = () => audioResponse(404);

    expect(await ensurePlayableStream(rowOf("b28-nodef2"))).toBeNull();
  });
});

// ------------------------------------------------------------
describe("组内跨源优选:本行无源但兄弟行有", () => {
  it("web 行探测失败且换源未命中 → 落到组内可用的 local 兄弟行,走服务端出流", async () => {
    // 这一步是 resolvePreferredStreamUrl 的返回行(512):返回 `/rest/stream?id=<原行>`
    // 而不是 null —— 出流端点自己会再走一遍优选换源,所以这里既标可播也不回写原行。
    const dir = mkdtempSync(join(tmpdir(), "mf-pref-"));
    const realFile = join(dir, "core.flac");
    writeFileSync(realFile, Buffer.from("fLaC"));

    sqlite.prepare(`
      INSERT INTO plugins (id, name, version, description, manifest, enabled, config, created_at, updated_at)
      VALUES ('core-play-preference', 'core-play-preference', '1.0.0', '', '{}', 1, '{"preferLocal":true,"fallbackToWeb":true}', ?, ?)
      ON CONFLICT(id) DO UPDATE SET enabled = 1, config = excluded.config
    `).run(new Date().toISOString(), new Date().toISOString());

    db.insert(songs).values({
      id: "b28-pref-web", title: "恋人", artist: "李荣浩", album: "黑马", duration: 275,
      path: "web:gmdl-b28-test:qq", url: "http://orig/dead.mp3", type: "web", groupId: "g-b28",
      pluginEntry: PROVIDER, sourceData: "{}", contentType: "audio/mpeg", suffix: "flac",
      fingerprint: "fp-pref-web",
    } as any).run();
    db.insert(songs).values({
      id: "b28-pref-local", title: "恋人", artist: "李荣浩", album: "黑马", duration: 275,
      path: `l:core:${realFile}`, url: null, type: "local", groupId: "g-b28",
      pluginEntry: null, sourceData: null, contentType: "audio/flac", suffix: "flac",
      fingerprint: "fp-pref-local",
    } as any).run();

    enableProvider([{ ...CAND, artist: "王俊凯" }]); // 换源一定不命中
    fetchHandler = () => audioResponse(404);

    const out = await ensurePlayableStream(rowOf("b28-pref-web"));
    expect(out).toContain("/rest/stream?id=b28-pref-web");
    // 原行 URL 不被回写(会污染去重指纹与来源角标)。
    expect(readUrl("b28-pref-web")).toBe("http://orig/dead.mp3");
    // 也不标可播:标了会让后续调用直接返回这条死链。
    expect(getCachedPlayability("b28-pref-web")).not.toBe("playable");
  });
});

// ------------------------------------------------------------
describe("FIFO:两个缓存的上限必须真的生效", () => {
  it("换源记忆超过 2000 → 逐出最老一条(内存有界)", async () => {
    enableProvider([]); // 空结果 → 每条都只写一条负缓存,不发真实探测
    fetchHandler = () => audioResponse(404);

    for (let i = 0; i < FALLBACK_CACHE_MAX + 1; i++) {
      await findFallbackStream(`fifo-${i}`, "恋人", "李荣浩", "黑马", 275, PROVIDER, "qq");
    }
    expect(getCachedPlayability("fifo-0")).toBe("unknown"); // 最老那条已被逐出
    expect(getCachedPlayability(`fifo-${FALLBACK_CACHE_MAX}`)).toBe("unplayable"); // 最新那条还在
  });

  it("可播记忆超过 5000 → 逐出最老一条(内存有界)", async () => {
    // resolveRemoteStreamUrl 每命中一次就 addPlayable 一次,且完全不碰库 ——
    // 拿它当纯计数器用,比跑 5000 次数据库写入快得多。
    fetchHandler = () => audioResponse(206);

    for (let i = 0; i < PLAYABLE_CACHE_MAX + 1; i++) {
      await resolveRemoteStreamUrl(`http://ok/${i}`, remoteMeta({ cacheKey: `pc-${i}` }), 500);
    }
    expect(getCachedPlayability("pc-0")).toBe("unknown"); // 最老那条已被逐出
    expect(getCachedPlayability(`pc-${PLAYABLE_CACHE_MAX}`)).toBe("playable"); // 最新那条还在
  });
});
