// ==================== 歌曲分组(同一首歌的多源归组) ====================
//
// 核心概念:本地/WebDAV 曲库与插件平台(go-music-dl 等)可能收录同一首歌,
// 落库后成为多行独立记录。分组规则 = 「规范化标题 + 规范化歌手 + 规范化
// 专辑」完全相同 + 时长差 ≤ 1s(秒级容差,防误合并不同版本;专辑一致已
// 承担版本区分,时长从 ±3s 收紧到秒级)。组内成员按优先级
// local > webdav > web 排列,播放/展示可优选用核心曲库源。
//
// 时长规则:duration 为 0/空视为「未知时长」,不参与容差比较(两首未知时长
// 的同名歌不合并),避免把不同版本误并成一组。
//
// 分组不删除任何行:歌单条目/收藏/播放历史引用的仍是具体 songId,分组只是
// 在 songs 表上附加 group_id 列,展示层按组合并、播放层按组优选。

export const GROUP_DURATION_TOLERANCE = 1; // ±1s(秒级;v1.13.26 前为 ±3s)
/** 规范化分组文本:去首尾空白、全角空格→半角、折叠内部空白、转小写。
 *  括号/引号/书名号等装饰符号全局删除但保留内部内容——(Live)/(Remix) 的
 *  版本词保留在正文中,靠标题差异天然分到不同组(符合「靠专辑或时长区分
 *  版本」);而同一版本的 (Live)/[Live]/Live 写法差异被归一,可正确合并。
 *  破折号/分隔符/标点等其余装饰符号仅首尾剥离,避免误伤内部连字符。 */
export function normalizeGroupText(s: string): string {
  if (!s) return "";
  // 括号/引号/书名号:全局删除,保留内部版本词
  const PAIRED_DECOR = /[()[\]《》「」『』"'`]/g;
  // 其余装饰符号(破折号/分隔符/标点):仅首尾剥离
  const EDGE_DECOR = /^[\s\-–—·.、,;:!?~*#]+|[\s\-–—·.、,;:!?~*#]+$/g;
  return s
    .replace(/\u3000/g, " ")          // 全角空格 → 半角
    .replace(/[\s\u00a0]+/g, " ")     // 折叠各类空白
    .trim()
    .toLowerCase()
    .replace(PAIRED_DECOR, "")        // 删除括号类符号,保留内部内容
    .replace(EDGE_DECOR, "")          // 首尾剥离剩余装饰符号
    .trim();
}

/** 分组 key = 规范化标题 + 规范化歌手 + 规范化专辑(不可见分隔符防碰撞)。 */
export function songGroupKey(title: string, artist: string, album?: string | null): string {
  return `${normalizeGroupText(title)}\u0001${normalizeGroupText(artist || "")}\u0001${normalizeGroupText(album || "")}`;
}

/** 两首时长是否在容差内:双方都必须 > 0(未知时长不参与容差比较)。 */
export function durationInRange(a: number | null | undefined, b: number | null | undefined, tolerance: number = GROUP_DURATION_TOLERANCE): boolean {
  const da = Number(a || 0);
  const db = Number(b || 0);
  if (da <= 0 || db <= 0) return false;
  return Math.abs(da - db) <= tolerance;
}

export interface GroupableSong {
  id: string;
  title: string;
  artist: string;
  album?: string | null;
  duration?: number | null;
}

export interface GroupAssignment {
  groupId: string;
  groupKey: string;
}

export interface GroupOptions {
  /** 时长容差(秒)。默认 GROUP_DURATION_TOLERANCE。 */
  tolerance?: number;
  /** 是否要求专辑一致(默认 true;false 时 key 退化为「标题+歌手」)。 */
  albumRequired?: boolean;
}

/** 组装分组 key:albumRequired=false 时专辑维度恒为空(等价无专辑匹配)。 */
export function buildGroupKey(title: string, artist: string, album: string | null | undefined, albumRequired: boolean): string {
  return `${normalizeGroupText(title)}\u0001${normalizeGroupText(artist || "")}\u0001${albumRequired ? normalizeGroupText(album || "") : ""}`;
}

/**
 * 为一组歌曲分配组号(存量迁移用)。规则:
 *  1. 按 groupKey 分桶(规范化标题+歌手+专辑相同,albumRequired 可关);
 *  2. 桶内按 duration 升序,union-find 两两比较,|d1-d2| ≤ 容差(默认 1s)的连成一组;
 *  3. 每生成一个组分配一个新的 groupId。
 * 返回 id → { groupId, groupKey } 映射;无标题(规范化后为空)的歌曲返回 null。
 */
export function assignSongGroups(rows: GroupableSong[], opts?: GroupOptions): Map<string, GroupAssignment> {
  const tolerance = opts?.tolerance ?? GROUP_DURATION_TOLERANCE;
  const albumRequired = opts?.albumRequired ?? true;
  const out = new Map<string, GroupAssignment>();
  const buckets = new Map<string, GroupableSong[]>();
  for (const r of rows) {
    const nt = normalizeGroupText(r.title);
    const na = normalizeGroupText(r.artist || "");
    const nal = albumRequired ? normalizeGroupText(r.album || "") : "";
    if (!nt && !na) continue; // 无标题且无歌手,不参与分组
    const key = `${nt}\u0001${na}\u0001${nal}`;
    let list = buckets.get(key);
    if (!list) { list = []; buckets.set(key, list); }
    list.push(r);
  }
  for (const [key, list] of buckets) {
    // 单曲桶:独立成组(仍分配 groupId,保持一致性)
    if (list.length === 1) {
      const r = list[0]!;
      out.set(r.id, { groupId: newGroupId(), groupKey: key });
      continue;
    }
    // 桶内排序后 union-find:任意两两差 ≤容差 合并
    const sorted = [...list].sort((a, b) => Number(a.duration || 0) - Number(b.duration || 0));
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let root = x;
      while (parent.get(root) !== root) { const p = parent.get(root); if (p === undefined) break; root = p; }
      while (parent.get(x) !== x) { const p = parent.get(x); if (p === undefined) break; parent.set(x, root); x = p; }
      return root;
    };
    for (const r of sorted) parent.set(r.id, r.id);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i]!, b = sorted[j]!;
        if (!durationInRange(a.duration, b.duration, tolerance)) continue;
        const ra = find(a.id), rb = find(b.id);
        if (ra !== rb) parent.set(ra, rb);
      }
    }
    // 同根归一组
    const byRoot = new Map<string, GroupableSong[]>();
    for (const r of sorted) {
      const root = find(r.id);
      let g = byRoot.get(root);
      if (!g) { g = []; byRoot.set(root, g); }
      g.push(r);
    }
    for (const group of byRoot.values()) {
      const gid = newGroupId();
      for (const r of group) out.set(r.id, { groupId: gid, groupKey: key });
    }
  }
  return out;
}

let seq = 0;
/** 组号生成:`g-<时间戳>-<序号>`,与歌曲 id(uuid)区分,便于日志/调试识别。 */
export function newGroupId(): string {
  seq = (seq + 1) % 0xffff;
  return `g-${Date.now().toString(36)}-${seq.toString(36)}`;
}

/**
 * 为新歌曲找可并入的已有组(导入/匹配时用):
 * 同 groupKey(已含专辑)的候选行按组聚合,若候选组内存在成员时长与新歌差
 * ≤1s(秒级),返回该组 groupId(多组命中取时长最接近的);否则返回 null
 * (调用方新建组)。
 */
export function findGroupForSong(
  candidates: { id: string; groupId: string | null; duration: number | null }[],
  duration: number | null,
  tolerance?: number,
): string | null {
  if (!candidates.length) return null;
  const groups = new Map<string, number[]>(); // groupId -> member durations
  for (const c of candidates) {
    // 兼容 snake_case(原生 SQL 返回 group_id)与 camelCase:调用方可能直接传
    // drizzle/原生查询行。此前只读 c.groupId 导致原生 SQL 行 groupId 恒为
    // undefined → 永远新建组(web/本地导入归组从未真正命中已有组)。
    const cid = (c as any).groupId ?? (c as any).group_id;
    if (!cid) continue;
    let arr = groups.get(cid);
    if (!arr) { arr = []; groups.set(cid, arr); }
    arr.push(Number(c.duration || 0));
  }
  let bestGroup: string | null = null;
  let bestDiff = Infinity;
  for (const [gid, durs] of groups) {
    for (const d of durs) {
      if (!durationInRange(d, duration, tolerance)) continue;
      const diff = Math.abs(Number(duration || 0) - d);
      if (diff < bestDiff) { bestDiff = diff; bestGroup = gid; }
    }
  }
  return bestGroup;
}
