// ==================== 内置插件:在线标签补全(tag-provider) ====================
//
// 能力:metadataProvider / coverProvider / lyricProvider —— 核心按能力遍历调用
// searchMetadata(host, song) / searchCover(host, song) / searchLyrics(host, song),
// 首个返回可用匹配的 provider 胜出。本插件一次性覆盖「标签 + 封面 + 歌词」三类能力。
//
// 数据源:**仅 QQ 音乐**。用 smartbox 联想搜索拿 songmid → 命中标题/歌手候选,
// 再用 musicu 详情取轨号/年份/时长/专辑,封面由 album.mid 拼 CDN,歌词走 lyric 接口。
//   - 所有 HTTP 均走 host.http(尊重系统代理),带 UA + 平台 Referer;
//   - 每个请求 try/catch + AbortController 超时(10s),单次尝试、绝不重试循环;
//   - 任何情况都不抛异常,拿不到就返回 null;
//   - 拿不到的字段一律不填(绝不臆造 —— 尤其 genre:QQ 只给数字码、无风格名,故省略)。

import type {
  CoverProviderPlugin,
  LyricProviderPlugin,
  LyricSongInput,
  MetadataProviderPlugin,
  PluginManifest,
  SongMetadata,
} from "../../plugins/types.js";
import type { PluginHost } from "../../plugins/host.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
/** 单次请求超时(毫秒),落在任务要求的 8–12s 区间。 */
const REQUEST_TIMEOUT_MS = 10000;
/** 时长一致性容差(秒):本地时长与平台声明时长之差超过它即判定为不同版本。 */
const DURATION_TOLERANCE_SEC = 5;

// ---------- HTTP(全部经 host.http,尊重系统代理;绝不抛异常) ----------

async function requestJson(host: PluginHost, url: string, init: any = {}): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await host.http(url, {
      ...init,
      headers: { "User-Agent": UA, ...(init.headers || {}) },
      signal: controller.signal,
    });
    if (!res || !res.ok) return null;
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return null; // 非 JSON(如被风控返回 HTML)—— 视为无结果
    }
  } catch {
    return null; // 网络错误 / 超时 / 中止 —— 一律软失败
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 平台请求 ----------

/** 联想搜索:关键词(标题 [+ 空格 + 歌手])→ 候选 `{mid,name,singer}`。 */
async function qqSearch(host: PluginHost, title: string, artist: string): Promise<any[]> {
  const kw = artist ? `${title} ${artist}` : title;
  const url = "https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg?key=" + encodeURIComponent(kw)
    + "&format=json&inCharset=utf8&outCharset=utf-8";
  const data = await requestJson(host, url, { headers: { Referer: "https://y.qq.com/" } });
  const list = data?.data?.song?.itemlist;
  return Array.isArray(list) ? list : [];
}

/** 歌曲详情(musicu.fcg):返回 track_info(含 album.mid / index_album / time_public / interval)。 */
async function qqSongDetail(host: PluginHost, mid: string): Promise<any> {
  const body = JSON.stringify({
    comm: { ct: 24, cv: 0 },
    req: {
      module: "music.pf_song_detail_svr",
      method: "get_song_detail_yqq",
      param: { song_type: 0, song_mid: mid },
    },
  });
  const data = await requestJson(host, "https://u.y.qq.com/cgi-bin/musicu.fcg?format=json", {
    method: "POST",
    headers: { Referer: "https://y.qq.com/", "Content-Type": "application/json" },
    body,
  });
  return data?.req?.data?.track_info || null;
}

/** 歌词:返回 LRC 文本(某些情况下可能仍是 base64,做一次解码兜底)。 */
async function qqLyric(host: PluginHost, mid: string): Promise<string | null> {
  const url = "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid="
    + encodeURIComponent(mid) + "&format=json&nobase64=1";
  const data = await requestJson(host, url, {
    headers: { Referer: "https://y.qq.com/portal/player.html" },
  });
  const raw = data?.lyric;
  if (!raw || typeof raw !== "string") return null;
  return maybeDecodeLyric(raw);
}

/** 有的响应即使带 nobase64=1 仍是 base64,这里在「看起来不像 LRC」时尝试解码。 */
function maybeDecodeLyric(s: string): string {
  if (!s) return s;
  if (s.includes("[ti:") || s.includes("[ar:") || /\[\d{1,3}:\d{2}/.test(s)) return s;
  const compact = s.replace(/\s+/g, "");
  if (/^[A-Za-z0-9+/=]+$/.test(compact) && compact.length % 4 === 0) {
    try {
      return Buffer.from(compact, "base64").toString("utf8");
    } catch {
      return s;
    }
  }
  return s;
}

// ---------- 归一化与匹配 ----------

/** 标题/歌手归一化:去大小写、去括号装饰段((Live)/【】/《》)与 feat.、去标点空白。 */
function normalizeText(s: any): string {
  if (s === undefined || s === null) return "";
  let t = String(s).toLowerCase();
  // 去掉成对的括号装饰段(中英文括号、方/书名号、全角括号),反复直至稳定
  for (let i = 0; i < 3; i++) {
    t = t.replace(/[(\[【《〈「『（〔｛][^)\]】》〉」』）〕｝]*[)\]】》〉」』）〕｝]/g, " ");
  }
  // 去掉 feat. / ft. 及其后内容
  t = t.replace(/\b(?:feat|ft)\.?.*$/g, " ");
  // 去掉所有标点/符号/空白(含全角标点)
  t = t.replace(/[\s.\-_'"`~!@#$%^&*()\[\]{}<>?/\\|,;:，。；：、！？…—“”‘’《》〈〉【】「」『』·（）〔〕｛｝]/g, "");
  return t;
}

/** 把「A/B、A&B、A, B」等歌手串拆成归一化后的集合。 */
function splitArtists(s: any): string[] {
  return String(s ?? "")
    .split(/[/&,，、;；·|]+/)
    .map((x) => normalizeText(x))
    .filter(Boolean);
}

function titleMatches(candName: any, wantTitle: string): boolean {
  const a = normalizeText(candName);
  const b = normalizeText(wantTitle);
  return !!a && a === b;
}

function artistMatches(candSinger: any, wantArtist: string): boolean {
  const want = splitArtists(wantArtist);
  if (want.length === 0) return true; // 未提供歌手 → 只用标题匹配
  const have = splitArtists(candSinger);
  return want.some((w) => have.includes(w));
}

/**
 * 时长校验:本地/平台任一时长缺失则不校验;都有一致到 ±5s 内才通过。
 *
 * 单位纪律(core 契约,2026-10-16 修正):`song.duration` 由核心按 **秒** 传入
 * (LyricSongInput 的调用方一律给 `songs.duration` / `durationSec`,见
 * orchestrator.collectExtraTags、tagRepair.repairSongTags、covers.ts、lyrics.ts);
 * `detail.interval` 也是秒。旧实现把本地值当毫秒除以 1000 → 与平台秒值差两个数量级,
 * 恒判 false,导致 QQ 的 searchMetadata/searchCover **恒被时长闸门拒**(元数据补全恒空)。
 */
function durationOk(songDurationSec: number | null | undefined, intervalSec: any): boolean {
  const local = Number(songDurationSec) || 0;
  const plat = Number(intervalSec) || 0;
  if (local <= 0 || plat <= 0) return true;
  return Math.abs(local - plat) <= DURATION_TOLERANCE_SEC;
}

/** 从 track_info 组装 SongMetadata(只填真的拿到的字段)。 */
function buildMetadata(t: any): SongMetadata | null {
  const meta: SongMetadata = {};
  const name = t?.name || t?.title;
  if (name) meta.title = String(name);
  const singers = Array.isArray(t?.singer)
    ? t.singer.map((s: any) => s?.name).filter(Boolean)
    : [];
  if (singers.length) meta.artist = singers.join("/");
  const albumName = t?.album?.name;
  if (albumName) meta.album = String(albumName);

  // 轨号:QQ 的 index_album 即专辑内序号(1 基,实测「晴天」= 3 正确)
  const track = Number(t?.index_album);
  if (Number.isFinite(track) && track > 0) meta.track = track;

  // 碟号:QQ 只给 index_cd(0 基)。拿不到明确的多碟信息时保守省略,绝不臆造。
  const cd = Number(t?.index_cd);
  if (Number.isFinite(cd) && cd > 0) meta.disc = cd + 1;

  // 年份:优先 track_info.time_public,兜底 album.time_public(形如 "2017-02-22")
  if (t?.time_public) {
    const y = parseYear(t.time_public);
    if (y) meta.year = y;
  } else if (t?.album?.time_public) {
    const y = parseYear(t.album.time_public);
    if (y) meta.year = y;
  }

  // 时长(秒)
  const dur = Number(t?.interval);
  if (Number.isFinite(dur) && dur > 0) meta.duration = dur;

  // genre 省略:QQ 返回的是数字码(如 1),非风格名,映射未知 → 不填。
  meta.platform = "qq";
  // 除 platform 外没有任何有效字段时不返回空壳。
  return Object.keys(meta).length > 1 ? meta : null;
}

function parseYear(v: any): number | undefined {
  const m = String(v ?? "").match(/(19|20)\d{2}/);
  if (!m) return undefined;
  const y = Number(m[0]);
  return Number.isFinite(y) && y >= 1900 && y <= 2100 ? y : undefined;
}

// ---------- Manifest ----------

export const tagProviderManifest: PluginManifest = {
  id: "tag-provider",
  name: "在线标签补全",
  version: "1.0.0",
  type: "metadata",
  description: "从 QQ 音乐补全歌曲标签(轨号/年份/时长/专辑等)、封面与歌词",
  capabilities: ["metadataProvider", "coverProvider", "lyricProvider"],
  platforms: ["qq"],
  platformLabels: { qq: "QQ音乐" },
  permissions: ["net", "log"],
  defaultEnabled: true,
  // 内置标签来源:下载期由本插件打上的标签,核心会在落盘后写「标签修复完成标记」,
  // 后续标签修复命中标记即跳过(外置插件不声明本字段,故其标签不标记)。
  builtinTagSource: true,
  configSchema: [],
  // 插件侧 i18n 字典:默认文案即中文,故 zh 省略、只补 en。前端按当前界面语言取用。
  i18n: {
    en: {
      name: "Online Tag Filler",
      description: "Enrich song tags (track/year/duration/album...), cover art and lyrics from QQ Music",
      documentation: `### Features
Enriches a song's tags, cover art and lyrics from QQ Music. It declares three capabilities at once — \`metadataProvider\`, \`coverProvider\` and \`lyricProvider\` — so the core's tag-repair / cover / lyrics pipelines all use this plugin.

### How it works
1. The core walks enabled plugins by capability and calls \`searchMetadata(host, song)\` / \`searchCover(host, song)\` / \`searchLyrics(host, song)\`; first-match-wins;
2. This plugin searches QQ Music by \`title + artist\` (title only when no artist) via the smartbox suggest endpoint to get candidate songmids;
3. Candidates are scored by normalized title equality (case/space/punctuation ignored, decorations like \`(Live)\`/\`【】\`/\`feat.\` stripped) plus normalized artist intersection; when \`song.duration\` is provided (in seconds) and the platform declares a length, \`|Δ| ≤ 5s\` is required;
4. Track details (track no. / release year / duration / album mid) come from the musicu song-detail endpoint; every missing field is simply left empty — nothing is ever fabricated (e.g. QQ only returns a numeric genre code, so \`genre\` is omitted);
5. Cover is built from the album mid; lyrics come from the QQ lyric endpoint.

### Notes
- No configuration; enabled by default; only QQ Music is queried;
- All HTTP goes through \`host.http\` (respects the system proxy) with a UA + QQ referer, single attempt, 10s timeout, never throws — a failed platform degrades gracefully to an empty result.`,
    },
  },
  documentation: `### 功能介绍
从 QQ 音乐为歌曲补全标签(轨号 / 年份 / 时长 / 专辑等)、封面与歌词。本插件一次声明
\`metadataProvider\`、\`coverProvider\`、\`lyricProvider\` 三种能力,核心的标签修复 / 封面 /
歌词链路都会调用它。

### 处理逻辑
1. 核心按能力遍历已启用插件,分别调用 \`searchMetadata(host, song)\` /
   \`searchCover(host, song)\` / \`searchLyrics(host, song)\`,首个可用结果胜出;
2. 本插件用 \`title + artist\` 搜索 QQ 音乐联想接口(artist 为空时只用 title),拿到候选 songmid;
3. 候选按「标题归一化相等(忽略大小写/空格/标点,去掉 \`(Live)\`/\`【】\`/\`feat.\` 等装饰)+
   歌手归一化后交集」判定;若 \`song.duration\` 给了(秒)且平台声明了时长,还要求 \`|Δ| ≤ 5s\`;
4. 轨号 / 年份 / 时长 / 专辑 mid 取自 musicu 歌曲详情接口;拿不到的字段一律不填,
   绝不臆造(如 QQ 的 genre 只给数字码,无风格名,故省略);
5. 封面由 album mid 拼 CDN;歌词走 QQ 歌词接口。

### 说明
- 无需配置,默认启用,只查 QQ 音乐;
- 所有 HTTP 均走 \`host.http\`(尊重系统代理),带 UA + QQ Referer,单次尝试、10s 超时、
  任何情况不抛异常;平台失败即优雅降级为空结果。`,
};

// ---------- Plugin impl ----------

export const tagProviderPlugin: MetadataProviderPlugin & CoverProviderPlugin & LyricProviderPlugin = {
  manifest: tagProviderManifest,

  /** 补全标签:标题+歌手匹配 → 详情;命中失败/无有效字段则返回 null。 */
  async searchMetadata(host: PluginHost, song: LyricSongInput): Promise<SongMetadata | null> {
    try {
      const title = (song?.title || "").trim();
      if (!title) return null;
      const artist = (song?.artist || "").trim();

      const cands = await qqSearch(host, title, artist);
      for (const c of cands) {
        const mid = c?.mid || c?.songmid;
        if (!mid) continue;
        if (!titleMatches(c?.name || c?.songname, title)) continue;
        if (!artistMatches(c?.singer || c?.singername, artist)) continue;
        const detail = await qqSongDetail(host, mid);
        if (!detail) continue;
        if (!durationOk(song?.duration, detail.interval)) continue;
        const meta = buildMetadata(detail);
        if (meta) return meta;
      }
      return null;
    } catch {
      return null;
    }
  },

  /** 补全封面:匹配后取专辑 mid 拼 QQ CDN 封面 URL。 */
  async searchCover(host: PluginHost, song: LyricSongInput): Promise<{ url?: string } | null> {
    try {
      const title = (song?.title || "").trim();
      if (!title) return null;
      const artist = (song?.artist || "").trim();

      const cands = await qqSearch(host, title, artist);
      for (const c of cands) {
        const mid = c?.mid || c?.songmid;
        if (!mid) continue;
        if (!titleMatches(c?.name || c?.songname, title)) continue;
        if (!artistMatches(c?.singer || c?.singername, artist)) continue;
        const detail = await qqSongDetail(host, mid);
        if (!detail) continue;
        if (!durationOk(song?.duration, detail.interval)) continue;
        const albumMid = detail?.album?.mid;
        if (!albumMid) continue;
        return { url: `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albumMid}.jpg` };
      }
      return null;
    } catch {
      return null;
    }
  },

  /** 补全歌词:匹配后直接取 LRC(歌词接口无时长,故不做时长校验)。 */
  async searchLyrics(host: PluginHost, song: LyricSongInput): Promise<{ lrc?: string; text?: string } | null> {
    try {
      const title = (song?.title || "").trim();
      if (!title) return null;
      const artist = (song?.artist || "").trim();

      const cands = await qqSearch(host, title, artist);
      for (const c of cands) {
        const mid = c?.mid || c?.songmid;
        if (!mid) continue;
        if (!titleMatches(c?.name || c?.songname, title)) continue;
        if (!artistMatches(c?.singer || c?.singername, artist)) continue;
        const lrc = await qqLyric(host, mid);
        if (lrc) return { lrc };
      }
      return null;
    } catch {
      return null;
    }
  },
};
