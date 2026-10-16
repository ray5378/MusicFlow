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

import { existsSync, statSync } from "node:fs";
import { sqlite } from "../../db/index.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("FETCH_TAG_REPAIR");

interface MarkerRow {
  fs_path: string;
  size: number;
  mtime_ms: number;
  src: string;
  at: string;
}

/** 读取标记行(不存在返回 null)。 */
function loadMarker(fsPath: string): MarkerRow | null {
  return (
    (sqlite
      .prepare("SELECT fs_path, size, mtime_ms, src, at FROM tag_repair_done WHERE fs_path = ?")
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
 */
export function markTagRepairDone(fsPath: string, src: string): boolean {
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
        `INSERT INTO tag_repair_done (fs_path, size, mtime_ms, src, at)
           VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(fs_path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms,
                                            src = excluded.src, at = excluded.at`,
      )
      .run(fsPath, Number(st.size) || 0, Math.floor(Number(st.mtimeMs) || 0), src || "", new Date().toISOString());
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
  return true;
}

/** 显式清除某文件的标记(如标签修复真正改写了该文件后调用)。 */
export function clearTagRepairMark(fsPath: string): void {
  if (!fsPath) return;
  deleteMarker(fsPath);
}

/** 已标记(且当前命中)的总数:供自省/统计。 */
export function getTagRepairMarkedCount(): number {
  try {
    return Number((sqlite.prepare("SELECT COUNT(*) AS n FROM tag_repair_done").get() as { n: number })?.n) || 0;
  } catch {
    return 0;
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
