// ==================== 本地随机歌单(按平台分组)内置插件 ====================
//
// 用途:首页「本地随机(按平台)」区块的数据源 —— 从**本地库**挑出各平台已入库的
// 歌单(来自平台搜索 / 分享导入 / 每日推荐同步,playlists.source_platform 非空),
// 按平台分组、每组随机洗牌后取 homeCount 个,每次调用内容不同 → 首页动态刷新。
//
// 背景:上游 music-lib 对 QQ/酷狗/酷我等平台返回的是固定编辑精选,不会变;网易云
// 每次返回新歌单。为了让**所有平台**首页都能动态变化,又不改上游、不改前端平台
// 逻辑,把「本地随机」作为独立能力由本内置插件提供。核心只加一个转发路由
// GET /v1/local-recommend,按 localPlatformRecommend 能力调用 recommendLocal()。
//
// 边界:
//  - type=recommender(非 source)→ 不会进入每日同步源遍历(recommendImport/Path A),
//    避免把本地库歌单误当上游源重复导入。
//  - 能力名 localPlatformRecommend(独立于 recommend)→ 不占 /v1/recommend,不跟
//    go-music-dl 抢端点。
//  - 平台显示名由本插件自带词典(核心不内置平台词典,符合插件自治规范)。

import { sqlite } from "../../db/index.js";
import { createLogger } from "../../utils/logger.js";
import type { PluginManifest } from "../../plugins/types.js";
import { resolveCoverFile, firstPlayableCoverRef } from "../playlistCover.js";
import { SCHEDULE_FIELDS } from "./scheduleFields.js";

const log = createLogger("LOCAL-PLATFORM-REC");

export const LOCAL_PLATFORM_REC_PLUGIN_ID = "local-random-recommend";
const DEFAULT_HOME_COUNT = 6; // 每个平台默认展示歌单数
const MAX_HOME_COUNT = 50;

// 平台 slug → 展示名。核心不内置平台词典,新增平台只需在此加一项。
const PLATFORM_LABELS: Record<string, string> = {
  netease: "网易云",
  qq: "QQ 音乐",
  kugou: "酷狗",
  kuwo: "酷我",
  migu: "咪咕",
  ximalaya: "喜马拉雅",
  bytedance: "抖音",
  youtube: "YouTube",
  soundcloud: "SoundCloud",
  local: "本地",
};

/** 读本插件配置:每平台歌单数。非法或未配置回落默认。 */
function getConfig(): { homeCount: number; sortOrder: number } {
  try {
    const row = sqlite
      .prepare("SELECT config FROM plugins WHERE name = ? AND enabled = 1")
      .get(LOCAL_PLATFORM_REC_PLUGIN_ID) as any;
    const cfg = row?.config ? JSON.parse(row.config) : {};
    const raw = parseInt(String(cfg.homeCount), 10);
    const homeCount =
      Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_HOME_COUNT) : DEFAULT_HOME_COUNT;
    const sortRaw = parseInt(String(cfg.sortOrder), 10);
    const sortOrder = Number.isFinite(sortRaw) && sortRaw > 0 ? sortRaw : 20;
    return { homeCount, sortOrder };
  } catch {
    return { homeCount: DEFAULT_HOME_COUNT, sortOrder: 20 };
  }
}

/** Fisher–Yates 洗牌(返回新数组,不改原数组)。 */
function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export interface LocalPlatformChannel {
  source: string; // 平台 slug,如 netease
  name: string; // 平台展示名
  count: number; // 本平台返回歌单数
  sortOrder?: number; // 首页排序值,数值越小越靠前
  playlists: {
    id: string; // 本地歌单 id(已入库,可直接播)
    name: string;
    coverArt: string | null; // 本地封面 ref(三端用各自 cover 工具拼完整 URL)
    songCount: number;
    imported: true; // 本地已入库歌单
  }[];
}

// ==================== P0-3:候选池缓存(SWR) ====================
// 首页「本地随机」稳态下每次刷新都要跨库取全部平台歌单。此处做进程内候选池:
//   - 主 SQL 一次读出全部带平台歌单,按平台分组存入 bySource;
//   - TTL(PLATFORM_POOL_TTL_MS)内直接复用候选集合,但**每次请求仍重新洗牌**
//     (随机性 100% 保留 —— 这是与「整体缓存」的本质区别);
//   - 显式失效(invalidatePlatformPool):置脏 + 后台单飞重建 —— 保留旧 warm 池继续
//     服务在途请求,后台重建后原子替换;
//   - TTL 过期 → SWR:旧池继续供本轮洗牌(不阻塞请求),后台单飞重建一次;
//   - 冷启动(进程内首次、无任何 warm 池)同步建一次(否则首页无数据);
//     空闲回收经 registerCacheCleaner 走 dropPlatformPool 硬清空。
//
// 注意:**封面解析不在这里**。历史实现把封面 memo 挂在池对象上(coverMemo),池每
// 120s TTL 重建、每次 invalidate 也重建 → memo 跟着清空,封面成本周期性回到 0,
// 永远热不起来(240 实测稳态单请求仍 0.9s)。现已抽成独立快照,见下方 P0-3b。
const PLATFORM_POOL_TTL_MS = 120_000; // 120 秒

interface PlatformPoolRow {
  id: string;
  name: string;
  source_platform: string;
  song_count: number;
  cover_art: string | null;
}

interface PlatformPool {
  ts: number;
  bySource: Map<string, PlatformPoolRow[]>;
}

let platformPoolCache: PlatformPool | null = null;

/** 置脏候选池缓存(歌单增删改/导入后调用):保留旧 warm 池继续服务在途请求,
 *  后台单飞重建后原子替换 —— 请求路径不再因显式失效而同步全量扫描。
 *  新数据在后台重建落地后的下一轮请求即可见。 */
export function invalidatePlatformPool(): void {
  poolDirty = true;
  if (platformPoolCache) schedulePoolRebuild();
}

/** 硬清空候选池缓存(空闲内存回收专用):回收要真正释放内存,不做后台重建;
 *  下一次请求走冷启动同步建池。
 *  **封面快照不在此清空** —— 它独立于池、868 条 <50KB,清掉只会让下一次首页请求
 *  重新解析全部歌单封面(240 实测 +0.9s),是「丢了能重建」里唯一不该丢的一项。 */
export function dropPlatformPool(): void {
  platformPoolCache = null;
  poolDirty = false;
}

// 注:空闲内存回收时清空该缓存,由 routes/api/shared.ts 经 registerCacheCleaner 注册。
// (不在此自注册:本模块被 builtins 加载,而 reclaim → streamFallback → … → builtins
//  会形成 load 期模块环,顶层调用 registerCacheCleaner 会命中 cleaners 的 TDZ。)

/**
 * 解析单行歌单的封面 ref —— 语义与 playlistCover.getPlaylistCover 逐字等价:
 * 同一列 cover_art + 同扩展名门(/\.(jpg|jpeg|png|gif)$/i)+ 同 resolveCoverFile;
 * 自身可解析时统一返回不带扩展名的 `pl-<id>`(不能直接透传 DB 的 `pl-<id>.jpg`,
 * 否则 getCoverArt 会把 `.jpg` 混进歌单 id 查库失败 → 封面空白),否则回落到
 * 歌单内可播歌曲的第一张封面。都没有返回 null(前端占位符)。
 *
 * 回落走 firstPlayableCoverRef 而非 listPlayableCoverRefs:首页每张卡片只需要一个
 * 封面,后者为收集全部候选会扫 50 行且逐行 fs 探测(240 实测大歌单 16.7ms)。
 */
function resolveRowCover(r: PlatformPoolRow): string | null {
  if (r.cover_art && /\.(jpg|jpeg|png|gif)$/i.test(r.cover_art) && resolveCoverFile(r.cover_art)) {
    return `pl-${r.id}`;
  }
  return firstPlayableCoverRef(r.id);
}

/** 后台重建 single-flight 标志:防止过期/失效窗口内并发请求重复重建。 */
let poolRebuildInflight = false;

/** 显式失效标记(冷池加固 2026-10-16):为 true 时保留旧池服务本轮请求、后台重建。 */
let poolDirty = false;

/** 全量重建候选池(主 SQL;不做增量合并,保持产物确定性)。 */
function buildPool(now: number): PlatformPool {
  const rows = sqlite
    .prepare(
      `SELECT id, name, source_platform, song_count, cover_art
       FROM playlists
       WHERE source_platform IS NOT NULL AND source_platform != ''`,
    )
    .all() as PlatformPoolRow[];
  const bySource = new Map<string, PlatformPoolRow[]>();
  for (const r of rows) {
    const src = r.source_platform || "";
    if (!src) continue;
    const list = bySource.get(src) || [];
    list.push(r);
    bySource.set(src, list);
  }
  return { ts: now, bySource };
}

/** 后台单飞重建候选池(不阻塞调用方):重建成功原子替换并清脏;
 *  失败保持旧池与脏标记、下一轮请求再 kick(不在微任务里自旋重试)。
 *  注:buildPool 为同步操作,微任务内不会与其它失效交错,故成功即可清脏。 */
function schedulePoolRebuild(): void {
  if (poolRebuildInflight) return; // single-flight:并发/多次失效合并为一次重建
  poolRebuildInflight = true;
  queueMicrotask(() => {
    try {
      platformPoolCache = buildPool(Date.now());
      poolDirty = false;
      log.info("本地随机候选池后台重建完成");
      scheduleCoverPrewarm(); // 新池有哪些歌单缺快照,后台补齐
    } catch (e: any) {
      log.warn("本地随机候选池后台重建失败(保持旧池,下轮重试)", { err: e?.message || e });
    } finally {
      poolRebuildInflight = false;
    }
  });
}

/** 取候选池:TTL 内复用;TTL 过期 / 显式失效 → SWR(旧池继续用 + 后台单飞重建);
 *  池不存在(仅冷启动 / 空闲回收后) → 同步重建(必须有一次,否则首页无数据)。 */
function getPool(): PlatformPool {
  const now = Date.now();
  if (platformPoolCache) {
    if (poolDirty || now - platformPoolCache.ts >= PLATFORM_POOL_TTL_MS) {
      // 不阻塞本轮:继续用旧池洗牌,后台重建供下一轮。
      schedulePoolRebuild();
    }
    return platformPoolCache;
  }
  platformPoolCache = buildPool(now);
  poolDirty = false;
  scheduleCoverPrewarm();
  return platformPoolCache;
}

// ==================== P0-3b:封面 ref 快照(独立于池 + 落盘) ====================
// 为什么独立:旧实现把封面 memo 挂在池对象上,池 TTL 重建 / invalidate 重建都会把
// memo 清空 → 每次「重建后的第一个请求」都要重新解析全部歌单封面。240 生产实测
// (868 个带平台歌单、其中 260 个需回落扫歌单歌曲):
//   - 主 SQL 3ms(不是瓶颈)
//   - 798 个 resolveCoverFile 285ms
//   - 260 个 listPlayableCoverRefs 4344ms  ← 真凶(单歌单 16.7ms)
// 表现为串行 8 次 5.22/2.18/1.19/1.19/1.89/0.81/0.94/0.91s、并发 3 个时 /ping
// 被同步阻塞到 1.48s(点其它标题栏页面卡住的直接原因)。
//
// 现在:快照 Map<playlistId,{ref,ts}> 生命周期比池长,并落盘 settings 表
// (key=localrec:cover-snapshot:v1) —— 进程重启 / 空闲回收后首个首页请求直接复用,
// 不必重新解析。内存 868 条 <50KB。
//
// 一致性:条目 30 分钟软过期。过期条目**仍服务请求**(不回退到占位符),由后台预热器
// 重算覆盖;歌单增删经 invalidatePlatformPool → 后台重建 → 预热补齐/清孤儿。
interface CoverEntry {
  ref: string | null;
  ts: number;
}

const COVER_SNAPSHOT_KEY = "localrec:cover-snapshot:v1";
const COVER_SNAPSHOT_TTL_MS = 30 * 60_000;
const COVER_PERSIST_DEBOUNCE_MS = 3_000;
const COVER_PREWARM_SLICE_MS = 12; // 单分片预算:超过即让出事件循环

let coverEntries: Map<string, CoverEntry> | null = null;
let coverPersistTimer: ReturnType<typeof setTimeout> | null = null;
let coverPrewarmRunning = false;

/** 惰性加载快照(首次用时读一次 settings;解析失败按空表继续)。 */
function loadCoverEntries(): Map<string, CoverEntry> {
  if (coverEntries) return coverEntries;
  const map = new Map<string, CoverEntry>();
  coverEntries = map;
  try {
    const row = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(COVER_SNAPSHOT_KEY) as
      | { value: string }
      | undefined;
    if (row?.value) {
      const parsed = JSON.parse(row.value) as Record<string, [string | null, number]>;
      for (const [id, v] of Object.entries(parsed)) {
        if (Array.isArray(v)) map.set(id, { ref: v[0] ?? null, ts: Number(v[1]) || 0 });
      }
      log.info("本地随机封面快照已加载", { entries: map.size });
    }
  } catch (e: any) {
    log.warn("本地随机封面快照加载失败(按空表继续)", { err: e?.message || e });
  }
  return map;
}

/** 落盘(去抖 3s):只在有变化时写,失败仅告警,绝不影响请求路径。 */
function markCoverSnapshotDirty(): void {
  if (coverPersistTimer) return;
  coverPersistTimer = setTimeout(() => {
    coverPersistTimer = null;
    try {
      const map = loadCoverEntries();
      const obj: Record<string, [string | null, number]> = {};
      for (const [id, e] of map) obj[id] = [e.ref, e.ts];
      sqlite
        .prepare(
          `INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(COVER_SNAPSHOT_KEY, JSON.stringify(obj), new Date().toISOString());
    } catch (e: any) {
      log.warn("本地随机封面快照落盘失败", { err: e?.message || e });
    }
  }, COVER_PERSIST_DEBOUNCE_MS);
  // 持久化定时器不该把进程钉住(容器 stop 时立刻退出)
  (coverPersistTimer as any)?.unref?.();
}

/** 清掉池里已不存在的孤儿条目(歌单被删),避免快照无限增长。 */
function pruneCoverSnapshot(map: Map<string, CoverEntry>, rows: PlatformPoolRow[]): void {
  const live = new Set(rows.map((r) => r.id));
  let removed = 0;
  for (const k of map.keys()) {
    if (!live.has(k)) {
      map.delete(k);
      removed++;
    }
  }
  if (removed > 0) markCoverSnapshotDirty();
}

/** 后台补/刷新快照:按 ≤12ms 分片让出事件循环,不与请求抢主线程。 */
function scheduleCoverPrewarm(): void {
  if (coverPrewarmRunning) return;
  coverPrewarmRunning = true;
  setTimeout(runCoverPrewarmSlice, 0);
}

function runCoverPrewarmSlice(): void {
  const pool = platformPoolCache;
  if (!pool) {
    coverPrewarmRunning = false;
    return;
  }
  const rows: PlatformPoolRow[] = [];
  for (const list of pool.bySource.values()) rows.push(...list);
  const map = loadCoverEntries();
  const now = Date.now();
  const todo = rows.filter((r) => {
    const e = map.get(r.id);
    return !e || now - e.ts >= COVER_SNAPSHOT_TTL_MS;
  });
  if (todo.length === 0) {
    pruneCoverSnapshot(map, rows);
    coverPrewarmRunning = false;
    return;
  }
  let i = 0;
  const step = () => {
    const start = Date.now();
    while (i < todo.length && Date.now() - start < COVER_PREWARM_SLICE_MS) {
      const r = todo[i++];
      map.set(r.id, { ref: resolveRowCover(r), ts: Date.now() });
    }
    if (i < todo.length) {
      setTimeout(step, 0); // 让出事件循环,HTTP 请求可插队
      return;
    }
    pruneCoverSnapshot(map, rows);
    markCoverSnapshotDirty();
    coverPrewarmRunning = false;
    log.info("本地随机封面快照预热完成", { total: rows.length, refreshed: todo.length });
  };
  setTimeout(step, 0);
}

/** 取某歌单封面 ref:快照命中直接返回(过期也用,并触发后台刷新);未命中同步算一次。 */
function coverOf(r: PlatformPoolRow): string | null {
  const map = loadCoverEntries();
  const now = Date.now();
  const hit = map.get(r.id);
  if (hit) {
    if (now - hit.ts >= COVER_SNAPSHOT_TTL_MS) scheduleCoverPrewarm();
    return hit.ref;
  }
  const ref = resolveRowCover(r);
  map.set(r.id, { ref, ts: now });
  markCoverSnapshotDirty();
  scheduleCoverPrewarm(); // 顺带把池里其它缺失项在后台补齐
  return ref;
}

/** 启动预热(供 HTTP 服务起来后调用):先把候选池建好、封面快照补齐,让用户
 *  首个首页请求直接命中。任何失败都静默 —— 下一次请求照样会自己建。 */
export function warmPlatformPoolOnBoot(): void {
  try {
    // 插件被禁用时不必预热(直查 DB,不依赖插件注册时序)
    const row = sqlite
      .prepare("SELECT enabled FROM plugins WHERE name = ?")
      .get(LOCAL_PLATFORM_REC_PLUGIN_ID) as { enabled: number } | undefined;
    if (row && !row.enabled) return;
    getPool();
    scheduleCoverPrewarm();
  } catch (e: any) {
    log.warn("本地随机启动预热失败(不影响请求路径)", { err: e?.message || e });
  }
}

/**
 * 清空封面快照。`dropPersisted=false` 只清内存(模拟「进程重启、快照仍在库里」);
 * 默认连 settings 行一起删。
 *
 * 用途:① 测试用例隔离(dropPlatformPool 已刻意**不**清快照,跨用例会串味);
 * ② 运维/配置重置时彻底重建快照。
 */
export function clearCoverSnapshot(dropPersisted = true): void {
  coverEntries = null;
  if (coverPersistTimer) {
    clearTimeout(coverPersistTimer);
    coverPersistTimer = null;
  }
  if (!dropPersisted) return;
  try {
    sqlite.prepare("DELETE FROM settings WHERE key = ?").run(COVER_SNAPSHOT_KEY);
  } catch (e: any) {
    log.warn("清空封面快照失败", { err: e?.message || e });
  }
}

/**
 * 从本地库按平台分组随机选歌单。纯函数,不报错;库里无任何带平台歌单时返回空。
 * 每组随机洗牌 → 每次调用结果不同(首页刷新即动态变化)。
 * 稳态下候选集合走 SWR 池、封面走持久化快照,但洗牌每次照做 → 刷新仍变。
 * 请求路径只做「读快照 + 洗牌 + 拼装」,不含任何 fs 探测与歌单歌曲 JOIN。
 */
export function recommendLocalPlatforms(): { channels: LocalPlatformChannel[] } {
  try {
    const cfg = getConfig();
    const { homeCount, sortOrder = 20 } = cfg;
    const pool = getPool();

    const channels: LocalPlatformChannel[] = [];
    for (const [source, list] of pool.bySource) {
      const picked = shuffle(list).slice(0, homeCount);
      channels.push({
        source,
        name: PLATFORM_LABELS[source] || source,
        count: picked.length,
        sortOrder,
        playlists: picked.map((r) => ({
          id: r.id,
          name: r.name,
          // 与 playlistCover.getPlaylistCover 语义一致:自身可解析 → `pl-<id>`;
          // 否则回落歌单内可播歌曲封面;都没有 → null(前端占位符)。
          // 走独立封面快照(P0-3b):不是每个请求现算,也不随候选池重建清空。
          coverArt: coverOf(r),
          songCount: r.song_count || 0,
          imported: true,
        })),
      });
    }
    return { channels };
  } catch (e: any) {
    log.error("local recommend failed", { err: e?.message || e });
    return { channels: [] };
  }
}

// ==================== Plugin (recommender, localPlatformRecommend) ====================
export const localPlatformRecommendManifest: PluginManifest = {
  id: LOCAL_PLATFORM_REC_PLUGIN_ID,
  name: "本地随机(按平台)",
  version: "1.0.0",
  type: "recommender",
  description:
    "从本地库按平台挑取已入库歌单供首页「本地随机」动态展示(分组随机,每次刷新内容不同)",
  capabilities: ["localPlatformRecommend"],
  defaultEnabled: true,
  configSchema: [
    {
      key: "homeCount",
      label: "每平台歌单数",
      type: "number",
      default: DEFAULT_HOME_COUNT,
      group: "frontend",
      help: "每个平台在首页「本地随机」分区展示的歌单数量(1~50,默认 6)。所有平台取同一个值。",
    },
    {
      key: "sortOrder",
      label: "首页显示顺序",
      type: "number",
      default: 20,
      group: "frontend",
      help: "数值越小越靠前(1~100,默认 20)。影响首页推荐中「本地随机(按平台)」分区的位置。",
    },
  ],
    ...SCHEDULE_FIELDS,
  // 插件侧 i18n 字典:默认文案即中文,故 zh 省略、只补 en。前端按当前界面语言取用。
  i18n: {
    en: {
      name: "Local Random (by Platform)",
      description:
        "Pick imported playlists from the local library by platform for the home 'Local Random' section (grouped random, different content on each refresh)",
      documentation: `### Features
Randomly picks imported playlists from the local library, grouped by platform, for the home "Local Random (by Platform)" section. Solves the problem of fixed, stale upstream picks from QQ/Kugou/Kuwo etc.: no longer depends on upstream — every refresh randomly swaps playlists from the local library.

### How it works
1. Queries playlists whose \`source_platform\` is not empty in the playlists table (from platform search / shared-link import / daily recommendation sync);
2. Groups by platform, shuffles each group randomly and takes the top \`homeCount\` (default 6, configurable);
3. Every call reshuffles → the home page shows different content on each refresh;
4. The core forwards via \`GET /v1/local-recommend\` using the \`localPlatformRecommend\` capability; all three clients (Web/client/HA) consume it uniformly.

### Notes
- Platform names shown in the UI come from the plugin's \`platformLabels\` mapping.`,
      platformLabels: {
        netease: "NetEase Cloud",
        qq: "QQ Music",
        kugou: "Kugou",
        kuwo: "Kuwo",
        migu: "Migu",
        ximalaya: "Ximalaya",
        bytedance: "Douyin",
        youtube: "YouTube",
        soundcloud: "SoundCloud",
        local: "Local",
      },
      fields: {
        homeCount: {
          label: "Playlists per platform",
          help: "Number of playlists shown per platform in the home 'Local Random' section (1–50, default 6). The same value applies to all platforms.",
        },
        sortOrder: {
          label: "Home display order",
          help: "Smaller values appear first (1–100, default 20). Affects the position of the 'Local Random (by Platform)' section in the home recommendations.",
        },
        scheduleEnabled: {
          label: "Participate in daily scheduled sync",
          help: "When off, the scheduled daily sync skips this plugin (manual refresh still works).",
        },
        runOnBoot: {
          label: "Run once on container startup",
          help: "When on, MusicFlow runs this plugin's playlist once on every startup/restart to keep it fresh.",
        },
        batchParallel: {
          label: "Allow parallel execution",
          help: "Off (default): this plugin's scheduled/batch jobs always run serially in the global queue; On: allowed to run in parallel with other plugins that enable this switch (uses more CPU but is faster).",
        },
      },
    },
  },
  documentation: `### 功能介绍
从本地库按平台分组随机挑取已入库歌单,供首页「本地随机(按平台)」分区动态展示。解决 QQ/酷狗/酷我等平台上游精选固定不变的问题:这里不再依赖上游,每次刷新从本地库随机换歌单。

### 处理逻辑
1. 查 playlists 表中 source_platform 非空的歌单(来自平台搜索 / 分享导入 / 每日推荐同步);
2. 按平台分组,每组随机洗牌后取前 \`homeCount\`(默认 6,可配置)个;
3. 每次调用随机洗牌 → 首页刷新内容不同;
4. 核心经 \`GET /v1/local-recommend\` 按 \`localPlatformRecommend\` 能力转发,三端(Web/客户端/HA)统一消费。

### 边界
- 只读本地已入库歌单,不访问上游、不改任何数据;
- type=recommender 不会进入每日同步源遍历,不会被误当上游源重复导入;
- 平台显示名由本插件自带词典(core 不内置平台词典)。`,
};

export const localPlatformRecommendPlugin: any = {
  manifest: localPlatformRecommendManifest,
  async recommendLocal(): Promise<{ channels: LocalPlatformChannel[] }> {
    return recommendLocalPlatforms();
  },
};
