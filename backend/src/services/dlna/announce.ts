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
import { nowUs } from "../sendspin/clock.js";
import { FIRST_FRAME_LEAD_US } from "../sendspin/streamEngine.js";
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
async function announceSendspin(opts: AnnounceOptions): Promise<{ targets: number }> {
  const { peerId, url } = opts;
  const { getSendspinServer } = await import("../sendspin/index.js");
  const { decodeToF32, SAMPLE_RATE, CHANNELS } = await import("../sendspin/encoding.js");
  const srv = getSendspinServer();
  if (!srv) throw new Error("sendspin 服务未运行");
  const clientId = peerId.slice(9);
  const conn = srv.clients.get(clientId);
  const g = srv.group(clientId);
  const qc = getQueueController();
  const snap = qc.snapshot(peerId);
  const wasActive = snap.isActive && snap.currentIndex >= 0;
  const wasPlaying = !!g.current;

  // 现场:音量(连接+组)与进度。无 current(闲置Coordinator)则进度从 0 起。
  const savedVol = conn?.volume ?? 100;
  const savedGroupVol = g.volume;
  const savedPos = g.current ? g.positionMs : 0;
  try {
    if (wasActive) qc.deactivate(peerId);
    if (typeof opts.volume === "number") {
      const v = Math.max(0, Math.min(100, Math.round(opts.volume)));
      if (conn) conn.volume = v;
      g.volume = v;
    }
    // 拉 TTS → 解码 48k 立体声。外链抓取 15s 超时,失败直接进恢复流程抛错。
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) throw new Error(`TTS 拉取失败: HTTP ${resp.status}`);
    const pcm = await decodeToF32(new Uint8Array(await resp.arrayBuffer()));
    // 入组(之前没在播就没成员)+ 宣告流格式,否则帧无处下发 / 客户端无格式丢弃。
    // 播完后若是新加的则摘掉,恢复播报前成员原样。
    let joined = false;
    if (conn && !g.members.has(conn)) {
      g.add(conn);
      joined = true;
    }
    if (conn) conn.announceStream();
    try {
      // 固定 20ms 喂料(960 样本/声道):播报要短延迟出首声,粒度越小越早凑满首块。
      // MA `chunk_duration_us = 25_000` 是**稳态推流**的粒度,播报属一次性短音频,
      // 粒度取 20ms 让 libFLAC 尽快凑满 4096 样本的块(≈85ms)并回调首帧。
      // ⚠️ 2026-09-17:此处已不再依赖任何编码器前瞻 —— flac 走**进程内 libFLAC**
      // (`LibFlacEncoder`),`process_interleaved()` 同步返回、每回调恰好一帧,
      // 无管道、无 ~1.1s 前瞻。flush() 只用于冲掉不足一块的尾帧。
      const frameSamples = SAMPLE_RATE * CHANNELS * 20 / 1000;
      const endCap = g.current && g.current.durationMs > 0 ? Math.max(0, g.current.durationMs - 500) : Infinity;
      let cursor = g.timelineBaseUs;
      let firstFrame = true;
      const deadline = Date.now() + (opts.timeoutMs ?? 300000);
      for (let off = 0; off < pcm.length; off += frameSamples) {
        if (Date.now() > deadline) break;
        const slice = pcm.subarray(off, Math.min(off + frameSamples, pcm.length));
        const posMs = Math.min(savedPos + Math.round((off / frameSamples) * 20), endCap);
        g.positionMs = posMs;
        // 时间戳与曲库推流同一套模型(MA `push_stream.py:1313`):
        // 首块锚在「当时墙钟 + 组公共 send_ahead」,之后**按实际产出样本数**累加。
        // 锚点必须用与帧头同源的 send_ahead,否则 delta≠0 → 设备立即吐字节 → 断流。
        if (firstFrame) {
          firstFrame = false;
          const aheadUs = g.commonSendAheadUs();
          cursor = nowUs() + BigInt(Math.max(aheadUs, FIRST_FRAME_LEAD_US));
        }
        const produced = Number(await g.pushFrame(cursor, slice)) || 0;
        cursor += BigInt(Math.round(((produced > 0 ? produced : Math.floor(slice.length / CHANNELS)) / SAMPLE_RATE) * 1_000_000));
        g.timelineBaseUs = cursor;
        await new Promise(r => setTimeout(r, 20));
      }
      // 逼出编码器内部尚未吐出的尾帧:不 flush 则 ≤1.1s 的短播报可能一帧都没出去
      // (ffmpeg 前瞻窗口,与调度粒度无关);顺带让首段拿到真实 STREAMINFO。
      for (const c of [...g.members]) {
        const enc = g.encoderFor(c);
        if (!enc.flush) continue;
        try {
          const tail = await enc.flush();
          for (const ck of tail) {
            if (!ck?.data || ck.data.length === 0) continue;
            c.sendAudio(cursor, ck.data);
            cursor += BigInt(Math.round(((ck.frameSamples ?? 0) / SAMPLE_RATE) * 1_000_000));
          }
        } catch { /* 尾帧失败不影响主流程 */ }
      }
      g.timelineBaseUs = cursor;
    } finally {
      if (joined && conn) g.remove(conn);
    }
    if (conn) conn.volume = savedVol;
    g.volume = savedGroupVol;
    if (wasActive && wasPlaying) {
      const baseUrl = getEffectiveBaseUrl();
      await qc.playFrom(peerId, snap.items, snap.currentIndex, baseUrl);
      if (savedPos > 2000) {
        await new Promise(r => setTimeout(r, 1200));
        await qc.transport(peerId, "seek", Math.floor(savedPos / 1000)).catch(() => {});
      }
    }
    return { targets: 1 };
  } finally {
    running.delete(peerId);
  }
}
