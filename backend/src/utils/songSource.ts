// 在线(web)歌曲的来源解析:songs.source_data.source(平台 id)+ plugin_entry(插件 id)。
// 所有歌曲序列化点统一经此函数暴露来源字段,供前端渲染「来源」列(平台徽标 + 插件名)。
// 本地歌曲不是 web 类型,一律返回空来源(前端不显示徽标)。
import { isCapabilityEnabled } from "../plugins/registry.js";
export interface SongSourceInfo {
  isWeb: boolean;
  /** 平台 id,如 netease / qq / kugou;未知平台为空串 */
  sourcePlatform: string;
  /** 来源插件 id,如 go-music-dl;非插件来源为空串 */
  sourcePluginId: string;
}

export function songSourceInfo(song: {
  type?: string | null;
  pluginEntry?: string | null;
  sourceData?: string | null;
  path?: string | null;
}): SongSourceInfo {
  if (song.type !== "web") return { isWeb: false, sourcePlatform: "", sourcePluginId: "" };
  const pluginId = song.pluginEntry || "";
  let source = "";
  try {
    const sd = JSON.parse(song.sourceData || "{}");
    if (sd && typeof sd.source === "string") source = sd.source;
  } catch {
    // source_data 损坏则忽略,走 path 兜底
  }
  if (!source && song.path) {
    // path 约定 "web:<plugin>:<source>";早期版本可能缺 source(退化为 "web:<plugin>")。
    const rest = (song.path || "").replace(/^web:/, "");
    const idx = rest.lastIndexOf(":");
    if (idx > 0) {
      const plugin = rest.slice(0, idx);
      const cand = rest.slice(idx + 1);
      if (cand && cand !== plugin) source = cand;
    }
  }
  return { isWeb: true, sourcePlatform: source, sourcePluginId: pluginId };
}

// ==================== 客户端歌曲行序列化 + 组内多源 ====================
// 统一输出点:全部歌曲 /v1/songs、歌单详情 items、songToChild(收藏页)。
// 主行与 sources(组内各源行)用同一序列化,前端合并展示/展开子行/播放优选
// 都消费这些字段。

export interface ClientSongRow {
  id: string;
  title: string;
  artist: string;
  album: string;
  artistId?: string | null;
  albumId?: string | null;
  duration: number;
  bitRate: number;
  suffix: string;
  contentType: string;
  size: number;
  playCount: number;
  genre: string;
  track: number;
  discNumber: number;
  coverArt?: string;
  /** 行类型:local | webdav | web(前端据此区分本地源与平台源) */
  type: string;
  sourcePlatform: string;
  sourcePluginId: string;
  isWeb: boolean;
  groupId?: string;
  /** 入库时间(ISO 字符串;列表页排序维度之一,亦用于展示「入库时间」列) */
  createdAt: string;
  /** 组内多源行(含自身;单成员组长度为 1)。仅 attachGroupSources 填充。 */
  sources?: ClientSongRow[];
}

/** 歌曲行 → 客户端字段。coverRef 由调用方按上下文解析(专辑封面映射/自身封面),
 *  不传时回退到自身 cover_art。 */
export function serializeSongRow(s: any, coverRef?: string): ClientSongRow {
  const src = songSourceInfo(s);
  return {
    id: s.id,
    title: s.title,
    artist: s.artist || "",
    album: s.album || "",
    artistId: s.artistId,
    albumId: s.albumId,
    duration: s.duration || 0,
    bitRate: s.bitRate || 0,
    suffix: s.suffix || "mp3",
    contentType: s.contentType || "audio/mpeg",
    size: s.size || 0,
    playCount: s.playCount || 0,
    genre: s.genre || "",
    track: s.track || 0,
    discNumber: s.discNumber || 1,
    coverArt: coverRef !== undefined ? coverRef : (s.coverArt ? `so-${s.id}` : undefined),
    type: s.type || "local",
    sourcePlatform: src.sourcePlatform,
    sourcePluginId: src.sourcePluginId,
    isWeb: src.isWeb,
    groupId: s.groupId || undefined,
    createdAt: s.createdAt || "",
  };
}

// 组内优先级:核心曲库(local) > WebDAV > 插件平台(web)
const GROUP_TYPE_ORDER: Record<string, number> = { local: 0, webdav: 1, web: 2 };

/** 组内成员排序:核心曲库优先,同类型按标题。主行 = 排序后第一项。 */
export function groupMemberSort(a: { type?: string | null; title?: string | null }, b: { type?: string | null; title?: string | null }): number {
  const ta = GROUP_TYPE_ORDER[a.type || "local"] ?? 3;
  const tb = GROUP_TYPE_ORDER[b.type || "local"] ?? 3;
  if (ta !== tb) return ta - tb;
  return (a.title || "").localeCompare(b.title || "");
}

/**
 * 歌曲封面回退链(与主行/v1.13.24 统一规则):
 * 自带封面 → so-<id>;否则专辑回退 al-<albumId>。专辑行即使不存在也照给,
 * 图片解析交给 getCoverArt 的 al- 分支(404 时前端自动落占位)。
 */
export function resolveSongCover(song: any): string | undefined {
  if (!song) return undefined;
  return song.coverArt ? `so-${song.id}` : (song.albumId ? `al-${song.albumId}` : undefined);
}

/**
 * 给已序列化的行附加组内多源。调用方负责一次批量查组成员行(rows,含
 * groupId 列),这里按组合并、排序(local > webdav > web)后填入 item.sources。
 * 单成员组也会填(长度 1),前端统一按「有无多源」判断合并展示。
 * resolveCover 可选:成员行封面解析(缺省回退自身 cover_art)。不传时 local
 * 成员(无自带封面)会输出空 coverArt → 前端合并主行占位,故调用方务必传入。
 */
export function attachGroupSources(
  items: ClientSongRow[],
  memberRows: any[],
  resolveCover?: (song: any) => string | undefined,
): void {
  // 插件总开关:同曲多源组(songGroup)关闭时不输出 sources —— 前端/客户端
  // 依赖 sources.length>1 判断合并,不输出即自然回到平铺展示,端侧零改动。
  if (!isCapabilityEnabled("songGroup")) return;
  const byGroup = new Map<string, any[]>();
  for (const r of memberRows) {
    if (!r.groupId) continue;
    let arr = byGroup.get(r.groupId);
    if (!arr) { arr = []; byGroup.set(r.groupId, arr); }
    arr.push(r);
  }
  for (const item of items) {
    if (!item.groupId) continue;
    const members = byGroup.get(item.groupId);
    if (!members || members.length === 0) continue;
    item.sources = [...members].sort(groupMemberSort).map((m) =>
      serializeSongRow(m, resolveCover ? resolveCover(m) : undefined),
    );
  }
}
