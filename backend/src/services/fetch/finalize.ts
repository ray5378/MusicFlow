// ==================== MusicFetch：命名 → 冲突 → 原子落盘 ====================
//
// 下载 / 校验 / 写标签 / 转码**全程在 cacheRoot 完成**，本模块把成品从缓存「原子」搬到
// `/MUSIC/DOWNLOAD` 的最终位置：`rename()` 同卷原子；跨卷（EXDEV）降级为 copy+unlink 并记警告。
// 落盘成功后显式 `chmod 0644` —— 容器内以 root 建出的文件默认 `user::rw- other::---`，
// 显式放开让 SMB / DLNA / 别的 NAS 应用可读。
//
// 命名与冲突处理复用 `naming.ts`（`buildRelativePath` / `resolveConflict`），不另起一套。
//
// 硬约束：**禁止原地覆盖** —— 若最终路径恰好等于传入的 cachePath（调用方把成品目录当缓存
// 目录用了），直接抛错，避免把「缓存里的半成品」当成品又搬回自己头上。
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import * as path from "node:path";
import {
  buildRelativePath,
  resolveConflict,
  type ConflictPolicy,
  type NamingCtx,
} from "./naming.js";
import type { CandidateQuality } from "./types.js";
import type { FetchConfig } from "./config.js";

export interface FinalizeTarget {
  title: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  artists?: string[];
  year?: number;
  track?: number;
  disc?: number;
}

export interface FinalizeOptions {
  /** 缓存中的成品文件（写完标签 / 转码后） */
  cachePath: string;
  target: FinalizeTarget;
  /** 真实探针结果，决定扩展名 */
  probed?: CandidateQuality;
  /** 探针拿不到时的兜底容器名 */
  containerHint?: string;
  config: FetchConfig;
  /** keepBetter 策略用：新文件是否比已存在的更好 */
  newIsBetter?: boolean;
  /** 来源平台 slug，供命名模板 {source} */
  source?: string;
  /**
   * 覆盖落盘目录（洗版「原地替换」用）：给出时成品落到该目录下、文件名仍取命名模板的
   * 文件名部分，忽略 config.downloadRoot。缺省行为完全不变。
   */
  destDirOverride?: string;
  /**
   * 覆盖落盘**根**（下载品质分流用，2026-10-11）：与 destDirOverride 不同 —— 本项
   * **保留命名模板的相对目录结构**（`{albumArtist}/{album}/...` 照旧展开），只是把根从
   * downloadRoot 换成该值。用于「源本身已达标无损 → 直接落 losslessRoot」。
   * 与 destDirOverride 同时给出时 destDirOverride 优先（原地替换语义更强）。
   */
  destRootOverride?: string;
}

export interface FinalizeResult {
  action: "write" | "skip" | "keep";
  finalPath?: string;
  relativePath?: string;
  reusedExisting?: boolean;
  warnings: string[];
}

/** 从缓存路径推断扩展名；去掉 `.part` / `.tmp` / `.download` 这类中间后缀。 */
function inferExtFromPath(p: string): string {
  let ext = path.extname(p || "").toLowerCase();
  if (ext === ".part" || ext === ".tmp" || ext === ".download" || ext === ".trtmp" || ext === ".tag") {
    ext = path.extname(p.slice(0, p.length - ext.length)).toLowerCase();
  }
  return ext.replace(/^\./, "");
}

function normalizeExt(ext: string | undefined): string {
  return String(ext ?? "").replace(/^\./, "").toLowerCase();
}

/** 用 finalName 替换 fullPath 的文件名部分。 */
function withBasename(fullPath: string, finalName: string): string {
  return path.join(path.dirname(fullPath), finalName);
}

/**
 * 计算命名 → 处理冲突 → 原子落盘。
 * 流程见文件头与设计稿 §3.6。
 */
export function finalizeFile(opts: FinalizeOptions): FinalizeResult {
  const warnings: string[] = [];
  const cfg = opts.config;

  // 1) 扩展名：探针 → 兜底容器 → 缓存路径后缀。
  const ext =
    normalizeExt(opts.probed?.container) ||
    normalizeExt(opts.containerHint) ||
    inferExtFromPath(opts.cachePath);
  if (!ext) {
    throw new Error(`无法确定音频扩展名（probed/containerHint/cachePath 均无有效后缀）: ${opts.cachePath}`);
  }

  // 2) 命名上下文 + 相对路径。
  const t = opts.target;
  const ctx: NamingCtx = {
    title: t.title,
    artist: t.artist,
    artists: t.artists,
    albumArtist: t.albumArtist,
    album: t.album,
    year: t.year,
    track: t.track,
    disc: t.disc,
    source: opts.source,
    bitDepth: opts.probed?.bitDepth,
    sampleRateHz: opts.probed?.sampleRateHz,
    bitrateKbps: opts.probed?.bitrateKbps,
  };
  const relativePath = buildRelativePath(ctx, cfg.naming, ext);
  // 落盘根三选一：destDirOverride（原地替换：只取命名模板文件名段，落回原目录）
  //             > destRootOverride（品质分流：保留完整相对目录结构）
  //             > config.downloadRoot（缺省，行为逐字节不变）。
  const destRoot = opts.destDirOverride ?? opts.destRootOverride ?? cfg.downloadRoot;
  let finalPath = opts.destDirOverride
    ? path.join(opts.destDirOverride, path.basename(relativePath))
    : path.join(destRoot, relativePath);

  // 禁止原地覆盖：缓存路径不能就在成品目录里（否则会把半成品搬回自己头上）。
  if (path.resolve(finalPath) === path.resolve(opts.cachePath)) {
    throw new Error(`禁止原地覆盖：最终路径与缓存路径相同 ${finalPath}`);
  }

  // 3) 冲突处理。
  const exists = existsSync(finalPath);
  const policy: ConflictPolicy = cfg.overwriteExisting ? "overwrite" : cfg.fileConflictPolicy;
  // rename 策略需要知道同目录下已用的名字，避免反复撞到同一个 `(1)`。
  let usedNames: Set<string> | undefined;
  if (policy === "rename" && exists) {
    const dir = path.dirname(finalPath);
    try {
      usedNames = new Set(readdirSync(dir));
    } catch {
      usedNames = undefined;
    }
  }
  const rc = resolveConflict({
    exists,
    policy,
    newIsBetter: opts.newIsBetter,
    usedNames,
    name: path.basename(finalPath),
  });

  if (rc.action !== "write") {
    return {
      action: rc.action,
      finalPath,
      relativePath: path.relative(destRoot, finalPath),
      reusedExisting: true,
      warnings,
    };
  }
  if (rc.finalName && rc.finalName !== path.basename(finalPath)) {
    finalPath = withBasename(finalPath, rc.finalName);
  }

  // 4) 建目录 + 原子落盘。
  mkdirSync(path.dirname(finalPath), { recursive: true });
  try {
    renameSync(opts.cachePath, finalPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "EXDEV") {
      // 跨设备：先复制再删源。复制不是原子的，但成品目录里不会出现半成品（源在缓存）。
      copyFileSync(opts.cachePath, finalPath);
      try {
        unlinkSync(opts.cachePath);
      } catch {
        /* 源清理失败不影响成品 */
      }
      warnings.push("跨卷（EXDEV），原子 rename 已退化为复制");
    } else {
      throw e;
    }
  }

  // 5) 放开权限位：容器内 root 建出的文件默认 other::---，其它应用读不到。
  try {
    chmodSync(finalPath, 0o644);
  } catch (e) {
    warnings.push(`chmod 0644 失败: ${e instanceof Error ? e.message : String(e)}`);
  }

  return {
    action: "write",
    finalPath,
    relativePath: path.relative(destRoot, finalPath),
    warnings,
  };
}
