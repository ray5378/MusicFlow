// ==================== 「网络歌曲入库」事件钩子（注册制） ====================
//
// 需求（2026-10-11 产品定调，最根本的一条）：**任何**入库的网络歌曲（平台歌曲）都必须
// 过一轮下载流程。唯一能把平台歌曲变成库行的收口点是本目录的 `importOnlineSongs`
// （插件歌单导入 / 单曲导入 / 每日推荐同步 / 跨源匹配 / 发现页全部经它落库），
// 所以钩子就打在它返回之前——所有导入路径自动获得该行为，不需要各处重复接线。
//
// 为什么是「注册制」而不是直接 import fetch 层：
//   1. 依赖方向：source 层是底层，fetch 层**反向依赖它**（candidates.ts 取
//      `getConfiguredProvider`）。静态反向 import 会形成 source↔fetch 环。
//   2. 测试隔离：绝大多数导入单测只关心「库里多了几行」。若导入时直接拉起真实下载，
//      单测会去建真实下载任务、`ensureWritableDir` 碰 /MUSIC、并 fork 批量子进程
//      （真实联网）。注册制下**未挂载即为空实现**，导入单测零改动、零污染。
//
// 生产侧由 `src/index.ts` 启动时调用 `registerFetchImportTrigger()` 挂载（fetch 层
// 提供的实现），并打印启动日志；`scripts/check-import-trigger.mjs` 在 CI 里钉死
// 「挂载点还在 + 触发链还通」，防任何一次重构把它静默拆掉（本仓的通行做法）。
//
// 契约（实现方必须守住）：
//   - 只接收**本轮新入库**的网络歌曲 id 列表（不是整批歌单）；空列表不触发；
//   - 实现方各自判定「要不要下、下哪些」；本层不做任何判定，也**绝不抛错给导入流程**
//     （钩子失败只应记日志，导入本身必须照常成功）。

/** 入库事件监听器：songIds 为本轮**新入库**的网络歌曲行 id。 */
export type ImportedSongsListener = (songIds: string[], ctx: { providerId: string }) => void;

let listener: ImportedSongsListener | null = null;

/** 挂载/卸载监听器（生产由 fetch 层在启动时挂载一次）。 */
export function setImportedSongsListener(fn: ImportedSongsListener | null): void {
  listener = fn;
}

/** 当前是否已挂载（自省/守卫用）。 */
export function hasImportedSongsListener(): boolean {
  return listener !== null;
}

/** 广播「本轮新入库的网络歌曲」。空列表直接返回；监听器抛错一律吞掉（不影响导入）。 */
export function emitImportedSongs(songIds: string[], ctx: { providerId: string }): void {
  if (!listener || !Array.isArray(songIds) || songIds.length === 0) return;
  try {
    listener(songIds, ctx);
  } catch {
    /* 钩子实现内部已自行处理异常；这里再加一层，确保导入永不被它带崩 */
  }
}
