// ==================== MusicFetch：本地 / WebDAV 已有则不下载 ====================
//
// 需求 3（用户硬性要求）的核心：**本地(l:) 或 WebDAV(w:) 已存在这首歌的可播放实体文件
// 时，不再重复下载**。
//
// 范围（关键守卫）：只认 `songs.path` 以 `l:`（本地磁盘源）或 `w:`（WebDAV 源）开头的
// **物理可播放行**。**不认**在线网页行（`type='web'` / path 不是这两个前缀）—— 那种行本身
// 没有本地文件，正是我们要补下载的对象；把它当「已有」会让下载被错误跳过。
//
// 性能：曲库在 240 生产有 13 万行（web 8.1 万 + 物理 5.2 万），**禁止每次全表 SELECT**。
// 用 drizzle 参数化粗筛（path 前缀 + 标题）`LIMIT 200`，再在 JS 里按归一化规则精筛。
// 用户输入里的 `%` / `_` 必须转义（`ESCAPE`），否则会被当通配符。
import { and, or, sql, type SQL } from "drizzle-orm";
import { db } from "../../db/index.js";
import { songs } from "../../db/schema.js";
import { DEFAULT_QUALITY_CONFIG } from "./types.js";

export type ExistingKind = "local" | "webdav";

export interface ExistingHit {
  songId: string;
  path: string;
  kind: ExistingKind;
  title: string;
  artist: string;
  album: string;
  durationSec: number;
  bitRate?: number;
  suffix?: string;
}

export interface ExistingQuery {
  title: string;
  artist?: string;
  album?: string;
  durationSec?: number;
}

/** 供测试注入的一行（列名对齐 `songs` 表）。 */
export interface ExistingRow {
  id: string;
  path: string;
  title: string;
  artist?: string | null;
  album?: string | null;
  /** 时长（整数秒，对齐 songs.duration） */
  duration?: number | null;
  /** 比特率（kbps，对齐 songs.bit_rate） */
  bitRate?: number | null;
  suffix?: string | null;
  type?: string | null;
}

/** 粗筛候选上限（单查询）。批量查询按 queries 数量放大，但封顶防爆。 */
const COARSE_LIMIT_PER_QUERY = 200;
const COARSE_LIMIT_MAX = 2000;

// ==================== 归一化 ====================

/** 全角 → 半角（U+FF01~U+FF5E 与全角空格）。 */
function toHalfWidth(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x3000) out += " ";
    else if (code >= 0xff01 && code <= 0xff5e) out += String.fromCodePoint(code - 0xfee0);
    else out += ch;
  }
  return out;
}

/** 去掉括号及括号内内容（半角/全角/方括号/花括号/【】），反复应用到稳定（处理嵌套）。 */
function stripBrackets(s: string): string {
  let out = s;
  let prev = "";
  while (prev !== out) {
    prev = out;
    out = out.replace(/\((?:[^()]*)\)/g, " ").replace(/\[(?:[^\[\]]*)\]/g, " ");
    out = out.replace(/【(?:[^【】]*)】/g, " ").replace(/\{(?:[^{}]*)\}/g, " ");
  }
  return out;
}

/**
 * 标题归一化：转小写 → 全角转半角 → 去括号内容 → 去 feat./ft. 后缀 → 去标点/符号/空白。
 * 结果用于「必须相等」的精确判定。
 */
export function normalizeTitle(s: string): string {
  let out = toHalfWidth(String(s ?? "").toLowerCase());
  out = stripBrackets(out);
  // 去掉 feat./ft. 及其之后的内容（无括号时也要能去掉）。
  out = out.replace(/\b(?:feat|ft)\.?\s.*$/i, " ");
  out = out.replace(/[\s\p{P}\p{S}]+/gu, "");
  return out;
}

/**
 * 歌手归一化：转小写 → 全角转半角 → 去括号内容 → 收敛空白。
 * 保留分隔符（用于「按分隔符切分后取交集」）。
 */
export function normalizeArtist(s: string): string {
  let out = toHalfWidth(String(s ?? "").toLowerCase());
  out = stripBrackets(out);
  out = out.replace(/\s+/g, " ").trim();
  return out;
}

/** 去掉所有空白（用于「一方包含另一方」的紧凑比较）。 */
function compact(s: string): string {
  return s.replace(/\s+/g, "");
}

/** 按常见分隔符切分歌手串（& / 、 , ; 空白 等）。 */
function artistTokens(s: string): string[] {
  return normalizeArtist(s)
    .split(/[&/,;；、·|]+|\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** 两位歌手是否匹配：任一方为空 → 不算不匹配；否则「一方包含另一方」或切分后有交集。 */
function artistsMatch(a: string, b: string): boolean {
  const ca = compact(normalizeArtist(a));
  const cb = compact(normalizeArtist(b));
  if (ca && cb && (ca.includes(cb) || cb.includes(ca))) return true;
  const ta = new Set(artistTokens(a));
  return artistTokens(b).some((t) => ta.has(t));
}

// ==================== LIKE 转义 ====================

/**
 * 转义 LIKE 模式里的通配符：`\` `%` `_` → 加反斜杠前缀。
 * 配合 SQL 里的 `ESCAPE '\'`，否则用户标题里的 `%`/`_` 会被当通配符（`_` 匹配任意单字符，
 * `%` 匹配任意串），造成粗筛过宽甚至错配。
 */
export function escapeLikePattern(s: string): string {
  return String(s ?? "").replace(/[\\%_]/g, (m) => `\\${m}`);
}

// ==================== 粗筛（参数化） ====================

function kindOf(path: string | null | undefined): ExistingKind | null {
  if (typeof path !== "string") return null;
  if (path.startsWith("l:")) return "local";
  if (path.startsWith("w:")) return "webdav";
  return null;
}

const SELECT_COLUMNS = {
  id: songs.id,
  path: songs.path,
  title: songs.title,
  artist: songs.artist,
  album: songs.album,
  duration: songs.duration,
  bitRate: songs.bitRate,
  suffix: songs.suffix,
  type: songs.type,
};

/** 粗筛：path 前缀 + 标题（参数化 + LIMIT），返回候选行集合。 */
function fetchCandidates(queries: ExistingQuery[]): ExistingRow[] {
  const titleConds: SQL[] = [];
  for (const q of queries) {
    const raw = (q.title ?? "").trim();
    if (!raw) continue;
    titleConds.push(sql`lower(${songs.title}) = lower(${raw})`);
    titleConds.push(
      sql`lower(${songs.title}) LIKE lower(${"%" + escapeLikePattern(raw) + "%"}) ESCAPE '\\'`,
    );
    const norm = normalizeTitle(raw);
    if (norm && norm !== raw.toLowerCase()) {
      titleConds.push(
        sql`lower(${songs.title}) LIKE lower(${"%" + escapeLikePattern(norm) + "%"}) ESCAPE '\\'`,
      );
    }
  }
  if (titleConds.length === 0) return [];

  const limit = Math.min(
    COARSE_LIMIT_PER_QUERY * Math.max(1, queries.length),
    COARSE_LIMIT_MAX,
  );
  return db
    .select(SELECT_COLUMNS)
    .from(songs)
    .where(
      and(
        sql`(${songs.path} LIKE 'l:%' OR ${songs.path} LIKE 'w:%')`,
        or(...titleConds),
      ),
    )
    .limit(limit)
    .all() as ExistingRow[];
}

// ==================== 精筛 ====================

function matchRow(q: ExistingQuery, row: ExistingRow, toleranceSec: number): ExistingHit | null {
  const kind = kindOf(row.path);
  if (!kind) return null;

  const qt = normalizeTitle(q.title);
  const rt = normalizeTitle(row.title ?? "");
  if (!qt || qt !== rt) return null;

  const qa = (q.artist ?? "").trim();
  const ra = (row.artist ?? "").trim();
  if (qa && ra && !artistsMatch(qa, ra)) return null;

  const qd = typeof q.durationSec === "number" && q.durationSec > 0 ? q.durationSec : 0;
  const rd = typeof row.duration === "number" && row.duration > 0 ? row.duration : 0;
  if (qd > 0 && rd > 0 && Math.abs(rd - qd) > toleranceSec) return null;

  return {
    songId: row.id,
    path: row.path,
    kind,
    title: row.title ?? "",
    artist: row.artist ?? "",
    album: row.album ?? "",
    durationSec: rd,
    bitRate: typeof row.bitRate === "number" ? row.bitRate : undefined,
    suffix: row.suffix ?? undefined,
  };
}

/** a 是否优于 b：local > webdav，再比 bitRate 大。 */
function better(a: ExistingHit, b: ExistingHit): boolean {
  const ka = a.kind === "local" ? 0 : 1;
  const kb = b.kind === "local" ? 0 : 1;
  if (ka !== kb) return ka < kb;
  return (a.bitRate ?? 0) > (b.bitRate ?? 0);
}

function pickBestOne(q: ExistingQuery, cands: ExistingRow[], toleranceSec: number): ExistingHit | null {
  let best: ExistingHit | null = null;
  for (const row of cands) {
    const hit = matchRow(q, row, toleranceSec);
    if (!hit) continue;
    if (!best || better(hit, best)) best = hit;
  }
  return best;
}

function resolveTolerance(toleranceSec?: number): number {
  return typeof toleranceSec === "number" && toleranceSec >= 0
    ? toleranceSec
    : DEFAULT_QUALITY_CONFIG.durationToleranceSec;
}

// ==================== 对外 API ====================

/**
 * 查库：本地(l:)或 WebDAV(w:)是否已有这首歌的可播放实体文件。
 * 命中多条时优先 local > webdav，再优先 bitRate 大；无命中返回 null（不抛异常）。
 *
 * @param rows 测试注入点：给出时跳过数据库查询，直接在这批行上精筛。
 */
export function findExistingPlayable(
  q: ExistingQuery,
  toleranceSec?: number,
  rows?: ExistingRow[],
): ExistingHit | null {
  const tol = resolveTolerance(toleranceSec);
  if (!q || !normalizeTitle(q.title)) return null;
  const cands = rows ?? fetchCandidates([q]);
  return pickBestOne(q, cands, tol);
}

/**
 * 批量版：一次任务开始时预查（dry-run 与批量预览用）。
 * 未注入 rows 时只发**一条**数据库查询（所有标题的粗筛条件合并），再在 JS 里分发精筛。
 */
export function findExistingPlayableBatch(
  qs: Array<ExistingQuery & { id: string }>,
  toleranceSec?: number,
  rows?: ExistingRow[],
): Map<string, ExistingHit | null> {
  const tol = resolveTolerance(toleranceSec);
  const out = new Map<string, ExistingHit | null>();
  if (!Array.isArray(qs) || qs.length === 0) return out;

  const valid = qs.filter((q) => q && q.id && normalizeTitle(q.title));
  const cands = valid.length === 0 ? [] : rows ?? fetchCandidates(valid);
  for (const q of qs) {
    if (!q || !q.id) continue;
    out.set(q.id, normalizeTitle(q.title) ? pickBestOne(q, cands, tol) : null);
  }
  return out;
}
