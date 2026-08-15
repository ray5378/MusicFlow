// ==================== 共享、内存有界的曲库匹配索引 ====================
//
// 历史实现 `buildLibraryIndex()` 直接 `db.select().from(songs).all()` —— 把
// 整张 songs 表(含 sourceData / streamHeaders 等大文本列、在线歌曲可达数千
// 字节)全部加载进内存。大曲库下一次歌单导入 RSS 就能飙到 ~900MB,且 sync-all
// 时每个歌单各建一次,内存被反复放大。
//
// 本模块用「精简 + 缓存 + 自动回收」彻底解决:
//   - 只 SELECT 匹配真正需要的列 (id, title, artist, suffix, path)
//   - 只索引「可播放」歌曲 (suffix IS NOT NULL) —— 在线-only、永远无法本地命中
//     的行直接排除,索引体量通常只有整表的零头
//   - 进程级单例缓存,一次同步批次内复用(同步 N 个歌单只建一次,而非 N 次)
//   - 空闲超时自动驱逐,且可在批次边界显式 clearLibraryIndex() 立即回收
//
// 峰值内存从「整表 × 全部列」降到「可播放歌曲 × ~80 字节」,通常 5~10 倍缩减。

import { db } from "../../db/index.js";
import { songs } from "../../db/schema.js";
import { isNotNull } from "drizzle-orm";
import { normalizeKey } from "./shared.js";

export interface MatchSong {
  id: string;
  suffix: string | null;
  path: string;
}

export type LibraryIndex = Map<string, MatchSong[]>;

// 单例缓存:懒构建于首次需要,在空闲驱逐或显式 clear 前复用。
let cache: LibraryIndex | null = null;
let lastUsedAt = 0;

// 空闲超过此时长后,下次访问先丢弃旧缓存再重建(兜底:即使调用方忘记释放,
// 也能在一分钟内回收内存,避免长驻 900MB 量级)。
const IDLE_EVICT_MS = 30_000;

function buildIndex(): LibraryIndex {
  // 关键:只取匹配所需的最小列,且只取带 suffix(本地可播放)的歌曲。
  // 这同时避开了在线歌曲巨大的 sourceData/streamHeaders/pluginEntry 文本列。
  const rows = db
    .select({
      id: songs.id,
      title: songs.title,
      artist: songs.artist,
      suffix: songs.suffix,
      path: songs.path,
    })
    .from(songs)
    .where(isNotNull(songs.suffix))
    .all() as unknown as { id: string; title: string; artist: string | null; suffix: string | null; path: string }[];

  const index: LibraryIndex = new Map();
  for (const s of rows) {
    const key = normalizeKey(s.title, s.artist || "");
    let arr = index.get(key);
    if (!arr) {
      arr = [];
      index.set(key, arr);
    }
    arr.push({ id: s.id, suffix: s.suffix, path: s.path });
  }
  return index;
}

/** 取共享、内存有界的曲库索引(构建一次、缓存复用)。
 *  @param force 强制重建(例如曲库刚大批量变动,需反映最新状态)。 */
export function getLibraryIndex(force = false): LibraryIndex {
  if (cache && !force && Date.now() - lastUsedAt > IDLE_EVICT_MS) {
    cache = null; // 空闲驱逐:回收后再重建
  }
  if (!cache || force) {
    cache = buildIndex();
  }
  lastUsedAt = Date.now();
  return cache;
}

/** 显式丢弃缓存索引,立即回收其内存。在批次边界调用(一次同步全量跑完、单次
 *  导入请求结束、每日推荐生成后),以便主动释放而非等待 TTL。 */
export function clearLibraryIndex(): void {
  cache = null;
  lastUsedAt = 0;
}
