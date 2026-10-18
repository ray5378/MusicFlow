// 自动生成 —— 由 index.ts 物理拆分而来（recommend 域，8 条路由）。零逻辑改动。
import type { Hono } from "hono";
import {
  BusinessErrorCode,
  apiErrorStatus,
  PERM,
  RECOMMEND_CACHE_TTL_MS,
  adminMiddleware,
  and,
  apiError,
  comboApi,
  count,
  dailyApi,
  dailyRecommendHomeCount,
  findLocalRemotePlaylist,
  firstEnabledByCapability,
  getEnabledByCapability,
  getPlugin,
  getPluginConfig,
  listHomeCardPlugins,
  localApi,
  log,
  or,
  permMiddleware,
  playlists,
  plugins,
  providerRecommendCache,
  recommendCache,
  runPluginJob,
  songs,
  sqlite,
  startAsyncTask,
  touch,
} from "./shared.js";

// ==================== stale-while-revalidate(SWR) ====================
// 原状:TTL(5min)过期后下一个请求阻塞式重调所有外网插件(冷 900ms+,插件慢时更久)。
// 现策略(2026-10-15 起冷启动也不阻塞):
//   有缓存(无论新旧) → 立即返回缓存;
//   缓存已过期       → 触发后台刷新(single-flight 去重,成功后原子更新缓存);
//   无任何缓存       → 立即返回空频道 + pending:true,后台 single-flight 拉取
//                      (60s 失败退避,防前端重试打爆上游);前端轮询重试自动填充。
// 后台刷新与请求路径共用同一聚合函数 fetchRecommendChannels,保证两条路径产物一致。
// 聚合结果 write-through 落 settings 表(见下方 B1),进程重启/内存回收后不再冷。

// ==================== B1:聚合缓存落库持久化 ====================
// 内存 recommendCache 会被 reclaim cleaner 清空、进程重启归零——之后下一个请求原本
// 都要吃「冷启动全量外呼」。现把聚合结果 write-through 到 settings 表(key = 前缀 +
// cacheKey),内存 miss 时从 DB 回灌;DB 行超 7 天视为陈旧清理。channels 为纯 JSON
// 可序列化数据,settings(TEXT)足够;落库失败仅告警,不影响请求路径。
const AGG_CACHE_PREFIX = "recommend.aggCache.";
const AGG_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** 内存 miss → 读 DB 回灌(不回写内存:PK 点查微秒级,避免旧值长驻)。 */
function readAggCacheDb(cacheKey: string): { ts: number; channels: any[] } | null {
  try {
    const row = sqlite
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(AGG_CACHE_PREFIX + cacheKey) as any;
    if (!row?.value) return null;
    const parsed = JSON.parse(String(row.value));
    if (!parsed || typeof parsed.ts !== "number" || !Array.isArray(parsed.channels)) return null;
    return { ts: parsed.ts, channels: parsed.channels };
  } catch (e: any) {
    console.warn("[RECOMMEND] 聚合缓存 DB 回灌失败:", e?.message || e);
    return null;
  }
}

/** write-through:内存为主,同时落 DB;顺手清理超龄旧 key(换插件集后旧 key 不再命中)。
 *  走 shared.sqlite(全仓 DB 访问的统一注入点,测试在此替换为假库)。
 *  列名必须是 settings 表的真实列 `updated_at` —— 写成 drizzle 属性名 updatedAt 会在
 *  prepare 阶段抛 no such column,被下方 catch 静默吞掉,表现为「看似落库成功、
 *  实则从未写入」(2026-10-15 复查发现的缺陷)。 */
function writeAggCache(cacheKey: string, entry: { ts: number; channels: any[] }): void {
  recommendCache.set(cacheKey, entry);
  try {
    sqlite
      .prepare(
        `INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(AGG_CACHE_PREFIX + cacheKey, JSON.stringify(entry), new Date().toISOString());
    // 超龄行清理:updated_at 为 ISO 串(字典序即时间序)。
    sqlite
      .prepare(`DELETE FROM settings WHERE key LIKE ? AND updated_at < ?`)
      .run(AGG_CACHE_PREFIX + "%", new Date(Date.now() - AGG_CACHE_MAX_AGE_MS).toISOString());
  } catch (e: any) {
    console.warn("[RECOMMEND] 聚合缓存落库失败:", e?.message || e);
  }
}

/** 聚合所有推荐插件频道(请求路径与后台刷新共用)。 */
async function fetchRecommendChannels(
  providerId: string,
  rp: ReturnType<typeof firstEnabledByCapability>,
  rpList: any[],
): Promise<{ channels: any[]; primaryError?: string }> {
  const allChannels: any[] = [];
  let primaryError: string | undefined;

  // ---- 1. 主推荐插件(如 go-music-dl) ----
  if (rp && typeof rp.impl?.recommend === "function") {
    const config = getPluginConfig(providerId) || {};
    try {
      const result = await rp.impl.recommend(config);
      const baseUrl = String(config.baseUrl || "").replace(/\/+$/, "");
      const channels = (Array.isArray(result?.channels) ? result.channels : []).map((ch: any) => ({
        source: ch.source || "",
        name: ch.name || ch.source || "",
        count: ch.count || 0,
        sortOrder: typeof ch.sortOrder === "number" ? ch.sortOrder : 99,
        _pluginId: providerId,
        playlists: (Array.isArray(ch.playlists) ? ch.playlists : []).map((pl: any) => {
          const source = pl.source || ch.source || "";
          const local = findLocalRemotePlaylist(pl.id, source, pl.name || "");
          return {
            id: pl.id,
            source,
            name: pl.name || "",
            creator: pl.creator || "",
            cover: pl.cover && !/^https?:\/\//i.test(String(pl.cover))
              ? `${baseUrl}${String(pl.cover).startsWith("/") ? "" : "/"}${pl.cover}`
              : (pl.cover || ""),
            trackCount: local ? String(local.songCount ?? "") : "",
            link: pl.link || "",
            imported: !!local,
          };
        }),
      }));
      for (const ch of channels) allChannels.push(ch);
    } catch (e: any) {
      console.warn(`[RECOMMEND] ${providerId} recommend() failed:`, e?.message || e);
      primaryError = String(e?.message || e);
      // 主推荐插件失败不阻断其他插件
    }
  }

  console.log(`[RECOMMEND] 找到 ${rpList.length} 个 recommendPlaylist 插件:`, rpList.map((p: any) => p.manifest.id).join(","));

  // ---- 2. 推荐歌单插件(具备 recommendPlaylist 能力,如榜单插件) ----
  // 并行聚合:各插件的 recommend() 各自看门狗/长耗时预算,互不阻塞。串行会累加
  // 墙钟(go-music-dl + 三个榜单),冷缓存下一次聚合轻松超过前端默认 15s 超时,导致
  // 首页整单(含 go-music-dl)被中止。并行 + 后端缓存后,首次即显著加快,后续秒开。
  // 每个插件独立 try/catch,单个失败不影响其它插件频道。
  const rpTasks = rpList
    .filter((p: any) => p.manifest.id !== providerId && typeof p.impl?.recommend === "function")
    .map((p: any) =>
      (async () => {
        const pConfig = getPluginConfig(p.manifest.id) || {};
        try {
          const result = await p.impl.recommend(pConfig);
          const channels = Array.isArray(result?.channels) ? result.channels : [];
          for (const ch of channels) {
            const playlists = (Array.isArray(ch.playlists) ? ch.playlists : []).map((pl: any) => {
              // 检查该歌单是否已入库(由 runDailyJob 同步)
              const local = findLocalRemotePlaylist(pl.id, ch.source || "", pl.name || "");
              return {
                id: pl.id,
                source: ch.source || "",
                name: pl.name || "",
                creator: pl.creator || "",
                cover: pl.cover || "",
                trackCount: local ? String(local.songCount ?? "") : "",
                link: pl.link || "",
                imported: !!local,
              };
            });
            allChannels.push({
              source: ch.source || "",
              name: ch.name || ch.source || "",
              count: ch.count || 0,
              sortOrder: typeof ch.sortOrder === "number" ? ch.sortOrder : 99,
              _pluginId: p.manifest.id,
              playlists,
            });
          }
        } catch (e: any) {
          console.warn(`[RECOMMEND] ${p.manifest.id} recommend() failed:`, e?.message || e);
        }
      })()
    );
  await Promise.all(rpTasks);

  // ---- 3. 按 sortOrder 升序排列(数值越小越靠前) ----
  allChannels.sort((a: any, b: any) => {
    const sa = typeof a.sortOrder === "number" ? a.sortOrder : 99;
    const sb = typeof b.sortOrder === "number" ? b.sortOrder : 99;
    return sa - sb;
  });

  return { channels: allChannels, primaryError };
}

/** 后台刷新 single-flight 表:key = 缓存 key。同一缓存在途刷新至多一个。 */
const recommendRefreshInflight = new Map<string, Promise<void>>();

/**
 * /v1/local-recommend 各 provider 的**在途调用**单飞表:key = 插件 id → 正在进行的
 * recommendLocal() 调用 promise(解析为 provider 原始结果)。冷启动竞速与 SWR 后台刷新
 * **共用同一张表**:同一 provider 任意时刻至多发起一次沙箱调用;settle 时写缓存并自清。
 * (2026-10-15 复审发现的缺陷:此前只对「后台写缓存」去重,不挡调用本身 —— 前端 8s 轮询
 *  与多客户端并发会把同一慢 provider 反复并发外呼,正是本次要消除的负载。)
 * 置于模块作用域:与 recommendRefreshInflight 同惯例,且便于测试钩子统一清空。
 */
const providerInvokeInflight = new Map<string, Promise<any>>();

/** 冷启动/刷新失败退避表:key → 上次失败时刻。60s 内不再重复发起后台拉取,
 *  防止前端轮询重试把故障中的上游打爆(2026-10-15 B2)。 */
const recommendColdFailAt = new Map<string, number>();
const RECOMMEND_REFRESH_BACKOFF_MS = 60 * 1000;

/** 缓存的后台刷新(SWR 过期续命 + 冷启动首拉共用,不 await):single-flight 去重;
 *  成功后原子更新缓存并 write-through 落 DB(B1)。聚合层面插件失败会被吞进
 *  primaryError 并返回空 channels —— 有旧缓存时**不覆盖**(保留 last-good,下次
 *  请求继续 stale 返回并再试);冷启动(无旧缓存)则记入失败退避表,60s 内不再 kick。 */
function refreshRecommendCacheInBackground(
  cacheKey: string,
  providerId: string,
  rp: ReturnType<typeof firstEnabledByCapability>,
  rpList: any[],
): void {
  if (recommendRefreshInflight.has(cacheKey)) return;
  const failedAt = recommendColdFailAt.get(cacheKey);
  if (failedAt && Date.now() - failedAt < RECOMMEND_REFRESH_BACKOFF_MS) return;
  const task = (async () => {
    const { channels, primaryError } = await fetchRecommendChannels(providerId, rp, rpList);
    if (primaryError && channels.length === 0) {
      recommendColdFailAt.set(cacheKey, Date.now());
      console.warn(`[RECOMMEND] 后台拉取失败(60s 退避): ${primaryError}`);
      return;
    }
    recommendColdFailAt.delete(cacheKey);
    writeAggCache(cacheKey, { ts: Date.now(), channels });
    log.info(`[RECOMMEND] 后台拉取完成: ${cacheKey}`);
  })().catch((e: any) => {
    recommendColdFailAt.set(cacheKey, Date.now());
    console.warn("[RECOMMEND] 后台拉取失败(60s 退避):", e?.message || e);
  }).finally(() => {
    recommendRefreshInflight.delete(cacheKey);
  });
  recommendRefreshInflight.set(cacheKey, task);
}

// ==================== 周期性预热刷新 ====================
// 模式与 services/dailyScheduler.ts 一致:递归 setTimeout、finally 里 re-arm、
// 异常不断链。间隔 = TTL/2:用户请求几乎总能命中未过期缓存。只预热「已有缓存」
// 的 key(说明首页被用过);冷启动不做无谓外呼。定时器 unref,不阻进程退出。
let recommendWarmerTimer: ReturnType<typeof setTimeout> | null = null;

export function startRecommendCacheWarmer(): void {
  if (recommendWarmerTimer) return;
  const tick = () => {
    recommendWarmerTimer = setTimeout(() => {
      try {
        // 用当前插件集重算 cacheKey(插件增删后旧 key 自然不再预热,由内存清理兜底)。
        const rp = firstEnabledByCapability("recommend");
        const providerId = rp?.manifest.id || "";
        const rpSigs = getEnabledByCapability("recommendPlaylist").map((p: any) => p.manifest.id).sort().join(",");
        const cacheKey = providerId + "|" + rpSigs;
        // B3(2026-10-15):内存 miss 时回退读 DB 落库缓存——进程重启后若首页曾被用过,
        // DB 里有 last-good,照常预热刷新,重启不再冷。DB 里也没有(从未访问过)则跳过,
        // 保留「冷启动不做无谓外呼」的既有哲学;用户首次访问时由请求路径 kick 冷启动。
        const entry = recommendCache.get(cacheKey) ?? readAggCacheDb(cacheKey);
        if (entry && Date.now() - entry.ts >= RECOMMEND_CACHE_TTL_MS) {
          refreshRecommendCacheInBackground(cacheKey, providerId, rp, getEnabledByCapability("recommendPlaylist"));
        }
      } catch (e: any) {
        console.warn("[RECOMMEND] SWR 预热失败:", e?.message || e);
      } finally {
        tick(); // re-arm(在 finally,异常也不能断链)
      }
    }, RECOMMEND_CACHE_TTL_MS / 2);
    recommendWarmerTimer?.unref?.();
  };
  tick();
}

// ==================== 单飞调用(provider 结果缓存写入) ====================
// 从 registerRecommend 内提到模块作用域:后台预热器(warmLocalProvidersOnce)需要在
// 模块加载期就能复用它 —— 与请求路径共用同一在途表,避免重复外呼。
/** 取(或发起)某 provider 的单飞调用。返回**原始结果 promise**:成功时先写入
 *  providerRecommendCache 再 resolve 该结果(冷启动路径依赖此返回值当作本轮真值),
 *  失败原样 reject,由调用方各自处理(冷启动交 raceDeadline 竞速;SWR 后台自行 catch)。
 *  在途表 providerInvokeInflight 见模块顶部。 */
function kickProviderInvoke(pluginId: string, p: any): Promise<any> {
  const existing = providerInvokeInflight.get(pluginId);
  if (existing) return existing;
  const tracked: Promise<any> = p.impl
    .recommendLocal(getPluginConfig(pluginId) || {})
    .then((fresh: any) => {
      providerRecommendCache.set(pluginId, { ts: Date.now(), result: fresh });
      return fresh;
    })
    .finally(() => {
      providerInvokeInflight.delete(pluginId);
    });
  providerInvokeInflight.set(pluginId, tracked);
  return tracked;
}

// ==================== local-recommend 冷启动预热(优化 #4) ====================
// 根因:进程刚启动(或内存缓存被 reclaim 清空)时 providerRecommendCache 无条目,
// 首页首个 /v1/local-recommend 会对每个声明 TTL 的榜单插件走 raceDeadline,硬等
// LOCAL_PROVIDER_DEADLINE_MS(2500ms) —— 生产日志实测慢请求 ms=2582/2484/1756/1521/1208。
// 这段等待发生在请求路径上,直接把首页打开拖慢。沙箱 provider 的首次调用成本高
// (冷启动加载/握手),是一次性昂贵开销;与其让请求路径买单,不如在后台提前跑一轮把
// 结果写进 providerRecommendCache —— 之后请求路径直接命中缓存秒回。
// 为什么用后台预热而不是让请求路径继续等 2500ms:等待是「每进程首启一次」的确定性
// 成本,后台预热把它挪到无人等待的时间窗口;请求路径仍保持有界(超时转 pending,前端
// 轮询自愈)。只预热**声明了 recommendCacheTtlSeconds(>0)** 的插件 —— 内置「本地随机」
// (localPlatformRecommend 能力但无该字段)每次需重洗,缓存分支根本不命中它,预热无意义。
const LOCAL_PROVIDER_WARMER_INITIAL_MS = 4 * 1000;
const LOCAL_PROVIDER_WARMER_MAX_INTERVAL_MS = 60 * 1000;
let localProviderWarmerTimer: ReturnType<typeof setTimeout> | null = null;

/** 预热周期 = min(60s, 所有声明 TTL 插件的最小 ttl/2)。
 *  取二者较小值:ttl/2 保证 TTL 较短的插件也在过期前被刷新;60s 为上限,避免非必要的
 *  频繁外呼。现有榜单插件 TTL 均为 120s(ttl/2 = 60s),正好与上限相等。 */
function localProviderWarmIntervalMs(): number {
  let interval = LOCAL_PROVIDER_WARMER_MAX_INTERVAL_MS;
  for (const p of getEnabledByCapability("localPlatformRecommend")) {
    const ttlSec = Number(p.manifest?.recommendCacheTtlSeconds);
    if (Number.isFinite(ttlSec) && ttlSec > 0) interval = Math.min(interval, (ttlSec * 1000) / 2);
  }
  return interval;
}

/** 跑一轮预热:遍历声明 TTL 的 localPlatformRecommend 插件,缓存缺失或已过期则后台
 *  单飞拉取(kickProviderInvoke 与请求路径共用同一在途表);返回全部在途 promise,
 *  便于测试等待其完成。 */
function warmLocalProvidersOnce(): Promise<void> {
  const tasks: Promise<any>[] = [];
  for (const p of getEnabledByCapability("localPlatformRecommend")) {
    if (typeof p.impl?.recommendLocal !== "function") continue;
    const ttlSec = Number(p.manifest?.recommendCacheTtlSeconds);
    if (!(Number.isFinite(ttlSec) && ttlSec > 0)) continue; // 未声明 TTL:不预热
    const pluginId = p.manifest.id;
    const cached = providerRecommendCache.get(pluginId);
    if (cached && Date.now() - cached.ts < ttlSec * 1000) continue; // 仍新鲜,不重复拉
    // 失败仅 warn,不阻塞、不设退避 —— 下一轮仍会重试。
    tasks.push(kickProviderInvoke(pluginId, p).catch((e: any) => {
      console.warn(`[LOCAL-RECOMMEND] 预热 ${pluginId} 失败:`, e?.message || e);
    }));
  }
  return Promise.all(tasks).then(() => undefined);
}

/** 测试钩子:跑一轮预热并等待所有 kick 结束(vitest 据此断言缓存已写入)。 */
export function __warmLocalProvidersOnceForTest(): Promise<void> {
  return warmLocalProvidersOnce();
}

/** 启动周期预热(幂等:已有定时器直接 return)。递归 setTimeout + finally re-arm,
 *  与 startRecommendCacheWarmer 同款;定时器 unref,不阻进程退出。首轮用较短初始
 *  延迟(3~5s,避开启动期批量任务抢资源),之后按 min(60s, ttl/2) 周期。 */
export function startLocalProviderWarmer(): void {
  if (localProviderWarmerTimer) return;
  const tick = (delayMs: number) => {
    localProviderWarmerTimer = setTimeout(() => {
      warmLocalProvidersOnce()
        .catch((e: any) => {
          console.warn("[LOCAL-RECOMMEND] 预热轮次失败:", e?.message || e);
        })
        .finally(() => {
          tick(localProviderWarmIntervalMs()); // re-arm(在 finally,异常也不能断链)
        });
    }, delayMs);
    localProviderWarmerTimer?.unref?.();
  };
  tick(LOCAL_PROVIDER_WARMER_INITIAL_MS);
}

/** 测试钩子:清空失败退避表、在途刷新表、provider 在途调用表与 provider 结果缓存
 *  (vitest 用例间隔离;预热用例需要从「缓存为空」的冷态起跑)。 */
export function __resetRecommendRefreshStateForTest(): void {
  recommendColdFailAt.clear();
  recommendRefreshInflight.clear();
  providerInvokeInflight.clear();
  providerRecommendCache.clear();
}

export function registerRecommend(app: Hono): void {
app.use("/v1/recommend", permMiddleware(PERM.RECOMMEND_VIEW));

app.use("/v1/local-recommend", permMiddleware(PERM.RECOMMEND_VIEW));

app.use("/v1/home/playlist-count", permMiddleware(PERM.RECOMMEND_VIEW));

app.get("/v1/recommend", async (c) => {
  // ==================== 统一推荐聚合 ====================
  // 1) 调用主推荐插件(具备 recommend 能力,如 go-music-dl)获取频道
  // 2) 调用所有推荐歌单插件(具备 recommendPlaylist 能力,如 QQ/酷狗/网易云榜单)
  // 3) 合并所有频道,按 sortOrder 升序排列
  // 这样每个插件都是独立平等的,不依赖 go-music-dl 内部合并。
  // ====================================================
  const rp = firstEnabledByCapability("recommend");
  const providerId = rp?.manifest.id || "";

  // 缓存 key 包含所有 recommendPlaylist 插件 ID,避免缓存错乱
  const rpList = getEnabledByCapability("recommendPlaylist");
  const rpSigs = rpList.map((p: any) => p.manifest.id).sort().join(",");
  const cacheKey = providerId + "|" + rpSigs;
  const cached = recommendCache.get(cacheKey) ?? readAggCacheDb(cacheKey);
  if (cached && Date.now() - cached.ts < RECOMMEND_CACHE_TTL_MS) {
    return c.json({ success: true, channels: cached.channels, providerId });
  }
  // SWR:有过期缓存 → 立即返回 stale + 后台单飞刷新(响应体形状与热路径一致)。
  if (cached) {
    refreshRecommendCacheInBackground(cacheKey, providerId, rp, rpList);
    return c.json({ success: true, channels: cached.channels, providerId });
  }

  // 无任何缓存(冷启动,2026-10-15 B2 起不再阻塞):立即返回空频道 + pending:true,
  // 后台 single-flight 拉取(成功 write-through 落 DB,失败 60s 退避)。前端收到
  // pending 后轮询重试,数据到位自动填充——首页打开路径从此零阻塞外呼。
  refreshRecommendCacheInBackground(cacheKey, providerId, rp, rpList);
  return c.json({ success: true, channels: [], providerId, pending: true });
});

// 启动周期预热(SWR 的一部分;幂等,重复注册不会叠加定时器)。
startRecommendCacheWarmer();

// 启动 local provider 后台预热(优化 #4;幂等,重复注册不会叠加定时器)。
startLocalProviderWarmer();

// ==================== 首页「本地随机(按平台)」(能力驱动,不写死插件名) ====================
// 由启用的 `localPlatformRecommend` 插件(如内置 local-random-recommend)提供:
// 从本地库按平台分组随机取已入库歌单,供三端(Web/客户端/HA)统一展示动态刷新的
// 平台歌单——不依赖上游固定精选。核心只按能力遍历调用并透传数据。

/** 冷启动 provider 软截止(ms):超过则本轮不再阻塞等待,转后台单飞拉取。 */
const LOCAL_PROVIDER_DEADLINE_MS = 2500;

/** 与截止时间竞速:超时返回 {ok:false};provider 自身报错则原样抛出(交外层 try/catch
 *  记录,与改动前「recommendLocal() failed」的告警语义一致)。两个分支都给 `p` 挂了
 *  处理函数,杜绝迟到 settle 造成的 unhandled rejection。 */
function raceDeadline<T>(p: Promise<T>, ms: number): Promise<{ ok: true; value: T } | { ok: false }> {
  return new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve({ ok: false }); } }, ms);
    p.then(
      (value) => { if (!done) { done = true; clearTimeout(t); resolve({ ok: true, value }); } },
      (err) => { if (!done) { done = true; clearTimeout(t); reject(err); } },
    );
  });
}

app.get("/v1/local-recommend", async (c) => {
  // 遍历所有具备该能力的插件,合并多插件的 channels(支持多提供方共存)。
  // 并发调用各 provider(P0-1):把若干「榜单类」插件(P1-1 命中缓存后近乎零成本)与
  // 内置「本地随机」(P0-3 池缓存后仅洗牌)的墙钟重叠,不再串行累加。各 provider 独立
  // try/catch,单个失败只记 warn、不影响其它;合并结果最后统一按 sortOrder 排序。
  const providers = getEnabledByCapability("localPlatformRecommend");
  const allChannels: any[] = [];
  let pendingAny = false;
  await Promise.all(
    providers.map(async (p) => {
      if (typeof p.impl?.recommendLocal !== "function") return;
      const pluginId = p.manifest.id;
      // P1-1:仅当插件 manifest 显式声明 recommendCacheTtlSeconds(>0 秒)才缓存其结果。
      // 完全由 manifest 字段驱动,核心不写死插件名;内置「本地随机」不声明该字段
      // (需每次重洗),故永不进入该缓存分支。
      const ttlSec = Number(p.manifest?.recommendCacheTtlSeconds);
      const cacheable = Number.isFinite(ttlSec) && ttlSec > 0;
      try {
        let result: any;
        const cached = cacheable ? providerRecommendCache.get(pluginId) : undefined;
        if (cached && Date.now() - cached.ts < ttlSec * 1000) {
          result = cached.result;
        } else if (cached) {
          // SWR:过期缓存立即返回 stale,后台单飞刷新(与 /v1/recommend 同策略)。
          // kickProviderInvoke 与冷分支共用单飞表 → 已有在途调用时直接复用它。
          // 后台刷新为 fire-and-forget:失败仅告警,勿让 rejection 逃逸成未处理拒绝。
          kickProviderInvoke(pluginId, p).catch((e: any) => {
            console.warn(`[LOCAL-RECOMMEND] ${pluginId} 拉取失败:`, e?.message || e);
          });
          result = cached.result;
        } else if (cacheable) {
          // 冷启动无缓存:不再同步阻塞(2026-10-15 首页偶发卡死修复)。沙箱 provider 调用
          // 实测 1.6–16.6s(最坏超过前端 15s 超时),会拖住首页打开。用软截止竞速**单飞调用**:
          // 截止内返回就用其真值(缓存已由 kickProviderInvoke 写入);超时则本轮该 provider 不产出
          // 频道并置 pending,后台同一条 promise 仍在跑,settle 后写缓存,下一轮请求即命中秒回。
          const raced = await raceDeadline(kickProviderInvoke(pluginId, p), LOCAL_PROVIDER_DEADLINE_MS);
          if (!raced.ok) {
            pendingAny = true;
            return; // 本轮跳过该 provider
          }
          result = raced.value;
        } else {
          // 未声明 TTL 的 provider(内置本地随机,纯进程内洗牌):保持同步调用。
          result = await p.impl.recommendLocal(getPluginConfig(pluginId) || {});
        }
        const channels = Array.isArray(result?.channels) ? result.channels : [];
        for (const ch of channels) {
          allChannels.push({
            source: ch.source || "",
            name: ch.name || ch.source || "",
            count: ch.count || 0,
            sortOrder: typeof ch.sortOrder === "number" ? ch.sortOrder : 99,
            // 可选展示文案(由提供方决定;缺省时前端回落为「本地随机」默认表述):
            //   subtag  → 分区标题后缀(如「每日更新」),缺省用「本地随机」
            //   tagline → 分区副标题说明,缺省用「从你的 X 歌单里随机(每次刷新不同)」
            subtag: typeof ch.subtag === "string" ? ch.subtag : undefined,
            tagline: typeof ch.tagline === "string" ? ch.tagline : undefined,
            // 本地歌单:直接透传 DB 字段(coverArt 为本地封面 ref,三端用各自 cover 工具拼 URL)。
            playlists: (Array.isArray(ch.playlists) ? ch.playlists : []).map((pl: any) => ({
              id: pl.id ?? "",
              name: pl.name ?? "",
              coverArt: pl.coverArt ?? null,
              songCount: pl.songCount ?? 0,
              imported: true,
            })),
          });
        }
      } catch (e: any) {
        // provider 本轮未产出(调起失败/拒绝):置 pending,前端据此继续轮询自愈 ——
        // 否则返回 200 + 空频道 + 无 pending,前端会当作「稳态空」而停止重试,分区永久空白。
        pendingAny = true;
        console.warn(`[LOCAL-RECOMMEND] ${p.manifest.id} recommendLocal() failed:`, e?.message || e);
      }
    }),
  );
  // 按 sortOrder 升序排列(数值越小越靠前)
  allChannels.sort((a, b) => {
    const sa = typeof a.sortOrder === "number" ? a.sortOrder : 99;
    const sb = typeof b.sortOrder === "number" ? b.sortOrder : 99;
    return sa - sb;
  });
  return c.json(
    pendingAny
      ? { success: true, channels: allChannels, pending: true }
      : { success: true, channels: allChannels },
  );
});

// 首页顶部「每日推荐 + 本地推荐 + 随机歌单」展示张数(含两张固定推荐)。
// 由每日推荐插件的 homeCount 配置控制(默认 8),核心经能力门面读取,不写死插件名。

app.get("/v1/home/playlist-count", (c) => {
  return c.json({ success: true, count: dailyRecommendHomeCount() });
});

// ==================== 首页固定卡(推荐插件自治) ====================
// 哪些推荐歌单固定在首页顶部、按什么位次排,由各插件自己的配置决定:
//   manifest.configSchema 声明 showOnHome(switch) / homePosition(number);
//   manifest.homePlaylistId 声明首页对应的固定歌单 id。
// 核心按能力收集(不写死插件名),位次冲突在保存插件配置时校验。

app.get("/v1/recommend/home-cards", (c) => {
  // ?all=1 返回全部固定推荐歌单(含未开启「在首页显示」的),供音流等场景
  // 选择固定引用;默认只返回 showOnHome(首页展示)。
  const all = c.req.query("all") === "1";
  const plugins = listHomeCardPlugins().filter((p) => p.showOnHome || all);
  // 位次排序:0(未固定)排最后,固定位次升序。
  const sorted = [...plugins].sort((a, b) => {
    const pa = a.position || Number.MAX_SAFE_INTEGER;
    const pb = b.position || Number.MAX_SAFE_INTEGER;
    return pa - pb || a.pluginId.localeCompare(b.pluginId);
  });
  const cards = sorted.map((p) => {
    const pl = sqlite.prepare("SELECT id, name, song_count, cover_art FROM playlists WHERE id = ?").get(p.playlistId) as any;
    return {
      pluginId: p.pluginId,
      name: p.name,
      playlistId: p.playlistId,
      position: p.position,
      capabilities: p.capabilities,
      isCombo: p.capabilities.includes("comboPlaylist"),
      // 歌单信息(前端按 songCount > 30 门槛展示)
      playlistName: pl?.name || "",
      songCount: pl?.song_count || 0,
      // 统一返回标准逻辑 ref pl-<id>(getCoverArt 按 pl- 前缀查歌单行解析;
      // 直接返回 cover_art 原始值(如 pl-pl-daily-today.jpg)会被当成 playlistId
      // 查表失败 → 首页卡片无封面)。
      coverArt: pl ? `pl-${p.playlistId}` : null,
    };
  });
  return c.json({ success: true, cards });
});

// ==================== 网络代理(管理员,仅插件拉取链路) ====================
// 系统设置里的「网络代理」:http://ip:port、https://ip:port 或 socks5://ip:port,
// 用于插件市场拉取 GitHub 等源(registry / plugin.json / 安装包)。仅影响插件拉取,
// 其它后端网络直连。

app.post("/v1/recommend/refresh", adminMiddleware, async (c) => {
  touch(); // 标记活动:推荐歌单刷新
  const body = await c.req.json().catch(() => ({}));

  // 单插件手动刷新:任意声明 dailyPlaylist / localPlaylist / comboPlaylist /
  // recommendPlaylist / localPlatformRecommend / playlistCleanup 能力的插件
  // (内置或外置)都可经此入口强制重跑。传 force 绕过插件自身的间隔闸门。
  // **异步任务通道**:任务在后台跑(沙箱用 manifest.longRunning
  // 长预算),立即返回,前端轮询 GET /v1/plugins/:id/job 看结果——不再被沙箱 15s
  // 或前端 axios 15s 卡死。
  const pluginId = body?.pluginId;
  if (pluginId) {
    const reg = getPlugin(pluginId);
    if (!reg) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.plugin.notFound"), 404);
    const caps: string[] = reg.manifest.capabilities || [];
    const isDaily =
      caps.includes("dailyPlaylist") ||
      caps.includes("localPlaylist") ||
      caps.includes("comboPlaylist") ||
      caps.includes("recommendPlaylist") ||
      caps.includes("localPlatformRecommend") ||
      caps.includes("playlistCleanup");
    if (!isDaily) {
      return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.plugin.noRefresh"), 400);
    }
    // 未启用(或尚无 DB 行)视为不可用。
    if (getPluginConfig(pluginId) === null) {
      return c.json(apiError(BusinessErrorCode.UNAVAILABLE, "errors.plugin.notEnabled"), apiErrorStatus(BusinessErrorCode.UNAVAILABLE));
    }
    const impl = reg.impl;
    if (typeof impl?.runDailyJob !== "function") {
      return c.json(apiError(BusinessErrorCode.INTERNAL, "errors.plugin.noDailyJob"), 500);
    }
    const { started, alreadyRunning } = runPluginJob(pluginId, "runDailyJob", { force: true, keywordOnly: !!body?.keywordOnly });
    if (alreadyRunning) {
      return c.json({ success: true, pluginId, alreadyRunning: true, message: "该插件刷新任务已在后台运行中" }, 200);
    }
    if (!started) {
      return c.json(apiError(BusinessErrorCode.UPSTREAM_ERROR, "errors.task.startFailed"), apiErrorStatus(BusinessErrorCode.UPSTREAM_ERROR));
    }
    return c.json({ success: true, pluginId, started: true, message: "已开始后台刷新,可通过 GET /v1/plugins/:id/job 查询进度" }, 202);
  }

  const targets = Array.isArray(body?.targets) ? body.targets : ["daily", "local", "roam"];
  // 同步前置校验:能力不存在直接 503(契约保留)。实际生成在一次性批量子进程内跑
  // (recommend-refresh,方案3),峰值内存随子进程退出归还;前端 202 后轮询
  // GET /v1/tasks/:taskId 取结果(task.result = { success, seedSalt, results })。
  if (targets.includes("daily") && !dailyApi()) return c.json(apiError(BusinessErrorCode.UNAVAILABLE, "errors.common.dailyRecommendDisabled"), apiErrorStatus(BusinessErrorCode.UNAVAILABLE));
  if (targets.includes("local") && (!localApi() || typeof localApi().generateLocalDailyPlaylist !== "function")) {
    return c.json(apiError(BusinessErrorCode.UNAVAILABLE, "errors.common.localRecommendDisabled"), apiErrorStatus(BusinessErrorCode.UNAVAILABLE));
  }
  if (targets.includes("roam") && (!comboApi() || typeof comboApi().generateComboPlaylist !== "function")) {
    return c.json(apiError(BusinessErrorCode.UNAVAILABLE, "errors.common.roamRecommendDisabled"), apiErrorStatus(BusinessErrorCode.UNAVAILABLE));
  }
  const seedSalt = Math.floor(Math.random() * 1_000_000);
  const started = startAsyncTask("recommend-refresh", `targets:${targets.join(",")}`, {
    kind: "recommend-refresh",
    args: { targets, seedSalt },
  });
  if (!started.started) {
    return c.json({
      success: true, started: false, alreadyRunning: true, taskId: started.taskId, seedSalt,
      message: "刷新任务已在后台运行中,可通过 GET /v1/tasks/:taskId 查询进度",
    }, 202);
  }
  return c.json({
    success: true, started: true, taskId: started.taskId, seedSalt,
    message: "已开始后台刷新,可通过 GET /v1/tasks/:taskId 查询进度",
  }, 202);
});

// ==================== User recommend pool ====================
// A user can click "加入每日推荐池" on any playlist (or on "我喜欢的音乐")
// to add that source to the pool. Each daily-recommend run picks up to 50
// random playable songs from every pool member and merges them into the
// day's combined "每日推荐" playlist.

// List all pool members (for an admin management page if desired).
}
