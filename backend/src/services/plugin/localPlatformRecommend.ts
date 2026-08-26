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
import { getPlaylistCover, listPlayableCoverRefs } from "../playlistCover.js";

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
function getConfig(): { homeCount: number } {
  try {
    const row = sqlite
      .prepare("SELECT config FROM plugins WHERE name = ? AND enabled = 1")
      .get(LOCAL_PLATFORM_REC_PLUGIN_ID) as any;
    const cfg = row?.config ? JSON.parse(row.config) : {};
    const raw = parseInt(String(cfg.homeCount), 10);
    const homeCount =
      Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_HOME_COUNT) : DEFAULT_HOME_COUNT;
    return { homeCount };
  } catch {
    return { homeCount: DEFAULT_HOME_COUNT };
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
  playlists: {
    id: string; // 本地歌单 id(已入库,可直接播)
    name: string;
    coverArt: string | null; // 本地封面 ref(三端用各自 cover 工具拼完整 URL)
    songCount: number;
    imported: true; // 本地已入库歌单
  }[];
}

/**
 * 从本地库按平台分组随机选歌单。纯函数,不报错;库里无任何带平台歌单时返回空。
 * 每组随机洗牌 → 每次调用结果不同(首页刷新即动态变化)。
 */
export function recommendLocalPlatforms(): { channels: LocalPlatformChannel[] } {
  try {
    const { homeCount } = getConfig();
    const rows = sqlite
      .prepare(
        `SELECT id, name, source_platform, song_count, cover_art
         FROM playlists
         WHERE source_platform IS NOT NULL AND source_platform != ''`,
      )
      .all() as {
      id: string;
      name: string;
      source_platform: string;
      song_count: number;
      cover_art: string | null;
    }[];

    // 按平台聚合。
    const bySource = new Map<string, typeof rows>();
    for (const r of rows) {
      const src = r.source_platform || "";
      if (!src) continue;
      const list = bySource.get(src) || [];
      list.push(r);
      bySource.set(src, list);
    }

    const channels: LocalPlatformChannel[] = [];
    for (const [source, list] of bySource) {
      const picked = shuffle(list).slice(0, homeCount);
      channels.push({
        source,
        name: PLATFORM_LABELS[source] || source,
        count: picked.length,
        playlists: picked.map((r) => {
          // ① 歌单自身有可解析封面时,统一返回不带扩展名的 `pl-<id>` ref(与详情页
          //    一致)。不能直接透传 DB 的 cover_art(如 `pl-<id>.jpg` 带扩展名),否则
          //    `getCoverArt?id=pl-<id>.jpg` 会按 pl- 前缀把 `.jpg` 混进歌单 id 去查库,
          //    查不到该歌单 → 封面空白。
          //    getPlaylistCover(id) 即详情页 `pl-<id>` 的解析路径:读到 playlists.coverArt
          //    文件存在才返回非空,保证与详情页显示完全一致。
          let coverArt: string | null = null;
          if (getPlaylistCover(r.id)) {
            coverArt = `pl-${r.id}`;
          } else {
            // ② 兜底:歌单自身无封面时,从歌单可播歌曲的有效封面里随机抽一张作歌单封面。
            //    仅当歌单确实没有任何歌曲封面时才保留 null(前端显示占位符)。
            const candidates = listPlayableCoverRefs(r.id);
            if (candidates.length > 0) {
              coverArt = candidates[Math.floor(Math.random() * candidates.length)];
            }
          }
          return {
            id: r.id,
            name: r.name,
            coverArt,
            songCount: r.song_count || 0,
            imported: true,
          };
        }),
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
  ],
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