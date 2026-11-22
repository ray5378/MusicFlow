// ==================== 艺人别名 / 成员关系（MusicBrainz CC0，自动同步） ====================
//
// 为什么：歌词归属判定里「A-Lin vs 黄丽玲」「BEYOND vs 黄家驹」「여자친구 vs G-Friend」
// 这类是**实体别名**问题，不是字形问题，规则推不出来。实测 MusicBrainz 正好覆盖：
//   A-Lin → 别名 黄丽玲/黃麗玲；BEYOND → 成员 黃家駒；叶蒨文 → 别名 叶倩文；吴奇隆 → 小虎隊。
// 数据 CC0（公共领域），可自由使用。
//
// 设计（用户定调 2026-11-23）：
//   · 只同步**华语相关**（本曲库里含汉字的艺人名），不搬全库；
//   · **本项目自动更新**：启动后与每 6 小时跑一次，每轮限量，断点续跑，不阻塞主流程；
//   · 不做后台手工补充入口；
//   · 查不到就放行（不否决）—— 只用来「把已经对上的救回来」，绝不反向猜。
import { sqlite } from "../db/index.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("artist-alias");
import { getSetting, setSetting } from "./settings.js";
import { artistTokens, nameCloseMatch, normKey } from "./fetch/tagTrust.js";
import { applyVariant } from "../utils/chineseConv.js";

const CURSOR_KEY = "artistAlias.syncCursor";
const SYNTH_UA = "MusicFlow/4.14.34 ( https://github.com/ray5378/MusicFlow )";
const THROTTLE_MS = 1100; // MusicBrainz 要求 ≤1 req/s
/** 每轮最多处理多少个新艺人（1.1s/个 ⇒ 300 个约 5.5 分钟） */
const PER_RUN = Number(process.env.MF_ALIAS_PER_RUN || 300);
/** 已同步过的艺人多久后重查一次（天） */
const REFRESH_DAYS = 180;

/** 别名归一（**唯一口径**）：简繁 + 去标点 + 小写。写入与查询必须都用它。 */
export function aliasNorm(v: unknown): string {
  return normKey(applyVariant(String(v ?? ""), "simplified"));
}

const nrm = aliasNorm;

const HAS_CJK = /[\u4e00-\u9fff]/;

/**
 * 两个艺人名是否「同一实体」——通过别名表判定。
 * 命中规则：任一方向的 (alias → canonical) 或 (canonical → alias) 相等。
 * 表里没有就返回 false（调用方保持原有判定，不做额外否决）。
 */
export function aliasRelated(a: unknown, b: unknown): boolean {
  const na = nrm(a);
  const nb = nrm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  try {
    const rows = sqlite
      .prepare(
        "SELECT alias_norm, canonical_norm FROM artist_alias WHERE alias_norm IN (?, ?) OR canonical_norm IN (?, ?)",
      )
      .all(na, nb, na, nb) as Array<{ alias_norm: string; canonical_norm: string }>;
    for (const r of rows) {
      // a 是别名、b 是正名（或反之）
      if (r.alias_norm === na && r.canonical_norm === nb) return true;
      if (r.alias_norm === nb && r.canonical_norm === na) return true;
      // 同正名的两个别名（黄丽玲 / LI Ling Huang）
      if (r.canonical_norm === nb) {
        const sib = sqlite
          .prepare("SELECT 1 FROM artist_alias WHERE canonical_norm = ? AND alias_norm = ? LIMIT 1")
          .get(r.canonical_norm, na);
        if (sib) return true;
      }
    }
    return false;
  } catch {
    return false; // 表不存在（老库未建）时静默降级
  }
}

/** 供歌词判定用：分词后任一组合能通过别名表即算一致。 */
export function artistAliasMatch(local: unknown, remote: unknown): boolean {
  const a = artistTokens(local);
  const b = artistTokens(remote);
  if (!a.length || !b.length) return false;
  for (const x of a) {
    for (const y of b) {
      if (aliasRelated(x, y) || nameCloseMatch(x, y)) return true;
    }
  }
  return false;
}

interface MBSearchArtist {
  id: string;
  name: string;
  score?: number;
  aliases?: Array<{ name: string }>;
}

/** 待同步的艺人：库里含汉字、且没同步过或已过期。 */
function nextArtists(limit: number): string[] {
  const staleBefore = new Date(Date.now() - REFRESH_DAYS * 86400_000).toISOString();
  const rows = sqlite
    .prepare(
      `SELECT DISTINCT s.artist AS name
         FROM songs s
         LEFT JOIN artist_alias_sync y ON y.norm = s.artist
        WHERE s.artist IS NOT NULL AND s.artist <> ''
          AND (y.norm IS NULL OR y.status = 'error' OR (y.updated_at < ? AND y.status <> 'done'))
        ORDER BY s.artist ASC
        LIMIT ?`,
    )
    .all(staleBefore, limit * 4) as Array<{ name: string }>;
  // 只留含汉字的（华语相关）；同一归一值只取一次
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    if (!HAS_CJK.test(r.name)) continue;
    const k = nrm(r.name);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(r.name);
    if (out.length >= limit) break;
  }
  return out;
}

function upsertSync(name: string, mbid: string | null, status: "done" | "not_found" | "error"): void {
  sqlite
    .prepare(
      `INSERT INTO artist_alias_sync (artist, norm, mbid, status, updated_at) VALUES (?,?,?,?,?)
       ON CONFLICT(artist) DO UPDATE SET norm=excluded.norm, mbid=excluded.mbid, status=excluded.status, updated_at=excluded.updated_at`,
    )
    .run(name, nrm(name), mbid, status, new Date().toISOString());
}

function insertAlias(alias: string, canonical: string, kind: "alias" | "member_of"): void {
  const an = nrm(alias);
  const cn = nrm(canonical);
  if (!an || !cn || an === cn) return;
  sqlite
    .prepare(
      `INSERT INTO artist_alias (alias, alias_norm, canonical, canonical_norm, kind, source, updated_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(alias_norm, canonical_norm) DO UPDATE SET updated_at=excluded.updated_at`,
    )
    .run(alias, an, canonical, cn, kind, "musicbrainz", new Date().toISOString());
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mbJson(path: string): Promise<any | null> {
  try {
    const res = await fetch("https://musicbrainz.org/ws/2/" + path, {
      headers: { "User-Agent": SYNTH_UA, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 503 || res.status === 429) {
      log.warn(`[alias-sync] MusicBrainz 限流 ${res.status}，本轮提前结束`);
      return null;
    }
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** 同步一个艺人：别名 + band 成员关系。返回是否成功写入。 */
async function syncOne(name: string): Promise<"done" | "not_found" | "error"> {
  const search = await mbJson(
    `artist?query=${encodeURIComponent(`artist:"${name}"`)}&fmt=json&limit=1`,
  );
  if (!search) return "error";
  const hit = (search.artists ?? [])[0] as MBSearchArtist | undefined;
  if (!hit || (hit.score ?? 0) < 95 || !(nrm(hit.name) === nrm(name) || nameCloseMatch(hit.name, name))) {
    upsertSync(name, null, "not_found");
    return "not_found";
  }
  for (const al of hit.aliases ?? []) insertAlias(al.name, hit.name, "alias");
  insertAlias(name, hit.name, "alias"); // 本地写法也登记，避免大小写/字形差异

  await sleep(THROTTLE_MS);
  const detail = await mbJson(`artist/${hit.id}?inc=artist-rels&fmt=json`);
  if (detail) {
    for (const rel of detail.relations ?? []) {
      if (rel.type !== "member of band" || !rel.artist?.name) continue;
      // 双向登记：成员 ↔ 乐队
      insertAlias(rel.artist.name, detail.name, "member_of");
      insertAlias(detail.name, rel.artist.name, "member_of");
    }
  }
  upsertSync(name, hit.id, "done");
  return "done";
}

let running = false;

/** 跑一轮同步（限量、可续跑、失败退避）。返回统计。 */
export async function syncArtistAliases(opts: { max?: number } = {}): Promise<{
  processed: number;
  done: number;
  notFound: number;
  error: number;
  skipped: boolean;
}> {
  if (running) return { processed: 0, done: 0, notFound: 0, error: 0, skipped: true };
  running = true;
  const budget = Math.max(1, Math.min(opts.max ?? PER_RUN, 2000));
  const names = nextArtists(budget);
  let done = 0,
    notFound = 0,
    error = 0;
  try {
    if (names.length) log.info(`[alias-sync] 本轮待同步 ${names.length} 位艺人（上限 ${budget}）`);
    for (const name of names) {
      const r = await syncOne(name);
      if (r === "done") done++;
      else if (r === "not_found") notFound++;
      else {
        error++;
        // 限流时直接收工，下一轮再来
        if (error === 1 && done === 0 && notFound === 0) break;
      }
      setSetting(CURSOR_KEY, JSON.stringify({ last: name, at: Date.now() }));
      await sleep(THROTTLE_MS);
    }
    if (names.length) {
      log.info(`[alias-sync] 本轮完成：命中 ${done} / 未命中 ${notFound} / 失败 ${error}`);
    }
  } finally {
    running = false;
  }
  return { processed: names.length, done, notFound, error, skipped: false };
}

/** 统计（给接口/自省用）。 */
export function getArtistAliasStats(): { aliasRows: number; syncedArtists: number; pending: number } {
  try {
    const aliasRows = (sqlite.prepare("SELECT COUNT(*) c FROM artist_alias").get() as { c: number }).c;
    const syncedArtists = (sqlite.prepare("SELECT COUNT(*) c FROM artist_alias_sync").get() as { c: number })
      .c;
    const pending = nextArtists(500).length;
    return { aliasRows, syncedArtists, pending };
  } catch {
    return { aliasRows: 0, syncedArtists: 0, pending: 0 };
  }
}

/** 启动后与定时自动更新（每 6 小时一轮，每轮限量）。 */
export function startArtistAliasScheduler(): void {
  const run = (tag: string) => {
    void syncArtistAliases()
      .then((r) => {
        if (!r.skipped && r.processed > 0) {
          log.info(`[alias-sync] ${tag}：处理 ${r.processed}（命中 ${r.done}）`);
        }
      })
      .catch((e) => log.warn(`[alias-sync] ${tag} 异常: ${e instanceof Error ? e.message : e}`));
  };
  // 启动 3 分钟后第一轮（避开启动高峰）
  setTimeout(() => run("boot"), 3 * 60_000);
  setInterval(() => run("定时"), 6 * 3600_000);
}
