/**
 * 标签兜底:把「下载器写坏的 Unknown/脏标签」尽量还原。
 *
 * 背景(2026-11 线上 1001 首):酷狗等源拿不到元数据时,会把
 * artist=Unknown Artist / album=Unknown Album **固化进文件**(经 ffmpeg 写标签),
 * 于是任何扫描链路读到的都只能是 Unknown。真实信息通常还留在三处:
 *   ① 内嵌歌词头 `[ar:歌手]` / `[al:专辑]`(LRC 格式);
 *   ② 文件名 `歌名 - 歌手`(下载器把歌手拼进了文件名);
 *   ③ 下载时的信源搜索信息(拿不到候选标签时,平台结果里通常仍有真歌手)。
 *
 * 专辑侧还有一类脏值(2026-11 存量 146 首):老下载器把**网址/广告文本/GBK 乱码/
 * 「空」「未知专辑」**写进 album,这些值会原样变成目录名。规则见 cleanAlbumTag。
 *
 * 规则:只在值为 Unknown/空/脏值时生效,绝不动真实标签;都没有就保持原样。
 * 统一放在这里,由以下调用方共用,避免各链路口径漂移:
 *   - 扫描入库(services/source/scanner.ts → upsertSong,webdav/smb/local 三条链路)
 *   - 下载写文件标签(services/fetch/orchestrator.ts,写盘前;同时影响命名)
 *   - 洗版换源(services/fetch/upgrade.ts → orchestrateSong,自动覆盖)
 */
export interface RecoverableTags {
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  /** 扫描侧字段名(music-metadata 解析出的纯文本歌词)。 */
  lyrics?: string;
  /** 下载侧字段名(provider 取到的纯文本歌词)。 */
  lyric?: string;
}

const UNKNOWN_ARTIST_RE = /^(unknown(\s*artist)?|未知(歌手)?)$/i;
const UNKNOWN_ALBUM_RE = /^(unknown(\s*album)?|未知(专辑)?)$/i;

export function isUnknownArtist(v?: string): boolean {
  return !v || UNKNOWN_ARTIST_RE.test(v.trim());
}

export function isUnknownAlbum(v?: string): boolean {
  return !v || UNKNOWN_ALBUM_RE.test(v.trim());
}

// ==================== 专辑脏值清洗 ====================
//
// 【口径】这套规则同时用于「存量一次性清洗」(2026-11 已按同规则修完 146 首)
// 与「增量写入」(下载/洗版/扫描)。三条链路口径必须一致,改这里就要意识到
// 历史数据需要按新规则重跑一遍,否则新旧数据的专辑命名会漂移。

/** cp1252 的 0x80-0x9F 区(GBK 被当 cp1252 解码时,这段会变成 Œ ˆ Š 等字符)。 */
const CP1252_HIGH: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86,
  0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c,
  0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95,
  0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

/**
 * 把「GBK 字节被当成 cp1252/latin1 解码」的乱码还原成原文(如
 * `ÔÚÏßÈÈËÑ£¨»ªÓï£©ÏµÁÐ28` → `在线热搜（华语）系列28`)。
 * 无法可靠还原(含无法映射的字符 / 解码出替换符 / 还原后与原串相同)返回 null。
 */
export function unMojibake(value: string): string | null {
  const bytes: number[] = [];
  let high = 0;
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0xff) bytes.push(code);
    else if (CP1252_HIGH[code] !== undefined) bytes.push(CP1252_HIGH[code]);
    else return null;
    if (code > 0x7f) high++;
  }
  // 少于 4 字节基本不可能是一段中文 GBK 双字节序列,直接放弃,避免误伤短标签。
  if (bytes.length < 4) return null;
  // 🔴 高字节占比必须过半:中文 GBK 被逐字节解码后几乎每个字符都是非 ASCII;
  // 而正常的西班牙语/法语/德语专辑(Habitación En Roma、Café del Mar)、
  // 弯引号(I’m Not Cool、Here’s Your Perfect)只有零星几个重音字符。
  // 没有这道闸,GBK 解码会把它们"成功"解成中文垃圾,把真专辑名洗掉(2026-11 实测 230 条误伤)。
  if (high / value.length < 0.5) return null;
  const decoded = new TextDecoder("gbk").decode(Buffer.from(bytes));
  if (decoded.includes("\uFFFD") || decoded === value) return null;
  return decoded;
}

/** 占位词(空专辑的另一种写法)。 */
// 注意不要收进 `?` / `…` / `♡` 这类:它们是真专辑名(陈奕迅《?》、Yee《♡》)。
const JUNK_ALBUM_RE = /^(空|未知|未知专辑|未知歌手|无|none|null|unknown(\s*album)?|n\/a|-+)$/i;
/**
 * 网址/域名识别(按结构,不枚举站点):
 *   - 协议头 http(s):// 或 www.
 *   - 「域名 + 常见 TLD」,允许前后带路径/文字
 * TLD 白名单是必需的:没有它 `Part.6`、`Op. 46` 这类正常专辑会被误伤
 * (数字结尾的 `6`/`46` 不在白名单里,所以安全)。
 */
const URL_RE = new RegExp(
  String.raw`(https?:\/\/|www\.)` +
    String.raw`|\b[\w-]+(?:\.[\w-]+)*\.(?:com|cn|net|org|cc|top|xyz|vip|info|me|tv|io|co|link|club|site|online|shop|wang|ink|biz|pw|ws|ltd|store|fun|pro|mobi|asia|la)\b`,
  "i",
);

/**
 * 联系方式/导流:平台名后跟账号(微信/公众号/QQ/抖音/快手/微博/小红书…),或独立 11 位手机号。
 * 与站点名单解耦 —— 以后多一个平台不用改正则。
 */
const CONTACT_RE = new RegExp(
  String.raw`(微信|weixin|wechat|公众号|qq|扣扣|抖音|快手|微博|小红书|b站|bilibili|telegram|whatsapp|加\s*[vV微]|vx|v[信X]|威信)\s*(号|id)?\s*[:：]?\s*[\w\d_-]{3,}` +
    String.raw`|(?<!\d)1[3-9]\d{9}(?!\d)`,
  "i",
);

/** 广告/下载站措辞(纯词语,命中即丢)。 */
// 只留几乎不可能出现在真专辑名里的词。`音乐网`(音乐网剧《少年有点酷》)、
// `正版`(地铁等待（正版）)都会误伤真实专辑,已剔除,交给网址/联系方式判据覆盖。
const AD_WORDS_RE = /(本站|官网|下载|歌库|音源|加群|关注|私信|领取|免费|网盘|论坛|嗨嗨网|资源网)/;

/**
 * 乱码残余的通用判据:既没有 CJK、也没有空白、长度很短,却混排了两种以上文字系统
 * —— 这正是「GBK 字节被逐字解码」的形态(如 Ҫôſ:西里尔 + 拉丁)。
 * 正常外文专辑要么有空白(Грезами Ночи, Печалью Дней),要么只有一种文字(Душа),
 * 都不会命中。
 */
function looksLikeMojibakeResidue(s: string): boolean {
  if (s.length > 10 || /\s/.test(s)) return false;
  if (/[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/.test(s)) return false;
  // 非 ASCII 占比也要过半:否则 `π-volume.3` 这类「一个希腊字母 + 英文」的真专辑
  // 会因为「希腊文 + 拉丁」被判成乱码残余。
  let nonAscii = 0;
  for (const ch of s) if ((ch.codePointAt(0) ?? 0) > 0x7f) nonAscii++;
  if (nonAscii / s.length < 0.5) return false;
  const scripts = new Set<string>();
  for (const ch of s) {
    if (/\p{Script=Latin}/u.test(ch)) scripts.add("latin");
    else if (/\p{Script=Cyrillic}/u.test(ch)) scripts.add("cyrillic");
    else if (/\p{Script=Greek}/u.test(ch)) scripts.add("greek");
    else if (/\p{Script=Hangul}/u.test(ch)) scripts.add("hangul");
    else if (/\p{Script=Arabic}/u.test(ch)) scripts.add("arabic");
  }
  return scripts.size >= 2;
}

/**
 * 清洗专辑标签,返回「可以写进文件/库」的值:
 *   - 空 / 「空」/「未知专辑」等占位 → ""(交给调用方用歌名兜底)
 *   - 网址/域名、联系方式、广告措辞 → ""
 *   - 乱码残余(无 CJK/无空白/多文字系统混排) → ""
 *   - 不含任何字母或数字 → ""
 *   - GBK 乱码 → 还原后的原文
 *   - 其余正常专辑名 → 原样返回(仅去首尾空白)
 */
/**
 * 是否命中网址/联系方式/广告措辞。
 * 与「空 / ♡ 这类无法自证的短值」分开:后者可能是真专辑(暗杠《空》),要交给
 * 多平台共识去裁定,不能一律当脏值丢掉。
 */
function isAdLike(cand: string): boolean {
  // 裸域名只有「整串就是一个网址」时才算广告:否则 `MTV.com Live - Avril Lavigne`
  // 这种把域名写进标题的真专辑会被误杀。带 www./协议头的仍然直接判脏。
  const urlHit = URL_RE.test(cand) && (/https?:\/\/|www\./i.test(cand) || !/\s/.test(cand.trim()));
  return urlHit || CONTACT_RE.test(cand) || AD_WORDS_RE.test(cand);
}

export function cleanAlbumTag(value?: string): string {
  const raw = (value ?? "").trim();
  if (!raw) return "";
  // 只有「还原结果确实含中文」才采信:GBK 解码对任意字节都会产出字符,
  // 不含中文的"还原"只能是误解码,保留原值。
  const decoded = unMojibake(raw);
  const cand = decoded && /[\u4e00-\u9fff]/.test(decoded) ? decoded : raw;
  if (JUNK_ALBUM_RE.test(cand)) return "";
  if (isAdLike(cand)) return "";
  // 纯符号(♡ / ☻ / ⊙▽⊙ / …)不判脏:这类是真实专辑名,宁可保留也不要用歌名覆盖。
  if (looksLikeMojibakeResidue(cand)) return "";
  return cand;
}

/**
 * 多平台专辑共识:至少 minPlatforms 个**不同平台**给出同一个专辑名,才认为它是真数据。
 *
 * 为什么需要:专辑写成 `空` / `♡` / `Unknown` 时,单看字符串无法区分「占位垃圾」和
 * 「真专辑」——暗杠的专辑就叫《空》,Yee 的专辑就叫《♡》。产品口径(2026-11):
 * 命中这类无法自证的值时,去多个平台比对,一致才采信;不一致则退回用歌名当专辑。
 *
 * 过滤:空值 / Unknown / 网址广告 一律不参与投票(这些即使一致也不可信)。
 */
export function consensusAlbum(
  items: Array<{ album?: string | null; platform?: string | null; pluginId?: string | null }>,
  minPlatforms = 2,
): string {
  const groups = new Map<string, { value: string; platforms: Set<string> }>();
  for (const it of items) {
    const value = (it.album ?? "").trim();
    if (!value || isUnknownAlbum(value) || isAdLike(value)) continue;
    const key = value.toLowerCase().replace(/\s+/g, "");
    const g = groups.get(key) ?? { value, platforms: new Set<string>() };
    g.platforms.add(String(it.platform || it.pluginId || "unknown"));
    groups.set(key, g);
  }
  let best = "";
  let bestN = 0;
  for (const g of groups.values()) {
    if (g.platforms.size > bestN) {
      bestN = g.platforms.size;
      best = g.value;
    }
  }
  return bestN >= minPlatforms ? best : "";
}

/**
 * 就地回填,返回是否真的改动了任何字段(供调用方决定是否记日志)。
 * @param fileName      目标文件名(可含扩展名)。下载链路写盘前还没有最终名,传空串。
 * @param fallbackArtist 兜底歌手(下载链路用信源搜索结果),仅在前两步都失败时使用。
 */
export function recoverUnknownTags(meta: RecoverableTags, fileName = "", fallbackArtist = ""): boolean {
  const originalAlbum = (meta.album ?? "").trim();
  const needArtist = isUnknownArtist(meta.artist);
  const needAlbum = isUnknownAlbum(meta.album);
  const albumDirty = cleanAlbumTag(meta.album) !== originalAlbum;
  if (!needArtist && !needAlbum && !albumDirty) return false;

  const text = meta.lyrics || meta.lyric || "";
  const lyricTag = (key: string): string => {
    const m = new RegExp(`\\[${key}:([^\\]]*)\\]`, "i").exec(text);
    return m ? m[1].trim() : "";
  };

  // 文件名去掉扩展名与下载器附加的 ` - Unknown Artist` 尾巴。
  // fileName 可以是完整路径:目录能告诉我们「歌名 - 歌手」还是「歌手 - 歌名」
  // (本项目下载落 `歌手/专辑/歌名 - 歌手.ext`,外部下载器常见 `歌手 - 歌名`)。
  const segs = fileName.split(/[\\/]+/).filter(Boolean);
  const baseName = segs.length > 0 ? segs[segs.length - 1] : "";
  const parentDir = segs.length >= 2 ? segs[segs.length - 2] : "";
  const grandDir = segs.length >= 3 ? segs[segs.length - 3] : "";
  const base = baseName
    .replace(/\.[^.]+$/, "")
    .replace(/\s*-\s*(unknown(\s*(artist|album))?|未知(歌手|专辑)?)\s*$/i, "")
    .trim();
  const sep = base.lastIndexOf(" - ");
  const left = sep > 0 ? base.slice(0, sep).trim() : "";
  const right = sep > 0 ? base.slice(sep + 3).trim() : "";
  const same = (a: string, b: string): boolean => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
  // 只有目录能给出线索时才敢拆标题:父/祖父目录命中右侧说明是本项目命名(歌名在前),
  // 命中左侧说明是外部命名(歌手在前);两边都对不上就不猜,保持原样。
  const titleFirst: boolean | null =
    same(parentDir, right) || same(grandDir, right)
      ? true
      : same(parentDir, left) || same(grandDir, left)
        ? false
        : null;

  let changed = false;
  // 专辑:先按歌词头 [al:] 回填,再统一清洗(乱码还原/脏值置空)。
  // 置空后由调用方用歌名兜底(orchestrator / naming / scanner)。
  let album = needAlbum ? "" : originalAlbum;
  if (needAlbum) {
    const al = lyricTag("al");
    if (al && !isUnknownAlbum(al)) album = al;
  }
  const cleanedAlbum = cleanAlbumTag(album);
  if (cleanedAlbum !== originalAlbum) {
    meta.album = cleanedAlbum;
    changed = true;
  }
  if (needArtist) {
    let ar = lyricTag("ar");
    if (isUnknownArtist(ar) && sep > 0 && titleFirst === true) ar = right;
    if (isUnknownArtist(ar) && sep > 0 && titleFirst === false) ar = left;
    if (isUnknownArtist(ar)) ar = fallbackArtist;
    if (ar && !isUnknownArtist(ar)) {
      meta.artist = ar;
      if (isUnknownArtist(meta.albumArtist)) meta.albumArtist = ar;
      changed = true;
    }
  }
  // 标签 title 就是整条 `歌名 - 歌手` 时收敛成歌名(仅在完全相等且方向已知时动)。
  if (sep > 0 && titleFirst !== null && meta.title && meta.title.trim() === base) {
    meta.title = titleFirst ? left : right;
    changed = true;
  }
  return changed;
}
