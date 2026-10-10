// ==================== 内嵌标签写入（MusicFetch M1） ====================
//
// 为什么必须走 ffmpeg：`music-metadata` 11.14.0 是**只读**解析库，没有任何写 API，
// 而 M0 Spike 已实测 ffmpeg `-c copy -metadata …` 能写 mp3/flac 全字段（含中文、
// track no/of、内嵌封面）。故本模块 = ffmpeg 参数拼装 + 进程封装，零新增依赖。
//
// 两条硬约束（M0 实测，违反会出线上问题）：
//   1. **绝不原地覆盖**：ffmpeg 不能边读边写同一个文件（会把源文件截断成 0 字节）。
//      本模块一律写 `<target>.tagtmp`，成功后再 `renameSync` 回目标路径；失败删临时
//      文件、原文件字节与 mtime 保持不动。
//   2. **mp3 必须 `-id3v2_version 3`**：缺省写 ID3v2.4，部分车机 / DLNA 读不出来。
//      flac 不能加这个参数（它是 Vorbis Comment，不是 ID3）。
//
// 实测回读能力（230，music-metadata 11.14.0 读回，见本轮实测记录）：
//   - mp3：title/artist/album/albumartist/track(no,of)/disc(no,of)/genre/year/封面 可回读；
//          **comment 与 lyrics 回读不到**（ID3v2.3 下 ffmpeg 写入但 music-metadata 未映射）
//          ⇒ 仍然写入（文件里有），但只进 warnings，不作为成功依据。
//   - flac：以上全部可回读，**外加 lyrics**（`-metadata lyrics=` → common.lyrics）。
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { createLogger } from "../../utils/logger.js";
import { resolveFfmpeg } from "../transcode.js";
import { normalizeContainer } from "./probe.js";
import type { FetchErrorCode } from "./types.js";

const log = createLogger("FETCH_TAG");

/** 待写入的标签。全部可选：缺省字段不覆盖文件里已有的值。 */
export interface SongTags {
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  /** 轨号 */
  track?: number;
  /** 总轨数（与 track 一起写成 `n/total`） */
  trackTotal?: number;
  /** 碟号 */
  disc?: number;
  /** 总碟数 */
  discTotal?: number;
  year?: number | string;
  genre?: string;
  comment?: string;
  /** 纯文本歌词（flac 可回读；mp3 只写不保证可读，进 warnings） */
  lyric?: string;
  /** 封面：内存 Buffer 或本地图片路径（jpg/png） */
  cover?: Buffer | string;
}

/** 写入结果。warnings 非空表示「写成功了但有些诉求没满足」，不算失败。 */
export interface WriteTagsResult {
  ok: true;
  /** 最终文件路径（原地写回时为 srcPath） */
  file: string;
  bytes: number;
  mtimeMs: number;
  /** 不满足的诉求（如 mp3 歌词不可回读、容器不支持内嵌标签） */
  warnings: string[];
}

/** 标签写入失败（ffmpeg 非 0 退出 / 超时 / 产物为空）。原文件保证未被破坏。 */
export class FetchTagError extends Error {
  readonly code: FetchErrorCode;
  readonly file: string;

  constructor(code: FetchErrorCode, message: string, file: string) {
    super(message);
    this.name = "FetchTagError";
    this.code = code;
    this.file = file;
  }
}

/** 支持内嵌标签的容器；其余容器走 warnings 跳过（不报错）。 */
export const TAGGABLE_CONTAINERS = new Set(["mp3", "flac", "m4a", "mp4", "ogg", "opus"]);

/** 由路径推断归一化容器名（未识别 → undefined）。 */
export function containerOf(file: string): string | undefined {
  return normalizeContainer(file);
}

/**
 * 临时文件路径：标记插在扩展名**之前**（`a.mp3` → `a.tagtmp.mp3`）。
 *
 * 为什么不能直接 `${target}.tagtmp`：ffmpeg 按扩展名推断封装格式，`.tagtmp`
 * 它不认识 → `Unable to choose an output format`（exit 234）。保留扩展名最省事，
 * 也省掉一张 container → -f 格式名的映射表。
 */
export function tmpPathFor(target: string, marker: string): string {
  const b = basename(target);
  const ext = extname(b);
  const stem = ext ? b.slice(0, b.length - ext.length) : b;
  return join(dirname(target), `${stem}.${marker}${ext}`);
}

/** 默认值：单次 ffmpeg 标签写入的超时（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 60_000;

/** 拼装 ffmpeg 标签写入参数（纯函数，便于单测锁定命令形态）。 */
export function buildTagArgs(opts: {
  src: string;
  out: string;
  container?: string;
  tags: SongTags;
  coverPath?: string;
}): string[] {
  const args: string[] = [
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", opts.src,
  ];
  if (opts.coverPath) args.push("-i", opts.coverPath);
  // 只取源文件的音频流（源里若已有封面，不重复带过去，避免双封面）。
  args.push("-map", "0:a");
  if (opts.coverPath) args.push("-map", "1:v");
  args.push("-c", "copy");
  // mp3 专属：写 ID3v2.3（车机/DLNA 兼容）。flac 是 Vorbis Comment，不加。
  if (opts.container === "mp3") args.push("-id3v2_version", "3");

  const t = opts.tags;
  const put = (key: string, val: string | undefined): void => {
    if (val === undefined || val === null || val === "") return;
    args.push("-metadata", `${key}=${String(val)}`);
  };
  put("title", t.title);
  put("artist", t.artist);
  put("album", t.album);
  put("album_artist", t.albumArtist);
  if (t.track !== undefined && t.track > 0) {
    put("track", t.trackTotal && t.trackTotal > 0 ? `${t.track}/${t.trackTotal}` : String(t.track));
  }
  if (t.disc !== undefined && t.disc > 0) {
    put("disc", t.discTotal && t.discTotal > 0 ? `${t.disc}/${t.discTotal}` : String(t.disc));
  }
  // ffmpeg 认 `date`（ID3v2.3 下自动落成 TYER/TDAT，music-metadata 回读为 common.year）。
  put("date", t.year === undefined || t.year === null ? undefined : String(t.year));
  put("genre", t.genre);
  put("comment", t.comment);
  put("lyrics", t.lyric);

  if (opts.coverPath) args.push("-disposition:v:0", "attached_pic");
  args.push(opts.out);
  return args;
}

interface RunResult {
  code: number | null;
  stderr: string;
  timedOut: boolean;
}

/** 拉起 ffmpeg 并等待结束；超时即 kill，绝不无限等待。 */
function runFfmpeg(args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    let settled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(resolveFfmpeg(), args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (e) {
      reject(new FetchTagError("TAG_FAILED", `无法启动 ffmpeg: ${String(e)}`, ""));
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
      resolve({ code: null, stderr, timedOut: true });
    }, timeoutMs);
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024);
    });
    child.on("error", (e: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new FetchTagError("TAG_FAILED", `ffmpeg 启动失败: ${e.message}`, ""));
    });
    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stderr, timedOut: false });
    });
  });
}

/** 封面 Buffer 落临时文件（ffmpeg 只能从文件路径读封面）；返回路径或 undefined。 */
function materializeCover(cover: Buffer | string | undefined, tag: string): string | undefined {
  if (!cover) return undefined;
  if (typeof cover === "string") return existsSync(cover) ? cover : undefined;
  if (!cover.length) return undefined;
  const dir = mkdtempSync(join(tmpdir(), "mf-tag-"));
  const isPng = cover.length > 8 && cover[0] === 0x89 && cover[1] === 0x50 && cover[2] === 0x4e && cover[3] === 0x47;
  const file = join(dir, `cover.${isPng ? "png" : "jpg"}`);
  writeFileSync(file, cover);
  return file;
}

/**
 * 把标签写回 `srcPath`（原地），或写到 `opts.dstPath`。
 *
 * 安全性：ffmpeg 输出到 `<target>.tagtmp`，成功后 `renameSync`。任何失败都会删除
 * 临时文件并保持原文件不变（字节数、mtime 均不动），调用方可安全重试。
 *
 * @throws FetchTagError  TAG_FAILED（ffmpeg 失败 / 产物为空）| TIMEOUT（超时）
 */
export async function writeTags(
  srcPath: string,
  tags: SongTags,
  opts: { dstPath?: string; timeoutMs?: number } = {},
): Promise<WriteTagsResult> {
  const target = opts.dstPath || srcPath;
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const warnings: string[] = [];

  if (!existsSync(srcPath)) {
    throw new FetchTagError("TAG_FAILED", `源文件不存在: ${srcPath}`, srcPath);
  }

  const container = containerOf(target) || containerOf(srcPath);
  // 不支持内嵌标签的容器（如 wav/aiff）：不跑 ffmpeg，按「跳过」处理并留 warnings。
  if (!container || !TAGGABLE_CONTAINERS.has(container)) {
    warnings.push(`容器 ${container || "未知"} 不支持内嵌标签，已跳过标签写入`);
    log.info("容器不支持内嵌标签，跳过", { srcPath, container });
    if (opts.dstPath && opts.dstPath !== srcPath) copyFileSync(srcPath, opts.dstPath);
    const st = statSync(target);
    return { ok: true, file: target, bytes: st.size, mtimeMs: st.mtimeMs, warnings };
  }

  // mp3 的歌词：照写（文件里有 USLT），但 music-metadata 读不回来 ⇒ 明确告知调用方。
  if (container === "mp3" && tags.lyric) {
    warnings.push("MP3 不保证内嵌歌词可被解析回读，歌词建议另存 .lrc 侧车文件");
  }
  if (container !== "flac" && container !== "mp3" && tags.lyric) {
    warnings.push(`容器 ${container} 的歌词回读未做实测验证，仅尽力写入`);
  }

  const coverPath = materializeCover(tags.cover, container);
  const tmp = tmpPathFor(target, "tagtmp");
  let coverDir: string | undefined;
  if (coverPath && coverPath.includes("mf-tag-")) coverDir = join(coverPath, "..");

  try {
    const args = buildTagArgs({ src: srcPath, out: tmp, container, tags, coverPath });
    log.info("写标签", { srcPath, target, container, hasCover: !!coverPath });
    const r = await runFfmpeg(args, timeoutMs);
    if (r.timedOut) {
      throw new FetchTagError("TIMEOUT", `ffmpeg 写标签超时(${timeoutMs}ms): ${srcPath}`, srcPath);
    }
    if (r.code !== 0 || !existsSync(tmp) || statSync(tmp).size === 0) {
      throw new FetchTagError(
        "TAG_FAILED",
        `ffmpeg 写标签失败(exit=${r.code}): ${srcPath} ${r.stderr.slice(0, 300)}`,
        srcPath,
      );
    }
    renameSync(tmp, target);
    const st = statSync(target);
    return { ok: true, file: target, bytes: st.size, mtimeMs: st.mtimeMs, warnings };
  } finally {
    if (existsSync(tmp)) {
      try { rmSync(tmp, { force: true }); } catch { /* 清理失败不影响主流程 */ }
    }
    if (coverDir) {
      try { rmSync(coverDir, { recursive: true, force: true }); } catch { /* 同上 */ }
    }
  }
}

/** 设计稿 §3.4 的三参形态：srcFile → dstFile（另存，不改动源文件）。 */
export async function writeTagsTo(
  srcFile: string,
  dstFile: string,
  tags: SongTags,
  opts: { timeoutMs?: number } = {},
): Promise<WriteTagsResult> {
  return writeTags(srcFile, tags, { dstPath: dstFile, timeoutMs: opts.timeoutMs });
}
