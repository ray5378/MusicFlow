// ==================== 内置插件:歌手资料抓取(artist-info) ====================
//
// 能力:artistInfo —— 核心(scraper/artist.ts)按能力遍历调用 fetchArtistInfo(name)。
// 数据源:QQ 音乐 → 网易云 → 酷狗 → 酷我(依次兜底);只负责「抓取并返回数据」,
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

/** 取纯文本(酷我歌手搜索是**单引号 JSON**,不是标准 JSON)。 */
async function fetchText(url: string, headers: Record<string, string> = {}): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, ...headers }, signal: controller.signal });
    if (!res.ok) return null;
    return await res.text();
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
// 【2026-10-17 换接口】原 `soso/fcgi-bin/client_search_cp` 在 240 生产实测**恒 HTTP 500、
// 响应体 0 字节**(代理/直连/Referer/Cookie 四种变体全 500),导致 QQ 歌手头像恒抓不到、
// 只能退网易云。同家族的 `soso/fcgi-bin/search_for_qq_cp` 200,且 **`singer[].mid` 仍然存在**
// (实测「周杰伦」→ mid=0025NhlN2yWrP4),故此处同样换用该端点。返回结构一致(仍读 singer[])。
async function scrapeFromQQ(name: string): Promise<ArtistInfoResult | null> {
  const q = encodeURIComponent(name);
  const data = await fetchJson(
    `https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp?p=1&n=5&w=${q}&format=json`,
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

// ---- 酷狗:搜歌手(singername/singerid)→ 歌手详情(imgurl + profile) ----
// 【2026-11-12 实测 240】`mobilecdn.kugou.com/api/v3/search/singer` 与
// `/api/v3/singer/info` 均直连 200(www.kuwo/yy 的 singer 搜索恒 "Access Deny",勿用);
// imgurl 形如 `http://singerimg.kugou.com/uploadpic/softhead/{size}/...`,把 {size} 换成 480。
async function scrapeFromKugou(name: string): Promise<ArtistInfoResult | null> {
  const data = await fetchJson(
    `http://mobilecdn.kugou.com/api/v3/search/singer?keyword=${encodeURIComponent(name)}&page=1&pagesize=5`,
  );
  const list = Array.isArray(data?.data) ? data.data : [];
  const match =
    list.find((s: any) => String(s?.singername ?? "").toLowerCase() === name.toLowerCase()) || list[0];
  if (!match?.singerid) return null;
  const info = await fetchJson(
    `http://mobilecdn.kugou.com/api/v3/singer/info?singerid=${encodeURIComponent(String(match.singerid))}`,
  );
  const d = info?.data;
  const result: ArtistInfoResult = {
    name: String(d?.singername || match.singername || name),
    platform: "kugou",
  };
  const img = String(d?.imgurl ?? "").trim();
  if (img) result.coverArtUrl = img.replace("{size}", "480");
  const bio = String(d?.profile ?? d?.intro ?? "").trim();
  if (bio) result.bio = bio;
  return result.coverArtUrl || result.bio ? result : null;
}

/** 酷我响应是单引号 JSON + `&nbsp;` 实体:去实体并压空白。 */
function cleanKuwoText(v: unknown): string {
  return String(v ?? "")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 酷我搜索响应是**单引号 JSON**(非标准),做引号感知的转换后 JSON.parse:
 * 单引号字符串 → 双引号(内部 `"` 转义、`\'` 还原为 `'`);已带双引号的段落原样保留。
 * (与内置标签插件同一套解析口径;插件之间不互相 import,故此处自带一份。)
 */
function singleQuoteToJson(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "'") {
      out += '"';
      i++;
      while (i < text.length) {
        const c = text[i]!;
        if (c === "\\") {
          const n = text[i + 1];
          if (n === "'") { out += "'"; i += 2; continue; }
          out += c + (n ?? "");
          i += 2;
          continue;
        }
        if (c === "'") { out += '"'; i++; break; }
        if (c === '"') { out += '\\"'; i++; continue; }
        out += c;
        i++;
      }
      continue;
    }
    if (ch === '"') {
      out += ch;
      i++;
      while (i < text.length) {
        const c = text[i]!;
        out += c;
        i++;
        if (c === "\\") {
          if (i < text.length) { out += text[i]!; i++; }
          continue;
        }
        if (c === '"') break;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

// ---- 酷我:搜歌手(ARTIST/ARTISTID/PICPATH/desc) ----
// 【2026-11-12 实测 240】`search.kuwo.cn/r.s?ft=artist` 直连 200,响应直接用
// `BASEPICPATH + PICPATH` 拼头像(实测 `http://img1.kuwo.cn/star/starheads/240/...` 200 image/jpeg);
// `desc` 即简介(服务端可能已截断,不再二次请求详情)。
async function scrapeFromKuwo(name: string): Promise<ArtistInfoResult | null> {
  const text = await fetchText(
    `http://search.kuwo.cn/r.s?all=${encodeURIComponent(name)}&ft=artist&itemset=web_2013`
      + "&client=kt&pn=0&rn=5&rformat=json&encoding=utf8",
  );
  if (!text) return null;
  let data: any = null;
  try {
    data = JSON.parse(singleQuoteToJson(text));
  } catch {
    return null;
  }
  const list = Array.isArray(data?.abslist) ? data.abslist : [];
  const match =
    list.find((a: any) => cleanKuwoText(a?.ARTIST).toLowerCase() === name.toLowerCase()) || list[0];
  if (!match?.ARTISTID) return null;
  const result: ArtistInfoResult = {
    name: cleanKuwoText(match.ARTIST) || name,
    platform: "kuwo",
  };
  const pic = cleanKuwoText(match.PICPATH).replace(/^\/+/, "");
  if (pic) {
    const base = cleanKuwoText(data?.BASEPICPATH) || "http://img1.kuwo.cn/star/starheads/";
    result.coverArtUrl = base.replace(/\/?$/, "/") + pic;
  }
  const bio = cleanKuwoText(match.desc);
  if (bio) result.bio = bio;
  return result.coverArtUrl || result.bio ? result : null;
}

export const artistInfoManifest: PluginManifest = {
  id: ARTIST_INFO_PLUGIN_ID,
  name: "歌手资料抓取",
  version: "1.1.0",
  type: "artist",
  description: "从 QQ 音乐 / 网易云 / 酷狗 / 酷我获取歌手头像与简介(按此顺序依次兜底)",
  capabilities: ["artistInfo"],
  defaultEnabled: true,
  configSchema: [],
  // 插件侧 i18n 字典:默认文案即中文,故 zh 省略、只补 en。前端按当前界面语言取用。
  i18n: {
    en: {
      name: "Artist Info Scraper",
      description:
        "Scrape artist avatars and bios from QQ Music, NetEase Cloud Music, Kugou Music and Kuwo Music (in that order)",
      documentation: `## Features
Enriches artists in your library with avatar and bio (triggered from Settings → Fetch Artist Info).

## How it works
1. The core walks enabled plugins with the \`artistInfo\` capability and calls \`fetchArtistInfo(artist name)\`;
2. This plugin queries QQ Music (search songs to find the singer mid → CDN avatar), then falls back to NetEase Cloud (artist search + detail bio), then Kugou Music (singer search + singer info) and finally Kuwo Music (artist search: avatar path + description);
3. Returns pure data (\`name/platform/coverArtUrl/bio\`); cover download and database persistence are handled by the core;
4. Returns null when all four platforms have no result; the core then falls back to the local album cover and marks the artist as "pending".`,
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
  documentation: `## 功能介绍\n为曲库歌手补充头像与简介(「设置 → 歌手信息抓取」触发)。\n\n## 处理逻辑\n1. 核心按 \`artistInfo\` 能力遍历启用插件,调 \`fetchArtistInfo(歌手名)\`;\n2. 本插件依次查 QQ 音乐(搜歌找 singer mid → CDN 头像)→ 网易云(搜索歌手 + 详情简介)→ 酷狗(歌手搜索 + 歌手详情)→ 酷我(歌手搜索,直出头像路径与简介),任一家拿到即返回;\n3. 返回纯数据(\`name/platform/coverArtUrl/bio\`),封面下载与数据库持久化由核心完成;\n4. 四个平台都无结果时返回 null,核心回退到本地专辑封面并标记「待补充」。`,
};

export const artistInfoPlugin = {
  manifest: artistInfoManifest,
  /** 抓取歌手资料:QQ → 网易云 → 酷狗 → 酷我 依次兜底。返回纯数据或 null。 */
  async fetchArtistInfo(name: string): Promise<ArtistInfoResult | null> {
    const r = await scrapeFromQQ(name);
    if (r) return r;
    const ns = await scrapeFromNetease(name);
    if (ns) return ns;
    const kg = await scrapeFromKugou(name);
    if (kg) return kg;
    return scrapeFromKuwo(name);
  },
};
