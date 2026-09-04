// ==================== 内置插件:歌手资料抓取(artist-info) ====================
//
// 能力:artistInfo —— 核心(scraper/artist.ts)按能力遍历调用 fetchArtistInfo(name)。
// 数据源:QQ 音乐优先,网易云兜底(与历史行为一致);只负责「抓取并返回数据」,
// 封面落盘与数据库持久化由核心完成(那是核心职责,不属于平台耦合)。

import type { PluginManifest } from "../../plugins/types.js";

export const ARTIST_INFO_PLUGIN_ID = "artist-info";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, ...headers }, signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** 插件对外返回的抓取结果(纯数据,核心负责落盘)。 */
export interface ArtistInfoResult {
  name: string;
  platform: string;
  coverArtUrl?: string;
  bio?: string;
}

// ---- QQ 音乐:搜歌找 singer mid → 拼 CDN 头像 URL ----
async function scrapeFromQQ(name: string): Promise<ArtistInfoResult | null> {
  const q = encodeURIComponent(name);
  const data = await fetchJson(
    `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=1&n=5&w=${q}&format=json`,
    { Referer: "https://y.qq.com/" },
  );
  const songList = data?.data?.song?.list || [];
  for (const song of songList) {
    const singers = song.singer || [];
    const match = singers.find((s: any) => (s.name || "").toLowerCase() === name.toLowerCase());
    const singer = match || singers[0];
    if (singer?.mid) {
      const picUrl = `https://y.gtimg.cn/music/photo_new/T001R300x300M000${singer.mid}.jpg`;
      return { name: singer.name || name, platform: "qq", coverArtUrl: picUrl };
    }
  }
  return null;
}

// ---- 网易云:搜索歌手 → 头像 + 简介 ----
async function scrapeFromNetease(name: string): Promise<ArtistInfoResult | null> {
  const q = encodeURIComponent(name);
  const data = await fetchJson(`https://music.163.com/api/search/get?s=${q}&type=100&limit=3`);
  const artistsList = data?.result?.artists || [];
  const match = artistsList.find((a: any) => (a.name || "").toLowerCase() === name.toLowerCase())
    || artistsList[0];
  if (!match?.id) return null;
  const result: ArtistInfoResult = { name: match.name || name, platform: "netease" };
  if (match.picUrl) result.coverArtUrl = match.picUrl;
  const detail = await fetchJson(`https://music.163.com/api/artist/${match.id}`);
  const brief = detail?.artist?.briefDesc || "";
  if (brief) result.bio = brief;
  return result;
}

export const artistInfoManifest: PluginManifest = {
  id: ARTIST_INFO_PLUGIN_ID,
  name: "歌手资料抓取",
  version: "1.0.0",
  type: "artist",
  description: "从 QQ 音乐 / 网易云抓取歌手头像与简介(QQ 优先,网易云兜底)",
  capabilities: ["artistInfo"],
  defaultEnabled: true,
  configSchema: [],
  // 插件侧 i18n 字典:默认文案即中文,故 zh 省略、只补 en。前端按当前界面语言取用。
  i18n: {
    en: {
      name: "Artist Info Scraper",
      description:
        "Scrape artist avatars and bios from QQ Music / NetEase Cloud Music (QQ first, NetEase fallback)",
      fields: {
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
  documentation: `## 功能介绍\n为曲库歌手补充头像与简介(「设置 → 歌手信息抓取」触发)。\n\n## 处理逻辑\n1. 核心按 \`artistInfo\` 能力遍历启用插件,调 \`fetchArtistInfo(歌手名)\`;\n2. 本插件先查 QQ 音乐(搜歌找 singer mid → CDN 头像),无结果再查网易云(搜索歌手 + 详情简介);\n3. 返回纯数据(\`name/platform/coverArtUrl/bio\`),封面下载与数据库持久化由核心完成;\n4. 两平台都无结果时返回 null,核心回退到本地专辑封面并标记「待补充」。`,
};

export const artistInfoPlugin = {
  manifest: artistInfoManifest,
  /** 抓取歌手资料:QQ 优先,网易云兜底。返回纯数据或 null。 */
  async fetchArtistInfo(name: string): Promise<ArtistInfoResult | null> {
    const r = await scrapeFromQQ(name);
    if (r) return r;
    return scrapeFromNetease(name);
  },
};
