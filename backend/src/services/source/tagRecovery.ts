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
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0xff) bytes.push(code);
    else if (CP1252_HIGH[code] !== undefined) bytes.push(CP1252_HIGH[code]);
    else return null;
  }
  // 少于 4 字节基本不可能是一段中文 GBK 双字节序列,直接放弃,避免误伤短标签。
  if (bytes.length < 4) return null;
  const decoded = new TextDecoder("gbk").decode(Buffer.from(bytes));
  if (decoded.includes("\uFFFD") || decoded === value) return null;
  return decoded;
}

/** 占位词(空专辑的另一种写法)。 */
const JUNK_ALBUM_RE = /^(空|未知|未知专辑|未知歌手|无|none|null|unknown(\s*album)?|n\/a|-+|\?+)$/i;
/** 网址 / 广告 / 下载站水印。 */
const AD_ALBUM_RE = /(www\.|\.com|\.cc|\.net|微信|公众号|QQ\d{5,}|博客|歌库|下载|音源|加群|关注|嗨嗨网|音乐网|本站|网站)/i;

/**
 * 清洗专辑标签,返回「可以写进文件/库」的值:
 *   - 空 / 「空」/「未知专辑」等占位 → ""(交给调用方用歌名兜底)
 *   - 网址 / 广告文本 → ""
 *   - 不可还原的纯符号乱码(既无中日韩字也无字母数字) → ""
 *   - GBK 乱码 → 还原后的原文
 *   - 其余正常专辑名 → 原样返回(仅去首尾空白)
 */
export function cleanAlbumTag(value?: string): string {
  const raw = (value ?? "").trim();
  if (!raw) return "";
  const decoded = unMojibake(raw);
  const cand = decoded ?? raw;
  if (JUNK_ALBUM_RE.test(cand)) return "";
  if (AD_ALBUM_RE.test(cand)) return "";
  if (!/[A-Za-z0-9\u4e00-\u9fff]/.test(cand)) return "";
  return cand;
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

  // 文件名去掉扩展名与下载器附加的 ` - Unknown Artist` 尾巴
  const base = fileName
    .replace(/\.[^.]+$/, "")
    .replace(/\s*-\s*(unknown(\s*(artist|album))?|未知(歌手|专辑)?)\s*$/i, "")
    .trim();
  const sep = base.lastIndexOf(" - ");

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
    if (isUnknownArtist(ar)) ar = sep > 0 ? base.slice(sep + 3).trim() : "";
    if (isUnknownArtist(ar)) ar = fallbackArtist;
    if (ar && !isUnknownArtist(ar)) {
      meta.artist = ar;
      if (isUnknownArtist(meta.albumArtist)) meta.albumArtist = ar;
      changed = true;
    }
  }
  // 标签 title 就是整条 `歌名 - 歌手` 时收敛成歌名(仅在完全相等时动,避免误伤真标题)
  if (sep > 0 && meta.title && meta.title.trim() === base) {
    meta.title = base.slice(0, sep).trim();
    changed = true;
  }
  return changed;
}
