// ==================== 内置插件:在线标签补全(tag-provider) ====================
//
// 能力:metadataProvider / coverProvider / lyricProvider —— 核心按能力遍历调用
// searchMetadata(host, song) / searchCover(host, song) / searchLyrics(host, song),
// 首个返回可用结果的 provider 胜出;本插件一次覆盖「标签 + 封面 + 歌词」三类能力。
//
// 数据源(2026-11-12 对齐 Music Tag Web 扩为四平台):
//   QQ 音乐 / 网易云音乐 / 酷狗音乐 / 酷我音乐。
//
// 【选源纪律】**QQ 音乐是默认来源**:先只跑 QQ,若 QQ 有「标题精确 + 歌手精确」的强命中,
// 直接采用(零额外请求、零额外延迟)。只有 QQ 无候选 / 只拿到弱候选(缺歌手、标题只是变体、
// 详情或封面/歌词拿不到)时,才把网易云 / 酷狗 / 酷我**并发**跑一遍,把四家候选放在一起
// 用统一评分选最优 —— 这样既保住「QQ 默认」的产品定调,又能在 QQ 覆盖不到时用其它平台补齐,
// 而不是像旧实现那样按固定顺序「谁先有结果用谁」。
//
// 【评分逻辑】(参考 xhongc/music-tag-web 的 match_score,并补上本地场景的硬闸门)
//   - 标题 2 分:归一化后精确相等(含「去尾部 ` - 歌手`」变体);不做前缀/包含模糊匹配,
//     避免把「告白气球remix」配到「告白气球」;
//   - 歌手 2 分:归一化后分词交集;本地无歌手 → 0 分(中性);本地有歌手却完全不匹配 → **直接否决**;
//   - 专辑 2 分:精确相等 / 1 分:互相包含 / 0 分:未知或不符(专辑不符很常见,不否决);
//   - 时长:两侧都有且 |Δ|>5s → **直接否决**;|Δ|≤2s 额外 +1 分(同样标题下选对版本);
//     严格层全被否时,仅对「标题精确 + 歌手精确」的候选放宽到 ±15s —— 2026-11-12 曲库
//     40 首实测:5~10s 差异多来自前奏/尾奏裁剪,放宽后救回「最寂寞的时候 (忧郁版)」,
//     且歌手不精确的一律不放宽(避免配到翻唱);
//   - 版本标记:候选名与本地名的「现场/Live/Remix/伴奏/纯音乐/翻唱/电台版…」集合必须一致,
//     不一致直接否决 —— 否则 `晴天 (KTV版伴奏)` 归一化后与 `晴天` 相等,会把伴奏当正曲;
//     「片段/抖音/剪辑/试听」是**温和标记**(2026-11-12):不否决,只作同分排序偏好,
//     因为这类多是同一录音的剪辑/试听片段,硬否决会把本可命中的正曲挡掉;
//   - 占位歌手(Unknown Artist / 未知歌手 / 网络歌手 / 群星 / 华语群星 / 佚名 / Various Artists)
//     不拼进搜索关键词、也不参与歌手否决(2026-11-12:定向样本 8/70 首是这类署名);
//   - 总分红线:total >= 3(即标题必须命中)才可作为候选。
//
// 【各平台字段来源】(2026-11-12 在 240 生产容器实测)
//   - QQ:真搜索 `search_for_qq_cp`(client_search_cp 生产恒 500,勿回退)→ 候选自带秒级时长;
//     轨号 / 年份 / 风格 / 专辑 mid 取自 musicu 详情(风格在**同级 info 块**的
//     `info.genre.content[].value`,track_info.genre 只是数字码,一律忽略);歌词走 lyric 接口。
//     全局限流:相邻两次 QQ 请求 ≥1.2s + 300~800ms 抖动(防封 IP)。
//   - 网易云:POST /api/cloudsearch/pc(dt 是**毫秒**,换算成秒;无加密、与旧 search/get 同速),
//     搜索响应直接带 `al.picUrl`(封面直链,无需二次详情)、`no`(轨号)、`publishTime`(年份);
//     歌词取 /api/song/lyric 的 lrc.lyric;无可读风格名 → genre 不填。
//   - 酷狗:complexsearch.kugou.com 搜索(signature = MD5(固定 KEY + 参数串 + 固定 KEY) 大写;
//     实测 240 直连 200、~0.14s);候选自带 SongName/SingerName/AlbumName/Duration/PublishDate/
//     Image(封面,{size} 替换为 480,歌手头像 singerimg 视为无封面);歌词走
//     lyrics.kugou.com search → download(fmt=lrc, content 为 base64);
//     旧 m.kugou.com/app/i/krc.php 2026-11-12 实测恒返回空,已弃用;无轨号/风格 → 不填。
//   - 酷我:search.kuwo.cn/r.s(web 版 /api/www/* 在本网络恒 "request is illegal",勿用);
//     响应是**单引号 JSON + &nbsp; 实体**,需容错解析;候选自带 NAME/ARTIST/ALBUM/DURATION/
//     MUSICRID/web_albumpic_short(封面前缀 http://img1.kuwo.cn/star/albumcover/);
//     专辑/时长缺失时用 m.kuwo.cn/newh5/singles/songinfoandlrc 的 songinfo 补;歌词也取自该接口
//     的 lrclist;无年份/轨号/风格 → 不填。
//
// 【流派来源(2026-11-12 实测)】只有 QQ 的 `info.genre.content[].value` 可用:
//   网易云专辑详情 /api/v1/album/{id} 的 `tags` 恒为空串、酷狗/酷我均不暴露可读流派。
//   因此非 QQ 命中时,若 QQ 侧存在「标题精确 + 歌手通过」的候选,会补取一次详情只填 genre
//   (搜索/详情均 memo,已查过不重复请求);拿不到就不填。
//
// 【匹配比较口径】标题/歌手/专辑比较前统一:小写 → 简繁折叠到简体 → 去括号装饰(【】()《》等)
// →去 feat./ft. 及之后 → 去标点空白。**简繁折叠只用于比较**,写入字形仍由核心
// applyTagsVariant 按用户所选字形输出。scanner 写入的 `Unknown Artist` 等占位值当空歌手。
//
// 【(2026-10-17) 历史坑,勿回退】
//   1. 搜索接口固定 `search_for_qq_cp` —— `client_search_cp` 生产恒 HTTP 500、0 字节;
//   2. 时长为**秒**,网易云搜索给的是毫秒,必须换算;
//   3. `track_info.genre` 是数字码,风格只能取 `info.genre.content[].value`;
//   4. 标题变体仅「去尾部 ` - 歌手`」,不做包含匹配;
//   5. 同一首歌的三个能力共享搜索/详情往返(memo),否则单首 QQ 往返 6 次 ≈ 10.8s;
//   6. 只缓存**成功**响应,瞬时失败绝不固化成「无候选」。
//
// 铁律:任何情况都不抛异常,拿不到就返回 null;拿不到的字段一律不填(绝不臆造)。

import { createHash } from "node:crypto";
import type {
  CoverProviderPlugin,
  LyricProviderPlugin,
  LyricSongInput,
  MetadataProviderPlugin,
  PluginManifest,
  SongMetadata,
} from "../../plugins/types.js";
import type { PluginHost } from "../../plugins/host.js";
// 中文简繁字形表(200KB+ 词表,与 tagWriter 写入侧共用同一份):仅用于**匹配比较**。
import { applyVariant } from "../../utils/chineseConv.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
/** 单次请求超时(毫秒)。 */
const REQUEST_TIMEOUT_MS = 10000;
/** 时长一致性容差(秒):本地时长与平台声明时长之差超过它即判定为不同版本。 */
const DURATION_TOLERANCE_SEC = 5;
/** 时长「更优」加分阈值(秒):同样标题/歌手/专辑时,时长更贴近的候选优先。 */
const DURATION_BONUS_SEC = 2;
/** 放宽层时长容差(秒):严格层无候选时,仅对「标题+歌手都精确」的候选启用。
 *  实测(2026-11-12 曲库 40 首):平台/文件时长差 5~10s 多来自前奏/尾奏裁剪,
 *  仍属同一录音;放宽到 15s 可救回「最寂寞的时候 (忧郁版)」这类严格层误杀。 */
const DURATION_RELAXED_SEC = 15;
/** 评分接受红线:标题 2 分 × 3 = 6;总分 < 3 视为无效匹配。 */
/** 单曲最多参与封面/歌词/详情兜底的候选数(防请求放大)。 */
const MAX_MATCH_TRIES = 3;

// ==================== HTTP(全部经 host.http,尊重系统代理;绝不抛异常) ====================

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

/** 取纯文本响应(酷狗歌词 / 酷我搜索这类非标准 JSON 用)。 */
async function requestText(host: PluginHost, url: string, init: any = {}): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await host.http(url, {
      ...init,
      headers: { "User-Agent": UA, ...(init.headers || {}) },
      signal: controller.signal,
    });
    if (!res || !res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ==================== QQ 音乐请求节流(防封 IP) ====================
//
// 相邻两次请求的**发起时刻**至少间隔 QQ_MIN_GAP_MS(默认 1.2s),再叠加 300~800ms 随机抖动,
// 使实际间隔落在约 1.5~2.0s。所有 QQ 请求共用同一条串行队列(搜索/详情/歌词都排队)。
// 环境变量 MF_QQ_MIN_GAP_MS 可覆盖最小间隔(测试置 0 时抖动一并归零)。
function qqGapMs(): { min: number; jitter: number } {
  const min = Math.max(0, Number(process.env.MF_QQ_MIN_GAP_MS ?? 1200) || 0);
  return { min, jitter: min > 0 ? 300 + Math.random() * 500 : 0 };
}

let qqNextAt = 0;
let qqTail: Promise<unknown> = Promise.resolve();

function qqThrottled<T>(fn: () => Promise<T>): Promise<T> {
  const run = qqTail.then(async () => {
    const wait = qqNextAt - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const g = qqGapMs();
    qqNextAt = Date.now() + g.min + g.jitter;
    return fn();
  });
  qqTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function qqRequestJson(host: PluginHost, url: string, init: any = {}): Promise<any> {
  return qqThrottled(() => requestJson(host, url, init));
}

// ==================== 短 TTL memo(同曲多能力往返去重) ====================
//
// 核心对**同一首歌**分别调用 searchMetadata / searchCover / searchLyrics;若每个能力都独立
// 搜索+详情,同一首要打 6 次 QQ 往返(实测单首 10.6~10.9s ≈ 6×1.8s)。故:
//   - 平台原始响应按「关键词 / 曲 ID」缓存;
//   - 「最优匹配」按归一化后的歌曲键缓存一次。
// 只缓存成功响应(TTL 180s、容量 2000),网络抖动不会被固化。
const MEMO_TTL_MS = 180_000;
const MEMO_MAX = 2000;
const memo = new Map<string, { at: number; val: unknown }>();

function memoGet<T>(key: string): T | undefined {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_TTL_MS) return hit.val as T;
  return undefined;
}

function memoSet(key: string, val: unknown): void {
  if (memo.size >= MEMO_MAX) memo.clear();
  memo.set(key, { at: Date.now(), val });
}

/** 仅供测试:清空 memo,避免用例之间串味。 */
export function __resetTagProviderMemo(): void {
  memo.clear();
}

/** 仅供测试:把全局 QQ 节流队列复位(排队链置空 + 下次可发起时刻清零)。
 *
 *  用例若切假时钟,队列里排队中的 setTimeout 会随假时钟丢弃 → qqTail 永不 settle,
 *  后续所有 QQ 请求卡死(CI 实测单文件 805s)。每个用例前复位即可。 */
export function __resetTagProviderQueue(): void {
  qqNextAt = 0;
  qqTail = Promise.resolve();
}

// ==================== 统一候选结构 ====================

/** 平台 slug。 */
export type TagPlatform = "qq" | "netease" | "kugou" | "kuwo";

/** 平台优先级:同分时按此顺序(QQ 默认优先)。 */
const PLATFORM_ORDER: TagPlatform[] = ["qq", "netease", "kugou", "kuwo"];

export interface PlatformCandidate {
  platform: TagPlatform;
  /** 平台原生 ID:QQ mid / 网易云 id / 酷狗 FileHash / 酷我 rid。 */
  id: string;
  /** 曲名(已去掉酷狗 <em>、酷我 &nbsp;)。 */
  name: string;
  /** 歌手名串(多歌手以 `/` 连接)。 */
  singerName: string;
  albumName: string;
  /** 平台声明时长(秒);取不到为 0。 */
  durationSec: number;
  /** 轨号(专辑内序号);平台不提供时 undefined(不臆造)。 */
  track?: number;
  /** 发行年份;取不到为 undefined。 */
  year?: number;
  /** 封面直链;取不到为 undefined(不臆造)。 */
  coverUrl?: string;
}

/** 评分明细(可单测锁定口径)。 */
export interface CandidateScore {
  /** 标题 2 / 0 */
  title: number;
  /** 歌手 2 / 1 / 0 */
  artist: number;
  /** 专辑 2 / 1 / 0 */
  album: number;
  /** 时长加分 1 / 0 */
  duration: number;
  total: number;
  /** 被否决的原因(存在即不可用) */
  reject?: string;
}

// ==================== 归一化与匹配 ====================

/** HTML 实体 / 酷狗高亮标签清洗。 */
function cleanPlatformText(v: unknown): string {
  return String(v ?? "")
    .replace(/<\/?em>/gi, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 标题/歌手/专辑归一化:去大小写、**简繁字形归一到简体**、去括号装饰段((Live)/【】/《》)
 * 与 feat.、去标点空白。简繁归一仅用于匹配比较,不改写任何写入内容。
 */
function normalizeText(s: any): string {
  if (s === undefined || s === null) return "";
  let t = cleanPlatformText(s).toLowerCase();
  t = applyVariant(t, "simplified");
  for (let i = 0; i < 3; i++) {
    t = t.replace(/[(\[【《〈「『（〔｛][^)\]】》〉」』）〕｝]*[)\]】》〉」』）〕｝]/g, " ");
  }
  t = t.replace(/\b(?:feat|ft)\.?.*$/g, " ");
  // 字符组里刻意用 \u 转义表示引号/反引号:守卫脚本的剥注释器按字符扫描、不解析正则字面量,
  // 直接写裸字符会让它提前进入字符串态、把后续注释整段吞掉(check-tag-repair R7 假红)。
  t = t.replace(/[\s.\-_\u0027\u0022\u0060~!@#$%^&*()\[\]{}<>?/\\|,;:，。；：、！？…—“”‘’《》〈〉【】「」『』·（）〔〕｛｝]/g, "");
  return t;
}

/** 把「A/B、A&B、A, B」等歌手串拆成归一化后的集合。 */
function splitArtists(s: any): string[] {
  return cleanPlatformText(s)
    .split(/[/&,，、;；·|]+/)
    .map((x) => normalizeText(x))
    .filter(Boolean);
}

/** 无信息量的歌手值:拼进关键词会恒 0 结果,匹配时也不参与歌手否决。
 *  除 scanner 写入的 Unknown 占位外,还包括「群星/网络歌手/佚名」这类**合辑署名**
 *  (2026-11-12 定向样本:8/70 首);把它们当真实歌手会让整首永远配不上。 */
const ARTIST_PLACEHOLDERS = new Set([
  "unknown artist",
  "未知歌手",
  "未知艺术家",
  "网络歌手",
  "群星",
  "华语群星",
  "佚名",
  "various artists",
  "va",
]);
function isArtistPlaceholder(s: any): boolean {
  return ARTIST_PLACEHOLDERS.has(String(s ?? "").trim().toLowerCase());
}

/**
 * 标题变体:完整标题 + 「去掉尾部 ` - xxx`」的主标题。scanner 会把「无标题标签」的落库标题
 * 写成「主标题 - 歌手」(全库约 11%),变体仍是**精确相等**语义(不做包含/前缀匹配)。
 */
function titleForms(wantTitle: string): string[] {
  const forms = [wantTitle];
  const m = String(wantTitle).match(/^(.*?)\s+-\s+(.+)$/);
  const head = m?.[1]?.trim();
  if (head) forms.push(head);
  return forms;
}

function titleMatches(candName: any, wantTitle: string): boolean {
  const a = normalizeText(candName);
  if (!a) return false;
  return titleForms(wantTitle).some((f) => {
    const w = normalizeText(f);
    if (!w) return false;
    if (w === a) return true;
    // 温和版本标记(片段/抖音/剪辑/试听)只影响排序,不参与否决:
    // 去掉尾部这类标记后相等即视为同一录音(括号形式已在 normalizeText 阶段去掉)。
    const wc = stripSoftVersionSuffix(w);
    const ac = stripSoftVersionSuffix(a);
    return !!wc && wc === ac;
  });
}

/** 歌手打分:2 精确 / 1 包含 / 0 本地无歌手 / -1 本地有歌手但完全不匹配(否决)。 */
function scoreArtist(candSinger: any, wantArtist: string): number {
  const want = splitArtists(wantArtist);
  if (want.length === 0) return 0;
  const have = splitArtists(candSinger);
  if (have.length === 0) return -1;
  if (want.some((w) => have.includes(w))) return 2;
  if (want.some((w) => have.some((h) => h.includes(w) || w.includes(h)))) return 1;
  return -1;
}

/** scanner 对「无专辑标签」写入的占位值,视同空(不参与专辑评分)。 */
const ALBUM_PLACEHOLDERS = new Set(["unknown album", "未知专辑"]);

/** 专辑打分:2 精确 / 1 包含 / 0 未知或不符(专辑不符很常见,不否决)。 */
function scoreAlbum(candAlbum: any, wantAlbum: string | null | undefined): number {
  const raw = String(wantAlbum ?? "").trim();
  const a = normalizeText(candAlbum);
  const w = ALBUM_PLACEHOLDERS.has(raw.toLowerCase()) ? "" : normalizeText(raw);
  if (!a || !w) return 0;
  if (a === w) return 2;
  if (a.includes(w) || w.includes(a)) return 1;
  return 0;
}

/** 本地/平台任一时长缺失则不校验;都有一致到 ±tolSec 内才通过。 */
function durationOk(songDurationSec: number | null | undefined, intervalSec: any, tolSec = DURATION_TOLERANCE_SEC): boolean {
  const local = Number(songDurationSec) || 0;
  const plat = Number(intervalSec) || 0;
  if (local <= 0 || plat <= 0) return true;
  return Math.abs(local - plat) <= tolSec;
}

/** 版本标记:现场 / 伴奏 / Remix 等。候选与本地必须一致(详见文件头【评分逻辑】)。
 *  拉丁字母标记要求词边界(避免 discover / recover 被误判成 cover)。
 *  【2026-11-12】「片段 / 抖音 / 剪辑 / 试听」从硬闸门下放到**温和层**:
 *  这类候选多是同一录音的剪辑/试听片段,标题归一化后本就相等;继续硬否决会挡掉本可命中的正曲。
 *  但 Live / 伴奏 / 纯音乐 / 翻唱 / 加速版等是**不同录音**,仍保持否决。 */
const VERSION_MARKER_RE =
  /(?:^|[^a-z])(live|remix|acoustic|cover|instrumental|karaoke)(?![a-z])|(伴奏|纯音乐|翻唱|现场|电台版|dj版|铃声|加速版|慢速版)/gi;

/** 温和版本标记:只作排序偏好(同分时优先「标记集合一致」),绝不否决候选。 */
const SOFT_VERSION_MARKER_RE = /(片段|抖音|剪辑|试听)/gi;

/** 去掉尾部温和标记(可带「版」字,可连续):「晴天片段」「晴天 剪辑版」→「晴天」。 */
const SOFT_VERSION_SUFFIX_RE = /(?:(?:片段|抖音|剪辑|试听)(?:版)?)+$/;
function stripSoftVersionSuffix(t: string): string {
  return t.replace(SOFT_VERSION_SUFFIX_RE, "");
}

function versionMarkers(s: any): Set<string> {
  const out = new Set<string>();
  const t = applyVariant(cleanPlatformText(s).toLowerCase(), "simplified");
  for (const m of t.matchAll(VERSION_MARKER_RE)) out.add((m[1] ?? m[2] ?? "").toLowerCase());
  return out;
}

/** 温和版本标记集合(用于排序偏好)。 */
function softVersionMarkers(s: any): Set<string> {
  const out = new Set<string>();
  const t = applyVariant(cleanPlatformText(s).toLowerCase(), "simplified");
  for (const m of t.matchAll(SOFT_VERSION_MARKER_RE)) out.add((m[1] ?? "").toLowerCase());
  return out;
}

function sameMarkers(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * 单候选评分(纯函数,导出供单测锁定口径)。
 * @returns reject 非空 → 该候选不可用(已含硬闸门:标题不符 / 歌手不符 / 时长超差 / 版本不符)
 */
export function scoreTagCandidate(c: PlatformCandidate, song: LyricSongInput): CandidateScore {
  return scoreTagCandidateWith(c, song, DURATION_TOLERANCE_SEC);
}

/** 可按容差放宽的评分实现(严格层 ±5s;仅「标题+歌手都精确」的放宽层用 ±15s)。 */
function scoreTagCandidateWith(c: PlatformCandidate, song: LyricSongInput, tolSec: number): CandidateScore {
  const wantTitle = String(song?.title ?? "").trim();
  const wantArtist = isArtistPlaceholder(song?.artist) ? "" : String(song?.artist ?? "").trim();

  // 1) 版本标记必须一致(归一化会去掉括号,故必须在原始名上判)
  const localMarkers = versionMarkers(wantTitle);
  const candMarkers = versionMarkers(c.name);
  for (const m of candMarkers) {
    if (!localMarkers.has(m)) {
      return { title: 0, artist: 0, album: 0, duration: 0, total: 0, reject: `版本标记不一致「${m}」` };
    }
  }
  for (const m of localMarkers) {
    if (!candMarkers.has(m)) {
      return { title: 0, artist: 0, album: 0, duration: 0, total: 0, reject: `缺少本地版本标记「${m}」` };
    }
  }

  // 2) 标题:只认归一化后精确相等(含「 - 歌手」变体)
  if (!titleMatches(c.name, wantTitle)) {
    return { title: 0, artist: 0, album: 0, duration: 0, total: 0, reject: "标题不匹配" };
  }

  // 3) 歌手:本地有歌手却完全不匹配 → 否决
  const artist = scoreArtist(c.singerName, wantArtist);
  if (artist < 0) {
    return { title: 0, artist: 0, album: 0, duration: 0, total: 0, reject: "歌手不匹配" };
  }

  // 4) 时长:超差 → 否决;贴近(±2s)加分
  if (!durationOk(song?.duration, c.durationSec, tolSec)) {
    return { title: 0, artist: 0, album: 0, duration: 0, total: 0, reject: "时长超差" };
  }
  const localDur = Number(song?.duration) || 0;
  const platDur = Number(c.durationSec) || 0;
  const durationScore = localDur > 0 && platDur > 0 && Math.abs(localDur - platDur) <= DURATION_BONUS_SEC ? 1 : 0;

  const album = scoreAlbum(c.albumName, song?.album);
  // 标题已精确命中即固定 6 分,恒 ≥ 门槛;旧实现的 `total < MIN_ACCEPT_SCORE` 分支不可达(已删)。
  const total = 2 * 3 + artist * 2 + album + durationScore;
  return { title: 2, artist, album, duration: durationScore, total };
}

/** 强命中(用于「QQ 默认优先」的提前收口):标题精确 + 歌手精确 + 时长通过 + 版本一致。 */
function isStrongMatch(s: CandidateScore): boolean {
  return !s.reject && s.title === 2 && s.artist === 2;
}

/** 候选排序:按总分降序 → 平台优先级 → 入池顺序(稳定)。
 *  `tolSec` 仅用于放宽层(严格层用默认 ±5s)。 */
function rankByScore(
  cands: PlatformCandidate[],
  song: LyricSongInput,
  tolSec = DURATION_TOLERANCE_SEC,
): Array<PlatformCandidate & { score: CandidateScore }> {
  const scored: Array<PlatformCandidate & { score: CandidateScore }> = [];
  for (const c of cands) {
    const score = scoreTagCandidateWith(c, song, tolSec);
    if (score.reject) continue;
    scored.push({ ...c, score });
  }
  const orderOf = (p: TagPlatform): number => {
    const i = PLATFORM_ORDER.indexOf(p);
    return i < 0 ? PLATFORM_ORDER.length : i;
  };
  // 温和版本标记只影响同分排序:标记集合与本地一致的候选优先(不改变任何分数/闸门)。
  const localSoft = softVersionMarkers(song?.title);
  const softRank = (c: PlatformCandidate): number => (sameMarkers(localSoft, softVersionMarkers(c.name)) ? 0 : 1);
  scored.sort(
    (a, b) => b.score.total - a.score.total || softRank(a) - softRank(b) || orderOf(a.platform) - orderOf(b.platform),
  );
  return scored;
}

/** 解析年份(取首个 19xx/20xx)。 */
function parseYear(v: any): number | undefined {
  const m = String(v ?? "").match(/(19|20)\d{2}/);
  if (!m) return undefined;
  const y = Number(m[0]);
  return Number.isFinite(y) && y >= 1900 && y <= 2100 ? y : undefined;
}

/** 从毫秒时间戳取年份;非法/缺失返回 undefined。 */
function yearFromMs(ms: number): number | undefined {
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  const y = new Date(ms).getUTCFullYear();
  return Number.isFinite(y) && y >= 1900 && y <= 2100 ? y : undefined;
}

// ==================== QQ 音乐 ====================

interface QqCandidate extends PlatformCandidate {
  platform: "qq";
}

async function qqSearch(host: PluginHost, title: string, artist: string): Promise<QqCandidate[]> {
  const kw = artist ? `${title} ${artist}` : title;
  const memoKey = `qq:s:${kw}`;
  const cached = memoGet<QqCandidate[]>(memoKey);
  if (cached) return cached;

  // 端点固定 search_for_qq_cp:client_search_cp 生产恒 500(见文件头)。
  const url = "https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp?w=" + encodeURIComponent(kw)
    + "&format=json&p=1&n=10&cr=1&new_json=1";
  const data = await qqRequestJson(host, url, { headers: { Referer: "https://y.qq.com/" } });
  if (data === null) return []; // 请求失败不写缓存
  const list = data?.data?.song?.list;
  const out: QqCandidate[] = [];
  if (Array.isArray(list)) {
    for (const s of list) {
      const mid = String(s?.mid ?? s?.songmid ?? "");
      const name = cleanPlatformText(s?.title ?? s?.songname ?? "");
      if (!mid || !name) continue;
      out.push({
        platform: "qq",
        id: mid,
        name,
        singerName: pickSingerName(s),
        albumName: cleanPlatformText(s?.album?.name ?? ""),
        durationSec: Number(s?.interval) || 0,
      });
    }
  }
  memoSet(memoKey, out);
  return out;
}

/** 歌手名串:new_json=1 时 `singer` 是对象数组,旧结构是 `singername` 字符串。 */
function pickSingerName(s: any): string {
  if (Array.isArray(s?.singer)) {
    return s.singer
      .map((x: any) => (typeof x?.name === "string" ? x.name.trim() : ""))
      .filter(Boolean)
      .join("/");
  }
  return typeof s?.singername === "string" ? s.singername : "";
}

async function qqSongDetail(host: PluginHost, mid: string): Promise<{ track: any; info: any } | null> {
  const memoKey = `qq:d:${mid}`;
  const cached = memoGet<{ track: any; info: any }>(memoKey);
  if (cached) return cached;

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
  if (!d?.track_info) return null; // 未命中/失败:不写缓存
  const out = { track: d.track_info, info: d.info || {} };
  memoSet(memoKey, out);
  return out;
}

/** 从 `req.data.info.genre.content[].value` 取**可读**风格名;取不到返回 undefined。 */
function pickGenre(info: any): string | undefined {
  const arr = info?.genre?.content;
  if (!Array.isArray(arr)) return undefined;
  const names = arr
    .map((x: any) => (typeof x?.value === "string" ? x.value.trim() : ""))
    .filter(Boolean);
  return names.length ? names.join("/") : undefined;
}

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

/** 有的响应即使带 nobase64=1 仍是 base64,在「看起来不像 LRC」时尝试解码。 */
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

// ==================== 网易云音乐 ====================

interface NsCandidate extends PlatformCandidate {
  platform: "netease";
  publishTimeMs: number;
}

// 【2026-11-12 网易云换接口】旧的 POST /api/search/get 只返回 `album.picId`(无 picUrl),
// 封面必须再打一次 /api/song/detail;且不返回轨号。实测同网络下 POST /api/cloudsearch/pc
// (无加密、200、≈0.25s,与旧接口同速)直接返回 `al.picUrl` / `no`(轨号) / `dt`(毫秒) /
// `publishTime`,故改用该端点:单首少一次往返 + 多拿轨号。响应同时兼容旧结构(artists/album/
// duration),避免上游字段漂移时直接变空。
async function nsSearch(host: PluginHost, title: string, artist: string): Promise<NsCandidate[]> {
  const kw = artist ? `${title} ${artist}` : title;
  const memoKey = `ns:s:${kw}`;
  const cached = memoGet<NsCandidate[]>(memoKey);
  if (cached) return cached;

  const data = await requestJson(host, "https://music.163.com/api/cloudsearch/pc", {
    method: "POST",
    headers: { Referer: "https://music.163.com/", "Content-Type": "application/x-www-form-urlencoded" },
    body: "s=" + encodeURIComponent(kw) + "&type=1&limit=10&offset=0",
  });
  if (data === null) return [];
  const list = data?.result?.songs;
  const out: NsCandidate[] = [];
  if (Array.isArray(list)) {
    for (const s of list) {
      const id = String(s?.id ?? "");
      const name = cleanPlatformText(s?.name ?? "");
      if (!id || !name) continue;
      // 新结构 ar[]/al{};旧结构 artists[]/album{}。两者都兼容。
      const ar = Array.isArray(s?.ar) ? s.ar : (Array.isArray(s?.artists) ? s.artists : []);
      const al = s?.al ?? s?.album ?? {};
      const publishTimeMs = Number(s?.publishTime ?? al?.publishTime) || 0;
      const dtMs = Number(s?.dt ?? s?.duration) || 0;
      const pic = typeof al?.picUrl === "string" ? al.picUrl : "";
      const track = Number(s?.no);
      out.push({
        platform: "netease",
        id,
        name,
        singerName: ar
          .map((x: any) => (typeof x?.name === "string" ? x.name.trim() : ""))
          .filter(Boolean)
          .join("/"),
        albumName: cleanPlatformText(al?.name ?? ""),
        // 单位纪律:网易云给**毫秒**,换算成秒与核心契约(秒)对齐。
        durationSec: Math.round(dtMs / 1000),
        year: yearFromMs(publishTimeMs),
        publishTimeMs,
        // 封面直链(已带);http 升级为 https,避免下游下载/展示被降级。
        coverUrl: pic ? pic.replace(/^http:/, "https:") : undefined,
        track: Number.isFinite(track) && track > 0 ? track : undefined,
      });
    }
  }
  memoSet(memoKey, out);
  return out;
}

/** 封面直链:搜索响应只有 picId,故二次调详情接口取 album.picUrl。 */
async function nsCoverUrl(host: PluginHost, id: string): Promise<string | null> {
  const memoKey = `ns:c:${id}`;
  const cached = memoGet<string>(memoKey);
  if (cached) return cached;

  const data = await requestJson(
    host,
    "https://music.163.com/api/song/detail/?ids=[" + encodeURIComponent(id) + "]",
    { headers: { Referer: "https://music.163.com/" } },
  );
  const pic = data?.songs?.[0]?.album?.picUrl;
  if (!(typeof pic === "string" && pic)) return null;
  memoSet(memoKey, pic);
  return pic;
}

async function nsLyric(host: PluginHost, id: string): Promise<string | null> {
  const data = await requestJson(
    host,
    "https://music.163.com/api/song/lyric?os=pc&id=" + encodeURIComponent(id) + "&lv=-1&kv=-1&tv=-1",
    { headers: { Referer: "https://music.163.com/" } },
  );
  const raw = data?.lrc?.lyric;
  return typeof raw === "string" && raw.trim() ? raw : null;
}

// ==================== 酷狗音乐 ====================

/** 酷狗搜索签名:固定 KEY + 参数串 + 固定 KEY 的 MD5(大写)。 */
const KUGOU_SECRET = "NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt";

function kugouSignature(keyword: string, t: string): string {
  const raw = `${KUGOU_SECRET}bitrate=0clienttime=${t}clientver=2000dfid=-inputtype=0iscorrection=1isfuzzy=0`
    + `keyword=${keyword}mid=${t}page=1pagesize=10platform=WebFilterprivilege_filter=0srcappid=2919`
    + `tag=emuserid=-1uuid=${t}${KUGOU_SECRET}`;
  return createHash("md5").update(raw, "utf8").digest("hex").toUpperCase();
}

async function kugouSearch(host: PluginHost, title: string, artist: string): Promise<PlatformCandidate[]> {
  const kw = artist ? `${title} ${artist}` : title;
  const memoKey = `kg:s:${kw}`;
  const cached = memoGet<PlatformCandidate[]>(memoKey);
  if (cached) return cached;

  const t = String(Date.now());
  const sig = kugouSignature(kw, t);
  const url = "https://complexsearch.kugou.com/v2/search/song?keyword=" + encodeURIComponent(kw)
    + `&page=1&pagesize=10&bitrate=0&isfuzzy=0&tag=em&inputtype=0&platform=WebFilter&userid=-1`
    + `&clientver=2000&iscorrection=1&privilege_filter=0&srcappid=2919&clienttime=${t}&mid=${t}`
    + `&uuid=${t}&dfid=-&signature=${sig}`;
  const data = await requestJson(host, url, { headers: { Referer: "https://www.kugou.com/" } });
  if (data === null) return [];
  const list = data?.data?.lists;
  const out: PlatformCandidate[] = [];
  if (Array.isArray(list)) {
    for (const s of list) {
      const id = String(s?.FileHash ?? "");
      const name = cleanPlatformText(s?.SongName ?? "");
      if (!id || !name) continue;
      out.push({
        platform: "kugou",
        id,
        name,
        // 酷狗多歌手以「、」分隔,统一成 `/` 与其它平台同形。
        singerName: cleanPlatformText(s?.SingerName ?? "").split("、").join("/"),
        albumName: cleanPlatformText(s?.AlbumName ?? ""),
        durationSec: Number(s?.Duration) || 0,
        year: parseYear(s?.PublishDate),
        coverUrl: kugouCoverUrl(s?.Image),
      });
    }
  }
  memoSet(memoKey, out);
  return out;
}

/** 酷狗封面:`http://imge.kugou.com/stdmusic/{size}/...`;歌手头像(singerimg)不是专辑封面,视为无。 */
function kugouCoverUrl(raw: any): string | undefined {
  const u = String(raw ?? "");
  if (!u || !/^https?:\/\//i.test(u)) return undefined;
  if (u.includes("singerimg.kugou.com")) return undefined;
  return u.replace("{size}", "480");
}

/** 酷狗歌词(2026-11-12 换接口):lyrics.kugou.com 搜索 → download(lrc) → base64 解码。
 *  旧的 `m.kugou.com/app/i/krc.php` 实测**恒返回空**(3/3 首,含热门曲),已不作为主路径。
 *  搜索用「候选名 + 候选歌手」而不用本地字段:与匹配结果同源,避免二次歧义;
 *  多个候选时优先时长接近的,否则取第一个(与 Music Tag Web 同口径)。 */
async function kugouLyric(host: PluginHost, c: PlatformCandidate): Promise<string | null> {
  const memoKey = `kg:ly:${c.id}`;
  const cached = memoGet<string>(memoKey);
  if (cached !== undefined) return cached;

  const kw = [c.name, isArtistPlaceholder(c.singerName) ? "" : c.singerName].filter(Boolean).join(" ");
  const durMs = Math.max(0, Math.round((Number(c.durationSec) || 0) * 1000));
  const search = await requestJson(
    host,
    "https://lyrics.kugou.com/search?ver=1&man=yes&client=pc&keyword=" + encodeURIComponent(kw)
      + `&duration=${durMs}&hash=${encodeURIComponent(c.id)}`,
    { headers: { Referer: "https://www.kugou.com/" } },
  );
  const list = search?.candidates;
  if (!Array.isArray(list) || list.length === 0) return null;
  const pick = pickKugouLyricCandidate(list, durMs);
  if (!pick?.id) return null;
  const dl = await requestJson(
    host,
    "https://lyrics.kugou.com/download?ver=1&client=pc&id=" + encodeURIComponent(String(pick.id))
      + "&accesskey=" + encodeURIComponent(String(pick?.accesskey ?? "")) + "&fmt=lrc&charset=utf8",
    { headers: { Referer: "https://www.kugou.com/" } },
  );
  const content = dl?.content;
  if (typeof content !== "string" || !content) return null;
  const lrc = normalizeLrc(Buffer.from(content, "base64").toString("utf8"));
  // 只认带时间戳/标签的 LRC;解出来不是歌词(如 KRC 密文乱码)一律当没有。
  if (!lrc || !lrc.includes("[")) return null;
  memoSet(memoKey, lrc);
  return lrc;
}

/** 歌词候选挑选:时长与候选曲目接近(±5s)的优先,否则第一个。 */
function pickKugouLyricCandidate(list: any[], durMs: number): any {
  if (durMs <= 0) return list[0];
  const near = list.find((x: any) => {
    const d = Number(x?.duration);
    return Number.isFinite(d) && d > 0 && Math.abs(d - durMs) <= 5000;
  });
  return near ?? list[0];
}

/** 统一歌词文本:去 BOM、还原 HTML 实体、统一换行。 */
function normalizeLrc(s: any): string {
  return String(s ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/\r\n?/g, "\n")
    .trim();
}

// ==================== 酷我音乐 ====================

/**
 * 酷我搜索响应是**单引号 JSON**(非标准),这里做引号感知的转换后 JSON.parse:
 * 单引号字符串 → 双引号(内部 `"` 转义、`\'` 还原为 `'`);已带双引号的段落原样保留。
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

async function kuwoSearch(host: PluginHost, title: string, artist: string): Promise<PlatformCandidate[]> {
  const kw = artist ? `${title} ${artist}` : title;
  const memoKey = `kw:s:${kw}`;
  const cached = memoGet<PlatformCandidate[]>(memoKey);
  if (cached) return cached;

  // web 版 /api/www/* 在本网络恒 "request is illegal";r.s 稳定可用(240 实测 200,~0.17s)。
  const url = "http://search.kuwo.cn/r.s?all=" + encodeURIComponent(kw)
    + "&ft=music&itemset=web_2013&client=kt&pn=0&rn=10&rformat=json&encoding=utf8"
    + "&vipver=1&show_copyright_off=1&pcmp4=1&mobi=1";
  const text = await requestText(host, url, { headers: { Referer: "http://www.kuwo.cn/" } });
  if (!text) return [];
  let data: any = null;
  try {
    data = JSON.parse(singleQuoteToJson(text));
  } catch {
    data = null; // 结构异常 → 当作无候选(不抛)
  }
  if (data === null) return [];
  const list = data?.abslist;
  const out: PlatformCandidate[] = [];
  if (Array.isArray(list)) {
    for (const s of list) {
      const rid = cleanPlatformText(s?.MUSICRID).replace(/^MUSIC_/, "");
      const name = cleanPlatformText(s?.NAME);
      if (!rid || !name) continue;
      out.push({
        platform: "kuwo",
        id: rid,
        name,
        singerName: cleanPlatformText(s?.ARTIST),
        albumName: cleanPlatformText(s?.ALBUM),
        durationSec: Number(s?.DURATION) || 0,
        coverUrl: kuwoCoverUrl(s?.web_albumpic_short),
      });
    }
  }
  memoSet(memoKey, out);
  return out;
}

/** 酷我封面:`http://img1.kuwo.cn/star/albumcover/<web_albumpic_short>`(240 实测 200 image/jpeg)。 */
function kuwoCoverUrl(short: any): string | undefined {
  const s = String(short ?? "").replace(/^\/+/, "").trim();
  if (!s) return undefined;
  return "http://img1.kuwo.cn/star/albumcover/" + s;
}

/** 酷我 songinfoandlrc 原始响应(元数据与歌词共用一次请求;只缓存有 data 的成功响应)。 */
async function kuwoSongRaw(host: PluginHost, rid: string): Promise<any> {
  const memoKey = `kw:raw:${rid}`;
  const cached = memoGet<any>(memoKey);
  if (cached) return cached;
  const data = await requestJson(
    host,
    "https://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=" + encodeURIComponent(rid),
    { headers: { Referer: "https://www.kuwo.cn/" } },
  );
  if (data?.data) memoSet(memoKey, data);
  return data;
}

/** 酷我歌曲信息(专辑 / 时长缺失时补全):songinfo 里 artist 可能为空,只取 album/duration。 */
async function kuwoSongInfo(host: PluginHost, rid: string): Promise<{ album?: string; durationSec?: number } | null> {
  const data = await kuwoSongRaw(host, rid);
  const si = data?.data?.songinfo;
  if (!si) return null;
  const out: { album?: string; durationSec?: number } = {};
  const album = cleanPlatformText(si?.album);
  if (album) out.album = album;
  const dur = Number(si?.duration) || 0;
  if (dur > 0) out.durationSec = dur;
  return out;
}

/** 酷我歌词:lrclist 的 time(秒,小数)+ lineLyric,拼成标准 LRC。 */
async function kuwoLyric(host: PluginHost, rid: string): Promise<string | null> {
  const data = await kuwoSongRaw(host, rid);
  const list = data?.data?.lrclist;
  if (!Array.isArray(list) || list.length === 0) return null;
  const lines: string[] = [];
  for (const row of list) {
    const t = Number(row?.time);
    const text = String(row?.lineLyric ?? "").trim();
    if (!Number.isFinite(t) || !text) continue;
    const m = Math.floor(t / 60);
    const s = (t - m * 60).toFixed(2).padStart(5, "0");
    lines.push(`[${String(m).padStart(2, "0")}:${s}]${text}`);
  }
  const lrc = normalizeLrc(lines.join("\n"));
  if (!lrc) return null;
  return lrc;
}

// ==================== 匹配编排:QQ 优先 → 必要时四平台全局择优 ====================

export interface MatchResult {
  /** 按评分排好序的候选(最多 MAX_MATCH_TRIES 条,供详情/封面/歌词依次兜底)。 */
  ranked: Array<PlatformCandidate & { score: CandidateScore }>;
  /** 是否因 QQ 强命中而提前收口(此时其它平台尚未搜索)。 */
  earlyExit: boolean;
  /** 是否来自「放宽层」(时长容差 ±15s):后续详情/封面/歌词的时长复核必须沿用放宽容差。 */
  relaxed?: boolean;
}

/** 搜索全部平台(QQ 结果可外部传入,避免重复请求),返回评分排序后的候选。 */
async function searchAllRanked(
  host: PluginHost,
  song: LyricSongInput,
  title: string,
  artist: string,
  qqPrefetched?: PlatformCandidate[],
  tolSec = DURATION_TOLERANCE_SEC,
): Promise<Array<PlatformCandidate & { score: CandidateScore }>> {
  // 四个平台**并发**发起(QQ 自带全局节流);已预取 QQ 时不再重复搜索。
  const jobs: Array<Promise<PlatformCandidate[]>> = [
    nsSearch(host, title, artist),
    kugouSearch(host, title, artist),
    kuwoSearch(host, title, artist),
  ];
  const all: PlatformCandidate[] = qqPrefetched ? [...qqPrefetched] : [];
  if (!qqPrefetched) jobs.push(qqSearch(host, title, artist));
  const settled = await Promise.allSettled(jobs);
  for (const r of settled) {
    if (r.status === "fulfilled") all.push(...r.value);
  }
  // 同平台同 ID 去重(不同平台各自独立)。
  const seen = new Set<string>();
  const uniq: PlatformCandidate[] = [];
  for (const c of all) {
    const k = `${c.platform}:${c.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(c);
  }
  return rankByScore(uniq, song, tolSec);
}

function resolveKey(song: LyricSongInput): string {
  return `${normalizeText(song?.title)}|${normalizeText(song?.artist)}|${Number(song?.duration) || 0}`;
}

/** 最优匹配(缓存):QQ 强命中即收口;否则四平台并搜索后按评分取最优。 */
async function resolveBest(host: PluginHost, song: LyricSongInput): Promise<MatchResult | null> {
  const title = cleanPlatformText(song?.title);
  if (!title) return null;
  const artist = isArtistPlaceholder(song?.artist) ? "" : cleanPlatformText(song?.artist);

  const key = `best:${resolveKey(song)}`;
  const cached = memoGet<MatchResult>(key);
  if (cached) return cached;

  const qq = await qqSearch(host, title, artist);
  const qqRanked = rankByScore(qq, song);
  const bestQq = qqRanked[0];
  if (bestQq && isStrongMatch(bestQq.score)) {
    const out: MatchResult = { ranked: qqRanked.slice(0, MAX_MATCH_TRIES), earlyExit: true };
    memoSet(key, out);
    return out;
  }

  const ranked = await searchAllRanked(host, song, title, artist, qq);
  if (ranked.length > 0) {
    const out: MatchResult = { ranked: ranked.slice(0, MAX_MATCH_TRIES), earlyExit: false };
    memoSet(key, out);
    return out;
  }
  // 放宽层:严格层被时长闸门全否时,只救「标题精确 + 歌手精确」的候选(容差 ±15s)。
  // 实测这类差异多来自前奏/尾奏裁剪,仍是同一录音;歌手不精确的一律不放宽,避免配到翻唱。
  const relaxed = (
    await searchAllRanked(host, song, title, artist, qq, DURATION_RELAXED_SEC)
  ).filter((c) => c.score.title === 2 && c.score.artist === 2);
  if (relaxed.length > 0) {
    const out: MatchResult = { ranked: relaxed.slice(0, MAX_MATCH_TRIES), earlyExit: false, relaxed: true };
    memoSet(key, out);
    return out;
  }
  return null; // 失败不缓存:下次仍可重试
}

/** 强命中时其它平台尚未搜索:封面/歌词/详情兜底需要「全平台候选」。 */
async function resolveAll(host: PluginHost, song: LyricSongInput): Promise<Array<PlatformCandidate & { score: CandidateScore }>> {
  const title = cleanPlatformText(song?.title);
  const artist = isArtistPlaceholder(song?.artist) ? "" : cleanPlatformText(song?.artist);
  const key = `all:${resolveKey(song)}`;
  const cached = memoGet<Array<PlatformCandidate & { score: CandidateScore }>>(key);
  if (cached) return cached;
  const ranked = await searchAllRanked(host, song, title, artist);
  if (ranked.length > 0) memoSet(key, ranked);
  return ranked;
}

// ==================== 专辑多平台一致判定 ====================
//
// 用途(产品定调 2026-11):本地专辑值「无法自证」(空 / 占位词 / 纯符号)时,
// 不看单一平台的结论,而是让**每个平台各自选出自己的最优候选**,再看这些平台的
// 专辑名是否一致 —— **至少 2 个不同平台报同一个专辑名**才采信。
//
// 为什么不用四家混排后的 top1:混排 top1 仍是「某一个平台说的」,无法区分
// 《空》这类真专辑与平台占位噪声;跨平台一致才有自证力。
//
// 口径:
//   - 每平台只取评分最高的一条(严格层 → 放宽层,与 searchMetadata 同口径);
//   - 专辑归一化:先剥离**尾部版本标注**(Explicit / Deluxe / Remastered / 豪华版…),
//     再「小写 + 去空白」;**绝不剥其它标点/符号**:否则 ♡ / ? 这类纯符号专辑会全部
//     折叠成空串,被误判成「一致」(2026-11-12:平台间 `X` / `X (Deluxe)` 的写法差异
//     曾把同一张专辑拆成两组,共识永远凑不齐);
//   - 空 / Unknown Album 不参与投票;拿不到专辑的平台直接缺席;
//   - 只缓存**有结论**的结果(与全文件「只缓存成功」纪律一致)。

/** 专辑一致判定所需的最少不同平台数。 */
const ALBUM_CONSENSUS_MIN_PLATFORMS = 2;

/** 专辑尾部「版本标注」白名单(中英):只有命中这些词的括号/短横标注才参与剥离。
 *  【2026-11-12】平台之间常见 `X (Explicit)` / `X (Deluxe)` / `X - Remastered` 的写法差异,
 *  不剥离会导致同一张专辑被拆成两组、共识永远凑不齐 2 个平台。 */
const ALBUM_EDITION_RE =
  /^(?:explicit|clean|deluxe(?:\s*edition)?|remaster(?:ed)?(?:\s*version)?|expanded(?:\s*edition)?|special(?:\s*edition)?|bonus(?:\s*track)?|anniversary(?:\s*edition)?|reissue|mono|stereo|hi[- ]?res|24[- ]?bit|豪华版|加强版|重制版|特别版|纪念版|数位版|彩蛋版)$/i;

function isAlbumEditionAnnotation(raw: string): boolean {
  return ALBUM_EDITION_RE.test(raw.replace(/[_/]/g, " ").replace(/\s+/g, " ").trim());
}

/** 平台侧专辑值归一化:剥离**尾部版本标注**后,小写 + 去空白,保留其它符号。
 *  纯符号值(♡ / ?)不做任何剥离,避免被折叠成空串后误判一致(见上文口径)。 */
function albumConsensusKey(v: string): string {
  let s = String(v ?? "").trim();
  for (let i = 0; i < 4; i++) {
    const bracketed = s.match(/[\(（\[【]\s*([^\(（\[【\)）\]】]*?)\s*[\)）\]】]$/);
    if (bracketed && bracketed.index !== undefined && bracketed.index > 0 && isAlbumEditionAnnotation(bracketed[1]!)) {
      s = s.slice(0, bracketed.index).trim();
      continue;
    }
    const dashed = s.match(/\s+[-–—]\s+(.+)$/);
    if (dashed && dashed.index !== undefined && dashed.index > 0 && isAlbumEditionAnnotation(dashed[1]!)) {
      s = s.slice(0, dashed.index).trim();
      continue;
    }
    break;
  }
  return s.toLowerCase().replace(/\s+/g, "");
}

/** 该平台「最优候选」的专辑名;严格层全被否时退放宽层(仅标题+歌手精确)。 */
async function platformBestAlbum(
  host: PluginHost,
  cands: PlatformCandidate[],
  song: LyricSongInput,
): Promise<string> {
  if (cands.length === 0) return "";
  let ranked = rankByScore(cands, song);
  if (ranked.length === 0) {
    ranked = rankByScore(cands, song, DURATION_RELAXED_SEC)
      .filter((c) => c.score.title === 2 && c.score.artist === 2);
  }
  const best = ranked[0];
  if (!best) return "";
  const usable = (v: string): string => {
    const a = cleanPlatformText(v).trim();
    if (!a || ALBUM_PLACEHOLDERS.has(a.toLowerCase())) return "";
    return a;
  };
  // 严格层**前 3 个**候选里取第一个带有效专辑的(2026-11-12):原实现只看 ranked[0],
  // 实测同平台 top3 内常有一条带专辑而另一条缺字段,逐条取可多救 3~4 首且不增加请求。
  for (const c of ranked.slice(0, MAX_MATCH_TRIES)) {
    const a = usable(c.albumName);
    if (a) return a;
  }
  // 前 3 条都没有专辑字段 → 才走详情补全(QQ / 酷我),控制请求量。
  let album = best.albumName || "";
  // 酷我搜索常缺专辑 → 用 songinfo 补(与 metadataFor 同口径)。
  if (!album && best.platform === "kuwo") {
    const si = await kuwoSongInfo(host, best.id);
    album = si?.album || "";
  }
  // QQ 搜索偶发缺 album → 用详情补。
  if (!album && best.platform === "qq") {
    const detail = await qqSongDetail(host, best.id);
    album = cleanPlatformText(detail?.track?.album?.name ?? "");
  }
  return usable(album);
}

/**
 * 四平台并发搜索 → 每平台取最优候选的专辑 → 归一化分组 → 返回一致值。
 * 仅当某一组覆盖 ≥2 个不同平台时返回(组内取首个出现的原值)。
 */
async function resolveAlbumConsensus(
  host: PluginHost,
  song: LyricSongInput,
): Promise<{ album: string; platforms: string[] } | null> {
  const title = cleanPlatformText(song?.title);
  if (!title) return null;
  const artist = isArtistPlaceholder(song?.artist) ? "" : cleanPlatformText(song?.artist);

  const key = `cons:${resolveKey(song)}`;
  const cached = memoGet<{ album: string; platforms: string[] }>(key);
  if (cached) return cached;

  const platforms: TagPlatform[] = ["qq", "netease", "kugou", "kuwo"];
  const settled = await Promise.allSettled([
    qqSearch(host, title, artist),
    nsSearch(host, title, artist),
    kugouSearch(host, title, artist),
    kuwoSearch(host, title, artist),
  ]);
  // 各平台并行取最优候选的专辑(酷我/QQ 的补全请求也并行)。
  const albums = await Promise.all(
    platforms.map((p, i) => {
      const r = settled[i];
      return r && r.status === "fulfilled" ? platformBestAlbum(host, r.value, song) : Promise.resolve("");
    }),
  );

  const groups = new Map<string, { value: string; platforms: Set<string> }>();
  for (let i = 0; i < platforms.length; i++) {
    const album = albums[i];
    if (!album) continue;
    const k = albumConsensusKey(album);
    if (!k) continue;
    const g = groups.get(k) ?? { value: album, platforms: new Set<string>() };
    g.platforms.add(platforms[i]!);
    groups.set(k, g);
  }
  let best: { album: string; platforms: string[] } | null = null;
  for (const g of groups.values()) {
    if (g.platforms.size >= ALBUM_CONSENSUS_MIN_PLATFORMS) {
      best = { album: g.value, platforms: [...g.platforms] };
      break;
    }
  }
  if (best) memoSet(key, best);
  return best;
}

// ==================== 各平台:元数据 / 封面 / 歌词 ====================

/** QQ 详情 → SongMetadata(轨号/年份/风格/专辑/时长)。 */
function buildQqMetadata(detail: { track: any; info: any }): SongMetadata | null {
  const t: any = detail?.track;
  const meta: SongMetadata = {};
  const name = t?.name || t?.title;
  if (name) meta.title = String(name);
  const singers = Array.isArray(t?.singer) ? t.singer.map((s: any) => s?.name).filter(Boolean) : [];
  if (singers.length) meta.artist = singers.join("/");
  const albumName = t?.album?.name;
  if (albumName) meta.album = String(albumName);

  // 轨号:QQ 的 index_album 即专辑内序号(1 基)
  const track = Number(t?.index_album);
  if (Number.isFinite(track) && track > 0) meta.track = track;

  // 年份:优先 track_info.time_public,兜底 album.time_public
  if (t?.time_public) {
    const y = parseYear(t.time_public);
    if (y) meta.year = y;
  } else if (t?.album?.time_public) {
    const y = parseYear(t.album.time_public);
    if (y) meta.year = y;
  }

  const dur = Number(t?.interval);
  if (Number.isFinite(dur) && dur > 0) meta.duration = dur;

  // 风格:只取同级 info 块的可读名;track_info.genre 是数字码,不用。
  const genre = pickGenre(detail?.info);
  if (genre) meta.genre = genre;

  meta.platform = "qq";
  return Object.keys(meta).length > 1 ? meta : null;
}

/** 非 QQ 平台:候选自带字段直接组装(只填拿到的;风格/轨号没有就不填)。 */
function buildBasicMetadata(c: PlatformCandidate, extra?: { album?: string; durationSec?: number }): SongMetadata | null {
  const meta: SongMetadata = { platform: c.platform };
  if (c.name) meta.title = c.name;
  if (c.singerName) meta.artist = c.singerName;
  const album = c.albumName || extra?.album || "";
  if (album) meta.album = album;
  if (c.year) meta.year = c.year;
  if (c.track && c.track > 0) meta.track = c.track;
  const dur = c.durationSec > 0 ? c.durationSec : (extra?.durationSec ?? 0);
  if (dur > 0) meta.duration = dur;
  return Object.keys(meta).length > 1 ? meta : null;
}

/** 某候选的元数据(QQ 需详情;酷我在专辑/时长缺失时补 songinfo)。
 *  详情里的时长一旦与本地相差 >5s,说明是**同名的不同版本**(搜索期 interval 可能被平台写成别的值),
 *  该候选作废,交由下一个候选/其它平台兜底。 */
async function metadataFor(
  host: PluginHost,
  c: PlatformCandidate,
  song: LyricSongInput,
  tolSec = DURATION_TOLERANCE_SEC,
): Promise<SongMetadata | null> {
  let meta: SongMetadata | null = null;
  if (c.platform === "qq") {
    const detail = await qqSongDetail(host, c.id);
    meta = detail ? buildQqMetadata(detail) : null;
    if (meta) {
      // 详情偶发只回标题/歌手/时长(如「老公天下第一」的 QQ 详情缺 album):
      // 用搜索候选自带字段补齐,不让已有信息白白丢掉。
      // 注意:详情**完全失败**时不回退候选 —— 交给其它平台(它们字段更全),
      // 这是既有产品口径(见用例「详情缺 track_info → 走网易云兜底」)。
      if (!meta.album && c.albumName) meta.album = c.albumName;
      if (!meta.duration && c.durationSec > 0) meta.duration = c.durationSec;
    }
  } else if (c.platform === "kuwo" && (!c.albumName || c.durationSec <= 0)) {
    const si = await kuwoSongInfo(host, c.id);
    meta = buildBasicMetadata(c, si ?? undefined);
  } else {
    meta = buildBasicMetadata(c);
  }
  if (meta?.duration && !durationOk(song?.duration, meta.duration, tolSec)) return null;
  return meta;
}

/**
 * 流派兜底(2026-11-12 四平台实测):
 *   - 网易云专辑详情(retina /api/v1/album/{id})的 `tags` 在 230/240 实测**恒为空串**
 *     (含《海阔天空》这类老专辑);酷狗搜索/详情、酷我 songinfo 也**不暴露可读流派**;
 *     故流派只剩 QQ `info.genre.content[].value` 一个可靠来源。
 *   - 当本次匹配没拿到 genre,而 QQ 侧存在「标题精确 + 歌手通过」的候选时,补取一次详情
 *     只要 genre(QQ 搜索/详情均走 memo,已查过的不会重复请求);拿不到就留空,绝不臆造。
 */
async function qqGenreFor(host: PluginHost, song: LyricSongInput): Promise<string | undefined> {
  const title = cleanPlatformText(song?.title);
  if (!title) return undefined;
  const artist = isArtistPlaceholder(song?.artist) ? "" : cleanPlatformText(song?.artist);

  const memoKey = `genre:${resolveKey(song)}`;
  const cached = memoGet<string>(memoKey);
  if (cached) return cached;

  const cands = rankByScore(await qqSearch(host, title, artist), song);
  const hit = cands
    .slice(0, MAX_MATCH_TRIES)
    .find((c) => c.score.title === 2 && (!artist || c.score.artist === 2));
  if (!hit) return undefined;
  const genre = pickGenre((await qqSongDetail(host, hit.id))?.info);
  if (!genre) return undefined;
  memoSet(memoKey, genre);
  return genre;
}

/** 某候选的封面(QQ 用详情里的专辑 mid;详情时长不符同样作废)。 */
async function coverFor(
  host: PluginHost,
  c: PlatformCandidate,
  song: LyricSongInput,
  tolSec = DURATION_TOLERANCE_SEC,
): Promise<string | null> {
  if (c.coverUrl) return c.coverUrl;
  if (c.platform === "qq") {
    const detail = await qqSongDetail(host, c.id);
    const interval = Number(detail?.track?.interval) || 0;
    if (interval > 0 && !durationOk(song?.duration, interval, tolSec)) return null;
    const albumMid = detail?.track?.album?.mid;
    return albumMid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albumMid}.jpg` : null;
  }
  if (c.platform === "netease") return nsCoverUrl(host, c.id);
  return null;
}

/** 某候选的歌词。 */
async function lyricFor(host: PluginHost, c: PlatformCandidate): Promise<string | null> {
  if (c.platform === "qq") return qqLyric(host, c.id);
  if (c.platform === "netease") return nsLyric(host, c.id);
  if (c.platform === "kugou") return kugouLyric(host, c);
  return kuwoLyric(host, c.id);
}

/**
 * 依次尝试候选(评分最高的先;最多 MAX_MATCH_TRIES 条),任一成功即返回。
 * 若此前是「QQ 强命中提前收口」,且这批候选全部拿不到 → 再搜全平台兜底
 * (例如 QQ 详情接口挂了,但网易云/酷狗/酷我有同一首)。
 */
async function firstAvailable<T>(
  host: PluginHost,
  song: LyricSongInput,
  pick: (host: PluginHost, c: PlatformCandidate, song: LyricSongInput, tolSec: number) => Promise<T | null>,
): Promise<T | null> {
  const res = await resolveBest(host, song);
  if (!res) return null;
  const tol = res.relaxed ? DURATION_RELAXED_SEC : DURATION_TOLERANCE_SEC;
  for (const c of res.ranked) {
    const v = await pick(host, c, song, tol);
    if (v) return v;
  }
  // 只有「QQ 强命中提前收口」才需要补搜其它平台(否则上面的候选已覆盖四平台)。
  if (!res.earlyExit) return null;
  const all = await resolveAll(host, song);
  for (const c of all.slice(0, MAX_MATCH_TRIES)) {
    const v = await pick(host, c, song, DURATION_TOLERANCE_SEC);
    if (v) return v;
  }
  return null;
}

// ==================== Manifest ====================

export const tagProviderManifest: PluginManifest = {
  id: "tag-provider",
  name: "在线标签补全",
  version: "1.3.0",
  type: "metadata",
  description: "从 QQ 音乐(默认)、网易云音乐、酷狗音乐、酷我音乐补全歌曲标签(轨号/年份/时长/专辑/风格等)、封面与歌词",
  capabilities: ["metadataProvider", "coverProvider", "lyricProvider"],
  platforms: ["qq", "netease", "kugou", "kuwo"],
  platformLabels: { qq: "QQ音乐", netease: "网易云音乐", kugou: "酷狗音乐", kuwo: "酷我音乐" },
  permissions: ["net", "log"],
  defaultEnabled: true,
  // 内置标签来源:下载期由本插件打上的标签,核心会在落盘后写「标签修复完成标记」,
  // 后续标签修复命中标记即跳过(外置插件不声明本字段,故其标签不标记)。
  builtinTagSource: true,
  configSchema: [],
  i18n: {
    en: {
      name: "Online Tag Filler",
      description:
        "Enrich song tags (track/year/duration/album/genre...), cover art and lyrics from QQ Music (default), NetEase Cloud Music, Kugou Music and Kuwo Music",
      documentation: `### Features
Enriches a song's tags, cover art and lyrics from four platforms: QQ Music (default), NetEase Cloud Music, Kugou Music and Kuwo Music. It declares \`metadataProvider\`, \`coverProvider\` and \`lyricProvider\` at once, so the core's tag-repair / download-enrich / cover / lyrics pipelines all use this plugin.

### How it works
1. QQ Music runs first. A **strong match** (exact normalized title + exact artist) is accepted immediately — no extra requests, no extra latency;
2. Only when QQ has no candidate or only weak ones (artist missing, title variant only, detail/cover/lyric unavailable) are NetEase / Kugou / Kuwo queried **in parallel**, then the best candidate across all four platforms wins by score;
3. Scoring (ported from Music Tag Web's match_score): title exact = 2, artist exact = 2 / contains = 1 / mismatch = rejected, album exact = 2 / contains = 1, duration within ±2s = +1; duration off by >5s, artist mismatch, or a version-marker mismatch (Live/Remix/伴奏/纯音乐/…) rejects the candidate;
4. Requests are cached per keyword / song id (180s, successes only), so the three capability calls share one search round-trip. QQ requests stay globally throttled (≥1.2s + jitter).

### Notes
- No configuration; enabled by default;
- Every missing field is left empty — nothing is ever fabricated. Genre is only available from QQ Music (NetEase album \`tags\` and Kugou/Kuwo expose no readable genre); when another platform wins, QQ is asked once for the genre of an exact-title match (memoized);
- Kugou lyrics use \`lyrics.kugou.com\` search + download; placeholder artists (Unknown / 群星 / Various Artists…) never enter the search keyword or veto a candidate; "片段/抖音/剪辑/试听" are soft version markers (ranking preference only), while Live/伴奏/纯音乐/翻唱 still reject.

### Album consensus
When a local album tag cannot prove itself (empty, a placeholder such as "Unknown Album", or pure symbols like \`♡\` / \`?\`), all four platforms are queried and each contributes its best album from the first three strict matches. Trailing edition annotations (\`(Explicit)\`, \`(Deluxe)\`, \`(Remastered)\`, …) are ignored when comparing; the album is accepted only when **at least two different platforms** agree.`,
    },
  },
  documentation: `### 功能介绍
从 QQ 音乐(默认)、网易云音乐、酷狗音乐、酷我音乐四个平台为歌曲补全标签(轨号 / 年份 /
时长 / 专辑 / 风格等)、封面与歌词。本插件一次声明 \`metadataProvider\`、\`coverProvider\`、
\`lyricProvider\` 三种能力,核心的标签修复 / 下载补全 / 封面 / 歌词链路都会调用它。

### 处理逻辑
1. **先跑 QQ 音乐**:若得到强命中(标题归一化后精确相等 + 歌手精确吻合),立即采用,
   不额外请求、不增加延迟;
2. 只有 QQ 无候选 / 仅弱候选(缺歌手、标题只是变体、详情或封面/歌词拿不到)时,才把
   网易云 / 酷狗 / 酷我**并发**搜索,四平台候选统一评分后取最优;
3. **评分**(参考 Music Tag Web 的 match_score,并补上本地场景硬闸门):
   标题精确 2 分、歌手精确 2 分(包含 1 分,本地有歌手却完全不匹配 → 否决)、
   专辑精确 2 分(包含 1 分)、时长相差 ≤2s 加 1 分;**时长相差 >5s、歌手不匹配、
   版本标记不一致(现场/Live/Remix/伴奏/纯音乐/翻唱/电台版…)→ 直接否决**;总分 ≥3
   (标题必须命中)才可作为候选;
4. 搜索结果按关键词 / 曲 ID 缓存 180s(只缓存成功响应),三个能力共享同一轮搜索;
   QQ 请求仍走全局限流(≥1.2s + 300~800ms 抖动);
5. 拿不到的字段一律不填,绝不臆造。风格(流派)只有 QQ 提供可读值 ——
   网易云专辑 \`tags\` 与酷狗/酷我均无可读流派;非 QQ 命中时会用 QQ 侧同曲候选补取一次
   (memo 化,拿不到不填);酷狗歌词走 lyrics.kugou.com 的 search + download(lrc);
6. **专辑多平台一致判定**:本地专辑为空 / 占位词 / 纯符号时,四平台各自取
   **严格层前 3 个候选中第一个带专辑的**做比对,归一化时容忍 \`(Explicit)\` /
   \`(Deluxe)\` / \`(Remastered)\` 等尾部版本标注,**至少 2 个不同平台一致**才采用;
7. 占位歌手(Unknown Artist / 未知歌手 / 网络歌手 / 群星 / 华语群星 / 佚名 / Various Artists)
   不拼进搜索关键词、不参与歌手否决;「片段 / 抖音 / 剪辑 / 试听」为温和版本标记,
   不否决候选,仅在同分时优先选择标记一致者(Live / 伴奏 / 纯音乐 / 翻唱仍否决)。`,
};

// ==================== Plugin impl ====================

export const tagProviderPlugin: MetadataProviderPlugin & CoverProviderPlugin & LyricProviderPlugin = {
  manifest: tagProviderManifest,

  async searchMetadata(host: PluginHost, song: LyricSongInput): Promise<SongMetadata | null> {
    try {
      if (!cleanPlatformText(song?.title)) return null;
      const meta = await firstAvailable(host, song, metadataFor);
      if (meta && !meta.genre) {
        const genre = await qqGenreFor(host, song);
        if (genre) meta.genre = genre;
      }
      return meta;
    } catch {
      return null;
    }
  },

  async searchCover(host: PluginHost, song: LyricSongInput): Promise<{ url?: string } | null> {
    try {
      if (!cleanPlatformText(song?.title)) return null;
      const url = await firstAvailable(host, song, coverFor);
      return url ? { url } : null;
    } catch {
      return null;
    }
  },

  async searchLyrics(host: PluginHost, song: LyricSongInput): Promise<{ lrc?: string; text?: string } | null> {
    try {
      if (!cleanPlatformText(song?.title)) return null;
      const raw = await firstAvailable(host, song, lyricFor);
      const lrc = normalizeLrc(raw);
      return lrc ? { lrc } : null;
    } catch {
      return null;
    }
  },

  async searchAlbumConsensus(
    host: PluginHost,
    song: LyricSongInput,
  ): Promise<{ album: string; platforms: string[] } | null> {
    try {
      if (!cleanPlatformText(song?.title)) return null;
      return await resolveAlbumConsensus(host, song);
    } catch {
      return null;
    }
  },
};
