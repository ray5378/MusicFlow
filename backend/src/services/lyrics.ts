import { db, sqlite } from "../db/index.js";
import { songs, mediaSources } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { getPluginImpl, getPluginConfig } from "../plugins/registry.js";
import { hasLyricProvider, searchLyrics } from "../plugins/providers.js";
import { getSettingBool } from "./settings.js";
import { saveLyricFile, resolveLyricContent } from "./lyricsStore.js";
import { createLogger } from "../utils/logger.js";
import { applyVariant } from "../utils/chineseConv.js";
import { currentFetchConfig } from "./fetch/configStore.js";

const log = createLogger("lyrics");

export interface LrcLine {
  time: number; // seconds
  text: string;
}

// Parse standard LRC content into timed lines
// Handles metadata tags ([ti:...], [ar:...], [al:...], [by:...], [offset:...]) and
// multiple timestamps per line, e.g. [00:10.00][00:20.00]text
//
// 两种"一行里多个时间戳"必须区分对待 —— 这是 2026-09-26 修复歌词整体重复的核心:
//   ① 分组式(标准写法,真·多行): `[00:10.00][00:20.00]副歌`
//      时间戳挤在一起、彼此之间没有文字 ⇒ 这句歌词确实要在 10s、20s 各出现一次,展开成多条。
//   ② 交错式(逐字 / 卡拉OK 歌词): `[00:00.63]天[00:00.89]地[00:01.35]龙`
//      时间戳把文字切成一个个字 ⇒ 整行只是**一句歌词**,那些时间戳是字级进度信息。
//      旧实现无差别地对每个时间戳都推入"整行文本",一行 20 个字就吐出 20 条完全相同的
//      歌词 ⇒ 所有消费端(Web / HA 卡片 / 客户端)都看到成片重复。逐字行必须**折叠成一条**,
//      起点取该行首个时间戳。
export function parseLrc(content: string): LrcLine[] {
  const lines: LrcLine[] = [];
  // 同 (time, text) 只保留一条:逐字折叠后、以及源里 `[ts][ts]同词` 这类写法都不会再吐重复行。
  const seen = new Set<string>();
  const timeRegex = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  const metaRegex = /^\[(ti|ar|al|by|offset|length|re|ve|au|la):/i;
  // LRC `[offset:N]`(毫秒):正值让歌词提前 N ms(等价于所有时间戳减去 N)。
  // 旧实现只把它当元数据跳过,导致带 offset 的歌词整体偏移;这里统一在解析时应用。
  const offsetMatch = content.match(/\[offset:\s*([+-]?\d+)\s*\]/i);
  const offsetSec = offsetMatch ? Number(offsetMatch[1]) / 1000 : 0;
  // enhanced LRC 的行内逐字标签 `<mm:ss.xx>`:不是行级时间戳,只作进度信息,渲染前剥掉,
  // 否则端上会直接显示 "<00:10.50>" 这种原始标签。
  const wordTagRegex = /<\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?>/g;
  const toSeconds = (m: RegExpMatchArray): number => {
    const min = parseInt(m[1]);
    const sec = parseInt(m[2]);
    const frac = m[3] ? parseInt(m[3].padEnd(3, "0")) / 1000 : 0;
    return Math.max(0, min * 60 + sec + frac - offsetSec);
  };
  const push = (time: number, text: string) => {
    const key = `${time}\u0000${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    lines.push({ time, text });
  };
  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    const matches = [...trimmed.matchAll(timeRegex)];
    if (matches.length === 0) {
      // Metadata line without timestamps -> skip
      if (metaRegex.test(trimmed)) continue;
      continue;
    }
    // Text = line with all [mm:ss.xx] / <mm:ss.xx> timestamps removed
    const text = trimmed.replace(timeRegex, "").replace(wordTagRegex, "").trim();
    if (!text) continue;
    if (matches.length === 1) {
      push(toSeconds(matches[0]), text);
      continue;
    }
    // 判定分组式 vs 交错式:首个时间戳结束到最后一个时间戳开始之间有没有文字。
    const first = matches[0];
    const last = matches[matches.length - 1];
    const between = trimmed.slice((first.index ?? 0) + first[0].length, last.index ?? 0);
    if (between.trim() === "") {
      // 分组式:标准多时间戳写法,该文本在多处出现,逐条展开。
      for (const m of matches) push(toSeconds(m), text);
    } else {
      // 交错式(逐字歌词):整行折叠成一条,起点取该行首个时间戳。
      push(toSeconds(first), text);
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}

// Build OpenSubsonic structuredLyrics from LRC lines
// OpenSubsonic spec: Line.start is in MILLISECONDS (integer)
export function lrcToStructured(lines: LrcLine[], lang: string = "und") {
  return {
    lang,
    synced: true,
    line: lines.map(l => ({ start: Math.round(l.time * 1000), value: l.text })),
  };
}

interface SongRow {
  id: string;
  path: string;
  title: string;
  artist: string | null;
  album?: string | null;
  url?: string | null;
  type?: string | null;
  duration?: number | null;
  pluginEntry?: string | null;
  sourceData?: string | null;
}

const lrcCache = new Map<string, { content: string | null; at: number }>();
const CACHE_TTL = 10 * 60 * 1000; // 10 min

// Periodically evict expired entries so the in-memory cache doesn't grow
// unbounded (the TTL above is otherwise only enforced lazily on read).
const lrcCacheSweep = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of lrcCache) {
    if (now - v.at >= CACHE_TTL) lrcCache.delete(k);
  }
}, 5 * 60 * 1000);
// Don't keep the process alive just for cache sweeping.
(lrcCacheSweep as any).unref?.();

/** 清空歌词内存缓存(供空闲内存回收;下次请求自动重建)。 */
export function clearLyricsCache(): void {
  lrcCache.clear();
}

/** 歌词内存缓存条目数(观测)。 */
export function getLyricsCacheEntries(): number {
  return lrcCache.size;
}

/** 学习音频的 sidecar .lrc 大量是 GBK/GB18030(中文课程光盘拷贝),按 UTF-8 → GB18030 顺序探测解码。 */
function decodeLrcBytes(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString("utf8");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder("gb18030").decode(buf);
    } catch {
      return buf.toString("utf8");
    }
  }
}

// 读取 sidecar .lrc(本地文件 / WebDAV 同目录 URL / SMB 同目录文件)。离线优先、最准;
// web 歌曲 path 不是 w:/l:/s: 前缀,直接返回 null。
/**
 * 这份 LRC 到底是不是这首歌的？
 *
 * 为什么要它（2026-11-21 真机）：`狂信者 / 黄立行` 的歌词里存的是 `分开旅行`（同歌手
 * 另一首）的整篇 —— 历史误匹配落库后，「①落库缓存」永远优先，provider 再也不会被问到。
 * 更恶性的情况存在：provider 按 id 取回的 LRC 也可能是别的歌（服务端 id 串了），
 * 不校验就会把错词写进库里、永久错误。
 *
 * 判据只认**首部标题行**（大多数 LRC 有 `[00:00.00]艺人 - 歌名` 这种行）：
 *   - 找不到标题行（纯时间轴歌词）→ 放行（无从判断，宁放不误杀）；
 *   - 找到标题行但**任何一段**都对不上歌名 → 判为不属于这首歌；
 *   - 歌名对得上（含互含/繁简统一/去括号）→ 放行。
 * 另外补一条时长上界：末行时间戳比歌曲时长还长 30s 以上 → 显然不是同一首。
 */
export function lrcBelongsToSong(
  content: string,
  song: { title?: string | null; artist?: string | null; duration?: number | null },
): boolean {
  if (!content) return false;
  const norm = (v: unknown) =>
    applyVariant(String(v ?? "").toLowerCase(), "simplified")
      .replace(/[\s\p{P}\p{S}]+/gu, "")
      .replace(/[（(【\[].*?[)）】\]]/g, "");
  const wantTitle = norm(song.title);
  const head = content.split(/\r?\n/).slice(0, 8);
  let headerLine: string | null = null;
  for (const raw of head) {
    const t = raw.replace(/^\[[^\]]*\]/g, "").trim();
    if (!t) continue;
    if (/^(作词|作曲|编曲|词|曲|混音|制作|录音|和声|吉他|贝斯|鼓|母带|演唱|原唱|出品|监制)/.test(t)) continue;
    if (/\[\d{1,2}:\d{1,2}/.test(t)) continue; // 逐字行
    if (/[-–—]/.test(t)) { headerLine = t; break; }
  }
  if (headerLine && wantTitle) {
    const parts = headerLine.split(/[-–—]/).map(norm).filter((x) => x.length >= 2);
    const titleHit = parts.some((p) => p.includes(wantTitle) || wantTitle.includes(p));
    if (!titleHit) {
      // 标题对不上时,再看**歌手**是否出现在同一行:出现了就是「同歌手的另一首歌」的标题行
      // (狂信者 → 刘若英、黄立行 - 分开旅行),必须否决。
      // 歌手也对不上 ⇒ 这行本来就只是歌词正文(正文常带连字符,如 a-only),放行避免误杀。
      const wantArtist = norm(song.artist);
      const artistHit =
        wantArtist.length >= 2 &&
        parts.some((p) => p.includes(wantArtist) || wantArtist.includes(p));
      if (artistHit) return false;
    }
  }
  // 时长上界:末行时间戳远超歌曲时长 ⇒ 是另一首(更长的)歌。
  const d = Number(song.duration) || 0;
  if (d > 0) {
    const times = [...content.matchAll(/\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)]
      .map((m) => Number(m[1]) * 60 + Number(m[2]));
    const maxTs = times.length > 0 ? Math.max(...times) : 0;
    if (maxTs > d + 30) return false;
  }
  return true;
}

async function readSidecarLrc(song: SongRow): Promise<string | null> {
  try {
    const colon1 = song.path.indexOf(":");
    if (colon1 < 0) return null;
    const prefix = song.path.slice(0, colon1);
    if (prefix !== "w" && prefix !== "l" && prefix !== "s") return null;
    const rest = song.path.slice(colon1 + 1);
    const colon2 = rest.indexOf(":");
    if (colon2 < 0) return null;
    const sourceId = rest.slice(0, colon2);
    const filePath = rest.slice(colon2 + 1);
    const lrcPath = filePath.replace(/\.[^.]+$/, "") + ".lrc";

    const source = db.select().from(mediaSources).where(eq(mediaSources.id, sourceId)).get();
    if (!source) {
      // D21 修复:源不存在也补一条日志,避免「取不到 sidecar」时现场一片空白。
      log.warn(`readSidecarLrc: 媒体源不存在(id=${sourceId}),跳过 sidecar`);
      return null;
    }
    const config = JSON.parse(source.config || "{}");

    if (prefix === "w") {
      const rawBase = config.url?.replace(/\/+$/, "");
      if (!rawBase) {
        // D21 修复:WebDAV 源没配 url ⇒ 无法拼地址,补日志便于排障(此前静默返回 null)。
        log.warn(`readSidecarLrc: WebDAV 源缺少 url 配置(source=${sourceId}),跳过 sidecar`);
        return null;
      }
      // ⚠️ 2026-11-21 修:源配置的 url 常带子目录(如 http://host:5444/dav),而 song.path 里的
      //   filePath **也**从 /dav 开始(出流侧 getWebDAVUrl 用的是 origin + filePath)。旧实现
      //   `base + lrcPath` 拼成 http://host:5444/dav/dav/... ⇒ 恒 404,WebDAV 同目录 .lrc
      //   一次都读不到。这里与服务端其它地方对齐:filePath 已包含 base 的路径段 ⇒ 只用 origin。
      let base = rawBase;
      try {
        const u = new URL(rawBase);
        const basePath = u.pathname.replace(/\/+$/, "");
        if (basePath && basePath !== "/" && (lrcPath === basePath || lrcPath.startsWith(basePath + "/"))) {
          base = u.origin;
        }
      } catch { /* 非法 URL 就按原样拼接 */ }
      const url = base + (lrcPath.startsWith("/") ? "" : "/") + lrcPath;
      const headers: Record<string, string> = { Range: "bytes=0-65535" };
      if (config.username && config.password) {
        headers["Authorization"] = "Basic " + Buffer.from(`${config.username}:${config.password}`).toString("base64");
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const res = await fetch(url, { headers, signal: controller.signal });
        if (res.ok || res.status === 206) return await res.text();
        // D21 修复:非 2xx/206(如 404)→ 记一条 debug,方便区分「没配到源」与「源上没有文件」。
        log.debug(`readSidecarLrc: sidecar 抓取未命中(status=${res.status} url=${url})`);
      } finally { clearTimeout(timeout); }
    } else if (prefix === "l") {
      const fs = await import("fs");
      if (fs.existsSync(lrcPath)) return decodeLrcBytes(fs.readFileSync(lrcPath));
      // D21 修复:本地 l: 分支同目录没有 .lrc 也补一条 debug。
      log.debug(`readSidecarLrc: 本地 sidecar 文件不存在(${lrcPath})`);
    } else if (prefix === "s") {
      // SMB 侧车歌词:学习音频全在 SMB 学习源上,旧实现只认 w:/l:,sidecar 被跳过 →
      // 落到在线歌词按课程名乱匹配(中文课程匹配出韩文歌词)。按同目录同名 .lrc 直接读回。
      const { loadSmbConfig, smbStat, smbReadRange } = await import("./source/smbClient.js");
      const cfg = loadSmbConfig(sourceId);
      if (!cfg) { log.warn(`readSidecarLrc: SMB 源配置不可用(source=${sourceId}),跳过 sidecar`); return null; }
      let size = 0;
      try {
        size = (await smbStat(sourceId, cfg, lrcPath)).size;
      } catch {
        log.debug(`readSidecarLrc: SMB sidecar 不存在(${lrcPath})`);
        return null;
      }
      if (size <= 0) return null;
      const buf = await smbReadRange(sourceId, cfg, lrcPath, 0, Math.min(size, 512 * 1024) - 1);
      return decodeLrcBytes(buf);
    }
  } catch (e) { log.warn("readSidecarLrc: 读取 sidecar 歌词异常,按无 sidecar 处理", { err: e }); }
  return null;
}

// Fetch lyrics for a song, unified across ALL song types:
//   ① 已落库歌词(songs.lyrics 存文件引用或旧文本,离线可用)
//   ② sidecar .lrc(本地 / WebDAV)
//   ③ 在线按需(A 开关,默认开):lyricProvider 插件,命中且 B(persist) 开则落库为文件
//   ④ web 歌曲 legacy 源插件 lyricUrl
export async function fetchLrcForSong(song: SongRow): Promise<string | null> {
  // 中文字形（产品定调 2026-10-16）：**所有 provider 提供的文本**按用户所选字形输出，
  // 歌词是其中量最大的一类。转换点在**出口**（下面两处 return）—— 这样连「本功能上线前
  // 就已落库 / 内嵌的繁体歌词」也会按当前设置显示；同方向重复转换是幂等的，故生产侧
  // （③ 命中时）转换与出口转换不会互相干扰。
  const variant = currentFetchConfig().chineseVariant;
  const cached = lrcCache.get(song.id);
  if (cached && Date.now() - cached.at < CACHE_TTL) {
    return cached.content ? applyVariant(cached.content, variant) : cached.content;
  }

  let content: string | null = null;
  // 学习音频:只能用同目录 sidecar .lrc。旧版本没有 SMB sidecar 分支,已把在线
  // 歌词(按课程名误匹配到的韩文歌)落库成 39 条脏缓存;在线 provider 对课程
  // 音频也只会继续误匹配。故学习行跳过 ①落库缓存 与 ③在线检索。
  const isStudy = (song as any).kind === "study";

  // ① 已落库的歌词:优先读 online-lyrics/<ref>.lrc 文件(新格式),文件缺失时
  //    把列内旧文本当歌词(v1.7.4 兼容)。离线也能显示,不依赖 provider 常驻。
  if (!isStudy) {
    try {
      const row = sqlite.prepare("SELECT lyrics FROM songs WHERE id = ?").get(song.id) as any;
      if (row?.lyrics) {
        const cached = resolveLyricContent(row.lyrics);
        if (cached && lrcBelongsToSong(cached, song as any)) {
          content = cached;
        } else if (cached) {
          // 错词自愈:丢弃后继续走 ②③,命中正确歌词时由 persist 覆盖落库。
          log.warn(
            `[lyrics] 落库歌词与曲目不符,已忽略 song=${song.id} title=${song.title ?? "-"} ` +
              `artist=${song.artist ?? "-"}`,
          );
        }
      }
    } catch { /* ignore */ }
  }

  // ② sidecar .lrc(离线优先、最准)
  if (!content) {
    const side = await readSidecarLrc(song);
    if (side && lrcBelongsToSong(side, song as any)) content = side;
    else if (side) {
      log.warn(
        `[lyrics] sidecar 歌词与曲目不符,已忽略 song=${song.id} title=${song.title ?? "-"}`,
      );
    }
  }

  // ③ 在线按需(A 开关):sidecar/落库都没有时,问 lyricProvider 插件
  if (!content && !isStudy && getSettingBool("lyrics.onDemand", true) && hasLyricProvider()) {
    // 把 source/album/extra 一并传给 lyric provider:插件据此优先同平台回退
    // (go-music-dl 的搜索回退需要 source 判断"本平台优先",否则只能盲目多平台搜索)。
    let sourceData: any = null;
    try { sourceData = JSON.parse((song as any).sourceData || "{}"); } catch {}
    const fromProviders = await searchLyrics({
      url: song.url,
      duration: song.duration,
      title: song.title,
      artist: song.artist,
      album: song.album,
      source: sourceData?.source || undefined,
      extra: sourceData?.extra || null,
    });
    if (fromProviders && !lrcBelongsToSong(fromProviders, song as any)) {
      // provider 按 id 取回来的也可能是别的歌(服务端 id 串了)—— 不校验就会把错词写进库里。
      log.warn(
        `[lyrics] 在线歌词与曲目不符,已丢弃 song=${song.id} title=${song.title ?? "-"} ` +
          `artist=${song.artist ?? "-"}`,
      );
    } else if (fromProviders) {
      // 生产侧先转一次：B 落库会把这个字符串写成 online-lyrics/<id>.lrc 文件，
      // 让**落盘产物**也随设置字形（否则文件里是繁体、界面显示简体，两处不一致）。
      content = applyVariant(fromProviders, variant);
      // B 落库(默认关):命中即写 online-lyrics/<id>.lrc 文件 + songs.lyrics 存引用,
      // 拉一次永存、离线也能显示(与封面 online-covers 同构,可单独挂卷/清空)。
      if (getSettingBool("lyrics.persist", false)) {
        const ref = saveLyricFile(song.id, content);
        if (ref) {
          try { sqlite.prepare("UPDATE songs SET lyrics = ? WHERE id = ?").run(ref, song.id); } catch { /* ignore */ }
        }
      }
    }
  }

  // ④ web 歌曲 legacy 源插件 lyricUrl(仅当上面都没有):provider 特定 URL 逻辑
  //    (如 go-music-dl 的 /music/download_lrc)留在插件侧,核心不重复实现。
  //    D22 修复:整段插件交互(取实现 / 构造 URL / 抓取)包进 try/catch,插件抛错或抓取
  //    失败都当「无歌词」处理并记 warn,与 ①②③ 的兜底一致,异常不再冒给调用方(避免 500)。
  if (!content && song.type === "web" && song.pluginEntry) {
    try {
      const impl = getPluginImpl(song.pluginEntry);
      if (impl?.lyricUrl) {
        const cfg = getPluginConfig(song.pluginEntry) || {};
        const lrcUrl = impl.lyricUrl(cfg, {
          url: song.url,
          duration: song.duration,
          title: song.title,
          artist: song.artist,
        });
        if (lrcUrl) {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 8000);
          try {
            const res = await fetch(lrcUrl, { signal: controller.signal });
            if (res.ok) {
              const text = await res.text();
              if (text && !text.startsWith("Lyric not found")) content = text;
            }
          } catch (e: any) {
            log.debug(`fetchLrcForSong: ④ 抓取 legacy 歌词失败,按无歌词处理: ${e?.message || e}`);
            content = null;
          } finally {
            clearTimeout(timeout);
          }
        }
      }
    } catch (e) {
      log.warn("fetchLrcForSong: ④ 源插件 lyricUrl 失败,按无歌词处理", { err: e });
    }
  }

  lrcCache.set(song.id, { content, at: Date.now() });
  return content ? applyVariant(content, variant) : content;
}

// Get parsed lyrics for a song id (null if none)
export async function getLyricsForSongId(songId: string): Promise<LrcLine[] | null> {
  const song = db.select().from(songs).where(eq(songs.id, songId)).get();
  if (!song) return null;
  return getLyricsForSong(song);
}

// Get parsed lyrics for an arbitrary song row / virtual song shape (null if none).
// 供远程未入库歌曲(web 端 remote: 直放)复用同一条在线歌词管线:fetchLrcForSong 只需
// id/url/type/pluginEntry/sourceData 等字段,不要求行真的存在于 DB。
export async function getLyricsForSong(song: any): Promise<LrcLine[] | null> {
  const content = await fetchLrcForSong(song as SongRow);
  if (!content) return null;
  const lines = parseLrc(content);
  return lines.length > 0 ? lines : null;
}
