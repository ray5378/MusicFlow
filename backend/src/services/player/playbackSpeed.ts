// 服务端倍速播放（2026-11-14）。
//
// 为什么需要独立模块：
//   - 倍速最终落在 **ffmpeg 的 `atempo` 滤镜**上（改变时长、保持音高），而出流是
//     在 cast / 起泵时**一次性生成**的（DLNA flow、sendspin 组泵、AirPlay 桥的 PCM
//     都来自各自的解码进程），所以「改倍速」= 用新参数**重投当前曲**，不是运行中改
//     某个变量（见 QueueController.setPlaybackSpeed）。
//   - 对外时间轴（队列 position / duration / seek / 歌词）必须恒为**内容时间**：
//     atempo=1.5 时 60s 的歌只产生 40s 输出流，设备上报的 40s 必须换算回 60s。
//     换算的倍率只有一个来源，就是本模块的注册表，禁止各链路自己猜。
//
// 档位与客户端保持一致（MusicFlow-client `player_utility_bar.dart` 的
// 0.75 / 1.0 / 1.25 / 1.5 / 1.75 / 2.0）—— 多端看到的可选项必须同构，否则
// 「手机能选、音箱选不到」会被当成功能缺失。
import { getSetting, setSetting } from "../settings.js";

export const PLAYBACK_SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];
export const DEFAULT_PLAYBACK_SPEED = 1;

/** 归一到白名单档位（非法/越界按最近档位；NaN → 1）。 */
export function normalizePlaybackSpeed(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PLAYBACK_SPEED;
  let best = DEFAULT_PLAYBACK_SPEED;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const s of PLAYBACK_SPEEDS) {
    const d = Math.abs(s - n);
    if (d < bestDelta) {
      bestDelta = d;
      best = s;
    }
  }
  return best;
}

/** atempo 滤镜串；1x 返回 null（调用方据此保持 af 链逐字节不变）。 */
export function atempoFilter(speed: number): string | null {
  const s = normalizePlaybackSpeed(speed);
  if (Math.abs(s - DEFAULT_PLAYBACK_SPEED) < 1e-6) return null;
  // atempo 单实例合法区间 0.5~100（ffmpeg 5.x），本项目 0.75~2 全在范围内。
  return `atempo=${s}`;
}

/** 在既有 af 链**末尾**追加 atempo（1x 原样返回，不复制语义）。
 *
 *  为什么放最后：loudnorm 必须按**原始时长**积分响度，DSP 也按源时间轴配置；
 *  先变速会让响度测量与 DSP 参数全部失真。atempo 放链尾只改最终时长。 */
export function withAtempo(af: string[], speed: number): string[] {
  const f = atempoFilter(speed);
  if (!f) return af;
  return [...af, f];
}

/** 内容秒 → 输出流秒（atempo 压缩后的时间轴）。`speed>1` 时输出流更短。 */
export function contentToStreamSec(sec: number, speed: number): number {
  const s = normalizePlaybackSpeed(speed);
  return s === DEFAULT_PLAYBACK_SPEED ? sec : sec / s;
}

/** 输出流秒 → 内容秒（设备上报的时间轴换算回对外时间轴）。 */
export function streamToContentSec(sec: number, speed: number): number {
  const s = normalizePlaybackSpeed(speed);
  return s === DEFAULT_PLAYBACK_SPEED ? sec : sec * s;
}

// ==================== 注册表（per device / group / client） ====================
//
// key = **裸 id**（QueueController 全程用裸 id，见其 stripPlayerPrefix）。
// DLNA 设备、AirPlay 设备、sendspin client、用户组各用自己的 id 命名空间；
// 同物理设备同时出现在 DLNA / AirPlay 时 id 不同，互不串味。
//
// 持久化放 settings 表（KV），而不是给三张队列表加列：
//   - 倍速是「播放器偏好」，不随队列清空而消失；
//   - 队列表的列变更需要 ALTER TABLE 迁移，收益与风险不成比例。
const KEY_PREFIX = "playback_speed:";
const cache = new Map<string, number>();

function keyOf(id: string): string {
  return KEY_PREFIX + id;
}

/** 去掉 playerId 的协议前缀（与 QueueController.stripPlayerPrefix 同口径）。 */
export function bareSpeedId(playerId: string): string {
  if (playerId.startsWith("dlna:")) return playerId.slice(5);
  if (playerId.startsWith("group:")) return playerId.slice(6);
  if (playerId.startsWith("airplay:")) return playerId.slice(8);
  if (playerId.startsWith("sendspin:")) return playerId.slice(9);
  return playerId;
}

/** 读取某播放器的倍速（缺省 1）。首次读取从 settings 表回填。 */
export function getPlaybackSpeed(playerId: string): number {
  const id = bareSpeedId(playerId);
  const hit = cache.get(id);
  if (hit !== undefined) return hit;
  let v = DEFAULT_PLAYBACK_SPEED;
  try {
    const raw = getSetting(keyOf(id), String(DEFAULT_PLAYBACK_SPEED));
    v = normalizePlaybackSpeed(raw);
  } catch {
    v = DEFAULT_PLAYBACK_SPEED;
  }
  cache.set(id, v);
  return v;
}

/** 写入倍速并持久化；返回归一后的值。 */
export function setPlaybackSpeed(playerId: string, speed: number): number {
  const id = bareSpeedId(playerId);
  const v = normalizePlaybackSpeed(speed);
  cache.set(id, v);
  try {
    setSetting(keyOf(id), String(v));
  } catch {
    /* settings 表未就绪（单测/启动早期）：内存值仍然生效 */
  }
  return v;
}

/** 测试用：清内存缓存（settings 读有 5s TTL，清理后重新从库读）。 */
export function _resetPlaybackSpeedCacheForTest(): void {
  cache.clear();
}
