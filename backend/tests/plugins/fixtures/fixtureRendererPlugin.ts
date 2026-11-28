// ==================== V13 新协议 fixture（仅测试线路，不发布） ====================
//
// 用途：证明「新增一个渲染协议 = 加一个插件 + 在 manifest.protocols 自述归属」，
// 核心零改动即可完成「发现 → 解析 → 起播」（见 docs/renderer-plugin-migration-plan.md
// §14.2 V13）。本协议名不在 KNOWN_RENDERER_PROTOCOLS 里，也不存在任何核心分支。
import type { RendererPlugin, PluginManifest } from "../../../src/plugins/types.js";
import type { ProtocolPlayer, PlayerState, QueueItem } from "../../../src/services/player/types.js";
import { PlaybackState } from "../../../src/services/player/types.js";

export const FIXTURE_PROTOCOL = "fixture";
export const FIXTURE_DEVICE_ID = "fx-device-1";

export interface FixtureProtocolPlayer extends ProtocolPlayer {
  /** 记录收到的调用（顺序敏感），供断言「起播确实打到插件」。 */
  calls: string[];
}

export function createFixtureProtocolPlayer(deviceId: string): FixtureProtocolPlayer {
  const playerId = `${FIXTURE_PROTOCOL}:${deviceId}`;
  const calls: string[] = [];
  return {
    playerId,
    calls,
    async playMedia(item: QueueItem): Promise<{ mediaUri: string }> {
      calls.push(`play:${item.songId}`);
      return { mediaUri: `fixture://${item.songId}` };
    },
    async stop(): Promise<void> {
      calls.push("stop");
    },
    async pause(): Promise<void> {
      calls.push("pause");
    },
    async resume(): Promise<void> {
      calls.push("resume");
    },
    async seek(seconds: number): Promise<void> {
      calls.push(`seek:${seconds}`);
    },
    async setVolume(vol: number): Promise<void> {
      calls.push(`volume:${vol}`);
    },
    async pollState(): Promise<PlayerState> {
      return {
        playerId,
        playbackState: PlaybackState.PLAYING,
        position: 0,
        duration: 0,
        updatedAt: Date.now(),
      };
    },
  };
}

export const fixtureRendererManifest: PluginManifest = {
  id: "fixture-renderer",
  name: "Fixture Renderer (V13)",
  version: "0.0.1",
  type: "renderer",
  description: "契约测试用假渲染器：验证新增协议无需核心改动",
  capabilities: ["renderer"],
  protocols: [FIXTURE_PROTOCOL],
  defaultEnabled: true,
  configSchema: [],
};

export const fixtureRendererPlugin: RendererPlugin = {
  manifest: fixtureRendererManifest,
  /** 与三内置插件同构：**同步**返回、自校验协议与设备归属、每次新建实例。 */
  createPlayer(protocol, deviceId) {
    if (protocol !== FIXTURE_PROTOCOL) return null;
    if (deviceId !== FIXTURE_DEVICE_ID) return null;
    return createFixtureProtocolPlayer(deviceId);
  },
  async discover() {
    return [{ id: FIXTURE_DEVICE_ID, name: "Fixture Speaker", type: FIXTURE_PROTOCOL, available: true }];
  },
  async cast(): Promise<{ mediaUri: string }> {
    throw new Error("fixture renderer 仅用于契约测试，不支持 cast");
  },
};
