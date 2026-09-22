// 锁死对象:`services/dlna/control.ts` 的 `createCastSession` 的 **token 复用纪律** ——
// 同 (songId, deviceId) 的未过期会话必须返回同一 token(仅续期),对齐 MA 的
// 「同一队列项流 URL 恒定」(resolve_stream_url 对同一 queue item 永远给同一 URL)。
//
// 为什么必须有这组测试:此前每次投流都 mint 新 token,同歌 seek 重投
// (Stop→SetAVTransportURI)后设备 TrackURI 必变,PlaybackTracker 的
// 「PLAYING 且 uri 变 = native gapless 换歌」判据把同歌重投误判成换歌 →
// 自动 advance 切下一首(240 真机实锤:4 次拖拽 2 次中招,HA 卡片与客户端同病,
// 「拖到靠近结尾必切下一首」)。手测极难稳定复现(依赖轮询相位跳过 BUFFERING
// 采样),故用单测钉住判据。
import { describe, it, expect } from "vitest";
import { createCastSession, resolveCastSession } from "../../src/services/dlna/control.js";

const BASE = "http://192.168.10.240:46400";

describe("createCastSession:同 (songId,deviceId) 复用 token(对齐 MA 稳定流 URL)", () => {
  it("同歌同设备连续两次 → 同 token 同 streamUrl(TrackURI 不变,tracker 不误判换歌)", () => {
    const a = createCastSession("csr-song-1", "csr-dev-1", BASE);
    const b = createCastSession("csr-song-1", "csr-dev-1", BASE);
    expect(b.token).toBe(a.token);
    expect(b.streamUrl).toBe(a.streamUrl);
    expect(b.expiresAt).toBeGreaterThanOrEqual(a.expiresAt);
  });

  it("换歌 → 新 token(PlaybackTracker 的 track_changed 判据对真换歌仍有效)", () => {
    const a = createCastSession("csr-song-2", "csr-dev-2", BASE);
    const b = createCastSession("csr-song-3", "csr-dev-2", BASE);
    expect(b.token).not.toBe(a.token);
  });

  it("同歌不同设备 → 新 token(设备间互不串流)", () => {
    const a = createCastSession("csr-song-4", "csr-dev-3", BASE);
    const b = createCastSession("csr-song-4", "csr-dev-4", BASE);
    expect(b.token).not.toBe(a.token);
  });

  it("复用后的 token 仍解析出同一 (songId, deviceId)(出流路由语义不变)", () => {
    createCastSession("csr-song-5", "csr-dev-5", BASE);
    const b = createCastSession("csr-song-5", "csr-dev-5", BASE);
    expect(resolveCastSession(b.token)).toEqual({ songId: "csr-song-5", deviceId: "csr-dev-5" });
  });
});
