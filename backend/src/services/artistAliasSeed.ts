// ==================== 艺名子集的「内置种子」加载 ====================
//
// 用户定调（2026-11-23）：别名表要**项目内置离线子集**，并且项目能定期更新它。
// 所以分两层：
//   ① 种子层（本文件）：data/artist-alias-seed.json 随镜像发布，启动时按 version 增量灌库，
//      无网络也能用；
//   ② 增补层（artistAlias.ts 的定时同步）：联网缓慢扩充本实例的别名表，并把结果导出成新的
//      种子快照，供下次发版内置（scripts/gen-artist-alias-seed.mjs 生成）。
//
// 种子文件结构（体积很小，只有三列）：
//   { "version": 3, "generatedAt": "...", "entries": [["黄丽玲","A-Lin","alias"], ...] }
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sqlite } from "../db/index.js";
import { aliasNorm } from "./artistAlias.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("artist-alias");

export interface AliasSeed {
  version: number;
  generatedAt: string;
  entries: Array<[string, string, string?]>;
}

/** 种子文件位置：源码与编译产物都能找到（dist/data 与 src/data 各放一份由构建脚本复制）。 */
function seedPaths(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [join(here, "..", "data", "artist-alias-seed.json"), join(here, "data", "artist-alias-seed.json")];
}

export function readSeed(): AliasSeed | null {
  for (const p of seedPaths()) {
    try {
      if (!existsSync(p)) continue;
      const raw = JSON.parse(readFileSync(p, "utf8")) as AliasSeed;
      if (!raw || !Array.isArray(raw.entries)) continue;
      return raw;
    } catch {
      /* 尝试下一个路径 */
    }
  }
  return null;
}

const APPLIED_KEY = "artistAlias.seedVersion";

/**
 * 启动时灌种子：只有种子 version 比已应用的更高才写（幂等、可重复）。
 * 单事务批量 upsert，几万行也在百毫秒级。
 */
export function applySeedIfNeeded(): { applied: boolean; version?: number; rows?: number } {
  const seed = readSeed();
  if (!seed) return { applied: false };
  let applied = 0;
  try {
    applied = Number(
      (sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(APPLIED_KEY) as
        | { value: string }
        | undefined)?.value ?? 0,
    );
  } catch {
    return { applied: false };
  }
  if (!Number.isFinite(applied) || seed.version <= applied) return { applied: false, version: seed.version };

  // ⚠️ 必须与 artistAlias.aliasNorm 完全一致，否则灌进去的行查不到（真机踩过）
  const norm = aliasNorm;
  const stmt = sqlite.prepare(
    `INSERT INTO artist_alias (alias, alias_norm, canonical, canonical_norm, kind, source, updated_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(alias_norm, canonical_norm) DO NOTHING`,
  );
  const now = new Date().toISOString();
  let rows = 0;
  const tx = sqlite.transaction(() => {
    for (const [alias, canonical, kind] of seed.entries) {
      const a = String(alias ?? "").trim();
      const c = String(canonical ?? "").trim();
      const an = norm(a);
      const cn = norm(c);
      if (!a || !c || !an || !cn || an === cn) continue;
      stmt.run(a, an, c, cn, kind === "member_of" ? "member_of" : "alias", "seed", now);
      rows += 1;
    }
    sqlite
      .prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(APPLIED_KEY, String(seed.version));
  });
  try {
    tx();
    log.info(`[alias-seed] 已灌入内置别名种子 v${seed.version}：${rows} 条（覆盖日期 ${seed.generatedAt}）`);
    return { applied: true, version: seed.version, rows };
  } catch (e) {
    log.warn(`[alias-seed] 灌入失败: ${e instanceof Error ? e.message : e}`);
    return { applied: false };
  }
}

/** 把当前表导出成种子（供发版内置；由 scripts/gen-artist-alias-seed.mjs 调用）。 */
export function exportSeedSnapshot(version: number): AliasSeed {
  const rows = sqlite
    .prepare("SELECT alias, canonical, kind FROM artist_alias ORDER BY alias_norm ASC")
    .all() as Array<{ alias: string; canonical: string; kind: string }>;
  return {
    version,
    generatedAt: new Date().toISOString().slice(0, 10),
    entries: rows.map((r) => [r.alias, r.canonical, r.kind]),
  };
}
