// 组离线 watchdog:一组里的全部成员离线时,保留组队列(不 deactivate),成员回归后
// 自动从当前曲 + 最后已知位置恢复播放。
//
// 对照 MA:MA 的 SyncGroup 在 leader 丢失且 IDLE_GRACE_SECONDS 后解散组;这里按既定
// 设计走"队列保留 + 成员回归自动恢复",适配 DLNA 设备随时上/下线。
//
// 恢复前的防重入检查:若设备已在播(GENA/轮询已确认 PLAYING),说明用户已手动恢复,
// 不重复触发续播,避免双重 cast。
import { getGroupManager } from "./index.js";
import { getOnlineMemberIds, getGroupStatus } from "./protocolPlayer.js";
import { getQueueController } from "../player/index.js";
import { getEffectiveBaseUrl, alignDeviceToPosition, getDeviceStatus } from "../dlna/control.js";
import { createLogger } from "../../utils/logger.js";

const TICK_MS = 10_000;

// groupId → 最后已知播放位置(秒)。全部成员离线瞬间记下,成员回归时续播到该位置。
const lastPosition = new Map<string, number>();
// 处于"全部成员离线"状态的组,用于只在离线→上线跳变时触发一次恢复。
const suspended = new Set<string>();

let timer: ReturnType<typeof setInterval> | null = null;

const log = createLogger("group");
export function startGroupWatchdog(): void {
  if (timer) return;
  timer = setInterval(() => { runGroupWatchdogTick().catch(() => {}); }, TICK_MS);
  log.info(`[group] offline watchdog started (every ${TICK_MS / 1000}s)`);
}

export function stopGroupWatchdog(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

/** 供测试在用例间清空模块级悬挂/位置状态。 */
export function resetGroupWatchdogForTest(): void {
  lastPosition.clear();
  suspended.clear();
}

/** 单次巡检(导出以便测试直接触发)。 */
export async function runGroupWatchdogTick(): Promise<void> {
  const qc = getQueueController();
  const groups = getGroupManager().list();
  const alive = new Set(groups.map(g => g.id));
  // 组已被删除 → 清掉残留状态。
  for (const id of [...lastPosition.keys()]) if (!alive.has(id)) lastPosition.delete(id);
  for (const id of [...suspended]) if (!alive.has(id)) suspended.delete(id);

  for (const g of groups) {
    const q = qc.snapshot(g.id);
    if (!q.isActive || q.currentIndex < 0) {
      // 队列未激活(已停止/清空):没有续播语义,清除悬挂状态。
      suspended.delete(g.id);
      lastPosition.delete(g.id);
      continue;
    }
    // 探活:组 pollState 只探 leader,非 leader 成员离线的 runtime available 不会翻转。
    // 这里对每个成员做一次轻量状态查询(失败会把 runtime available 置 false,成功置 true),
    // 让 getOnlineMemberIds(基于 isDeviceAvailable)在本次巡检里就看到真实可达性。
    for (const d of g.memberIds) {
      try { await getDeviceStatus(d); } catch {}
    }
    const online = getOnlineMemberIds(g.id);
    if (online.length === 0) {
      // 全员离线:记录最后位置并进入悬挂(队列保留在 DB,isActive 不变)。
      if (!suspended.has(g.id)) {
        suspended.add(g.id);
        // 清掉 tracker 的 lastPlaying:成员回归后 leader 报 NO_MEDIA_PRESENT→IDLE 时
        // 不再被误判 ended(否则队列被 deactivate,恢复无从谈起)。
        qc.resetGroupTracker(g.id);
        log.info(`[group] ${g.id}(${g.name}) 所有成员离线,播放悬挂(队列保留),成员回归后自动恢复`);
      }
      continue;
    }
    if (suspended.has(g.id)) {
      suspended.delete(g.id);
      const resumePos = lastPosition.get(g.id) || 0;
      lastPosition.delete(g.id);
      // 设备已在播(用户已手动恢复)→ 不再重复触发续播。
      let state: string | undefined;
      try { state = (await getGroupStatus(g.id)).state; } catch {}
      if (state === "PLAYING" || state === "PAUSED_PLAYBACK") {
        log.info(`[group] ${g.id}(${g.name}) 成员回归但已在播(${state}),跳过自动恢复`);
        continue;
      }
      log.info(`[group] ${g.id}(${g.name}) 成员回归,恢复播放@${resumePos}s`);
      await qc.resumeActive(g.id, getEffectiveBaseUrl());
      if (resumePos > 0) {
        // resumeActive 里的 cast 会让成员从头播,cast 后立刻 seek 在部分渲染器上
        // 会静默失效,这里对每个在线成员做校准 seek(seek+轮询收敛到目标位置)。
        const online = getOnlineMemberIds(g.id);
        await Promise.allSettled(online.map(d => alignDeviceToPosition(d, resumePos)));
      }
      continue;
    }
    // 正常播放中:记录 leader 进度,供"最后成员离线瞬间"使用(状态派生自 leader)。
    try {
      const st = await getGroupStatus(g.id);
      if (typeof st.position === "number") lastPosition.set(g.id, st.position);
    } catch {}
  }
}