// MA 式 player 状态类型。对照 MA 的 PlaybackState + PlayerState + CompareState。
//
// 注意 `PreProbeStatus` 是 **type-only import**（编译后擦除）—— 与
// preProbeScheduler ↔ types 之间不构成运行时循环。
import type { PreProbeStatus } from "./preProbeScheduler.js";

/** 播放状态机。对照 MA PlaybackState。 */
export enum PlaybackState {
  IDLE = "IDLE",            // 设备 STOPPED / NO_MEDIA_PRESENT
  PLAYING = "PLAYING",
  PAUSED = "PAUSED",
  BUFFERING = "BUFFERING",  // TRANSITIONING 映射到这里(屏蔽瞬态,见 PlaybackTracker)
}

/** Player 当前状态快照。对照 MA PlayerState(精简版)。 */
export interface PlayerState {
  playerId: string;          // dlna:<deviceId> (未来 universal:<id>)
  playbackState: PlaybackState;
  position: number;          // 秒
  duration: number;          // 秒
  mediaUri?: string;         // 当前流 URL,用于检测曲目切换
  updatedAt: number;         // ms epoch,状态最后一次刷新
}

/** 状态迁移比较快照。对照 MA CompareState。PlaybackTracker 据此判断。 */
export interface CompareState {
  playbackState: PlaybackState;
  mediaUri?: string;
  position: number;
  duration: number;
  updatedAt: number;
}

export function toCompareState(s: PlayerState): CompareState {
  return {
    playbackState: s.playbackState,
    mediaUri: s.mediaUri,
    position: s.position,
    duration: s.duration,
    updatedAt: s.updatedAt,
  };
}

/** 队列播放模式。对照本地原有 PlayMode(order/one/all/shuffle)。 */
export type PlayMode = "order" | "one" | "all" | "shuffle";

export interface QueueItem {
  songId: string;
  title: string;
  artist?: string;
  album?: string;
  albumId?: string;
  mime: string;
  coverArt?: string;
  duration?: number;
  // 以下为展示用扩展元数据(HA 的 media_track / media_album_artist 等需要)。
  // 全部可选:只带 songId 的精简队列项(HA 点播 / flow / 持久化恢复)会在 cast 前
  // 由 QueueController.resolveItem 补齐。
  track?: number;        // 曲目号
  discNumber?: number;   // 碟号
  albumArtist?: string;  // 专辑艺术家(取自 albums 表,缺失时退化为 artist)
  year?: number;         // 发行年份(取自 albums 表)
  genre?: string;        // 流派
}

/** 协议端点接口:DLNA / 未来 Cast 都实现这个。对照 MA 协议 player 契约。 */
export interface ProtocolPlayer {
  playerId: string;
  /** 执行播放一首(Stop→Set→wait→Play)。返回上报用的 mediaUri。 */
  playMedia(item: QueueItem, baseUrl: string): Promise<{ mediaUri: string }>;
  stop(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  seek(seconds: number): Promise<void>;
  setVolume(vol: number): Promise<void>;
  /** 主动查询设备状态(SOAP poll)。GENA 事件路径不依赖此方法。 */
  pollState(): Promise<PlayerState>;
}

/** 队列快照(对照原 QueueSnapshot,新增 ended 字段)。 */
export interface QueueSnapshot {
  items: QueueItem[];
  currentIndex: number;
  playMode: PlayMode;
  isActive: boolean;
  ended: boolean;
  /**
   * 随机播放的**权威洗牌序列**（队列下标数组，一轮内不重复）与当前位置。
   *
   * 为什么必须下发（2026-09-10）：
   * 洗牌序列此前只存在于服务端内存，客户端（Flutter / HA / 卡片）各自实现了
   * 一份自己的洗牌逻辑 → **两份随机序列必然不一致** → 客户端显示/预测的
   * 「下一首」与设备实际播放的不是同一首歌，用户观感是「推的不是当前播放的歌」。
   *
   * 现约定：**洗牌序列的唯一权威在服务端**，客户端只做镜像（对齐 SPEC）。
   * - `shuffleOrder` 非 shuffle 模式或队列未就绪时为空数组；
   * - 客户端据此渲染队列面板顺序 / 预测下一首，**不得自行生成**；
   * - 纯离线队列（服务端无从知晓，如本地已缓存列表）例外，由客户端本地洗牌。
   */
  shuffleOrder?: number[];
  /** 当前曲在 `shuffleOrder` 中的位置；-1 表示未就绪。 */
  shufflePos?: number;
  /** 洗牌序列版本号:服务端每次重建(整队替换/长度变化/显式重洗/重启后重建)+1。
   *  客户端缓存序列时据此检测换版 —— epoch 变了必须重新定位当前曲在序列中的位置。 */
  shuffleEpoch?: number;
  /**
   * 服务端预探测状态位（2026-09-11）。
   *
   * 由 QueueController 从 `PreProbeScheduler.status()` 填入，随快照自动下发 ——
   * `GET /v1/peers/:id/queue` 与 WS `queue_changed`/`peer_queue_changed`
   * 都用展开语法透传，**无需新增事件类型**。
   *
   * 消费方约定：**仅 Web 端**渲染（右上角持久轻提示 + 缓冲水位）；
   * HA 卡片不读该字段 ⇒ 天然不显示，不必改一行代码。
   *
   * `exhausted` 在冷却到期后由 `status()` 自动回落为 false ——
   * 提示随状态消失，不留一条与事实不符的告警。
   */
  preProbe?: PreProbeStatus;
}
