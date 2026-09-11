// ==================== 组级换源救援(group rescue) ====================
//
// 背景(2026-09-12 真机取证):同曲多源归组后,同一首歌在库里可能有多行
// (核心曲库 local / WebDAV / 各插件平台 web)。出流解析 `ensurePlayableStream`
// 此前**只看当前这一行**的 sourceData 去多源兜底,兄弟行明明可播也不试 ——
// 于是「库里有这首歌、只是当前这一行是死链」被整体判成不可播,客户端白跳一首。
//
// 救援语义:本行(含其自身多源兜底)确认无可用直链后,才在**同一 group_id** 里
// 按组内优先级(local > webdav > web)逐个试兄弟行:
//   - local / webdav 兄弟:文件由本服务 /rest/stream 直出 → 构造
//     `/rest/stream?id=<siblingId>` 绝对地址即可(投屏与客户端都走这条);
//   - web 兄弟(别的平台/源):递归走它自己的 ensurePlayableStream(带深度守卫)。
// 命中后**只写内存缓存**(挂在原 songId 下),不把兄弟行的 URL 回写进原行 ——
// 原行的 url/sourceData 参与去重指纹与展示,改写会污染曲库。

import { db } from "../../../db/index.js";
import { songs } from "../../../db/schema.js";
import { eq } from "drizzle-orm";
import { groupMemberSort } from "../../../utils/songSource.js";
import { isCapabilityEnabled } from "../../../plugins/registry.js";
import { getEffectiveBaseUrl } from "../../dlna/control.js";

/** 递归深度守卫:兄弟行自身也会触发救援,防止 A→B→A 死循环。 */
const MAX_RESCUE_DEPTH = 2;

export type GroupRescueResult = { url: string; source: string; siblingId: string };

type RescueSong = {
  id: string;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  duration?: number | null;
  url?: string | null;
  pluginEntry?: string | null;
  sourceData?: string | null;
};

/** 兄弟行是否「不用探测即可出流」(核心曲库 / WebDAV 的文件行)。 */
function isFileBacked(type?: string | null): boolean {
  return type === "local" || type === "webdav";
}

/**
 * 在同曲多源组里找一个可顶上的兄弟行。
 * @param resolveSibling 递归解析 web 兄弟行的回调(由 streamFallback 注入,
 *        避免本模块与它形成静态循环依赖);带深度参数。
 */
export async function findGroupRescueStream(
  song: RescueSong,
  depth: number,
  resolveSibling: (row: any, nextDepth: number) => Promise<string | null>,
): Promise<GroupRescueResult | null> {
  if (!song?.id || depth > MAX_RESCUE_DEPTH) return null;
  // 同曲多源分组总开关关闭 → 不救援(与 attachGroupSources 行为一致)。
  if (!isCapabilityEnabled("songGroup")) return null;

  let own: any = null;
  try {
    own = db.select({ groupId: songs.groupId }).from(songs).where(eq(songs.id, song.id)).get();
  } catch {
    return null;
  }
  const gid = own?.groupId;
  if (!gid) return null;

  let members: any[] = [];
  try {
    members = db.select().from(songs).where(eq(songs.groupId, gid)).all();
  } catch {
    return null;
  }
  if (members.length <= 1) return null;

  const siblings = members
    .filter((m) => m.id !== song.id)
    .sort(groupMemberSort);

  for (const sib of siblings) {
    if (isFileBacked(sib.type)) {
      // 本地/WebDAV 文件行:由本服务直出,地址恒定可用(不做网络探测 ——
      // 探测一个本地路径没有意义;文件缺失由 /rest/stream 拉流时报错兜底)。
      const url = `${getEffectiveBaseUrl()}/rest/stream?id=${encodeURIComponent(sib.id)}`;
      return { url, source: sib.type === "webdav" ? "webdav" : "local", siblingId: sib.id };
    }
    // web 兄弟行:递归解析(它自己也会先探原链再走多源兜底)。
    try {
      const url = await resolveSibling(sib, depth + 1);
      if (url) return { url, source: "web", siblingId: sib.id };
    } catch {
      // 单个兄弟失败继续下一个。
    }
  }
  return null;
}
