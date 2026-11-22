// 生成「艺人别名种子」：把本库含汉字的艺人拿去 MusicBrainz 查别名/成员关系，
// 产出 src/data/artist-alias-seed.json（随发版内置，运行期离线可用）。
//
// 用法：
//   node scripts/gen-artist-alias-seed.mjs                 # 从 data/musicflow.db 取艺人，限量 3000
//   node scripts/gen-artist-alias-seed.mjs --limit 200     # 只跑前 200 位（试跑）
//   node scripts/gen-artist-alias-seed.mjs --export-only   # 只把现有 artist_alias 表导出成种子
//   node scripts/gen-artist-alias-seed.mjs --names a,b,c   # 指定艺人名（调试）
//
// 纪律：MusicBrainz 要求 ≤1 req/s 且必须带联系方式的 User-Agent。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argOut = (() => {
  const i = process.argv.indexOf("--out");
  return i >= 0 ? process.argv[i + 1] : null;
})();
const SEED_PATH = argOut ? resolve(argOut) : resolve(root, "src/data/artist-alias-seed.json");
const DB_PATH = (() => {
  const i = process.argv.indexOf("--db");
  return i >= 0 ? resolve(process.argv[i + 1]) : resolve(root, "data/musicflow.db");
})();
const UA = "MusicFlow/4.14.34 ( https://github.com/ray5378/MusicFlow )";
const THROTTLE_MS = 1600;

const args = process.argv.slice(2);
const argVal = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const LIMIT = Number(argVal("--limit", 3000));
const EXPORT_ONLY = args.includes("--export-only");
const NAMES = (argVal("--names", "") || "").split(",").map((s) => s.trim()).filter(Boolean);

const norm = (v) => String(v ?? "").trim().toLowerCase();
const HAS_CJK = /[\u4e00-\u9fff]/;

function readExisting() {
  try {
    if (!existsSync(SEED_PATH)) return { version: 0, generatedAt: "", entries: [] };
    return JSON.parse(readFileSync(SEED_PATH, "utf8"));
  } catch {
    return { version: 0, generatedAt: "", entries: [] };
  }
}

function artistsFromDb(limit) {
  if (!existsSync(DB_PATH)) return [];
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db
    .prepare("SELECT DISTINCT artist AS a FROM songs WHERE artist IS NOT NULL AND artist <> '' ORDER BY artist")
    .all();
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (!HAS_CJK.test(r.a)) continue;
    const k = norm(r.a);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r.a);
    if (out.length >= limit) break;
  }
  return out;
}

function existingEntriesFromDb() {
  if (!existsSync(DB_PATH)) return [];
  const db = new Database(DB_PATH, { readonly: true });
  try {
    return db.prepare("SELECT alias, canonical, kind FROM artist_alias").all();
  } catch {
    return [];
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function mb(path, attempt = 0) {
  try {
    const res = await fetch("https://musicbrainz.org/ws/2/" + path, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 503 || res.status === 429) {
      if (attempt < 3) {
        const wait = 5000 * (attempt + 1);
        console.warn(`[seed] ${res.status} 限流，${wait}ms 后重试（${attempt + 1}/3）`);
        await sleep(wait);
        return mb(path, attempt + 1);
      }
      return null;
    }
    if (!res.ok) {
      console.warn(`[seed] HTTP ${res.status} ${path.slice(0, 60)}`);
      return null;
    }
    return res.json();
  } catch (e) {
    if (attempt < 2) {
      await sleep(3000);
      return mb(path, attempt + 1);
    }
    console.warn(`[seed] 请求异常 ${path.slice(0, 50)}: ${e?.message || e}`);
    return null;
  }
}

async function main() {
  const seed = readExisting();
  const map = new Map();
  for (const [a, c, k] of seed.entries ?? []) map.set(`${norm(a)}|${norm(c)}`, [a, c, k || "alias"]);

  if (EXPORT_ONLY) {
    for (const r of existingEntriesFromDb()) map.set(`${norm(r.alias)}|${norm(r.canonical)}`, [r.alias, r.canonical, r.kind]);
  } else {
    const names = NAMES.length ? NAMES : artistsFromDb(LIMIT);
    console.log(`[seed] 待查艺人 ${names.length} 位，已有种子 ${map.size} 条`);
    let i = 0;
    for (const name of names) {
      i++;
      const s = await mb(`artist?query=${encodeURIComponent(`artist:"${name}"`)}&fmt=json&limit=1`);
      const hit = s?.artists?.[0];
      if (!hit || (hit.score ?? 0) < 95) {
        console.log(`[seed] ${i}/${names.length} ${name} 未命中${hit ? '（score ' + hit.score + '）' : ''}`);
        await sleep(THROTTLE_MS);
        continue;
      }
      for (const al of hit.aliases ?? []) {
        map.set(`${norm(al.name)}|${norm(hit.name)}`, [al.name, hit.name, "alias"]);
      }
      map.set(`${norm(name)}|${norm(hit.name)}`, [name, hit.name, "alias"]);

      await sleep(THROTTLE_MS);
      const d = await mb(`artist/${hit.id}?inc=artist-rels&fmt=json`);
      for (const rel of d?.relations ?? []) {
        if (rel.type !== "member of band" || !rel.artist?.name) continue;
        map.set(`${norm(rel.artist.name)}|${norm(d.name)}`, [rel.artist.name, d.name, "member_of"]);
        map.set(`${norm(d.name)}|${norm(rel.artist.name)}`, [d.name, rel.artist.name, "member_of"]);
      }
      if (i % 25 === 0) console.log(`[seed] ${i}/${names.length} …（${name} ✓ 累计 ${map.size} 条）`);
      await sleep(THROTTLE_MS);
    }
  }

  const entries = [...map.values()].sort((x, y) => norm(x[0]).localeCompare(norm(y[0])));
  const before = (seed.entries ?? []).length;
  const out = {
    // 条目没变就不升版本（避免无意义的种子版本滚动，灌库是按 version 增量触发的）
    version: entries.length === before ? seed.version ?? 1 : (seed.version ?? 0) + 1,
    generatedAt: new Date().toISOString().slice(0, 10),
    entries,
  };
  writeFileSync(SEED_PATH, JSON.stringify(out, null, 0) + "\n", "utf8");
  console.log(`[seed] 已写入 ${SEED_PATH}：v${out.version}，${entries.length} 条`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
