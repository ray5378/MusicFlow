// ==================== 定期孤儿清理 ====================
//
// 目标:把「只增不删」的常驻 Map 收进有界空间。以「设备持久化表(含离线/禁用)
// + 播放器组 + 用户表」为合法 key 集合,定期删除各模块残留的孤儿 key(设备删了、
// 组删了、playerId 变了等),防长期运行内存无界增长。
//
// 与 memory/reclaim(空闲清缓存)互补:这里不依赖空闲,固定 10 分钟一轮兜底;
// 与 peer.ts 的 reconcile(设备→peer 列表)同模式,但覆盖到 eventing/QueueController/
// PlayerController 内部表。
import { getCachedDevices } from "../dlna/control.js";
import { getEventManager } from "../dlna/eventing.js";
import { getGroupManager } from "../group/index.js";
import { getPlayerController, getQueueController } from "../player/index.js";
import { sweepScrobbleDedupe } from "../../plugins/scrobblers.js";
import { db } from "../../db/index.js";
import { users } from "../../db/schema.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("ORPHAN-PRUNE");

const ORPHAN_PRUNE_INTERVAL_MS = 10 * 60 * 1000; // 10 分钟一轮

/** 启动定期孤儿清理。在 index.ts 启动时调用一次。 */
export function startOrphanPruner(): void {
  // 启动后 1 分钟先跑一轮(此时设备表/组已 loadFromDb),之后每 10 分钟一轮。
  setTimeout(() => { try { pruneOrphansOnce(); } catch (e: any) { log.error("首次清理出错", { err: e?.message || e }); } }, 60_000);
  setInterval(() => { try { pruneOrphansOnce(); } catch (e: any) { log.error("清理出错", { err: e?.message || e }); } }, ORPHAN_PRUNE_INTERVAL_MS);
}

/** 执行一轮孤儿清理(供测试直接调用)。 */
export function pruneOrphansOnce(): void {
  const deviceIds = new Set(getCachedDevices().map((d) => d.id));
  const groupIds = new Set(getGroupManager().list().map((g) => g.id));
  const userIds = new Set(db.select().from(users).all().map((u) => u.id));

  getEventManager().pruneOrphans(deviceIds);
  getQueueController().pruneOrphans(deviceIds, groupIds);

  // PlayerController 的 key 是 playerId(local:<uid> / dlna:<deviceId> / group:<groupId>)。
  const playerIds = new Set<string>();
  for (const uid of userIds) playerIds.add(`local:${uid}`);
  for (const did of deviceIds) playerIds.add(`dlna:${did}`);
  for (const gid of groupIds) playerIds.add(`group:${gid}`);
  getPlayerController().pruneOrphans(playerIds);

  sweepScrobbleDedupe();
}
