// ==================== WebDAV 标签修复（纯内存：下载 → 改标签 → 回传） ====================
//
// 与本地修复（tagRepair.repairSongTags）的区别只在「文件怎么进、怎么出」：
//   本地：music-metadata 读文件头 + ffmpeg 写临时文件后 rename；
//   云盘：整文件读进内存 Buffer → 用 memTags 直接重组 metadata → PUT 临时名 → MOVE 覆盖。
// 全程不落盘（临时文件也不需要），一次只持有一首歌的 Buffer。
//
// 判据与本地严格同源（避免两条路漂移）：
//   - 只修**缺**的：内嵌没有封面/歌词/专辑/歌名/歌手才补，已有值一律不动；
//   - 专辑优先用 DB 声明值（下载时 provider 写的），DB 也为空才走多平台一致判定；
//   - 歌词必须过 lrcBelongsToSong（归属 + 内容量≥5 行），不合格宁可不写。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sqlite } from "../../db/index.js";
import { getDataDir } from "../../utils/env.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("wdav-repair");
import { applyTagsVariant, type SongTags } from "./tagWriter.js";
import { containerOfName, readTags, writeTags, type Container, type MemTags } from "./memTags.js";
import { lrcBelongsToSong } from "../lyricsMatch.js";
import { albumIsPlaceholder, coverAllowed, isPlaceholderAlbum, needLyricByFile, writableAlbum } from "./tagTrust.js";
import {
  searchCover,
  searchLyrics,
  searchMetadata,
} from "../../plugins/providers.js";
import {
  wdavCtxOfSource,
  wdavDelete,
  wdavGetRange,
  wdavGetWhole,
  wdavProbeTags,
  wdavPathParts,
  wdavReplaceFile,
  wdavPut,
  wdavSize,
  wdavTmpNameFor,
} from "./wdavIO.js";
import type { FetchConfig } from "./config.js";

export interface WdavRepairRow {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  duration: number | null;
  path: string;
  has_lyrics: number | null;
  album_id: string | null;
  source_data: string | null;
  url: string | null;
}

export interface WdavRepairOutcome {
  /** error = 写盘/上传失败（**不可当 skip**：游标不能前进，否则这首歌永久漏掉） */
  outcome: "fixed" | "unobtainable" | "skip" | "error";
  cover: boolean;
  lyric: boolean;
  album: boolean;
  meta: boolean;
  /** 供进度面板显示的说明（失败原因 / 跳过原因） */
  note?: string;
}

const none = (note?: string): WdavRepairOutcome => ({
  outcome: "skip",
  cover: false,
  lyric: false,
  album: false,
  meta: false,
  note,
});

/** DB 专辑值归一（占位/空 → 空串）。 */
function dbAlbumOf(raw: string | null | undefined): string {
  const v = String(raw ?? "").trim();
  return isPlaceholderAlbum(v) ? "" : v;
}

/** 下载封面图（插件会给 URL），上限 8MB，失败返回 null。 */
async function fetchImageBytes(url: string): Promise<{ data: Buffer; mime: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    const len = Number(res.headers.get("content-length") || 0);
    if (len > 8 * 1024 * 1024) return null;
    const data = Buffer.from(await res.arrayBuffer());
    if (!data.length || data.length > 8 * 1024 * 1024) return null;
    const mime = res.headers.get("content-type")?.split(";")[0]?.trim() || "image/jpeg";
    return { data, mime: mime.startsWith("image/") ? mime : "image/jpeg" };
  } catch {
    return null;
  }
}

/** 把封面落到 data/covers（与本地修复同款命名），返回文件引用。 */
function saveAlbumCover(albumId: string, cover: { data: Buffer; mime: string }): string | null {
  try {
    const ext = cover.mime === "image/png" ? "png" : cover.mime === "image/gif" ? "gif" : "jpg";
    const dir = join(getDataDir(), "covers");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${albumId}.${ext}`), cover.data);
    return `${albumId}.${ext}`;
  } catch (e) {
    log.warn(`[wdav-repair] 封面落盘失败 album=${albumId}: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/**
 * 修复一首 WebDAV 歌曲。调用方保证该曲 path 以 `w:` 开头。
 * 全程内存；上传用「临时名 + MOVE 覆盖」保证原文件直到最后一步才变。
 */
export async function repairWebdavSongTags(
  row: WdavRepairRow,
  cfg: FetchConfig,
): Promise<WdavRepairOutcome> {
  const parts = wdavPathParts(row.path);
  if (!parts) return none("路径不是 WebDAV 形态");
  const container = containerOfName(parts.filePath);
  if (!container) return none(`容器不支持内嵌标签(${parts.filePath.slice(-6)})`);

  const ctx = wdavCtxOfSource(parts.sourceId);
  if (!ctx) return none("找不到音乐源配置");

  // 1) 先只读头部判断缺不缺（标签都在文件头：MP3=ID3v2，FLAC=metadata blocks）。
  //    标签齐全就**完全不下载整文件** —— 1000 首的目录能省下几十 GB 流量。
  let embedded: MemTags;
  try {
    embedded = readTags(await wdavProbeTags(ctx, parts.filePath, container), container);
  } catch (e) {
    return none(`读文件头失败: ${e instanceof Error ? e.message : e}`);
  }

  const dbAlbum = dbAlbumOf(row.album);
  // 专辑占位判定：DB 里的专辑等于歌名（scanner 对"无专辑"文件的兜底写法）⇒ 不可信。
  // 实测（2026-11-23）：三首被写进「专辑=歌名」的文件，全是这种占位值。
  const dbAlbumIsPlaceholder = albumIsPlaceholder(dbAlbum, row.title);
  let needCover = !embedded.cover;
  // 歌词只看文件本身：DB 的 has_lyrics 对云盘经常是脏的（实测 has_lyrics=1 但文件无词、
  // 同目录也没有 .lrc）——信它会让歌词永远补不上。
  let needLyric = needLyricByFile(embedded.lyric);
  let needAlbum = !embedded.album && Boolean(dbAlbum) && !dbAlbumIsPlaceholder;
  let needTitle = !embedded.title;
  let needArtist = !embedded.artist;
  let needMeta = needTitle || needArtist;

  // 2) 需要修才整文件进内存（修复必须重组整个容器），并**用全文再判一次**：
  //    头部窗口（MP3 tagLen / FLAC 1MB）之外如果还藏着大封面，这里会纠正误判。
  let buf: Buffer = Buffer.alloc(0);
  if (needCover || needLyric || needAlbum || needMeta) {
    try {
      buf = await wdavGetWhole(ctx, parts.filePath);
    } catch (e) {
      return none(`下载失败: ${e instanceof Error ? e.message : e}`);
    }
    try {
      embedded = readTags(buf, container);
    } catch (e) {
      return none(`解析标签失败: ${e instanceof Error ? e.message : e}`);
    }
    needCover = !embedded.cover;
    needLyric = !embedded.lyric && !row.has_lyrics;
    needAlbum = !embedded.album && Boolean(dbAlbum);
    needTitle = !embedded.title;
    needArtist = !embedded.artist;
    needMeta = needTitle || needArtist;
  }

  if (!needCover && !needLyric && !needAlbum && !needMeta) {
    // 文件其实齐了：只把 DB 的 has_lyrics / 专辑封面补齐（不重写文件）。
    if (!row.has_lyrics && embedded.lyric) {
      sqlite
        .prepare("UPDATE songs SET has_lyrics = 1, updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), row.id);
    }
    if (row.album_id && embedded.cover) {
      const cur = sqlite.prepare("SELECT cover_art FROM albums WHERE id = ?").get(row.album_id) as
        | { cover_art: string | null }
        | undefined;
      if (cur && !String(cur.cover_art ?? "").trim()) {
        const ref = saveAlbumCover(row.album_id, { data: embedded.cover.data, mime: embedded.cover.mime });
        if (ref) {
          sqlite
            .prepare("UPDATE albums SET cover_art = ?, updated_at = ? WHERE id = ?")
            .run(ref, new Date().toISOString(), row.album_id);
        }
      }
    }
    return none("标签已齐（只读了文件头，未下载整文件）");
  }

  let sd: { source?: string; provider?: string } = {};
  try {
    sd = row.source_data ? JSON.parse(row.source_data) : {};
  } catch {
    /* 旧数据无 source_data */
  }
  const songInput = {
    title: row.title,
    artist: row.artist,
    album: row.album,
    duration: row.duration,
    url: row.url,
    source: sd.source ?? sd.provider ?? null,
  };

  const tags: SongTags = {};
  let gotCover: { data: Buffer; mime: string } | null = null;

  // 先拿元数据：它是「这首歌到底是谁的」唯一严格判据（标题精确 + 歌手分词 + 时长闸门），
  // 也是封面可否采信的前置条件。没有强命中的元数据时，宁可不写封面 ——
  // 实测：何韵诗《好奇心杀死猫》被写进 SNOW THA PRODUCT 的封面、吴奇隆《思念就像一条河流》
  // 被写进《追风少年》的封面，都是「只按标题/歌手拿到了别的专辑的图」。
  let meta: { title?: string; artist?: string; album?: string } | null = null;
  if (needCover || needAlbum || needMeta) {
    try {
      const m = await searchMetadata(songInput as any);
      if (m) meta = { title: m.title, artist: m.artist, album: m.album };
    } catch (e) {
      log.warn(`[wdav-repair] 取元数据失败 song=${row.id}: ${e instanceof Error ? e.message : e}`);
    }
  }

  const metaAlbum = String(meta?.album ?? "").trim();

  let coverProvider: string | null = null;
  let builtinCover: boolean | undefined;
  if (needCover) {
    const coverDecision = coverAllowed({
      title: row.title,
      artist: row.artist,
      dbAlbum,
      metaAlbum,
      metaArtist: meta?.artist,
      coverProvider,
      builtinCover,
    });
    if (!coverDecision.allowed) {
      log.warn(
        `[wdav-repair] 封面跳过(${coverDecision.reason}) song=${row.id} title=${row.title} ` +
          `meta=${meta ? `${meta.title}/${meta.artist}/${meta.album}` : "null"}`,
      );
    } else {
      try {
        const coverUrl = await searchCover(songInput as any, {
          onMatch: (pid: string, builtin: boolean) => {
            coverProvider = pid;
            builtinCover = builtin;
          },
        });
        if (coverUrl) gotCover = await fetchImageBytes(coverUrl);
        if (gotCover) tags.cover = gotCover.data;
      } catch (e) {
        log.warn(`[wdav-repair] 取封面失败 song=${row.id}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  if (needLyric) {
    try {
      const lrc = await searchLyrics(songInput as any);
      if (
        lrc &&
        lrcBelongsToSong(
          lrc,
          { title: row.title, artist: row.artist, album: row.album, duration: row.duration },
          { strictArtist: true },
        )
      ) {
        tags.lyric = lrc;
      } else if (lrc) {
        log.warn(`[wdav-repair] 歌词与曲目不符，不写入 song=${row.id} title=${row.title}`);
      }
    } catch (e) {
      log.warn(`[wdav-repair] 取歌词失败 song=${row.id}: ${e instanceof Error ? e.message : e}`);
    }
  }

  // 专辑：DB 值可信就用 DB 值，否则用元数据的专辑；**「专辑=歌名」一律不写**（占位值）。
  if (needAlbum) {
    const target = writableAlbum({ dbAlbum, metaAlbum, title: row.title });
    if (target) tags.album = target;
  }
  if (needTitle && meta?.title) tags.title = meta.title;
  if (needArtist && meta?.artist) tags.artist = meta.artist;

  applyTagsVariant(tags, cfg.chineseVariant);

  const patch: MemTags = {
    title: tags.title,
    artist: tags.artist,
    album: tags.album,
    lyric: tags.lyric,
    cover: gotCover ? { data: gotCover.data, mime: gotCover.mime } : undefined,
  };
  const anything =
    patch.title !== undefined ||
    patch.artist !== undefined ||
    patch.album !== undefined ||
    patch.lyric !== undefined ||
    patch.cover !== undefined;
  if (!anything) {
    return { outcome: "unobtainable", cover: false, lyric: false, album: false, meta: false, note: "各来源均未取到" };
  }

  // 5) 内存改标签
  let out: Buffer;
  try {
    out = writeTags(buf, container as Container, patch);
  } catch (e) {
    return none(`写标签失败: ${e instanceof Error ? e.message : e}`);
  }
  buf = Buffer.alloc(0); // 尽早释放原 Buffer

  // 6) 上传：临时名 → 校验 → MOVE 覆盖
  const tmpPath = wdavTmpNameFor(parts.filePath, row.id);
  try {
    await wdavPut(ctx, tmpPath, out);
  } catch (e) {
    await wdavDelete(ctx, tmpPath);
    return { ...none(`上传失败: ${e instanceof Error ? e.message : e}`), outcome: "error" };
  }

  // 校验上传内容（PUT 到临时名后读回头部解析，确认标签真的在）
  try {
    const remoteSize = await wdavSize(ctx, tmpPath);
    if (remoteSize !== null && remoteSize !== out.length) {
      await wdavDelete(ctx, tmpPath);
      return { ...none(`上传字节数不符(远端 ${remoteSize} / 本地 ${out.length})`), outcome: "error" };
    }
    const head = await wdavGetRange(ctx, tmpPath, Math.min(out.length - 1, 256 * 1024));
    const check = readTags(head, container);
    const wantLyric = patch.lyric !== undefined && patch.lyric !== "";
    const wantCover = patch.cover !== undefined;
    const wantAlbum = patch.album !== undefined;
    if ((wantLyric && !check.lyric) || (wantCover && !check.cover) || (wantAlbum && !check.album)) {
      await wdavDelete(ctx, tmpPath);
      return { ...none("上传后回读校验未通过（标签没写进去）"), outcome: "error" };
    }
  } catch (e) {
    await wdavDelete(ctx, tmpPath);
    return { ...none(`上传校验失败: ${e instanceof Error ? e.message : e}`), outcome: "error" };
  }

  try {
    // 该网关 MOVE 到已存在的目标会 500 ⇒ 交给 wdavReplaceFile 处理（删后改名 + PUT 兜底）
    await wdavReplaceFile(ctx, tmpPath, parts.filePath, out);
  } catch (e) {
    await wdavDelete(ctx, tmpPath);
    return { ...none(`替换失败: ${e instanceof Error ? e.message : e}`), outcome: "error" };
  }

  // 7) 回写 DB（只补空白维度，不覆盖既有值）
  try {
    const now = new Date().toISOString();
    if (patch.lyric) {
      sqlite.prepare("UPDATE songs SET has_lyrics = 1, updated_at = ? WHERE id = ?").run(now, row.id);
    }
    if (patch.album && row.album_id && !String(row.album ?? "").trim()) {
      sqlite
        .prepare("UPDATE songs SET album = ?, updated_at = ? WHERE id = ?")
        .run(String(patch.album), now, row.id);
    }
    if (gotCover && row.album_id) {
      const ref = saveAlbumCover(row.album_id, gotCover);
      if (ref) {
        const cur = sqlite.prepare("SELECT cover_art FROM albums WHERE id = ?").get(row.album_id) as
          | { cover_art: string | null }
          | undefined;
        if (cur && !String(cur.cover_art ?? "").trim()) {
          sqlite
            .prepare("UPDATE albums SET cover_art = ?, updated_at = ? WHERE id = ?")
            .run(ref, now, row.album_id);
        }
      }
    }
    if (patch.title || patch.artist) {
      sqlite
        .prepare(
          "UPDATE songs SET title = COALESCE(NULLIF(title, ''), ?), artist = COALESCE(NULLIF(artist, ''), ?), updated_at = ? WHERE id = ?",
        )
        .run(patch.title ?? "", patch.artist ?? "", now, row.id);
    }
  } catch (e) {
    log.warn(`[wdav-repair] DB 回写失败 song=${row.id}: ${e instanceof Error ? e.message : e}`);
  }

  log.info(
    `[wdav-repair] 已修复 song=${row.id} ${row.title} | cover=${Boolean(patch.cover)} lyric=${Boolean(patch.lyric)} album=${Boolean(patch.album)} meta=${Boolean(patch.title || patch.artist)}`,
  );
  return {
    outcome: "fixed",
    cover: Boolean(patch.cover),
    lyric: Boolean(patch.lyric),
    album: Boolean(patch.album),
    meta: Boolean(patch.title || patch.artist),
  };
}
