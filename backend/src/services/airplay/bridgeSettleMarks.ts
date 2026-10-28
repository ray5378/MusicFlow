/**
 * exp4(E3):桥 cold-settle 过的 DLNA peer 标记(服务端内存,TTL 20s)。
 *
 * 背景(240 全量时序取证):同一台物理设备(Linkplay 类,AirPlay+DLNA 双身份),桥刚
 * RECORD 接管 AirPlay 后,卡片的 resetPeer(源端 DLNA)又向设备下发 SOAP Stop
 * (14:13:16.610 发起 → 17.657/17.701 两次成功)⇒ 固件输入仲裁把通路顶回 DLNA ——
 * TCP/RTSP 仍活着、timing reply 照答,但音频不渲染(泵 125/s、loss=0、全程无声)。
 * 出声实例(源端是 airplay / 无 transfer)的 RECORD 之后没有任何 DLNA 命令,完全对应。
 *
 * 写入点:control.bridgePrepareDevice 的同 host DLNA settle **成功之后**(settle 本身
 * 就靠 Stop 让位,不能提前写)。消费点:peers 路由 /stop 与 /reset —— 命中且开关
 * 打开时只做服务端复位(stopPlayback/clear),不下发设备命令。
 */
const marks = new Map<string, { ts: number; airplayDeviceId: string }>();

/** 标记有效期:覆盖「桥建立 → 卡片 resetPeer」这段前后端交互窗口。 */
export const BRIDGE_SETTLE_MARK_TTL_MS = 20_000;

/** 容量上限(老条目按插入序淘汰;桥数量远小于此,纯保险)。 */
const MAX_MARKS = 64;

/** exp4(E3)开关:命中标记时跳过设备端 DLNA Stop(缺省关 = 现行为)。 */
export function raopSuppressDlnaResetAfterBridge(): boolean {
  const v = process.env.MF_BRIDGE_RAOP_SUPPRESS_DLNA_RESET_AFTER_BRIDGE;
  return v === "1" || v === "true";
}

/** 记录「dlnaPeerId 刚被 airplayDeviceId 的桥 cold-settle 过」。nowMs 注入供单测。 */
export function markBridgeSettledDlnaPeer(
  dlnaPeerId: string,
  airplayDeviceId: string,
  nowMs: number = Date.now(),
): void {
  if (!dlnaPeerId) return;
  marks.set(dlnaPeerId, { ts: nowMs, airplayDeviceId });
  if (marks.size > MAX_MARKS) {
    const oldest = marks.keys().next().value as string | undefined;
    if (oldest !== undefined) marks.delete(oldest);
  }
}

/** 该 DLNA peer 是否在 TTL 内被桥 settle 过(过期即删,返回 false)。 */
export function isRecentlyBridgeSettledDlnaPeer(dlnaPeerId: string, nowMs: number = Date.now()): boolean {
  const rec = marks.get(dlnaPeerId);
  if (!rec) return false;
  if (nowMs - rec.ts > BRIDGE_SETTLE_MARK_TTL_MS) {
    marks.delete(dlnaPeerId);
    return false;
  }
  return true;
}

/** 单测清场(生产不使用)。 */
export function clearBridgeSettleMarks(): void {
  marks.clear();
}
