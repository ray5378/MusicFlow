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
import { resolveCoverFile, listPlayableCoverRefs } from "../playlistCover.js";
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

// ==================== P0-3:候选池 + 封面解析缓存 ====================
// 首页「本地随机」稳态下每次刷新都要跨库取全部平台歌单 + 逐歌单探测封面文件,
// 240 个歌单时 DB/fs 往返是主要耗时。此处做进程内候选池缓存:
//   - 主 SQL 一次读出全部带平台歌单,按平台分组存入 bySource;
//   - 每个歌单的最终 coverArt 惰性解析并 memo 到 coverMemo(避免重复探测);
//   - TTL(PLATFORM_POOL_TTL_MS)内**直接复用候选集合与封面**,但**每次请求仍重新洗牌**
//     (随机性 100% 保留 —— 这是与「整体缓存」的本质区别);
//   - TTL 过期 / 显式失效(invalidatePlatformPool) → 重建一次(走一次慢路径)。
// 内存占用 ≈ 平台歌单行数,可忽略。空闲内存回收时经 registerCacheCleaner 一并清空。
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
  coverMemo: Map<string, string | null>;
}

let platformPoolCache: PlatformPool | null = null;

/** 置空候选池缓存(歌单增删改/导入后调用,让新歌单立即可见)。 */
export function invalidatePlatformPool(): void {
  platformPoolCache = null;
}

// 注:空闲内存回收时清空该缓存,由 routes/api/shared.ts 经 registerCacheCleaner 注册。
// (不在此自注册:本模块被 builtins 加载,而 reclaim → streamFallback → … → builtins
//  会形成 load 期模块环,顶层调用 registerCacheCleaner 会命中 cleaners 的 TDZ。)

/**
 * 解析单行歌单的封面 ref —— 语义与 playlistCover.getPlaylistCover 逐字等价:
 * 同一列 cover_art + 同扩展名门(/\.(jpg|jpeg|png|gif)$/i)+ 同 resolveCoverFile;
 * 自身可解析时统一返回不带扩展名的 `pl-<id>`(不能直接透传 DB 的 `pl-<id>.jpg`,
 * 否则 getCoverArt 会把 `.jpg` 混进歌单 id 查库失败 → 封面空白),否则回落到
 * 歌单内可播歌曲的封面随机一张;都没有返回 null(前端占位符)。
 */
function resolveRowCover(r: PlatformPoolRow): string | null {
  if (r.cover_art && /\.(jpg|jpeg|png|gif)$/i.test(r.cover_art) && resolveCoverFile(r.cover_art)) {
    return `pl-${r.id}`;
  }
  const candidates = listPlayableCoverRefs(r.id);
  if (candidates.length > 0) {
    return candidates[Math.floor(Math.random() * candidates.length)];
  }
  return null;
}

/** 取候选池:TTL 内复用,过期/不存在则重建(走一次主 SQL 慢路径)。 */
function getPool(): PlatformPool {
  const now = Date.now();
  if (platformPoolCache && now - platformPoolCache.ts < PLATFORM_POOL_TTL_MS) {
    return platformPoolCache;
  }
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
  platformPoolCache = { ts: now, bySource, coverMemo: new Map() };
  return platformPoolCache;
}

/** 取(惰性解析 + memo)某歌单的封面 ref。 */
function memoCover(pool: PlatformPool, r: PlatformPoolRow): string | null {
  const hit = pool.coverMemo.get(r.id);
  if (hit !== undefined) return hit;
  const cover = resolveRowCover(r);
  pool.coverMemo.set(r.id, cover);
  return cover;
}

/**
 * 从本地库按平台分组随机选歌单。纯函数,不报错;库里无任何带平台歌单时返回空。
 * 每组随机洗牌 → 每次调用结果不同(首页刷新即动态变化)。
 * 稳态下候选集合与封面解析走进程内缓存(TTL 内),但洗牌每次照做 → 刷新仍变。
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
          coverArt: memoCover(pool, r),
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