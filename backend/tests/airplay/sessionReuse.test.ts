// 锁死对象:`services/airplay/session.ts` 的 `createAirPlaySession` 的 **token 复用纪律** ——
// 与 DLNA 的 `createCastSession` 同根因(见 tests/dlna/castSessionReuse.test.ts):
// 同 (songId, deviceId) 的未过期会话必须复用 token(仅续期),否则同歌 seek 重建流
// 后 mediaUri 变化会触发 PlaybackTracker 的「PLAYING 且 uri 变 = 换歌」误判 →
// 自动 advance 切下一首。SQLite 主路径与内存回退路径都要钉住。
import { describe, it, expect } from "vitest";
import { createAirPlaySession, resolveAirPlaySession } from "../../src/services/airplay/session.js";

const BASE = "http://192.168.10.240:46400";

describe("createAirPlaySession:同 (songId,deviceId) 复用 token", () => {
  it("同歌同设备连续两次 → 同 token 同 streamUrl", () => {
    const a = createAirPlaySession("aps-song-1", "aps-dev-1", BASE);
    const b = createAirPlaySession("aps-song-1", "aps-dev-1", BASE);
    expect(b.token).toBe(a.token);
    expect(b.streamUrl).toBe(a.streamUrl);
    expect(b.expiresAt).toBeGreaterThanOrEqual(a.expiresAt);
  });

  it("换歌 → 新 token(track_changed 判据对真换歌仍有效)", () => {
    const a = createAirPlaySession("aps-song-2", "aps-dev-2", BASE);
    const b = createAirPlaySession("aps-song-3", "aps-dev-2", BASE);
    expect(b.token).not.toBe(a.token);
  });

  it("同歌不同设备 → 新 token", () => {
    const a = createAirPlaySession("aps-song-4", "aps-dev-3", BASE);
    const b = createAirPlaySession("aps-song-4", "aps-dev-4", BASE);
    expect(b.token).not.toBe(a.token);
  });

  it("复用后的 token 仍解析出同一 (songId, deviceId)", () => {
    createAirPlaySession("aps-song-5", "aps-dev-5", BASE);
    const b = createAirPlaySession("aps-song-5", "aps-dev-5", BASE);
    expect(resolveAirPlaySession(b.token)).toEqual({ songId: "aps-song-5", deviceId: "aps-dev-5" });
  });
});
