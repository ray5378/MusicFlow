// 生成「艺人别名子集」——**按地区批量**抓取（比逐人搜索快两个数量级）。
//
// 为什么：逐人 `artist:"名字"` 搜索每人要 1~2 次请求，3000 人要 ~6000 请求，实测 3.8 小时只跑完
// 420 人还被 MusicBrainz 限流。改成 `artist?area=<地区>&limit=100&inc=aliases` 分页浏览：
// 一次请求拿 100 人（含别名），3000 人只需 30 次请求。
//
// 用法：
//   node scripts/gen-artist-alias-seed.mjs --by-area                 # 华语地区全量（推荐）
//   node scripts/gen-artist-alias-seed.mjs --by-area --max-pages 20  # 限量试跑
//   node scripts/gen-artist-alias-seed.mjs --limit 200               # 旧的逐人模式（慢，仅补漏）
//   node scripts/gen-artist-alias-seed.mjs --export-only             # 只把现有表导出成种子
//
// 地区：CN/TW/HK/MO/SG/MY（华语圈）。只收含汉字或有中文别名的人群，控制种子体积。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argVal = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
};
const SEED_PATH = argVal("--out") ? resolve(argVal("--out")) : resolve(root, "src/data/artist-alias-seed.json");
const DB_PATH = argVal("--db") ? resolve(argVal("--db")) : resolve(root, "data/musicflow.db");
const UA = "MusicFlow/4.14.34 ( https://github.com/ray5378/MusicFlow )";
/** 便于用本地桩服务验证分页/重试：MB_BASE=http://127.0.0.1:PORT */
const MB_BASE = process.env.MB_BASE || "https://musicbrainz.org/ws/2/";
const THROTTLE_MS = 1100;

const args = process.argv.slice(2);
const BY_AREA = args.includes("--by-area");
const EXPORT_ONLY = args.includes("--export-only");
const LIMIT = Number(argVal("--limit", 3000));
const MAX_PAGES = Number(argVal("--max-pages", 10000));
const NAMES = (argVal("--names", "") || "").split(",").map((s) => s.trim()).filter(Boolean);

const AREAS = ["CN", "TW", "HK", "MO", "SG", "MY"];

const norm = (v) => String(v ?? "").trim().toLowerCase();
const HAS_CJK = /[\u4e00-\u9fff]/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readSeed() {
  try {
    if (!existsSync(SEED_PATH)) return { version: 0, generatedAt: "", entries: [] };
    return JSON.parse(readFileSync(SEED_PATH, "utf8"));
  } catch {
    return { version: 0, generatedAt: "", entries: [] };
  }
}

async function mb(path, attempt = 0) {
  try {
    const res = await fetch(MB_BASE + path, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 503 || res.status === 429) {
      if (attempt < 5) {
        const wait = 3000 * (attempt + 1);
        console.log(`[seed] 限流 ${res.status}，${wait}ms 后重试（${attempt + 1}/5）`);
        await sleep(wait);
        return mb(path, attempt + 1);
      }
      return null;
    }
    if (!res.ok) {
      console.log(`[seed] HTTP ${res.status} ${path.slice(0, 60)}`);
      return null;
    }
    return res.json();
  } catch (e) {
    if (attempt < 2) {
      await sleep(2000);
      return mb(path, attempt + 1);
    }
    console.log(`[seed] 请求异常 ${path.slice(0, 50)}: ${e?.message || e}`);
    return null;
  }
}

function artistsFromDb(limit) {
  if (!existsSync(DB_PATH)) return [];
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db.prepare("SELECT DISTINCT artist AS a FROM songs WHERE artist <> '' ORDER BY artist").all();
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

/** 按地区批量拉：一次 100 人，带 aliases。 */
async function byArea(map) {
  let pages = 0;
  let artists = 0;
  for (const cc of AREAS) {
    // 用 ISO 代码查（`area:CN` 这种模糊搜索会把 "Mo‘ynoq"/"My Darling" 之类匹配进来，实测踩过）
    const s = await mb(`area?query=${encodeURIComponent(`iso:${cc}`)}&fmt=json&limit=5`);
    const area = (s?.areas ?? []).find(
      (a) => (a.type === "Country" || a.type === "Subdivision") && a.id,
    );
    if (!area?.id) {
      console.log(`[seed] ${cc} 地区未解析到（iso 查询无 Country/Subdivision 命中），跳过`);
      await sleep(THROTTLE_MS);
      continue;
    }
    console.log(`[seed] ${cc} = ${area.name}（${area.type}）${area.id}`);
    await sleep(THROTTLE_MS);
    let offset = 0;
    let total = Infinity;
    console.log(`[seed] ${cc} (${area.name}) 开始分页…`);
    while (offset < total && pages < MAX_PAGES) {
      const b = await mb(
        `artist?area=${area.id}&limit=100&offset=${offset}&inc=aliases&fmt=json`,
      );
      if (!b) break;
      total = Number(b["artist-count"] ?? 0);
      const list = b.artists ?? [];
      if (!list.length) break;
      for (const a of list) {
        artists++;
        const names = [a.name, ...(a.aliases ?? []).map((x) => x.name)].filter(Boolean);
        const zh = names.filter((n) => HAS_CJK.test(n));
        // 只收华语相关：本人名或别名里有汉字
        if (!zh.length) continue;
        for (const n of names) {
          if (n === a.name) continue;
          map.set(`${norm(n)}|${norm(a.name)}`, [n, a.name, "alias"]);
        }
        map.set(`${norm(a.name)}|${norm(a.name)}`, [a.name, a.name, "alias"]);
      }
      offset += list.length;
      pages++;
      if (pages % 10 === 0) {
        console.log(`[seed] 已 ${pages} 页 / ${artists} 人 / ${map.size} 条（${cc} ${offset}/${total}）`);
      }
      await sleep(THROTTLE_MS);
    }
  }
  return { pages, artists };
}

/** 逐人搜索（补漏用）；只对含汉字的艺人。 */
async function byNames(names, map) {
  let i = 0;
  for (const name of names) {
    i++;
    const s = await mb(`artist?query=${encodeURIComponent(`artist:"${name}"`)}&fmt=json&limit=1`);
    const hit = s?.artists?.[0];
    if (hit && (hit.score ?? 0) >= 95) {
      for (const al of hit.aliases ?? []) map.set(`${norm(al.name)}|${norm(hit.name)}`, [al.name, hit.name, "alias"]);
      map.set(`${norm(name)}|${norm(hit.name)}`, [name, hit.name, "alias"]);
      await sleep(THROTTLE_MS);
      const d = await mb(`artist/${hit.id}?inc=artist-rels&fmt=json`);
      for (const rel of d?.relations ?? []) {
        if (rel.type !== "member of band" || !rel.artist?.name) continue;
        map.set(`${norm(rel.artist.name)}|${norm(d.name)}`, [rel.artist.name, d.name, "member_of"]);
        map.set(`${norm(d.name)}|${norm(rel.artist.name)}`, [d.name, rel.artist.name, "member_of"]);
      }
    }
    if (i % 20 === 0) console.log(`[seed] ${i}/${names.length} …累计 ${map.size} 条`);
    await sleep(THROTTLE_MS);
  }
}

async function main() {
  const seed = readSeed();
  const map = new Map();
  for (const [a, c, k] of seed.entries ?? []) map.set(`${norm(a)}|${norm(c)}`, [a, c, k || "alias"]);

  if (EXPORT_ONLY) {
    for (const r of existingEntriesFromDb()) map.set(`${norm(r.alias)}|${norm(r.canonical)}`, [r.alias, r.canonical, r.kind]);
  } else if (BY_AREA) {
    const stat = await byArea(map);
    console.log(`[seed] 地区抓取完成：${stat.pages} 页 / ${stat.artists} 人 / 累计 ${map.size} 条`);
  } else {
    const names = NAMES.length ? NAMES : artistsFromDb(LIMIT);
    console.log(`[seed] 逐人模式：${names.length} 位`);
    await byNames(names, map);
  }

  const entries = [...map.values()]
    .filter(([a, c]) => norm(a) !== norm(c)) // 自反条目无意义
    .sort((x, y) => norm(x[0]).localeCompare(norm(y[0])));
  const before = (seed.entries ?? []).length;
  const out = {
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
