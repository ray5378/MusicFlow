// 组离线 watchdog:一组里的全部成员离线时,保留组队列(不 deactivate),成员回归后
// 自动从当前曲 + 最后已知位置恢复播放。
//
// 对照 MA:MA 的 SyncGroup 在 leader 丢失且 IDLE_GRACE_SECONDS 后解散组;这里按既定
// 设计走"队列保留 + 成员回归自动恢复",适配 DLNA 设备随时上/下线。
//
// 恢复前的防重入检查:若设备已在播(GENA/轮询已确认 PLAYING),说明用户已手动恢复,
// 不重复触发续播,避免双重 cast。
import { getGroupManager } from "./index.js";
import { getOnlineAirPlayIds, getOnlineSendspinIds, getGroupStatus } from "./protocolPlayer.js";
import { sendspinGroupJoin } from "../sendspin/index.js";
import { sendspinGroupName } from "../sendspin/playerCore.js";
import { getQueueController } from "../player/index.js";
import { getEffectiveBaseUrl } from "../dlna/control.js";
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
    // 探活:组成员只有 sendspin / airplay 两类,在线判定都不走 DLNA 探活 ——
    //   - sendspin:front clients ready(事件驱动);
    //   - airplay:discovery 的 available(mDNS 90s 惰性过期)。
    // 旧实现曾对每个成员发一次 SOAP GetTransportInfo 来刷新可达性,DLNA 禁入组后该路径
    // 已整体移除(否则每 10s 对空集合空转,还留着"组内可校准设备位置"的错误语义)。
    const online = getOnlineAirPlayIds(g.id);
    const spinOnline = getOnlineSendspinIds(g.id);
    if (online.length === 0 && spinOnline.length === 0) {
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
      // 必须把最后已知位置**传下去**:resumeActive 缺省是从头播,不传就会让"续播"
      // 变成"重播"(用户听感:离线回来那首歌从头开始,进度白丢)。resumePos=0 时说
      // 明从未记录过进度(刚建组就断),从头播才是对的 ⇒ 传 undefined。
      await qc.resumeActive(g.id, getEffectiveBaseUrl(), resumePos > 0 ? Math.round(resumePos * 1000) : undefined);
      // 组成员共享同一条 pump:resumeActive 会重建 pump + 桥接会话(airplay 成员
      // 由 group player 的 playMedia 重新握手),位置由 pump 的 seekPositionMs 裁决,
      // **不再**逐设备 alignDeviceToPosition(DLNA 已禁入组,没有"设备自拉流"可校准)。
      // 回归的 sendspin 成员重新入组(断开时已从组成员摘除):播中走直播沿,
      // 空闲仅登记。resumeActive 已恢复组 pump(如组在播)。
      for (const cid of getOnlineSendspinIds(g.id)) {
        try {
          // ug 懒创建缺省 100:回归入组前灌持久音量(与 playMedia/align 同源)。
          const { sendspinGroupTransport } = await import("../sendspin/index.js");
          await sendspinGroupTransport(sendspinGroupName(g.id), "volume", getGroupManager().getVolume(g.id));
          await sendspinGroupJoin(sendspinGroupName(g.id), cid);
        } catch {}
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