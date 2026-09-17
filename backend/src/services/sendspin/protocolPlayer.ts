// Sendspin ProtocolPlayer — 把每个 Sendspin 客户端(或客户端组)接入统一队列/传输
// 机制(UniversalPlayer + QueueController),与 DLNA 设备完全同构。音频由
// services/sendspin/server.ts 的 SendspinGroup 一次性解码→逐客户端编码→同一时间线
// 推流驱动;本文件只把 ProtocolPlayer 契约映射到 SendspinServer 的组/连接状态上。
//
// 与 DLNA 一样,报给上游的 mediaUri 复用 createCastSession 的 token 流地址(供
// PlayerController 检测曲目切换),真正音频走内部推流,不依赖设备回连拉流。
import { PlaybackState, type PlayerState, type ProtocolPlayer, type QueueItem } from "../player/types.js";
import { createCastSession, getEffectiveBaseUrl } from "../dlna/control.js";
import { getServer } from "./runtime.js";
import { pumpFor } from "./streamEngine.js";
import { getPlayerController, getQueueController } from "../player/index.js";

/** 单个 sendspin 客户端抽象成一个 ProtocolPlayer。 */
export function createSendspinProtocolPlayer(clientId: string): ProtocolPlayer {
  const playerId = `sendspin:${clientId}`;
  return {
    playerId,
    async playMedia(item: QueueItem, baseUrl: string) {
      const srv = getServer();
      if (!srv) throw new Error(`sendspin server not running: ${clientId}`);
      const conn = srv.clients.get(clientId);
      // 同一时间线推流:组 = 以 clientId 命名的组(多客户端场景由注册层归并)。
      const g = srv.group(clientId);
      const pump = pumpFor(srv, g);
      pump.stop(); // 打断上一首,避免重叠推流
      // ⚠️ 切歌必须先 stream/end 收尾旧流,再 stream/start 起新流(成对)。
      // 只发 stream/start 会让设备把新流塞进「旧解码上下文」——它认为扬声器已在跑,
      // 不重建 ring buffer/speaker task,新流音频无从解码 → 链路上一切正常但**无声**
      // (2026-09-17 ESPHome 真机:重发 stream/start 后只剩 codec header 一行日志)。
      // MA 金标准同样是 `Stream ended` → `Stream Started` 成对出现。
      // 顺序:先置空 current 让 group/update 报 stopped,再 finishPlayback 发 stream/end;
      // 关掉旧编码器同时清掉残留分段(否则旧段字节会混进新歌首帧)。
      g.current = null;
      g.close();
      g.finishPlayback();
      g.positionMs = 0;
      // 当前曲元数据进组状态:status.media / queue currentMedia 据此上报,
      // 前端与 HA 靠 media.songId 变化触发歌词/封面刷新(缺了就卡在第一首)。
      g.current = { songId: item.songId, title: item.title, artist: item.artist, album: item.album, coverArt: item.coverArt, durationMs: (item.duration ?? 0) * 1000 };
      // mediaUri:token 流地址,仅供 track_changed 检测;音频走内部推流。
      const streamUrl = createCastSession(item.songId, clientId, baseUrl).streamUrl;
      if (conn) {
        conn.group = g;
        g.add(conn); // 成员入组,推流才真正下发
        // 起播宣告:先组状态(playing),**再** stream/start —— 对齐 aiosendspin 的
        // `group/update(playing) → stream/start`(见 MA 真机:前者先到)。此前我们
        // 反着发(stream/start 在前),组状态仍 stopped 时设备端直接忽略 stream/start,
        // 无 format 不播 → ESPHome 真机一直不进入 PLAYING 的根因在此。
        //
        // ⚠️ stream/start **不能在这里立刻发**:下面 pump.play() 要先解析网络源 + ffmpeg
        // 解码整曲,实测耗时可达 **10s**(长曲更久)。若 stream/start 先发而首块音频
        // 10s 后才到,设备侧会在等待中丢弃该流 —— 表现为收到 `Stream Started` 但
        // **不做 codec header 处理**、扬声器不启动 = 无声(2026-09-17 真机实锤)。
        // MA 的解法(player/v1.py `_pending_stream_start`)正是把这个消息**推迟到
        // 第一块音频到达时**才发 —— 我们同样用 pump 的 onFirstFrame 回调触发。
        conn.sendGroupUpdate();
        g.pendingAnnounce = conn;
      }
      // 起播即推 media_changed(HA 卡片歌词/封面即时跟随,不必等 2s 轮询;
      // 对齐 DLNA castToDevice 的 media_changed + player_refresh)。
      // 经 QueueController 事件总线 → ws 转发(device_id=裸 clientId)。
      // player/index 动态导入:避免 sendspin/protocolPlayer 在模块初始化期被
      // 静态拉入 player/index → sendspin 的模块环。
      void import("../player/index.js").then(({ getQueueController }) => {
        try {
          getQueueController().emit("media_changed", clientId, {
            songId: item.songId,
            title: item.title,
            artist: item.artist,
            album: item.album,
            coverArt: item.coverArt,
          });
        } catch { /* 控制器未就绪时忽略 */ }
      }).catch(() => {});
      // 后台起播:解码→按组时间线推流。不阻塞 playMedia 返回(pollState 反映进度)。
      void pump.play(item.songId).catch((e) => {
        // 无可播源等:置空 current,交 QueueController 走跳过/换源。
        // stream/start 已发过,必须 stream/end 收尾,否则客户端空等。
        g.current = null;
        g.finishPlayback();
        getServer()?.log("warn", `sendspin play ${item.songId} failed: ${(e as Error)?.message || e}`);
      });
      // 服务端权威起播即上报 PLAYING:sendspin 没有 GENA/秒级上报,PlaybackTracker 只能靠
      // QueueController 每 5s 的轮询喂 PLAYING。曲目短于轮询间隔(如 3s 测试曲)时,唯一那次
      // 轮询常在自然结束后才到 → lastPlaying 从没置位 → 自然结束(auto-advance)永不触发,
      // 队列卡死(见 streamEngine.ts 头部注)。这里在起播瞬间 push 一次 PLAYING,让
      // tracker 立即记下 lastPlaying(并关闭乐观窗口),之后 poll 到 IDLE 即确定性 advance。
      // ⚠️ 必须异步(setTimeout 0)上报:playCurrent 在 `await player.playMedia(...)` 之后
      // 同步调用 resetTracker(清掉"上一首"的 lastPlaying 防误 advance)。若这里同步上报,
      // 刚置上的 lastPlaying 会被 resetTracker 清掉 → 自然结束的 IDLE 又无 lastPlaying →
      // 卡死(见 QueueController.playCurrent 注释)。setTimeout 回调是宏任务,必然晚于
      // resetTracker(该同步调用所在的微任务),从而保住本首的 PLAYING。
      setTimeout(() => {
        getPlayerController().reportState({
          playerId,
          playbackState: PlaybackState.PLAYING,
          position: g.positionMs / 1000,
          duration: (g.current?.durationMs ?? (item.duration ?? 0) * 1000) / 1000,
          updatedAt: Date.now(),
        });
      }, 0);
      return { mediaUri: streamUrl };
    },
    async stop() {
      const g = groupOf(clientId);
      const srv = getServer();
      if (srv) pumpFor(srv, srv.group(clientId)).stop();
      g.positionMs = 0;
      g.current = null;
      // 流结束 + playback_state → stopped,组状态同步给客户端(自然结束走 pump)。
      const live = srv?.group(clientId);
      if (live) live.finishPlayback();
      else srv?.clients.get(clientId)?.sendGroupUpdate();
    },
    async pause() {
      const srv = getServer();
      if (srv) pumpFor(srv, srv.group(clientId)).pause();
    },
    async resume() {
      const srv = getServer();
      if (!srv) return;
      const g = srv.group(clientId);
      const pump = pumpFor(srv, g);
      // 已在推流(暂停中) → 原地恢复即可,不动流(不会重发 stream/start)。
      if (pump.active) {
        pump.resume();
        return;
      }
      // 无推流在跑(冷起播 / 上次 stop 之后)=**真正的起播**。
      //
      // ⚠️ 这里曾只调 pump.resume()(空操作),后果是「点播放没声音」:
      //   POST /peers/:id/play → transport("play") → player.resume();
      //   而 resumePlayback() 见 q.isActive=true 直接早退(currentIndex 有效但从未起播),
      //   于是没有 playMedia、没有 stream/start、没有 pump → 全链路静默
      //   (2026-09-17 ESPHome 真机实测:服务端无 pushFrame、设备端停在 IDLE)。
      //   对照 DLNA:它的 resume() = playDevice()(重发 SetAVTransportURI)= 真起播,
      //   所以 DLNA 从未暴露这个缺口 —— sendspin 必须自己补上「冷起播走 playMedia」。
      const qc = getQueueController();
      const snap = qc.snapshot(clientId);
      const item = snap.currentIndex >= 0 ? snap.items[snap.currentIndex] : undefined;
      if (!item) {
        srv.log("warn", `sendspin resume: ${clientId} 无当前曲(队列空或未选曲),忽略`);
        return;
      }
      // 只带 songId 的 item 需补全元数据(coverArt/mime 等),否则组状态缺字段。
      const fullItem = await qc.resolveItem(item);
      await this.playMedia(fullItem, getEffectiveBaseUrl());
    },
    async seek(seconds: number) {
      const g = groupOf(clientId);
      g.positionMs = Math.max(0, seconds * 1000);
    },
    async setVolume(vol: number) {
      const srv = getServer();
      const conn = srv?.clients.get(clientId);
      if (conn) conn.volume = Math.min(100, Math.max(0, vol));
      groupOf(clientId).volume = Math.min(100, Math.max(0, vol));
    },
    async pollState(): Promise<PlayerState> {
      const g = groupOf(clientId);
      // 逻辑播放状态以「组当前曲」为准(已注册播放器在投/续播即视为播放中);
      // 连接就绪与否只影响推流可达性,不改变 QueueController 的切歌/恢复判定。
      const playing = !!g.current;
      return {
        playerId,
        playbackState: playing ? PlaybackState.PLAYING : PlaybackState.IDLE,
        position: g.positionMs / 1000,
        duration: (g.current?.durationMs ?? 0) / 1000,
        updatedAt: Date.now(),
      };
    },
  };
}

/** 取 clientId 对应组;服务端未运行则返回内存假组(供未连接时的幂等控制)。 */
function groupOf(clientId: string): SendspinGroupLike {
  const srv = getServer();
  if (!srv) return ephemeralGroup(clientId);
  return srv.group(clientId);
}

// 内存假组:服务未跑但在做 URI 兜底/状态构造时安全返回。
interface SendspinGroupLike {
  positionMs: number;
  volume: number;
  current: { songId: string; title?: string; artist?: string; durationMs: number } | null;
}
const ephemeralMap = new Map<string, SendspinGroupLike>();
function ephemeralGroup(clientId: string): SendspinGroupLike {
  let g = ephemeralMap.get(clientId);
  if (!g) {
    g = { positionMs: 0, volume: 100, current: null };
    ephemeralMap.set(clientId, g);
  }
  return g;
}