// ==================== 标签修复完成标记(2026-10-16) ====================
//
// 语义:凡在**下载期**由「内置标签来源插件」(manifest.builtinTagSource,如内置
// tag-provider)打上标签的成品文件,落盘后在 tag_repair_done 表登记一行
// (fs_path + size + mtime_ms + src)。标签修复扫描命中该标记 **且文件位置/大小/mtime
// 均未变** 时 → 不探针、不联网,直接跳过该歌(视为「已修复·跳过」)。
//
// 为什么:下载期内置插件已用与修复完全相同的取值来源(provider)打过一轮标签;
// 网络波动导致这一轮拿不到值时不会写标记 → 修复仍会补;拿得到值时再跑修复纯属重复。
//
// 失效规则:
//   - 位置变了 → 以 fs_path 为主键,新路径不在表内 → 自然不命中;
//   - 文件被改写(size/mtime 变)→ 命中检查时删掉该行、返回未命中(内容可能已变,需重探)。
//
// 只对**内置**来源标记:外置插件的 manifest 不声明 builtinTagSource → 其提供的标签不标记。
//
// 终态不可得(2026-10-17·选项 C):修复时「真缺标签但各来源都拿不到」的歌也在此登记一行,
//   但 outcome='unobtainable'(默认 'fixed' 表「已达标」)。语义=让候选池**收敛**:下轮扫描命中
//   该标记即跳过,不再对同一首歌无限重探/重扫(实测 96% 未命中、池子永不收敛)。
//   安全阀:unobtainable 标记带 30 天 TTL —— 超期后 isTagRepairMarked 返回 false 允许重探
//   (防断网/平台抽风把整库永久标记,且可自愈)。unobtainable 行**不计入**「已修复」,
//   也**不参与**来源分布聚合(见 getTagRepairMarkedCount / getTagRepairPlatformCounts)。

import { existsSync, statSync } from "node:fs";
import { sqlite } from "../../db/index.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("FETCH_TAG_REPAIR");

/** 终态不可得标记的存活期:超期后视为失效,允许重探(自愈窗口)。 */
const UNOBTAINABLE_TTL_MS = 30 * 24 * 3_600_000;

interface MarkerRow {
  fs_path: string;
  size: number;
  mtime_ms: number;
  src: string;
  platform: string | null;
  outcome: string | null;
  at: string;
}

/** 读取标记行(不存在返回 null)。 */
function loadMarker(fsPath: string): MarkerRow | null {
  return (
    (sqlite
      .prepare("SELECT fs_path, size, mtime_ms, src, platform, outcome, at FROM tag_repair_done WHERE fs_path = ?")
      .get(fsPath) as MarkerRow | undefined) ?? null
  );
}

function deleteMarker(fsPath: string): void {
  try {
    sqlite.prepare("DELETE FROM tag_repair_done WHERE fs_path = ?").run(fsPath);
  } catch (e) {
    log.warn(`标记清理失败 fs=${fsPath}: ${e instanceof Error ? e.message : e}`);
  }
}

/**
 * 登记「下载期已由内置标签来源打好标签」。仅当文件确实存在时写入。
 * 幂等:同一路径重复落盘(如原地替换/洗版)以最新一次 size/mtime 为准。
 *
 * platform:本次命中的来源平台("qq" / "netease"),供管理端「标签来源分布」聚合展示;
 * 拿不到平台(如仅走封面/歌词或 DB 兜底)时传 undefined → 落 NULL,归入「历史/未记录来源」。
 * outcome:修复结果 —— 'fixed'=已达标(默认);'unobtainable'=真缺但各来源都拿不到(终态不可得,带 30 天 TTL)。
 */
export function markTagRepairDone(
  fsPath: string,
  src: string,
  platform?: string | null,
  outcome: "fixed" | "unobtainable" = "fixed",
): boolean {
  if (!fsPath) return false;
  let st;
  try {
    if (!existsSync(fsPath)) return false;
    st = statSync(fsPath);
  } catch {
    return false;
  }
  try {
    sqlite
      .prepare(
        `INSERT INTO tag_repair_done (fs_path, size, mtime_ms, src, platform, outcome, at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(fs_path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms,
                                            src = excluded.src, platform = excluded.platform,
                                            outcome = excluded.outcome, at = excluded.at`,
      )
      .run(
        fsPath,
        Number(st.size) || 0,
        Math.floor(Number(st.mtimeMs) || 0),
        src || "",
        platform ? String(platform) : null,
        outcome,
        new Date().toISOString(),
      );
    return true;
  } catch (e) {
    log.warn(`标记写入失败 fs=${fsPath}: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

/**
 * 命中判定:标记存在 **且** 文件仍在原路径、size 与 mtime 未变。
 * 文件不存在或已变化 → 清掉失效行并返回 false(内容可能已变,需重探)。
 */
export function isTagRepairMarked(fsPath: string): boolean {
  if (!fsPath) return false;
  const row = loadMarker(fsPath);
  if (!row) return false;
  let st;
  try {
    if (!existsSync(fsPath)) {
      deleteMarker(fsPath); // 文件没了,标记失去意义
      return false;
    }
    st = statSync(fsPath);
  } catch {
    deleteMarker(fsPath);
    return false;
  }
  const size = Number(st.size) || 0;
  const mtimeMs = Math.floor(Number(st.mtimeMs) || 0);
  if (size !== Number(row.size) || mtimeMs !== Number(row.mtime_ms)) {
    deleteMarker(fsPath); // 位置没动但内容变了 → 失效
    return false;
  }
  // 终态不可得标记带 30 天 TTL:超期视为失效、允许重探(自愈窗口;防断网/平台抽风把整库永久标记)。
  // 注意此处**不删行**(超期只是放弃跳过,下次重探仍可写回新标记)。
  if (String(row.outcome ?? "") === "unobtainable") {
    const at = Date.parse(String(row.at ?? ""));
    if (Number.isFinite(at) && Date.now() - at > UNOBTAINABLE_TTL_MS) return false;
  }
  return true;
}

/** 显式清除某文件的标记(如标签修复真正改写了该文件后调用)。 */
export function clearTagRepairMark(fsPath: string): void {
  if (!fsPath) return;
  deleteMarker(fsPath);
}

/** 已达标(已修复)标记行数:供「已修复」统计。**排除** outcome='unobtainable' 的终态不可得行。 */
export function getTagRepairMarkedCount(): number {
  try {
    return (
      Number(
        (
          sqlite
            .prepare(
              "SELECT COUNT(*) AS n FROM tag_repair_done WHERE outcome IS NULL OR outcome != 'unobtainable'",
            )
            .get() as { n: number }
        )?.n,
      ) || 0
    );
  } catch {
    return 0;
  }
}

/** 全部已落标记的 fs_path 列表（供「待修复」口径剔除已不再重扫的歌）。
 * 纯 DB 读取、不 stat：失效判定（size/mtime 变化）由扫描阶段的 isTagRepairMarked 负责，
 * 此处只反映「有标记 = 不再重扫」的稳定口径（含 outcome='fixed' 与 'unobtainable' 两类）。 */
export function getTagRepairMarkedPaths(): string[] {
  try {
    const rows = sqlite.prepare("SELECT fs_path FROM tag_repair_done").all() as Array<{ fs_path: string }>;
    return rows.map((r) => String(r.fs_path));
  } catch {
    return [];
  }
}

/** 终态不可得标记行数：供「终态不可得」统计(已被标记跳过、池子不再重扫的歌数;带 30 天 TTL)。 */
export function getTagRepairUnobtainableCount(): number {
  try {
    return (
      Number(
        (
          sqlite.prepare("SELECT COUNT(*) AS n FROM tag_repair_done WHERE outcome = 'unobtainable'").get() as {
            n: number;
          }
        )?.n,
      ) || 0
    );
  } catch {
    return 0;
  }
}

/** 按 source platform 分组统计**已达标**标记行数(供管理端「标签来源分布」)。
 * DB 聚合,不做任何实时探测(实时探测会打爆平台 API 并触发限流)。
 * platform 为 NULL 的历史行归一为空串 "",前端据此归入「历史(未记录来源)」。
 * **排除** outcome='unobtainable' 行:终态不可得非「已修复」,不该污染来源分布。
 */
export function getTagRepairPlatformCounts(): Array<{ platform: string; count: number }> {
  try {
    const rows = sqlite
      .prepare(
        "SELECT platform, COUNT(*) AS n FROM tag_repair_done " +
          "WHERE outcome IS NULL OR outcome != 'unobtainable' GROUP BY platform",
      )
      .all() as Array<{ platform: string | null; n: number }>;
    return rows.map((r) => ({ platform: r.platform == null ? "" : String(r.platform), count: Number(r.n) || 0 }));
  } catch {
    return [];
  }
}

/** 测试复位:清空标记表。 */
export function _resetTagRepairMarkersForTest(): void {
  try {
    sqlite.prepare("DELETE FROM tag_repair_done").run();
  } catch {
    /* 表可能尚未建立(纯单测无 DB):忽略 */
  }
}
