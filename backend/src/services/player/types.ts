// MA 式 player 状态类型。对照 MA 的 PlaybackState + PlayerState + CompareState。

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
  mime: string;
  coverArt?: string;
  duration?: number;
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
}
