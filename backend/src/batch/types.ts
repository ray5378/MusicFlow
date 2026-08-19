// ==================== 批量任务子进程(Batch Worker)协议 ====================
//
// 方案3(一次全部落地):所有批量任务(每日推荐 / 6h 维护 / 媒体源扫描 / 歌单导入 /
// 同步 / 在线匹配 / 推荐同步 / 清理 / 刮削)一律跑在一次性子进程里(fork),做完即退
// (exit 0)。子进程与主进程共享同一份 service 代码,但拥有独立的 better-sqlite3
// 连接与独立的进程堆——批量任务造成的峰值内存随进程销毁归还操作系统,主进程常驻
// 内存不再被批量任务拉高。
//
// 本文件定义任务契约与 IPC 协议(JSON 安全):
//   父 → 子   run{jobId,kind,args} / abort{jobId} / pace{active}
//   子 → 父   ready / heartbeat / progress{jobId,payload} /
//             result{jobId,result,rss} / error{jobId,error,sandboxCode,hint}
//
// 约束:
//   - args 必须 JSON 可序列化(子进程从自己的注册表/DB 重建 provider/config/plugin)。
//   - 每个子进程只跑一个 job(一次性),跑完 process.exit(0)。
//   - 主进程持有全局批量闸(acquireBatchLock)串行化所有批量任务(同一时刻 1 个子进程)。

export type BatchJobKind =
  | "daily-jobs"           // 每日推荐全管线(内置/外置推荐 + 组合歌单 + 平台推荐同步 + 网页歌清理)
  | "maintenance"          // 6h 维护:playlistSync.runSyncJob 全部 + 新歌手信息刮削
  | "plugin-job"           // 单插件方法(手动刷新 / 聚合同步的 Path B)
  | "scan"                 // 媒体源扫描(webdav/local)+ 扫描后新增歌手刮削
  | "playlist-import"      // URL 歌单导入(网络拉取 + 增量重建)
  | "playlist-sync"        // 手动同步一张歌单
  | "playlist-search-import" // 歌单搜索「加入库」
  | "album-search-import"  // 专辑搜索「加入库」
  | "song-search-import"   // 歌曲搜索「加入库」
  | "match-playlist"       // 在线匹配一张歌单
  | "match-playlists"      // 在线批量匹配所有含占位条目的歌单
  | "recommend-sync-all"   // 路径 A:平台每日推荐全量重导
  | "purge-web-songs"      // 过期未引用网页歌曲清理
  | "scrape-artists";      // 批量歌手信息刮削

/** 运行时任务类型列表(用于注册校验 / 日志)。 */
export const jobKinds: readonly BatchJobKind[] = [
  "daily-jobs",
  "maintenance",
  "plugin-job",
  "scan",
  "playlist-import",
  "playlist-sync",
  "playlist-search-import",
  "album-search-import",
  "song-search-import",
  "match-playlist",
  "match-playlists",
  "recommend-sync-all",
  "purge-web-songs",
  "scrape-artists",
];

/** 一次批量任务的完整请求(父进程可 JSON 序列化后传给子进程)。 */
export interface BatchJobRequest {
  kind: BatchJobKind;
  args: Record<string, any>;
}

/** 父 → 子 消息。 */
export type ParentToChildMessage =
  | { type: "run"; jobId: string; kind: BatchJobKind; args: Record<string, any> }
  | { type: "abort"; jobId: string }
  | { type: "pace"; active: boolean };

/** 子 → 父 消息。 */
export type ChildToParentMessage =
  | { type: "ready"; pid: number }
  | { type: "heartbeat"; pid: number }
  | { type: "progress"; jobId: string; payload: any }
  | { type: "result"; jobId: string; result: any; rss: number }
  | { type: "error"; jobId: string; error: string; sandboxCode?: string; hint?: string };
