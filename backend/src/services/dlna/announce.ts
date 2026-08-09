// 播报(announcement)服务 —— 供 HA 的 media_player.play_media(announce: true) 使用。
//
// 语义:临时打断当前播放,放一段外部音频(通常是 TTS),放完自动回到原来的歌
// 和原来的进度。HA 里这是最常用的自动化动作之一("有人按门铃了""洗衣机好了")。
//
// 为什么要单独一个编排层,而不是直接 SetAVTransportURI:
//   1. 队列自动推进会捣乱。播报结束时设备进入 STOPPED,QueueController 的
//      PlaybackTracker 会把它当成"这首放完了"从而自动切下一首。所以播报全程
//      必须先 deactivate 队列,结束后再由我们主动恢复。
//   2. 现场要完整保存:播放状态 + 进度 + 音量。播报音量通常要临时调高,
//      结束后必须还原,否则用户音乐会一直停在播报音量上。
//   3. 组播报要并发下发到全部成员,且每台设备的现场独立保存。
//
// 并发保护:同一 peer 同时只允许一个播报在跑(第二个直接拒绝),否则两次播报
// 会互相把对方保存的"原始现场"覆盖掉,最后恢复出一个错误的状态。
import {
  getDevice,
  getDeviceStatus,
  setDeviceVolume,
  playUriOnDevice,
  waitUntilStopped,
  getEffectiveBaseUrl,
} from "./control.js";
import { getQueueController } from "../player/index.js";
import { getGroupManager } from "../group/index.js";

interface SavedState {
  deviceId: string;
  volume: number;
  wasPlaying: boolean;
  position: number;
}

const running = new Set<string>();

export function isAnnouncing(peerId: string): boolean {
  return running.has(peerId);
}

/** 解析 peerId → 实际要发声的 DLNA 设备列表。 */
function resolveTargets(peerId: string): string[] {
  if (peerId.startsWith("dlna:")) return [peerId.slice(5)];
  if (peerId.startsWith("group:")) {
    const g = getGroupManager().get(peerId.slice(6));
    return (g?.memberIds || []).filter(d => !!getDevice(d));
  }
  return [];
}

export interface AnnounceOptions {
  peerId: string;
  url: string;
  /** 播报音量(0-100)。不传则沿用设备当前音量。 */
  volume?: number;
  /** 播报最长等待时间,超时后强制进入恢复流程。 */
  timeoutMs?: number;
}

export async function announceOnPeer(opts: AnnounceOptions): Promise<{ targets: number }> {
  const { peerId, url } = opts;
  if (!/^https?:\/\//i.test(url)) throw new Error("播报 URL 必须是 http(s) 绝对地址");

  const targets = resolveTargets(peerId);
  if (targets.length === 0) throw new Error("该播放器不支持播报(仅 DLNA 设备与组)");
  if (running.has(peerId)) throw new Error("该播放器正在播报中");
  running.add(peerId);

  const qc = getQueueController();
  const snap = qc.snapshot(peerId);
  const wasActive = snap.isActive && snap.currentIndex >= 0;

  try {
    // 1) 保存现场。逐台设备独立保存 —— 组里各成员音量可以不一样。
    const saved: SavedState[] = [];
    await Promise.all(targets.map(async (deviceId) => {
      try {
        const st = await getDeviceStatus(deviceId);
        saved.push({
          deviceId,
          volume: st.volume,
          wasPlaying: st.state === "PLAYING",
          position: st.position,
        });
      } catch {
        saved.push({ deviceId, volume: 0, wasPlaying: false, position: 0 });
      }
    }));

    // 2) 冻结队列自动推进。播报结束设备会 STOPPED,不冻结的话会被误判成切歌。
    if (wasActive) qc.deactivate(peerId);

    // 3) 调播报音量 → 播 → 等播完。任一台失败不影响其余设备。
    if (typeof opts.volume === "number") {
      const v = Math.max(0, Math.min(100, Math.round(opts.volume)));
      await Promise.allSettled(targets.map(d => setDeviceVolume(d, v)));
    }
    const played = await Promise.allSettled(
      targets.map(d => playUriOnDevice(d, url, { title: "Announcement" })),
    );
    if (played.every(r => r.status === "rejected")) {
      throw new Error("播报下发失败:目标设备均无响应");
    }
    await Promise.allSettled(
      targets.map(d => waitUntilStopped(d, opts.timeoutMs ?? 300000)),
    );

    // 4) 还原音量。放在恢复播放之前,免得原曲先以播报音量炸出来一下。
    await Promise.allSettled(
      saved
        .filter(s => typeof opts.volume === "number")
        .map(s => setDeviceVolume(s.deviceId, s.volume)),
    );

    // 5) 恢复原曲。播报前本来就没在播的,保持安静即可 —— 播报不该顺手开始放歌。
    const anyWasPlaying = saved.some(s => s.wasPlaying);
    if (wasActive && anyWasPlaying) {
      const resumeAt = Math.max(...saved.map(s => s.position), 0);
      const baseUrl = getEffectiveBaseUrl();
      await qc.playFrom(peerId, snap.items, snap.currentIndex, baseUrl);
      if (resumeAt > 2) {
        // 起播后设备需要一点时间就绪才吃得下 seek。
        await new Promise(r => setTimeout(r, 1200));
        await qc.transport(peerId, "seek", resumeAt).catch(() => {});
      }
    }
    return { targets: targets.length };
  } finally {
    running.delete(peerId);
  }
}
