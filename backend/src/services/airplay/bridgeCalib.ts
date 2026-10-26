// AirPlay 桥 A/V 标定位移(2026-10-26 真机标定引入)。
//
// 为什么需要:桥的可听时刻 = startNtp + L_true,而 startNtp = A − L_assumed(我们用
// RECORD 回包的 Audio-Latency,缺省 1s)。两者不等 ⇒ 桥整体早/晚 (L_true − L_assumed)。
// 240 现场实测:HiVi(00226CFFA0C0, MUZO 固件)**根本不回 Audio-Latency**
// (90 分钟日志 0 条 `audio latency:`),所以设备真实 hold depth 无法从协议读到。
// 而 sendspin(esp32)是按帧头 ts − send_ahead 出声的确定性实现,于是两者差一个常量,
// 只能靠标定把这个常量补掉。
//
// ⚠️ 只平移「内容落点」(planBridgeAnchor 的 A),**绝不动 latencyFrames**:
// 同一个 latencyFrames 还是设备的保持深度与 SYNC 广告值(`rtp_timestamp_latency`),
// 单方面调小会让设备跑空(underrun → 周期性静音),那是另一个更严重的 bug。
//
// 语义:**正值 = 桥整体延后**(用来修「AirPlay 比 SENDSPIN 快」);0 = 不标定(历史行为)。
// 生效时机:下一次桥会话建立(切歌 / 组重建 / 桥重连)时进入 planBridgeAnchor;R31 起**有组上下文一律取按组值** airplayDelayUsOf(groupId)(group/delayCalib.ts:92),本文件的全局值只在无组时兜底。
// `[airplay-bridge] {ev:"anchor"}` 事件里的 `anchorShiftUs` 即生效值(可现场验收)。
import { getSetting } from "../settings.js";

/** settings 键:桥 A/V 标定位移(毫秒,正=延后)。 */
export const BRIDGE_AV_SHIFT_KEY = "bridge.avShiftMs";
export const BRIDGE_AV_SHIFT_MAX_MS = 2000;
export const BRIDGE_AV_SHIFT_MIN_MS = -2000;

/** 原始字符串 → 毫秒(纯函数,便于单测;非法/空 → 0 = 不标定)。 */
export function parseBridgeAvShiftMs(raw: string): number {
  const s = (raw ?? "").trim();
  if (s === "") return 0;
  const n = Number(s);
  if (!Number.isFinite(n)) return 0;
  const v = Math.round(n);
  if (v > BRIDGE_AV_SHIFT_MAX_MS) return BRIDGE_AV_SHIFT_MAX_MS;
  if (v < BRIDGE_AV_SHIFT_MIN_MS) return BRIDGE_AV_SHIFT_MIN_MS;
  return v;
}

/** 当前标定值(毫秒)。读 settings 表,5s 缓存。 */
export function getBridgeAvShiftMs(): number {
  return parseBridgeAvShiftMs(getSetting(BRIDGE_AV_SHIFT_KEY, ""));
}

/** 当前标定值(微秒),直接喂 planBridgeAnchor.anchorShiftUs。 */
export function getBridgeAvShiftUs(): number {
  return getBridgeAvShiftMs() * 1000;
}
