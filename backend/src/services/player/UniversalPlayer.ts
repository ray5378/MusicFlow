// 协议聚合壳。对照 MA UniversalPlayer:
//   - 自身无 play_media,转发给底层协议 player
//   - 状态聚合自协议 player
//   - queue 挂在 UniversalPlayer 上(由 QueueController 持有)
//
// 当前只接 DLNA 协议 player。未来加 Cast/AirPlay 时,在此层做协议选择。
import { ProtocolPlayer, QueueItem, PlayerState, PlaybackState } from "./types.js";

export class UniversalPlayer {
  constructor(
    public readonly playerId: string,   // "universal:<id>" 或直接复用 "dlna:<deviceId>"
    public readonly name: string,
  ) {}

  private protocol: ProtocolPlayer | null = null;

  /** 绑定底层协议 player(DLNA / 未来 Cast)。 */
  attachProtocol(player: ProtocolPlayer): void {
    this.protocol = player;
  }

  getProtocol(): ProtocolPlayer | null {
    return this.protocol;
  }

  async playMedia(item: QueueItem, baseUrl: string): Promise<{ mediaUri: string }> {
    if (!this.protocol) throw new Error(`UniversalPlayer ${this.playerId} 无协议 player`);
    return this.protocol.playMedia(item, baseUrl);
  }

  async stop(): Promise<void> { await this.protocol?.stop(); }
  async pause(): Promise<void> { await this.protocol?.pause(); }
  async resume(): Promise<void> { await this.protocol?.resume(); }
  async seek(s: number): Promise<void> { await this.protocol?.seek(s); }
  async setVolume(v: number): Promise<void> { await this.protocol?.setVolume(v); }

  async pollState(): Promise<PlayerState> {
    if (!this.protocol) {
      return { playerId: this.playerId, playbackState: PlaybackState.IDLE, position: 0, duration: 0, updatedAt: Date.now() };
    }
    return this.protocol.pollState();
  }
}
