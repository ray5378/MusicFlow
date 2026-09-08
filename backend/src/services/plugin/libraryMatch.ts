// ==================== 导入前库内匹配(方案A:先匹配库、缺了才进) ====================
//
// 歌单/专辑搜索「加入库」导入前,先按元数据在曲库里找已有行(本地文件 /
// WebDAV / 其它平台 web 行),命中的歌直接绑旧行、不再插新行——与榜单同步
// (插件 runDailyJob → matchLocal)的行为对齐,消除两条导入路径的差异:
// 榜单同步是「先匹配本地库、未命中才入库」,而搜索导入此前是「直接入库成新行」,
// 同一首歌(已在曲库)会多出一行 source=导入平台 的重复行。
//
// 匹配语义(与 matchLocal 同阈值):
//   - 标题硬:归一化后精确相等(经 group_key 前缀定位,见下);
//   - 歌手硬:归一化后互相包含(处理 "G.E.M.邓紫棋" vs "邓紫棋"),不符 =
//     同名异曲,直接排除,绝不退而求其次绑同名歌;
//   - 时长软:双方均 >0 且差 ≤5s 加分(多版本择优,不否决);
//   - 专辑软:归一化一致加分;
//   - 过线:期望歌手时须 140(歌名 100 + 歌手 40),无歌手信息时歌名精确即可;
//   - 同分并列:本地/WebDAV 行优先于 web 行(绑旧行的目的就是复用可直连的源),
//     再按时长差最小择优。
//
// 候选定位:group_key = 归一化标题 \u0001 归一化歌手 \u0001 归一化专辑。一次
// 全量扫描(只取小列)构建「归一化标题 → 候选行」索引,单次导入 O(表大小)
// 一次 + O(N) 匹配,不做逐首 LIKE(避免 N 次全表扫)。仅 group_key 非空的行
// 可被匹配(同曲多源组默认开启,本地扫描/在线导入都会回填;关闭分组的存量行
// 不可匹配,回退原行为直接入库)。
//
// 本索引为调用方局部变量(单次导入构建、用完即弃),不跨调用缓存——导入是
// 离散交互操作,复用价值低于内存占用。

import { sqlite } from "../../db/index.js";
import { normalizeGroupText } from "../../utils/songGroup.js";

interface LibCandidate {
  id: string;
  type: string | null;
  artist: string | null;
  album: string | null;
  duration: number | null;
}

/**
 * 紧缩归一:normalizeGroupText 基础上再删全部内部空白。括号前空格
 * (「甲乙丙丁 (你我怎么两清)」vs「甲乙丙丁(你我怎么两清)」)等跨平台
 * 写法差异靠它归一。只用于本匹配器,不改全局分组归一化(存量 group_key
 * 语义不变)。
 */
function tight(s: string): string {
  return normalizeGroupText(s).replace(/[\s\u00a0]+/g, "");
}

/** 归一化标题 → 候选行索引(从 group_key 前缀拆出标题)。 */
function buildTitleIndex(): Map<string, LibCandidate[]> {
  const rows = sqlite
    .prepare("SELECT id, type, artist, album, duration, group_key FROM songs WHERE group_key IS NOT NULL AND group_key != ''")
    .all() as { id: string; type: string | null; artist: string | null; album: string | null; duration: number | null; group_key: string }[];
  const idx = new Map<string, LibCandidate[]>();
  for (const r of rows) {
    const sep = r.group_key.indexOf("\u0001");
    const nt = sep >= 0 ? r.group_key.slice(0, sep) : r.group_key;
    const key = tight(nt);
    if (!key) continue;
    let arr = idx.get(key);
    if (!arr) { arr = []; idx.set(key, arr); }
    arr.push({ id: r.id, type: r.type, artist: r.artist, album: r.album, duration: r.duration });
  }
  return idx;
}

/** 单首匹配:返回已有行 songId,未命中返回 null。 */
function matchOne(
  idx: Map<string, LibCandidate[]>,
  song: { name?: string | null; title?: string | null; artist?: string | null; album?: string | null; duration?: number | null },
): string | null {
  const nt = tight(song.name || song.title || "");
  if (!nt) return null;
  const na = tight(song.artist || "");
  const nal = tight(song.album || "");
  const candidates = idx.get(nt);
  if (!candidates?.length) return null;
  const dur = Number(song.duration || 0);

  let best: { id: string; score: number; local: number; diff: number } | null = null;
  for (const c of candidates) {
    let sc = 100; // 歌名已精确(归一)相等
    if (na) {
      const ha = tight(c.artist || "");
      if (!ha || (ha.indexOf(na) < 0 && na.indexOf(ha) < 0)) continue; // 歌手不符 = 同名异曲
      sc = 140;
    }
    const rd = Number(c.duration || 0);
    let diff = Number.MAX_SAFE_INTEGER;
    if (dur > 0 && rd > 0) {
      diff = Math.abs(rd - dur);
      if (diff <= 5) sc += 10; // 时长软:多版本择优,不否决
    }
    if (nal && tight(c.album || "") === nal) sc += 5; // 专辑软
    const local = c.type && c.type !== "web" ? 0 : 1; // 本地/WebDAV 优先
    if (
      !best ||
      sc > best.score ||
      (sc === best.score && (local < best.local || (local === best.local && diff < best.diff)))
    ) {
      best = { id: c.id, score: sc, local, diff };
    }
  }
  // 过线:期望歌手时须 140,无歌手信息时歌名精确即可(与榜单同步 matchLocal 同阈值)
  return best && ((na && best.score >= 140) || (!na && best.score >= 100)) ? best.id : null;
}

/**
 * 批量库内匹配:对每首歌返回已有行 songId 或 null(与入参等长、顺序对齐)。
 * 单次调用构建一次标题索引,适合整单导入前的一次性匹配。
 */
export function matchSongsToLibrary(
  songs: { name?: string | null; title?: string | null; artist?: string | null; album?: string | null; duration?: number | null }[],
): (string | null)[] {
  if (!songs.length) return [];
  let idx: Map<string, LibCandidate[]>;
  try {
    idx = buildTitleIndex();
  } catch {
    // 索引构建失败(如引擎异常)时静默降级:全部不匹配,回退原入库行为。
    return songs.map(() => null);
  }
  return songs.map((s) => matchOne(idx, s));
}
