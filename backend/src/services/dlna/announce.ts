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
import {
  getAirPlayStatus,
  setAirPlayVolume,
  castToAirPlayDevice,
} from "../airplay/control.js";
import { PlaybackState } from "../player/types.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("ANNOUNCE");

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

  // 按 kind 分流:dlna/group 走经典路径,airplay/sendspin 各走自己的发声通道。
  // 并发保护与 URL 校验在各路径入口之前统一做一次。
  if (peerId.startsWith("airplay:") || peerId.startsWith("sendspin:")) {
    if (running.has(peerId)) throw new Error("该播放器正在播报中");
    running.add(peerId);
    try {
      if (peerId.startsWith("airplay:")) return await announceAirPlay(opts);
      return await announceSendspin(opts);
    } finally {
      running.delete(peerId);
    }
  }

  const targets = resolveTargets(peerId);
  if (targets.length === 0) throw new Error("该播放器不支持播报");
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
    //    setDeviceVolume 自带「回读确认 + 重发」,此处检查各设备音量是否真正就位,
    //    未确认的记入日志(播报继续,不中断)。
    if (typeof opts.volume === "number") {
      const v = Math.max(0, Math.min(100, Math.round(opts.volume)));
      const volResults = await Promise.allSettled(targets.map(d => setDeviceVolume(d, v)));
      volResults.forEach((r, i) => {
        if (r.status === "rejected") log.warn(`[announce] ${targets[i]} 播报音量 ${v} 未确认:${(r.reason as Error)?.message || r.reason}`);
      });
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
    //    setDeviceVolume 自带确认+重发;还原失败会导致设备音量停在播报档,记日志提示。
    const restoreResults = await Promise.allSettled(
      saved
        .filter(s => typeof opts.volume === "number")
        .map(s => setDeviceVolume(s.deviceId, s.volume)),
    );
    restoreResults.forEach((r, i) => {
      if (r.status === "rejected") log.warn(`[announce] 还原音量失败(${i}):${(r.reason as Error)?.message || r.reason}`);
    });

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

// ==================== AirPlay 播报 ====================
//
// 同样的保存→冻结→播报→还原→恢复语义,发声通道换成 RAOP:
//   - 状态/音量经 airplay/control(音量对 LinkPlay 会转发到同机 DLNA);
//   - TTS 外链由 castToAirPlayDevice 直接起 RAOP 会话(传 streamUrl,不走曲库);
//   - 播完用状态轮询收敛(playbackState 回到 IDLE 即会话终结)。
async function announceAirPlay(opts: AnnounceOptions): Promise<{ targets: number }> {
  const { peerId, url } = opts;
  const deviceId = peerId.slice(8);
  const saved = { volume: 80, wasPlaying: false, position: 0 };
  try {
    const st = getAirPlayStatus(deviceId);
    saved.volume = st.volume;
    saved.wasPlaying = st.playbackState === PlaybackState.PLAYING;
    saved.position = st.position;
  } catch { /* 取不到按静默 idle 处理 */ }

  const qc = getQueueController();
  const snap = qc.snapshot(peerId);
  const wasActive = snap.isActive && snap.currentIndex >= 0;
  try {
    if (wasActive) qc.deactivate(peerId);
    if (typeof opts.volume === "number") {
      const v = Math.max(0, Math.min(100, Math.round(opts.volume)));
      await setAirPlayVolume(deviceId, v).catch((e: any) =>
        log.warn(`[announce] ${deviceId} 播报音量 ${v} 未确认:${e?.message || e}`));
    }
    await castToAirPlayDevice({
      deviceId,
      songId: `__announce__${Date.now()}`,
      title: "Announcement",
      streamUrl: url,
    });
    await waitUntilAirPlayIdle(deviceId, opts.timeoutMs ?? 300000);
    if (typeof opts.volume === "number") {
      await setAirPlayVolume(deviceId, saved.volume).catch((e: any) =>
        log.warn(`[announce] 还原音量失败:${e?.message || e}`));
    }
    if (wasActive && saved.wasPlaying) {
      const baseUrl = getEffectiveBaseUrl();
      await qc.playFrom(peerId, snap.items, snap.currentIndex, baseUrl);
      if (saved.position > 2) {
        await new Promise(r => setTimeout(r, 1200));
        await qc.transport(peerId, "seek", saved.position).catch(() => {});
      }
    }
    return { targets: 1 };
  } finally {
    running.delete(peerId);
  }
}

/** 轮询 AirPlay 会话状态直到 IDLE(会话终结)或超时。对照 waitUntilStopped。 */
async function waitUntilAirPlayIdle(deviceId: string, budgetMs = 300000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  // 起播要时间,先给 1.5s 缓冲再判定,否则读到旧 IDLE 误判成已播完。
  await new Promise(r => setTimeout(r, 1500));
  while (Date.now() < deadline) {
    try {
      const st = getAirPlayStatus(deviceId);
      if (st.playbackState === PlaybackState.IDLE) return;
    } catch { /* 设备抖动,继续等 */ }
    await new Promise(r => setTimeout(r, 500));
  }
}

// ==================== Sendspin 播报 ====================
//
// 服务端自有推流管线:TTS 外链拉回解码成 PCM,直接按组时间线推给客户端,
// 不经过曲库 pump。暂停/恢复/进度走通用 QueueController(队列冻结 + playFrom + seek)。
// 双模式:sendspin 运行时已 fork 到专属子进程 —— 推帧/编码走子进程(RPC),
// 队列冻结/恢复(QC)留主进程。in-proc(单测/子进程自身)直接调 playerCore。
async function announceSendspin(opts: AnnounceOptions): Promise<{ targets: number }> {
  const { peerId, url } = opts;
  const { isForkMode } = await import("../sendspin/mode.js");
  const qc = getQueueController();
  const snap = qc.snapshot(peerId);
  const wasActive = snap.isActive && snap.currentIndex >= 0;
  // 现场(在播?进度?)必须在 deactivate **之前**捕获 —— deactivate 会停流清 current。
  let probe: { wasPlaying: boolean; savedPos: number };
  if (isForkMode()) {
    const { sendspinSupervisor } = await import("../sendspin/supervisor.js");
    if (!sendspinSupervisor.isRunning()) throw new Error("sendspin 服务未运行");
    probe = await sendspinSupervisor.rpc("announceProbe", { peerId });
  } else {
    const { getSendspinServer } = await import("../sendspin/index.js");
    const { announceProbeCore } = await import("../sendspin/playerCore.js");
    const srv = getSendspinServer();
    if (!srv) throw new Error("sendspin 服务未运行");
    probe = announceProbeCore(srv, peerId);
  }
  try {
    if (wasActive) qc.deactivate(peerId);
    let result: { targets: number };
    if (isForkMode()) {
      const { sendspinSupervisor } = await import("../sendspin/supervisor.js");
      // 播报可能长达数分钟(TTS 长文),RPC 超时放宽到 6min(内部另有 deadline 300s)。
      result = await sendspinSupervisor.rpc(
        "announce",
        { peerId, url, volume: opts.volume, timeoutMs: opts.timeoutMs, savedPos: probe.savedPos },
        360_000,
      );
    } else {
      const { getSendspinServer } = await import("../sendspin/index.js");
      const { announceCore } = await import("../sendspin/playerCore.js");
      const srv = getSendspinServer();
      if (!srv) throw new Error("sendspin 服务未运行");
      result = await announceCore(srv, peerId, url, {
        volume: opts.volume,
        timeoutMs: opts.timeoutMs,
        savedPos: probe.savedPos,
      });
    }
    if (wasActive && probe.wasPlaying) {
      const baseUrl = getEffectiveBaseUrl();
      await qc.playFrom(peerId, snap.items, snap.currentIndex, baseUrl);
      if (probe.savedPos > 2000) {
        await new Promise((r) => setTimeout(r, 1200));
        await qc.transport(peerId, "seek", Math.floor(probe.savedPos / 1000)).catch(() => {});
      }
    }
    return { targets: result.targets };
  } finally {
    running.delete(peerId);
  }
}
