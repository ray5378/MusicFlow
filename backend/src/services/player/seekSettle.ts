// ==================== seek 冷静期(后置传输命令与"真结束"的隔离) ====================
//
// 解决的问题(2026-09-21 真机实测):
//   拖动进度条时,后端要按新的 `-ss` **重起 ffmpeg**(DLNA 侧是重发 SOAP Seek /
//   重投 SetAVTransportURI)。重定位期间设备必然有一小段"非 PLAYING"的真空。
//   若恰好有一拍状态上报落在这个真空里,`PlaybackTracker` 会算出 `idle_early`
//   (IDLE 但进度远未到已知时长 = 疑似误报);`QueueController` 的复查逻辑
//   (`pollState()` 立刻探一次)在真空里几乎必然探到非 PLAYING → 判成"设备确实停了"
//   → **放行切歌** → 队列跳到下一首 → 位置回到 0。
//   用户看到的就是「拖动完成后进度条自己跳回去了」。
//
//   真机日志(15 次连续 seek 后):
//     [sendspin] finishPlayback member=C4:9E:7E:08:75:64
//     [PlayerController][report] … IDLE pos=117.7 dur=0
//     [tracker][update] PLAYING→IDLE pos=118 dur=214 → idle_early
//     [QueueController][idle_early] … 复查确认已停,放行切歌
//     [QueueController][playCurrent] idx=1398 → report PLAYING pos=0   ← 归零
//
// 因此:凡是"刚下发过 seek"的 peer,在冷静期内收到的 IDLE 一律按**重定位真空**解释,
// 不得当作真结束。冷静期只拦截 `idle_early` 这一条判据 —— 它按定义就是
// 「IDLE 但进度远没到时长」的疑似误报,真播完走的是 `advance` / `ended`,不受影响。
import { createLogger } from "../../utils/logger.js";

const log = createLogger("seek-settle");

/**
 * seek 后的冷静期(毫秒)。
 * 取值依据:`-ss` 重起 ffmpeg + 2s 预缓冲 ≈ 1–3s;状态上报/轮询粒度 5s;
 * 再留一档余量 → 8s 足以覆盖重定位真空,又远小于"用户按停后要等多久"的感知阈值。
 */
export const SEEK_SETTLE_MS = 8_000;

/** peer(裸 id) → 最近一次 seek 下发时刻。 */
const lastSeekAt = new Map<string, number>();

/** 归一化 playerId:剥掉 `dlna:` / `group:` / `airplay:` / `sendspin:` / `local:` 前缀
 *  (与 `peer.ts::parsePeerId` 认的五种 kind 对齐)。
 *  两侧必须用同一个 key —— 否则 route 侧记的与决策侧查的不是一条记录。
 *  注:未知前缀不剥(避免把裸 id 里本来就有的冒号吃掉)。 */
export function seekSettleKey(playerId: string): string {
  for (const p of ["dlna:", "group:", "airplay:", "sendspin:", "local:"]) {
    if (playerId.startsWith(p)) return playerId.slice(p.length);
  }
  return playerId;
}

/** 记一次 seek 下发。**在任何 seek 真正下发给播放器之前**调用。 */
export function markSeekIssued(playerId: string, at: number = Date.now()): void {
  lastSeekAt.set(seekSettleKey(playerId), at);
}

/** 最近一次 seek 下发时刻(从未 seek 过 → 0)。 */
export function lastSeekIssuedAt(playerId: string): number {
  return lastSeekAt.get(seekSettleKey(playerId)) ?? 0;
}

/** 是否仍在 seek 冷静期内(= 此刻的 IDLE 应解释为重定位真空)。 */
export function withinSeekSettle(playerId: string, now: number = Date.now()): boolean {
  const at = lastSeekAt.get(seekSettleKey(playerId));
  if (at === undefined) return false;
  return now - at < SEEK_SETTLE_MS;
}

/** 距上次 seek 的毫秒数(从未 seek 过 → Infinity,便于日志直出)。 */
export function sinceSeekMs(playerId: string, now: number = Date.now()): number {
  const at = lastSeekAt.get(seekSettleKey(playerId));
  return at === undefined ? Number.POSITIVE_INFINITY : now - at;
}

/** 清掉记录(停止播放 / 队列清空时调用,避免陈旧时刻长期占据 Map)。 */
export function clearSeekSettle(playerId: string): void {
  lastSeekAt.delete(seekSettleKey(playerId));
}

/** 供排障:当前被记录的 peer 数。 */
export function seekSettleSize(): number {
  return lastSeekAt.size;
}

/** 仅在冷静期真的拦下一次误判时打一条(便于确认这条护栏在生产里生效)。 */
export function logSeekSettleSuppressed(player: string, decision: string): void {
  log.warn(
    `[seek-settle] ${player}: 距上次 seek ${Math.round(sinceSeekMs(player))}ms < ${SEEK_SETTLE_MS}ms,`
    + ` ${decision} 判为 seek 重定位真空 → 撤销(不切歌)`,
  );
}
