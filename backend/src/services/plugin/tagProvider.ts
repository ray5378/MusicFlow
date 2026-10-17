// ==================== 内置插件:在线标签补全(tag-provider) ====================
//
// 能力:metadataProvider / coverProvider / lyricProvider —— 核心按能力遍历调用
// searchMetadata(host, song) / searchCover(host, song) / searchLyrics(host, song),
// 首个返回可用匹配的 provider 胜出。本插件一次性覆盖「标签 + 封面 + 歌词」三类能力。
//
// 数据源:**QQ 音乐(默认) + 网易云音乐(兜底)**。每个能力方法（searchMetadata/searchCover/
// searchLyrics）内部都是「先跑 QQ 循环，QQ 拿不到再跑网易云循环」的两段式——产品定调
//   2026-10-17：QQ 音乐是默认获取标签的选择，网易云音乐只作 QQ 拿不到的**补充链路**。
//   - QQ：用**真搜索接口** client_search_cp(关键词 = 标题 [+空格+歌手])拿候选(自带秒级时长)
//     → 过标题/歌手/时长三闸门 → 再用 musicu 详情取轨号/年份/专辑/风格，封面由 album.mid
//     拼 CDN，歌词走 lyric 接口；
//   - 网易云：POST /api/search/get 拿候选（时长字段是**毫秒**，必须换算成秒才能过 ±5s 闸门）
//     → 同样过标题/歌手/时长三闸门 → 封面须**二次调** /api/song/detail/?ids=[id] 取
//     album.picUrl 直链（搜索响应的 album 只有 picId、没有 picUrl），歌词取 /api/song/lyric
//     的 lrc.lyric；该平台不提供可读风格名，故 genre 一律不填（绝不臆造）。
//   - 所有 HTTP 均走 host.http(尊重系统代理),带 UA + 平台 Referer;
//   - 每个请求 try/catch + AbortController 超时(10s),单次尝试、绝不重试循环;
//   - **QQ 侧全局限流**（2026-10-17 产品要求）：相邻两次 QQ 请求至少间隔 1.2s，再叠加
//     300~800ms 随机抖动（实际间隔 1.5~2.0s），防止同一出口 IP 高频访问被风控封禁；
//     三处 QQ 调用（搜索/详情/歌词）共用同一条串行队列，故一次修复内的多次 QQ 往返也按序限速。
//     网易云链路不受此限（产品只要求限制 QQ）。
//   - 任何情况都不抛异常,拿不到就返回 null;
//   - 拿不到的字段一律不填(绝不臆造 —— 例如风格只在详情接口的**同级 info 块**
//     `info.genre.content[].value` 给出可读名时才用;`track_info.genre` 只是数字码、
//     与分类 id 对不上,不可靠,一律忽略)。
//
// 【2026-10-17 修正·命中率】原先打 smartbox 联想接口(splcloud/fcgi-bin/smartbox_new.fcg),
// 它只回热门联想词 —— 实测 240 生产库抽样 30 首有 22 首零候选(整体命中率仅约 11.6%);
// 换真搜索接口 client_search_cp 后 12/12 都找到目标曲、9/12 时长吻合。另:scanner 对「无
// 歌手标签文件」写入的占位值(Unknown Artist 等)会被拼进关键词导致恒 0 结果,故占位值一律当空歌手。
//
// 【2026-10-17 修正】原先只读 `req.data.track_info`，于是误判「QQ 无风格名」而省略 genre；
// 实测 `req.data.info.genre.content[].value` 直接给可读风格（如「告白气球」= "R&B"、
// 「晴天」= "Pop"），故本插件改为从 info 块取风格并写入。

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

// ---------- QQ 音乐请求节流（防封 IP）----------
//
// 【2026-10-17 产品要求】访问 QQ 音乐 API 的频率必须限流：相邻两次请求的**发起时刻**
// 至少间隔 QQ_MIN_GAP_MS(默认 1.2s)，再叠加 300~800ms 随机抖动（取不到抖动则退化为固定间隔），
// 使实际间隔落在约 1.5~2.0s。所有 QQ 请求共用**同一条串行队列**（全局单实例），因此
// 「搜索 → 详情 → 歌词」这类一次修复内的多次往返也按序限速，避免同一出口 IP 被风控封禁。
// 环境变量 MF_QQ_MIN_GAP_MS 可覆盖最小间隔（测试置 0 时抖动一并归零，以免拖慢用例）。
function qqGapMs(): { min: number; jitter: number } {
  const min = Math.max(0, Number(process.env.MF_QQ_MIN_GAP_MS ?? 1200) || 0);
  return { min, jitter: min > 0 ? 300 + Math.random() * 500 : 0 };
}

let qqNextAt = 0;
let qqTail: Promise<unknown> = Promise.resolve();

/** 把一次 QQ 请求串进全局节流队列：等足「上次请求之后的最小间隔 + 随机抖动」再发起。 */
function qqThrottled<T>(fn: () => Promise<T>): Promise<T> {
  const run = qqTail.then(async () => {
    const wait = qqNextAt - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const g = qqGapMs();
    qqNextAt = Date.now() + g.min + g.jitter;
    return fn();
  });
  // 队列不许被单次失败掐断（requestJson 本身不抛，这里只是兜底）。
  qqTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** QQ 侧 JSON 请求：与 requestJson 同语义，但受全局节流约束。 */
function qqRequestJson(host: PluginHost, url: string, init: any = {}): Promise<any> {
  return qqThrottled(() => requestJson(host, url, init));
}

// ---------- 平台请求 ----------

/** 搜索候选(归一化后的统一形状)。 */
interface QqCandidate {
  mid: string;
  name: string;
  /** 平台声明的歌手名串(多歌手以 `/` 连接);可能为空。 */
  singerName: string;
  /** 平台声明时长(秒);取不到为 0。搜索结果自带,用于进详情调用前的时长预筛。 */
  interval: number;
}

/**
 * 搜索:关键词(标题 [+ 空格 + 歌手])→ 候选。
 *
 * 【2026-10-17 换接口】原打 smartbox 联想接口,它只回热门联想词,实测生产库抽样 73% 的歌
 * 零候选(整体命中率仅 11.6%);改用**真搜索** client_search_cp 后 100% 有候选。候选归一化
 * 为 `{mid,name,singerName,interval}`;搜索结果自带 interval(秒),故时长预筛在搜索阶段即可
 * 完成,只有通过者才进详情调用(省一次网络往返)。
 */
async function qqSearch(host: PluginHost, title: string, artist: string): Promise<QqCandidate[]> {
  const kw = artist ? `${title} ${artist}` : title;
  const url = "https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=" + encodeURIComponent(kw)
    + "&format=json&p=1&n=10&cr=1&new_json=1";
  const data = await qqRequestJson(host, url, { headers: { Referer: "https://y.qq.com/" } });
  const list = data?.data?.song?.list;
  if (!Array.isArray(list)) return [];
  const out: QqCandidate[] = [];
  for (const s of list) {
    const mid = String(s?.mid ?? s?.songmid ?? "");
    const name = String(s?.title ?? s?.songname ?? "");
    if (!mid || !name) continue;
    out.push({ mid, name, singerName: pickSingerName(s), interval: Number(s?.interval) || 0 });
  }
  return out;
}

/** 取候选的歌手名串:new_json=1 时 `singer` 是对象数组(取 `.name`),旧结构是 `singername` 字符串。 */
function pickSingerName(s: any): string {
  if (Array.isArray(s?.singer)) {
    return s.singer
      .map((x: any) => (typeof x?.name === "string" ? x.name.trim() : ""))
      .filter(Boolean)
      .join("/");
  }
  return typeof s?.singername === "string" ? s.singername : "";
}

/**
 * 歌曲详情(musicu.fcg)：返回 `{ track, info }`。
 *   - `track` = `req.data.track_info`：专辑 mid / 时长 / 轨号 / 年份等；
 *   - `info`  = `req.data.info`：**与 track_info 同级的分类信息块**，其中
 *     `info.genre.content[].value` 是**可读风格名**（如 "R&B"、"Pop"、"民谣"）。
 */
async function qqSongDetail(host: PluginHost, mid: string): Promise<{ track: any; info: any } | null> {
  const body = JSON.stringify({
    comm: { ct: 24, cv: 0 },
    req: {
      module: "music.pf_song_detail_svr",
      method: "get_song_detail_yqq",
      param: { song_type: 0, song_mid: mid },
    },
  });
  const data = await qqRequestJson(host, "https://u.y.qq.com/cgi-bin/musicu.fcg?format=json", {
    method: "POST",
    headers: { Referer: "https://y.qq.com/", "Content-Type": "application/json" },
    body,
  });
  const d = data?.req?.data;
  if (!d?.track_info) return null;
  return { track: d.track_info, info: d.info || {} };
}

/** 从 `req.data.info.genre.content[].value` 取**可读**风格名（多个用 `/` 连接）；取不到返回 undefined。 */
function pickGenre(info: any): string | undefined {
  const arr = info?.genre?.content;
  if (!Array.isArray(arr)) return undefined;
  const names = arr
    .map((x: any) => (typeof x?.value === "string" ? x.value.trim() : ""))
    .filter(Boolean);
  return names.length ? names.join("/") : undefined;
}

/** 歌词:返回 LRC 文本(某些情况下可能仍是 base64,做一次解码兜底)。 */
async function qqLyric(host: PluginHost, mid: string): Promise<string | null> {
  const url = "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid="
    + encodeURIComponent(mid) + "&format=json&nobase64=1";
  const data = await qqRequestJson(host, url, {
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

// ---------- 网易云音乐（QQ 未命中时的补充链路） ----------
//
// 探针实测（2026-10-17，在 240 生产容器内经系统代理真机验证）：
//   - POST https://music.163.com/api/search/get（body `s=<kw>&type=1&limit=10&offset=0`，
//     带 Referer music.163.com）→ code 200，候选在 `result.songs[]`；
//   - `duration` 是**毫秒**（实测 215666 → 216s），必须 Math.round(/1000) 才能过 ±5s 秒级闸门；
//   - 歌手在 `artists[].name`；专辑名 `album.name`；年份可由 `album.publishTime`（毫秒时间戳）取年；
//   - **搜索响应的 album 只有 picId、没有 picUrl** → 封面必须二次调
//     `/api/song/detail/?ids=[id]` 取 `songs[0].album.picUrl`（实测 200，直链无需拼 CDN）；
//   - 歌词 GET `/api/song/lyric?os=pc&id=<id>&lv=-1&kv=-1&tv=-1` → `lrc.lyric`（带时间戳）；
//   - 该平台不提供风格的**可读名**，故 genre 不填。

/** 网易云候选（归一化后的统一形状；与 QqCandidate 同构，另带专辑名与发行时间）。 */
interface NsCandidate {
  id: string;
  name: string;
  /** 平台声明的歌手名串（多歌手以 `/` 连接）；可能为空。 */
  singerName: string;
  /** 平台声明时长（秒）；搜索响应给的是毫秒，此处已换算。 */
  interval: number;
  albumName: string;
  /** 专辑发行时间（毫秒时间戳）；取不到为 0。 */
  publishTimeMs: number;
}

/** 搜索（关键词 = 标题 [+空格+歌手]）→ 候选。 */
async function nsSearch(host: PluginHost, title: string, artist: string): Promise<NsCandidate[]> {
  const kw = artist ? `${title} ${artist}` : title;
  const data = await requestJson(host, "https://music.163.com/api/search/get", {
    method: "POST",
    headers: { Referer: "https://music.163.com/", "Content-Type": "application/x-www-form-urlencoded" },
    body: "s=" + encodeURIComponent(kw) + "&type=1&limit=10&offset=0",
  });
  const list = data?.result?.songs;
  if (!Array.isArray(list)) return [];
  const out: NsCandidate[] = [];
  for (const s of list) {
    const id = String(s?.id ?? "");
    const name = String(s?.name ?? "");
    if (!id || !name) continue;
    out.push({
      id,
      name,
      singerName: Array.isArray(s?.artists)
        ? s.artists
            .map((x: any) => (typeof x?.name === "string" ? x.name.trim() : ""))
            .filter(Boolean)
            .join("/")
        : "",
      // 单位纪律：网易云给**毫秒**，这里换算成秒，与核心契约（秒）对齐。
      interval: Math.round((Number(s?.duration) || 0) / 1000),
      albumName: String(s?.album?.name ?? ""),
      publishTimeMs: Number(s?.album?.publishTime) || 0,
    });
  }
  return out;
}

/** 封面直链：搜索响应只有 picId，故二次调详情接口取 album.picUrl。 */
async function nsCoverUrl(host: PluginHost, id: string): Promise<string | null> {
  const data = await requestJson(
    host,
    "https://music.163.com/api/song/detail/?ids=[" + encodeURIComponent(id) + "]",
    { headers: { Referer: "https://music.163.com/" } },
  );
  const pic = data?.songs?.[0]?.album?.picUrl;
  return typeof pic === "string" && pic ? pic : null;
}

/** 歌词：取 lrc.lyric（与 QQ 的 `{lyric}` 不同）。 */
async function nsLyric(host: PluginHost, id: string): Promise<string | null> {
  const data = await requestJson(
    host,
    "https://music.163.com/api/song/lyric?os=pc&id=" + encodeURIComponent(id) + "&lv=-1&kv=-1&tv=-1",
    { headers: { Referer: "https://music.163.com/" } },
  );
  const raw = data?.lrc?.lyric;
  return typeof raw === "string" && raw.trim() ? raw : null;
}

/** 从毫秒时间戳取年份；非法/缺失返回 undefined。 */
function yearFromMs(ms: number): number | undefined {
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  const y = new Date(ms).getUTCFullYear();
  return Number.isFinite(y) && y >= 1900 && y <= 2100 ? y : undefined;
}

/** 从网易云候选组装 SongMetadata（只填真拿到的字段；风格无来源，不填）。 */
function buildNsMetadata(c: NsCandidate): SongMetadata | null {
  const meta: SongMetadata = { platform: "netease" };
  if (c.name) meta.title = c.name;
  if (c.singerName) meta.artist = c.singerName;
  if (c.albumName) meta.album = c.albumName;
  const y = yearFromMs(c.publishTimeMs);
  if (y) meta.year = y;
  if (Number.isFinite(c.interval) && c.interval > 0) meta.duration = c.interval;
  // 除 platform 外没有任何有效字段时不返回空壳。
  return Object.keys(meta).length > 1 ? meta : null;
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

/**
 * scanner 对「文件无歌手标签」写入的占位值(scanner.ts: `Unknown Artist`)。这些值不是真歌手:
 * 一旦被拼进搜索关键词或参与歌手匹配,会恒 0 结果/恒不匹配(实测多首因此零候选)。只精确匹配
 * 这几种占位;「群星」等是合法值,不处理。
 */
const ARTIST_PLACEHOLDERS = new Set(["unknown artist", "未知歌手", "未知艺术家"]);
function isArtistPlaceholder(s: any): boolean {
  return ARTIST_PLACEHOLDERS.has(String(s ?? "").trim().toLowerCase());
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

/**
 * 在两个平台共用的三闸门里挑出**首个**通过的候选：标题归一化相等 → 歌手归一化交集 →
 * 时长 ±5s（候选自带时长，先筛掉再决定是否进详情/歌词调用，省一次网络往返）。
 * QQ 与网易云的候选形状已统一（`name/singerName/interval`），故同一实现复用。
 */
function firstMatch<T extends { name: string; singerName: string; interval: number }>(
  cands: readonly T[],
  title: string,
  artist: string,
  songDuration: number | null | undefined,
): T | null {
  for (const c of cands) {
    if (!titleMatches(c.name, title)) continue;
    if (!artistMatches(c.singerName, artist)) continue;
    if (!durationOk(songDuration, c.interval)) continue;
    return c;
  }
  return null;
}

/** 从 `{track,info}` 组装 SongMetadata(只填真的拿到的字段)。 */
function buildMetadata(detail: { track: any; info: any }): SongMetadata | null {
  const t: any = detail?.track;
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

  // 风格:取自**同级 info 块**的可读名(info.genre.content[].value);track_info.genre
  // 只是数字码,与分类 id 对不上,不用。取不到即不填(绝不臆造)。
  const genre = pickGenre(detail?.info);
  if (genre) meta.genre = genre;

  // 碟号不返回:成品文件不留 DISCNUMBER/DISCTOTAL(产品定调 2026-10-17)。
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
  description: "从 QQ 音乐(默认)与网易云音乐(兜底)补全歌曲标签(轨号/年份/时长/专辑/风格等)、封面与歌词",
  capabilities: ["metadataProvider", "coverProvider", "lyricProvider"],
  platforms: ["qq", "netease"],
  platformLabels: { qq: "QQ音乐", netease: "网易云音乐" },
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
      description: "Enrich song tags (track/year/duration/album/genre...), cover art and lyrics from QQ Music, with NetEase Cloud Music as fallback",
      documentation: `### Features
Enriches a song's tags, cover art and lyrics from QQ Music, falling back to NetEase Cloud Music when QQ Music has no match. It declares three capabilities at once — \`metadataProvider\`, \`coverProvider\` and \`lyricProvider\` — so the core's tag-repair / cover / lyrics pipelines all use this plugin.

### How it works
1. The core walks enabled plugins by capability and calls \`searchMetadata(host, song)\` / \`searchCover(host, song)\` / \`searchLyrics(host, song)\`; first-match-wins;
2. Every capability method runs a **two-stage** lookup: the QQ Music loop first; only when that yields nothing does the NetEase Cloud Music loop run. QQ Music is the default source, NetEase Cloud Music is strictly a fallback;
3. Both stages search by \`title + artist\` (title only when there is no artist, or when the artist is a scanner placeholder such as \`Unknown Artist\`), then apply the same three gates: normalized title equality (case/space/punctuation ignored, decorations like \`(Live)\`/\`【】\`/\`feat.\` stripped), normalized artist intersection, and — when \`song.duration\` is provided (in seconds) — the \`|Δ| ≤ 5s\` length check, which runs **against the candidate's own length first**, so a rejected candidate never triggers a detail request;
4. **QQ Music stage**: \`client_search_cp\` gives candidates carrying their declared length in seconds; track details (track no. / release year / duration / album mid) come from the musicu song-detail endpoint, and the **genre** name is read from the sibling \`info.genre.content[].value\` block (a human-readable name such as "R&B"/"Pop"), while \`track_info.genre\` is only a numeric code and is ignored; the cover is built from the album mid, lyrics come from the QQ lyric endpoint;
5. **NetEase Cloud Music stage** (fallback only): \`POST /api/search/get\` gives candidates whose \`duration\` is in **milliseconds** (converted to seconds here); the search response's \`album\` carries only a \`picId\` and no \`picUrl\`, so the cover requires a second call to \`/api/song/detail/?ids=[id]\` to read \`album.picUrl\` (a direct URL); lyrics come from \`/api/song/lyric\` → \`lrc.lyric\`. This platform exposes no human-readable genre, so \`genre\` is always left empty. Every missing field is simply left empty — nothing is ever fabricated.

### Notes
- No configuration; enabled by default. QQ Music is the default source and NetEase Cloud Music is used only as a fallback;
- All HTTP goes through \`host.http\` (respects the system proxy) with a UA + platform referer, single attempt, 10s timeout, never throws — a failed platform degrades gracefully to an empty result and the next platform is tried.`,
    },
  },
  documentation: `### 功能介绍
从 QQ 音乐(默认来源)与网易云音乐(QQ 拿不到时的兜底来源)为歌曲补全标签(轨号 / 年份 /
时长 / 专辑 / 风格等)、封面与歌词。本插件一次声明 \`metadataProvider\`、\`coverProvider\`、
\`lyricProvider\` 三种能力,核心的标签修复 / 封面 / 歌词链路都会调用它。

### 处理逻辑
1. 核心按能力遍历已启用插件,分别调用 \`searchMetadata(host, song)\` /
   \`searchCover(host, song)\` / \`searchLyrics(host, song)\`,首个可用结果胜出;
2. 本插件的**每个能力方法都是两段式**:先跑 QQ 音乐循环,**只有 QQ 全部候选都没命中**时才
   跑网易云音乐循环(QQ 是默认获取标签的选择,网易云只是补充链路);
3. 两个平台共用同一套三闸门:关键词都是 \`title + artist\`(artist 为空、或为 scanner 写入的
   占位值如 \`Unknown Artist\` 时只用 title);候选按「标题归一化相等(忽略大小写/空格/标点,
   去掉 \`(Live)\`/\`【】\`/\`feat.\` 等装饰)+ 歌手归一化后交集」判定;若 \`song.duration\` 给了
   (秒),**先用候选自带时长做时长预筛**(\`|Δ| ≤ 5s\`),不通过就不再调详情接口;
4. **QQ 音乐段**:候选来自 \`client_search_cp\`(自带秒级时长);轨号 / 年份 / 时长 / 专辑 mid
   取自 musicu 歌曲详情接口;**风格**取自与 track_info 同级的 \`info.genre.content[].value\`
   (可读名,如 "R&B"/"Pop"),而 track_info.genre 只是数字码、一律忽略;封面由 album mid
   拼 CDN;歌词走 QQ 歌词接口;
5. **网易云音乐段(仅兜底)**:候选来自 \`POST /api/search/get\`,其 \`duration\` 是**毫秒**
   (此处已换算成秒);搜索响应里的 \`album\` 只有 picId、没有 picUrl,故封面须**二次调**
   \`/api/song/detail/?ids=[id]\` 取 \`album.picUrl\` 直链;歌词取 \`/api/song/lyric\` 的
   \`lrc.lyric\`;该平台不提供可读风格名,故 genre 一律不填。拿不到的字段一律不填,绝不臆造。

### 说明
- 无需配置,默认启用;QQ 音乐为默认来源,网易云音乐仅在 QQ 拿不到时兜底;
- 所有 HTTP 均走 \`host.http\`(尊重系统代理),带 UA + 平台 Referer,单次尝试、10s 超时、
  任何情况不抛异常;平台失败即优雅降级为空结果并继续尝试下一个平台。`,
};

// ---------- Plugin impl ----------

export const tagProviderPlugin: MetadataProviderPlugin & CoverProviderPlugin & LyricProviderPlugin = {
  manifest: tagProviderManifest,

  /** 补全标签：先 QQ 音乐（默认来源），QQ 拿不到再走网易云音乐（补充链路）；都拿不到返回 null。 */
  async searchMetadata(host: PluginHost, song: LyricSongInput): Promise<SongMetadata | null> {
    try {
      const title = (song?.title || "").trim();
      if (!title) return null;
      // scanner 对「无歌手标签」写入的占位值(Unknown Artist)当空歌手:拼进关键词会恒 0 结果。
      const artist = isArtistPlaceholder(song?.artist) ? "" : (song?.artist || "").trim();

      // ① QQ 音乐（默认来源）：候选自带秒级时长，先做时长预筛再调详情（省一次网络往返）。
      for (const c of await qqSearch(host, title, artist)) {
        if (!titleMatches(c.name, title)) continue;
        if (!artistMatches(c.singerName, artist)) continue;
        if (!durationOk(song?.duration, c.interval)) continue;
        const detail = await qqSongDetail(host, c.mid);
        if (!detail) continue;
        if (!durationOk(song?.duration, detail.track?.interval)) continue;
        const meta = buildMetadata(detail);
        if (meta) return meta;
      }

      // ② 网易云音乐（兜底）：只有 QQ 全部候选都没命中才走到这里。
      const ns = firstMatch(await nsSearch(host, title, artist), title, artist, song?.duration);
      if (ns) return buildNsMetadata(ns);
      return null;
    } catch {
      return null;
    }
  },

  /** 补全封面：先 QQ（album.mid 拼 CDN 直链），QQ 拿不到再网易云（须二次调详情取 album.picUrl）。 */
  async searchCover(host: PluginHost, song: LyricSongInput): Promise<{ url?: string } | null> {
    try {
      const title = (song?.title || "").trim();
      if (!title) return null;
      const artist = isArtistPlaceholder(song?.artist) ? "" : (song?.artist || "").trim();

      // ① QQ 音乐（默认来源）
      for (const c of await qqSearch(host, title, artist)) {
        if (!titleMatches(c.name, title)) continue;
        if (!artistMatches(c.singerName, artist)) continue;
        if (!durationOk(song?.duration, c.interval)) continue;
        const detail = await qqSongDetail(host, c.mid);
        if (!detail) continue;
        if (!durationOk(song?.duration, detail.track?.interval)) continue;
        const albumMid = detail.track?.album?.mid;
        if (!albumMid) continue;
        return { url: `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albumMid}.jpg` };
      }

      // ② 网易云音乐（兜底）：搜索响应里 album 只有 picId、没有 picUrl，封面必须二次调详情接口。
      const ns = firstMatch(await nsSearch(host, title, artist), title, artist, song?.duration);
      if (ns) {
        const url = await nsCoverUrl(host, ns.id);
        if (url) return { url };
      }
      return null;
    } catch {
      return null;
    }
  },

  /** 补全歌词：先 QQ，QQ 拿不到再网易云。
   *  QQ 歌词接口不返回时长，故沿用原口径只判标题+歌手；网易云经 firstMatch 顺带过时长闸门
   *  （更严格，避免给「不同版本」贴上错的词）。 */
  async searchLyrics(host: PluginHost, song: LyricSongInput): Promise<{ lrc?: string; text?: string } | null> {
    try {
      const title = (song?.title || "").trim();
      if (!title) return null;
      const artist = isArtistPlaceholder(song?.artist) ? "" : (song?.artist || "").trim();

      // ① QQ 音乐（默认来源）
      for (const c of await qqSearch(host, title, artist)) {
        if (!titleMatches(c.name, title)) continue;
        if (!artistMatches(c.singerName, artist)) continue;
        const lrc = await qqLyric(host, c.mid);
        if (lrc) return { lrc };
      }

      // ② 网易云音乐（兜底）：歌词在 lrc.lyric（与 QQ 的 {lyric} 不同）。
      const ns = firstMatch(await nsSearch(host, title, artist), title, artist, song?.duration);
      if (ns) {
        const lrc = await nsLyric(host, ns.id);
        if (lrc) return { lrc };
      }
      return null;
    } catch {
      return null;
    }
  },
};
