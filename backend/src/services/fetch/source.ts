// ==================== MusicFetch：把下载目录注册成 media source ====================
//
// 曲库里一首歌属于哪个源，完全由 `songs.path` 的前缀决定：`l:<sourceId>:<绝对路径>`
// （scanner 约定）。所以「下载落盘后入库」之前，**必须先有一条 media_sources 行**，
// 再拿它的 id 去调 `scanLocalFiles()`。少了这一步，会写出 `l:<不存在的id>:...` 的孤儿行：
// 能播（`parseSongPath` 只剥前缀、不查 media_sources），但永远无法被「重扫该源」覆盖，
// 也无法在源管理页按源整批删除。
//
// 本模块只负责「幂等地拿到 / 创建这条源行」，不触发扫描、不写 songs。
//
// 三级幂等（缺一不可）：
//   1. 按路径复用既有 local 源 —— 命中即原样返回，**绝不改 name/enabled/config**；
//      用户手工建的源不能被我们篡改。
//   2. 确定性主键 + onConflictDoNothing —— 同一路径永远得到同一 id，重复执行零副作用；
//      竞态下 onConflictDoNothing 是静默跳过。
//   3. 插入后回读拿 id —— 保证一定拿到（无论是本次插入还是别人先插的）。
//
// 🔴 `enabled` 必须是数字 `1`：它是 INTEGER 列，better-sqlite3 绑 JS boolean 会抛
//    "SQLite3 can only bind numbers..." → 未捕获 → 500。仓库先例见
//    `routes/api/sources.ts` 的 `normalizeEnabled`。
import { createHash } from "node:crypto";
import * as path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { mediaSources } from "../../db/schema.js";

export interface EnsureSourceResult {
  sourceId: string;
  /** 本次新建 */
  created: boolean;
  /** 命中用户已手工登记的源 */
  reusedExisting: boolean;
  /** 已有别的 local 源覆盖了该路径（会导致同一文件两行），调用方应打 warn */
  ancestorSourceId: string | null;
}

/** media_sources 的一行（本模块只用到这几个字段）。 */
interface SourceRow {
  id: string;
  name: string | null;
  type: string | null;
  enabled: number | null;
  config: string | null;
}

/** 解析 local 源的 config.path；坏 JSON / 非字符串一律当空（不抛）。 */
function readConfigPath(config: string | null | undefined): string {
  if (!config) return "";
  try {
    const obj = JSON.parse(config);
    if (obj && typeof obj === "object" && typeof obj.path === "string") return obj.path;
  } catch {
    /* 坏 JSON 视作无路径 */
  }
  return "";
}

/** ancestor 是否等于 child 或位于 child 的祖先位置。 */
function isAncestorOrSame(ancestor: string, child: string): boolean {
  if (ancestor === child) return true;
  const rel = path.relative(ancestor, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** 把 rootPath 规整成绝对路径（幂等主键依赖它，必须与写入的绝对路径一致）。 */
function absOf(rootPath: string): string {
  return path.resolve(rootPath);
}

/** 路径 → 确定性主键：`dl-<sha1 前 12 位>`。 */
export function downloadSourceId(rootPath: string): string {
  const abs = absOf(rootPath);
  return `dl-${createHash("sha1").update(abs).digest("hex").slice(0, 12)}`;
}

/** 只查不建：按绝对路径找既有 local 源，返回其 id，找不到返回 null。 */
export function findDownloadSource(rootPath: string): string | null {
  const abs = absOf(rootPath);
  const rows = db.select().from(mediaSources).all() as SourceRow[];
  for (const s of rows) {
    if (s.type !== "local") continue;
    const p = readConfigPath(s.config);
    if (p && path.resolve(p) === abs) return s.id;
  }
  return null;
}

/**
 * 遍历所有 local 源，找出「其根是 rootPath 的严格祖先」的那个源 id。
 * 若用户已有 local 源根 = /MUSIC（downloadRoot 的祖先），我们新建的独立源会让同一文件
 * 出现两行（songs.path 不同，upsertSong 不合并）—— 调用方据此打 warn，但不改 upsertSong。
 */
function findAncestorId(rows: SourceRow[], abs: string, selfId: string): string | null {
  for (const s of rows) {
    if (s.type !== "local" || s.id === selfId) continue;
    const p = readConfigPath(s.config);
    if (!p) continue;
    const root = path.resolve(p);
    if (root !== abs && isAncestorOrSame(root, abs)) return s.id;
  }
  return null;
}

/**
 * 幂等确保 `/MUSIC/DOWNLOAD` 对应的 media source 存在，返回其 id。
 * 见文件头「三级幂等」。
 */
export function ensureDownloadSource(rootPath: string, name?: string): EnsureSourceResult {
  const abs = absOf(rootPath);
  const rows = db.select().from(mediaSources).all() as SourceRow[];

  // 第 1 级：按路径复用既有 local 源（不改任何字段）。
  for (const s of rows) {
    if (s.type !== "local") continue;
    const p = readConfigPath(s.config);
    if (p && path.resolve(p) === abs) {
      return {
        sourceId: s.id,
        created: false,
        reusedExisting: true,
        ancestorSourceId: findAncestorId(rows, abs, s.id),
      };
    }
  }

  // 第 2 级：确定性主键 + onConflictDoNothing。
  const id = downloadSourceId(abs);
  const existedById = rows.some((r) => r.id === id);
  const now = new Date().toISOString();
  db.insert(mediaSources)
    .values({
      id,
      name: name ?? "已下载",
      type: "local",
      enabled: 1, // 🔴 数字，不能是 boolean
      config: JSON.stringify({ path: abs }),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .run();

  // 第 3 级：回读（竞态下 onConflictDoNothing 静默跳过，必须回读确认）。
  const got = db.select().from(mediaSources).where(eq(mediaSources.id, id)).get() as
    | SourceRow
    | undefined;
  const sourceId = got?.id ?? id;
  const allRows = db.select().from(mediaSources).all() as SourceRow[];

  return {
    sourceId,
    created: !existedById && !!got,
    reusedExisting: false,
    ancestorSourceId: findAncestorId(allRows, abs, sourceId),
  };
}
