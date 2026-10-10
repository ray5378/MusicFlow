// ==================== MusicFetch 洗版（无损替换低码率）====================
//
// 语义：手动触发一次「洗版」任务，把下载区（/MUSIC/DOWNLOAD）里**码率不达标**的曲子
// 重新取链，只认无损、且要到「原生无损」档：
//   - 压缩无损（flac / alac / ape）：有效码率 **≥ 700 kbps**；
//   - 未压缩无损（wav / aiff）    ：有效码率 **≥ 1400 kbps**（≈ CD 级 1411 kbps）。
// 命中更好音质后落盘到 /MUSIC/LOSSLESS，并（按用户选择）处置原低码率文件。
//
// ⚠️ 原件处置（尤其 delete）**不可逆** —— 所以 `disposeOriginalFile` 里每一条安全闸
// 都是硬要求，任何一条不满足都必须退化为「不碰文件 + warning」，**绝不放宽**。
//
// 为什么门槛要做成「按容器分档」：`quality.ts:classifyTier` 按「有效码率 ≥ 该容器下限」
// 才认无损档（**flac 只是容器，不代表无损**，产品定调 2026-10-11）——所以「压缩 700 /
// 未压缩 1400」这个双档同时驱动**档位判定**与**假无损判定**（两处共用 `losslessMinEffBitrate`）
// —— 见 types.ts 的 `uncompressedContainers` / `uncompressedMinKbps` 与 `buildUpgradeQuality`。
// 洗版档 qualityFloor=lossless 因此天然把「有损转 flac」的假无损挡在门外；
// 另有「有效码率高于原件则原地替换」的抢救通道（orchestrator 的 inPlace）。
//
// 无 IO 的部分（门槛判定 / 计划派生）是纯函数，便于单测；有副作用的部分
// （迁移库行 / 处置文件）各自 try/catch，失败只返回 warning，**绝不抛**。
import { copyFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import * as path from "node:path";
import { eq, and, like } from "drizzle-orm";
import { db, sqlite } from "../../db/index.js";
import { songs, albums } from "../../db/schema.js";
import { extractMetadataLocal, upsertSong } from "../source/scanner.js";
import type { FetchTarget } from "./candidates.js";
import { DEFAULT_LOSSLESS_ROOT, type FetchConfig } from "./config.js";
import type { QualityConfig } from "./types.js";
import { effectiveBitrateKbps } from "./quality.js";

/** 压缩无损容器（码率下限 = fakeLosslessMinEffBitrate = 700）。 */
export const LOSSLESS_COMPRESSED_CONTAINERS: string[] = ["flac", "alac", "ape"];
/** 未压缩无损容器（码率下限 = uncompressedMinKbps = 1400）。 */
export const LOSSLESS_UNCOMPRESSED_CONTAINERS: string[] = ["wav", "aiff"];

/** 与 scanner 同口径的音频扩展名集合（scanner 里是模块私有的，这里独立一份）。 */
const AUDIO_EXTENSIONS = new Set([
  ".mp3", ".flac", ".wav", ".aac", ".ogg", ".m4a", ".wma", ".ape", ".aiff", ".opus",
]);

/** 洗版档的两条硬编码门槛（压缩 / 未压缩）。 */
const UPGRADE_COMPRESSED_MIN_KBPS = 700;
const UPGRADE_UNCOMPRESSED_MIN_KBPS = 1400;

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 库内一行（洗版用到的列）。 */
export interface UpgradeSongRow {
  id: string;
  path: string;
  title: string;
  artist: string;
  album: string;
  suffix: string;
  bitRate: number;
  durationSec: number;
  size: number;
}

/** 一条洗版计划项（只读快照，供 UI 展示 / 建 target）。 */
export interface UpgradePlanItem {
  songId: string;
  title: string;
  artist: string;
  album: string;
  suffix: string;
  bitrateKbps: number;
  durationSec: number;
  path: string;
  reason: string;
}

// ==================== 纯函数：档位与门槛 ====================

/**
 * 由基础质量配置派生「洗版档」：无损 + 双档码率。
 * 保留 base 的时长区间 / 关键词 / 采样率上下限等旋钮，只覆盖与「无损原生」相关的项。
 */
export function buildUpgradeQuality(base: QualityConfig): QualityConfig {
  return {
    ...base,
    qualityFloor: "lossless",
    minBitrateKbps: UPGRADE_COMPRESSED_MIN_KBPS, // 第 6 步 lossy 专用，这里仅兜底
    allowedContainers: [...LOSSLESS_COMPRESSED_CONTAINERS, ...LOSSLESS_UNCOMPRESSED_CONTAINERS],
    preferLossless: true,
    fakeLosslessDetect: "bitrate",
    fakeLosslessMinEffBitrate: UPGRADE_COMPRESSED_MIN_KBPS, // 压缩无损下限
    uncompressedContainers: [...LOSSLESS_UNCOMPRESSED_CONTAINERS],
    uncompressedMinKbps: UPGRADE_UNCOMPRESSED_MIN_KBPS, // 未压缩无损下限
  };
}

/**
 * 某个「容器 + 体量」是否**低于**洗版门槛（纯函数）。
 * 有损格式 / 码率未知 / 低于该容器对应下限 → below:true。
 *
 * 入参刻意做成**宽形状**：既服务库内行（suffix/bitRate/size/durationSec），也服务
 * **下载侧源探针**（container/bytes/durationSec）—— 下载按品质分流时直接复用这一套门槛，
 * 不另造判据（产品定调 2026-10-11）。码率一律走 `upgradeBaselineKbps`：`size/duration`
 * 现场换算优先，**平台不声明码率也能算出来**，`bit_rate` 列只作回落。
 */
export function isBelowUpgradeBar(
  row: {
    suffix?: string;
    bitRate?: number;
    size?: number;
    durationSec?: number;
  },
  upQ: QualityConfig,
): { below: boolean; reason: string } {
  const suffix = String(row.suffix ?? "").toLowerCase();
  const allLossless = [...LOSSLESS_COMPRESSED_CONTAINERS, ...LOSSLESS_UNCOMPRESSED_CONTAINERS];
  if (!allLossless.includes(suffix)) {
    return { below: true, reason: `有损格式 ${suffix || "(未知)"}` };
  }
  const br = upgradeBaselineKbps(row);
  if (!(br > 0)) {
    return { below: true, reason: "码率未知，视为低码率" };
  }
  const isUncompressed = LOSSLESS_UNCOMPRESSED_CONTAINERS.includes(suffix);
  const need = isUncompressed
    ? (upQ.uncompressedMinKbps ?? UPGRADE_UNCOMPRESSED_MIN_KBPS)
    : (upQ.fakeLosslessMinEffBitrate ?? UPGRADE_COMPRESSED_MIN_KBPS);
  if (br < need) {
    return { below: true, reason: `${Math.round(br)}kbps < ${need}kbps（${suffix}）` };
  }
  return { below: false, reason: `${Math.round(br)}kbps >= ${need}kbps（${suffix}）` };
}

/**
 * 取洗版基准码率（kbps）。
 *
 * 🔴 **size/duration 现场换算优先，`bit_rate` 列只作回落** —— 与 `quality.ts:pickBitrateKbps`
 * 同一条不变量（字节数才是真实体量）。原因：240 生产实测，扫描入库的 `bit_rate` 对
 * flac 基本是垃圾（49,358 首 flac 的库存值平均只有真实值的 1/202，随机样本
 * 853kbps→8、1726kbps→2；mp3 则是准的），直接信它会把曲库 94% 误判成「低于洗版门槛」。
 * `size` 与 `duration` 则 100% 可信（w: 行 size 全量有值）。
 */
export function upgradeBaselineKbps(row: {
  size?: number;
  durationSec?: number;
  bitRate?: number;
}): number {
  const eff = effectiveBitrateKbps(Number(row.size ?? 0), Number(row.durationSec ?? 0));
  if (eff > 0) return eff;
  const br = Number(row.bitRate ?? 0);
  return br > 0 ? br : 0;
}

// ==================== 查库与计划 ====================

/**
 * 查库：这些媒体源下的所有 local 行（`path like 'l:<sourceId>:%'`）。
 * sourceIds 为空 → 返回空数组（回落逻辑由调用方负责）。
 */
export function collectUpgradeSongs(sourceIds: string[]): UpgradeSongRow[] {
  const ids = Array.isArray(sourceIds) ? sourceIds.filter((s) => typeof s === "string" && s) : [];
  if (ids.length === 0) return [];
  const out: UpgradeSongRow[] = [];
  for (const sid of ids) {
    let rows: any[];
    try {
      rows = db
        .select({
          id: songs.id,
          path: songs.path,
          title: songs.title,
          artist: songs.artist,
          album: songs.album,
          suffix: songs.suffix,
          bitRate: songs.bitRate,
          duration: songs.duration,
          size: songs.size,
        })
        .from(songs)
        .where(and(eq(songs.type, "local"), like(songs.path, `l:${sid}:%`)))
        .all();
    } catch {
      continue; // 单个源查询失败不影响其它源
    }
    for (const r of rows) {
      out.push({
        id: String(r.id),
        path: String(r.path ?? ""),
        title: String(r.title ?? ""),
        artist: String(r.artist ?? ""),
        album: String(r.album ?? ""),
        suffix: String(r.suffix ?? ""),
        bitRate: Number(r.bitRate ?? 0),
        durationSec: Number(r.duration ?? 0),
        size: Number(r.size ?? 0),
      });
    }
  }
  return out;
}

/**
 * 出洗版计划（只读，不下载）。
 * - `songIds` 给了 → 只保留这些 id 的行；否则只保留 `isBelowUpgradeBar` 命中的行。
 * - `limit` 截断时 `truncated:true`；`total` = 范围内总数、`belowBar` = 未截断前低于门槛数、
 *   `cooled` = 因冷却期跳过的低于门槛数（cooldownDays 天内已尝试过洗版，无论成败）。
 */
export function buildUpgradePlan(
  sourceIds: string[],
  cfg: FetchConfig,
  opts?: { limit?: number; offset?: number; songIds?: string[] },
): { sourceIds: string[]; total: number; belowBar: number; cooled: number; truncated: boolean; items: UpgradePlanItem[] } {
  const rows = collectUpgradeSongs(sourceIds);
  const total = rows.length;
  const upQ = buildUpgradeQuality(cfg.quality);

  // 冷却过滤：N 天内尝试过（无论成败）的歌自动跳过；显式 songIds 视为用户点名重试，绕过冷却。
  const cooldownDays = Math.min(365, Math.max(1, Math.floor(cfg.upgradeCooldownDays > 0 ? cfg.upgradeCooldownDays : 30)));
  const attemptedAt = collectUpgradeAttemptedAt();
  const nowMs = Date.now();
  let cooled = 0;
  const belowAll = rows.filter((r) => {
    if (!isBelowUpgradeBar(r, upQ).below) return false;
    const at = attemptedAt.get(r.id);
    if (at) {
      const t = Date.parse(at);
      if (Number.isFinite(t) && nowMs - t < cooldownDays * 86_400_000) {
        cooled += 1;
        return false;
      }
    }
    return true;
  });
  const belowBar = belowAll.length;

  const sidList: string[] = opts && Array.isArray(opts.songIds) ? opts.songIds : [];
  const wanted = sidList.length > 0 ? new Set(sidList.map((v) => String(v))) : null;
  const pool = wanted ? rows.filter((r) => wanted.has(r.id)) : belowAll;

  const offRaw = opts?.offset;
  const offset = typeof offRaw === "number" && Number.isFinite(offRaw) && offRaw > 0 ? Math.floor(offRaw) : 0;
  const limRaw = opts?.limit;
  const limit = typeof limRaw === "number" && Number.isFinite(limRaw) && limRaw > 0
    ? Math.floor(limRaw)
    : (cfg.upgradeBatchLimit > 0 ? cfg.upgradeBatchLimit : 20);

  const sliced = pool.slice(offset, offset + limit);
  const truncated = offset + sliced.length < pool.length;

  const items: UpgradePlanItem[] = sliced.map((r) => ({
    songId: r.id,
    title: r.title,
    artist: r.artist,
    album: r.album,
    suffix: r.suffix,
    bitrateKbps: Math.round(upgradeBaselineKbps(r)),
    durationSec: r.durationSec,
    path: r.path,
    reason: isBelowUpgradeBar(r, upQ).reason,
  }));

  return { sourceIds, total, belowBar, cooled, truncated, items };
}

/**
 * 计划项 → FetchTarget。
 *
 * `sourceData` 里把洗版信息**包一层 `upgrade`**（而不是平铺 songId/path/...）：
 * `candidates.ts` 的 `readSourceData` 会从顶层抓 `remoteId ?? songId ?? id` 与
 * `source ?? platform ?? ...`，平铺会被误当成「分支 B 的平台歌曲 ID」而触发一次无意义取链。
 * 包一层后顶层无这些键 → 分支 B 自然不参与，安全。
 */
export function buildUpgradeTargets(items: UpgradePlanItem[]): FetchTarget[] {
  return items.map((it) => ({
    id: `upgrade:${it.songId}`,
    title: it.title,
    artist: it.artist,
    album: it.album,
    durationSec: it.durationSec > 0 ? it.durationSec : undefined,
    sourceData: JSON.stringify({
      upgrade: {
        songId: it.songId,
        path: it.path,
        suffix: it.suffix,
        bitRate: it.bitrateKbps,
      },
    }),
  }));
}

// ==================== 库行迁移（保住旧行 id，别让歌单变死引用）====================

/** 迁移结果。 */
export interface MigrateResult {
  migrated: boolean;
  removedRowId?: string;
  warnings: string[];
}

/** 需要从新行拷到旧行的元数据列（不含 id/group/createdAt/playCount —— 那些保留旧行原值）。 */
const COPY_COLUMNS = [
  "title", "artist", "artistId", "album", "albumId", "duration", "bitRate",
  "contentType", "suffix", "size", "genre", "discNumber", "track", "year",
  "albumArtist", "composer", "comment", "tags", "hasLyrics", "coverArt", "fingerprint",
] as const;

/** 按文件 stat 生成与 scanLocalFiles 一致的指纹。 */
function fingerprintOf(filePath: string): string | undefined {
  try {
    const st = statSync(filePath);
    return `${st.size}|${st.mtimeMs}`;
  } catch {
    return undefined;
  }
}

/** 删行后修正专辑曲目数/时长（删新行会让扫描时算出的 count 多 1）。 */
function recomputeAlbumCounts(albumIds: Array<string | null | undefined>): void {
  const ids = [...new Set(albumIds.filter((x): x is string => !!x))];
  for (const id of ids) {
    try {
      const agg = sqlite
        .prepare("SELECT COUNT(*) AS cnt, COALESCE(SUM(duration), 0) AS dur FROM songs WHERE album_id = ?")
        .get(id) as any;
      db.update(albums)
        .set({ songCount: agg?.cnt ?? 0, duration: agg?.dur ?? 0 })
        .where(eq(albums.id, id))
        .run();
    } catch {
      /* 计数修正失败不影响迁移主流程 */
    }
  }
}

/**
 * 把新无损文件的库行「迁移」到旧行上（**保持旧行 id 不变**），并删掉扫描新建的那行。
 *
 * 为什么必须保住旧行 id：`playlist_songs.song_id` / `user_favorite_songs.song_id` 引用它，
 * 一旦换成新 id，用户歌单/收藏里这首歌就成了死引用。
 *
 * ⚠️ 与设计稿的一处必要偏差：本函数是 **async**。原因是「扫描没建出新行」的兜底分支
 * 需要 `await extractMetadataLocal(newPath)`（music-metadata 只有异步 API）。正常流程
 * （新行已由 scanLocalFiles 建好）走纯同步分支。
 *
 * 任何异常都只返回 warning，**绝不抛**（抛了会把已落盘的无损文件连累成失败项）。
 */
export async function migrateUpgradedSong(args: {
  oldSongId: string;
  newPath: string;
  newSourceId: string;
}): Promise<MigrateResult> {
  const warnings: string[] = [];
  try {
    const oldRow = db.select().from(songs).where(eq(songs.id, args.oldSongId)).get();
    if (!oldRow) return { migrated: false, warnings: ["旧曲目行不存在"] };

    const newFullPath = `l:${args.newSourceId}:${args.newPath}`;
    let newRow = db.select().from(songs).where(eq(songs.path, newFullPath)).get();

    // 扫描没建出新行（scanLocalFiles 失败/未跑）→ 自己抽元数据入库（复用 scanner 的
    // upsertSong，封面/专辑/艺人的副作用与正常扫描完全一致）。
    if (!newRow && existsSync(args.newPath)) {
      try {
        const meta = await extractMetadataLocal(args.newPath);
        upsertSong(newFullPath, meta, args.newSourceId, fingerprintOf(args.newPath));
      } catch (e) {
        warnings.push(`新文件元数据抽取失败: ${msgOf(e)}`);
      }
      newRow = db.select().from(songs).where(eq(songs.path, newFullPath)).get();
    }
    if (!newRow) return { migrated: false, warnings: [...warnings, "新文件未入库，无法迁移"] };

    // 新行就是旧行（同一 path）→ 无需迁移。
    if (newRow.id === args.oldSongId) return { migrated: true, warnings };

    const now = new Date().toISOString();
    const patch: Record<string, unknown> = { path: newFullPath, updatedAt: now };
    // 迁移即「今天入库」（产品定调 2026-10-10）：created_at 一并刷新为迁移时刻。
    // 否则 webdav 老行迁移后「最近添加」（按 created_at 倒序）仍按老时间排序，
    // 用户看不到刚下载的歌（240 实测：45 行迁移后挂在 2026-08-12 上）。
    patch.createdAt = now;
    for (const k of COPY_COLUMNS) patch[k] = (newRow as any)[k];
    // type 一并跟随新行：web 行被「全库下载」替换成实体文件后必须是 local，否则
    // `type='local' AND path LIKE 'l:%'` 这类查询会永远漏掉它（洗版场景新行本就是 local，无变化）。
    patch.type = (newRow as any).type ?? "local";

    db.update(songs)
      .set(patch as any)
      .where(eq(songs.id, args.oldSongId))
      .run();
    db.delete(songs).where(eq(songs.id, newRow.id)).run();
    // 删行会让扫描阶段算出的专辑计数多 1：修正旧行/新行涉及的专辑。
    recomputeAlbumCounts([oldRow.albumId, newRow.albumId]);

    return { migrated: true, removedRowId: newRow.id, warnings };
  } catch (e) {
    return { migrated: false, warnings: [`库行迁移失败: ${msgOf(e)}`] };
  }
}

// ==================== 原件处置（不可逆 → 多重安全闸）====================

export interface DisposeResult {
  action: string;
  deleted?: boolean;
  movedTo?: string;
  warnings: string[];
}

/** originalPath 是否落在 root（或等于 root）之下。 */
function isUnderRoot(originalPath: string, root: string): boolean {
  const r = path.resolve(root);
  if (r === originalPath) return true;
  const rel = path.relative(r, originalPath);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * 原低码率文件的处置（带安全闸）。
 *
 * 🔴 用户选择的是「直接删除原件」，**不可逆**。因此以下每一条都必须同时满足，否则
 * 一律退化为「不碰文件 + warning」：
 *   1. 原路径与新路径（解析后）不同；
 *   2. 新文件确实存在（existsSync(newPath)）；
 *   3. 原路径落在 allowedRoots 中任意一个之下；
 *   4. 扩展名在音频扩展名集合内。
 * delete → unlinkSync；move → 备份到 backupDir（EXDEV 降级 copy+unlink）。
 */
export function disposeOriginalFile(args: {
  originalPath: string;
  newPath: string;
  action: "keep" | "move" | "delete";
  backupDir?: string;
  allowedRoots: string[];
}): DisposeResult {
  const warnings: string[] = [];
  try {
    const orig = path.resolve(args.originalPath);
    const neu = path.resolve(args.newPath);

    // 闸 1：原、新不同路径。
    if (orig === neu) {
      return { action: "skip", warnings: ["原件与新文件为同一路径，跳过处置"] };
    }
    // 闸 2：新文件真的在。
    if (!existsSync(neu)) {
      return { action: "skip", warnings: ["新文件不存在，拒绝处置原件"] };
    }
    // 闸 3：原路径必须在允许的下载根之下。
    const allowed = Array.isArray(args.allowedRoots) ? args.allowedRoots.filter((r) => typeof r === "string" && r) : [];
    if (!allowed.some((root) => isUnderRoot(orig, root))) {
      return { action: "skip", warnings: [`原件不在允许的下载根之下，拒绝处置: ${orig}`] };
    }
    // 闸 4：音频扩展名。
    const ext = path.extname(orig).toLowerCase();
    if (!AUDIO_EXTENSIONS.has(ext)) {
      return { action: "skip", warnings: [`非音频扩展名（${ext || "无"}），拒绝处置`] };
    }
    // 闸 5：动作合法性（未知动作一律不碰文件）。
    if (args.action === "keep") {
      return { action: "keep", warnings };
    }
    if (args.action === "delete") {
      unlinkSync(orig);
      return { action: "delete", deleted: true, warnings };
    }

    // move：备份到 backupDir（缺省不动）。
    if (!args.backupDir) {
      return { action: "skip", warnings: ["未指定 backupDir，拒绝移动原件"] };
    }
    const backupRoot = path.resolve(args.backupDir);
    mkdirSync(backupRoot, { recursive: true });
    const base = path.basename(orig);
    let dest = path.join(backupRoot, base);
    // 目标重名时加序号，绝不覆盖备份目录里已有文件。
    for (let i = 1; existsSync(dest); i++) {
      const stem = base.slice(0, base.length - ext.length);
      dest = path.join(backupRoot, `${stem}.${i}${ext}`);
    }
    try {
      renameSync(orig, dest);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "EXDEV") {
        copyFileSync(orig, dest);
        try {
          unlinkSync(orig);
        } catch {
          warnings.push("跨卷复制成功但删除原件失败，请手动清理");
        }
        warnings.push("跨卷（EXDEV），移动已退化为复制 + 删除");
      } else {
        throw e;
      }
    }
    return { action: "move", movedTo: dest, warnings };
  } catch (e) {
    return { action: "skip", warnings: [`原件处置失败（已保留原件）: ${msgOf(e)}`] };
  }
}

// ==================== 洗版任务 config_json 快照（自 routes 迁入，供调度器复用） ====================

/** 洗版任务的 config_json 快照（含 __upgrade 供批量子进程还原）。 */
export function buildUpgradeJobConfig(cfg: FetchConfig): Record<string, any> {
  return {
    ...cfg,
    skipIfInLibrary: false, // 洗版必须能命中「库内已有的低码率行」，绕开「已有则跳过」
    // 候选音质预探是**必须功能**（产品定调 2026-10-11：开关已从 UI 摘除）——洗版要判
    // 「候选有效码率是否高于原件」，不预探就只能信信源虚标的声明值，误判率极高。
    // 这里硬钉 true，避免历史遗留的 `inspectCandidates:false` 覆盖项把它静默关掉。
    inspectCandidates: true,
    quality: buildUpgradeQuality(cfg.quality),
    __upgrade: {
      downloadRootOverride: cfg.losslessRoot || DEFAULT_LOSSLESS_ROOT,
      originalDisposal: {
        action: cfg.upgradeOriginalAction,
        backupDir: path.join(cfg.downloadRoot, cfg.upgradeBackupDir),
        allowedRoots: [cfg.downloadRoot],
      },
    },
  };
}

// ==================== 洗版冷却（fetch_upgrade_attempts 表） ====================
//
// 产品语义（2026-10-10 确认）：同一首歌 N 天内（默认 30）只要**尝试过**洗版
// ——无论成败——下次触发就自动跳过（「失败的短时间内也可能好不了」，不该天天白扫）。
// 与 fetch_library_attempts 同构但独立：song_id 主键 + INSERT OR IGNORE 天然幂等；
// resetUpgradeAttempts() 供「清空洗版记录」按钮用（下一次全量可触发）。

let upgradeAttemptsEnsured = false;

/** 幂等建「洗版已尝试」表（本仓无迁移框架，CREATE TABLE IF NOT EXISTS 即可）。 */
export function ensureUpgradeAttemptsTable(): void {
  if (upgradeAttemptsEnsured) return;
  sqlite
    .prepare(
      `CREATE TABLE IF NOT EXISTS fetch_upgrade_attempts (
         song_id      TEXT PRIMARY KEY,
         attempted_at TEXT NOT NULL,
         batch_id     TEXT NOT NULL,
         status       TEXT NOT NULL DEFAULT 'attempted'
       )`,
    )
    .run();
  upgradeAttemptsEnsured = true;
}

/** 记录「这一批已尝试洗版」（失败也记，INSERT OR IGNORE 幂等）。 */
export function recordUpgradeAttempts(batchId: string, songIds: string[]): void {
  if (!batchId || songIds.length === 0) return;
  ensureUpgradeAttemptsTable();
  const now = new Date().toISOString();
  const stmt = sqlite.prepare(
    "INSERT OR IGNORE INTO fetch_upgrade_attempts (song_id, attempted_at, batch_id, status) VALUES (?, ?, ?, 'attempted')",
  );
  const tx = sqlite.transaction((ids: string[]) => {
    for (const id of ids) if (id) stmt.run(id, now, batchId);
  });
  tx(songIds);
}

/** songId → 最近一次尝试时间（ISO 串）。 */
export function collectUpgradeAttemptedAt(): Map<string, string> {
  ensureUpgradeAttemptsTable();
  const rows = sqlite.prepare("SELECT song_id, attempted_at FROM fetch_upgrade_attempts").all() as Array<{
    song_id: string;
    attempted_at: string;
  }>;
  const out = new Map<string, string>();
  for (const r of rows) out.set(String(r.song_id ?? ""), String(r.attempted_at ?? ""));
  return out;
}

/** 清空全部洗版冷却记录，返回清除行数。 */
export function resetUpgradeAttempts(): number {
  ensureUpgradeAttemptsTable();
  const res = sqlite.prepare("DELETE FROM fetch_upgrade_attempts").run();
  return Number(res?.changes ?? 0);
}
