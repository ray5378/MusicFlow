// 一次性数据修复：无损容器存量行的 bit_rate 垃圾值回填。
// 根因见 src/services/source/scanner.ts 的 LOSSLESS_SIZE_BITRATE_EXTS 注释：
// music-metadata 对截断头部解析出的 format.bitrate 是「到手字节/时长」的估算
// （240 实测：49,358 首 flac 库值平均只有真实值 1/202；2,665 首 w: 行 bit_rate=0）。
// 判据（保守，只动明显错的行）：库值 < 真实换算值(size*8/duration/1000) 的一半 → 重算。
// 幂等：反复执行无副作用。用法：
//   node scripts/backfill-lossless-bitrate.mjs [--db /path/musicflow.db] [--dry-run]
// 缺省 --db 时按 DATA_DIR 环境变量解析（<DATA_DIR>/musicflow.db，与服务端同布局）。
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dbIdx = args.indexOf("--db");
let dbPath = dbIdx >= 0 ? args[dbIdx + 1] : "";
if (!dbPath) {
  const dataDir = process.env.DATA_DIR || "";
  if (!dataDir) {
    console.error("缺少 --db <path> 或 DATA_DIR 环境变量");
    process.exit(1);
  }
  dbPath = path.join(dataDir, "musicflow.db");
}
if (!fs.existsSync(dbPath)) {
  console.error("数据库不存在: " + dbPath);
  process.exit(1);
}

const db = new Database(dbPath);
const LOSSLESS = "('flac','wav','ape','aiff','aif','wv')";
const where =
  "suffix IN " + LOSSLESS + " AND COALESCE(size,0) > 0 AND COALESCE(duration,0) > 0" +
  " AND (bit_rate IS NULL OR bit_rate < (size * 8.0 / duration) / 2000)";

const before = db.prepare("SELECT COUNT(*) AS n FROM songs WHERE " + where).get();
console.log("待修复行数: " + before.n + " (db=" + dbPath + (dryRun ? " ,dry-run" : "") + ")");
const sample = db
  .prepare("SELECT id, suffix, bit_rate, size, duration FROM songs WHERE " + where + " LIMIT 5")
  .all();
for (const r of sample) {
  const real = Math.round((r.size * 8) / r.duration / 1000);
  console.log(
    "  样例 " + r.id + " [" + r.suffix + "] bit_rate=" + r.bit_rate + " -> " + real +
    "kbps (size=" + r.size + ", dur=" + r.duration + "s)",
  );
}
if (!dryRun) {
  const res = db
    .prepare(
      "UPDATE songs SET bit_rate = CAST((size * 8.0 / duration) / 1000 + 0.5 AS INTEGER) WHERE " + where,
    )
    .run();
  console.log("已回填: " + res.changes + " 行");
}
db.close();
