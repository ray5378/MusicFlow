// AirPlay 源端「进度 / 当前曲」读取的桥兜底契约（v4.15.17）。
// 背景：桥播放（单机桥 / 群组桥成员）时 RAOP 会话表为空或 relTime 恒 0，
// 只读 getAirPlayPeerStatus 会把 8s 的源读成 0s ⇒ 流转目标从 0 起播
// （v4.15.15/v4.15.16 真机 A/B 同症，2026-11-28）。这里钉死：
//   1) RAOP 位置为 0 时取泵派生桥状态的位置；
//   2) RAOP 有非零位置时仍优先 RAOP（不改变非桥路径）；
//   3) 两条链都没有位置时返回 0（不把旧行为改成 null）；
//   4) 当前曲：RAOP 无 media 时用桥 media 校正下标，有 media 时不被桥覆盖。
import "../plugins/_env.js";
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  ap: { position: 0, songId: undefined as string | undefined, media: undefined as any },
  bridge: null as any,
}));

vi.mock("../../src/services/airplay/control.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/services/airplay/control.js")>();
  return {
    ...actual,
    getAirPlayPeerStatus: () => ({
      state: "PLAYING",
      position: h.ap.position,
      duration: 180,
      volume: 40,
      muted: false,
      updatedAt: 0,
      trackUri: "",
      songId: h.ap.songId,
      media: h.ap.media,
    }),
  };
});

vi.mock("../../src/services/airplay/protocolPlayer.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/services/airplay/protocolPlayer.js")>();
  return { ...actual, getBridgePeerStatus: async () => h.bridge };
});

import { readPeerPositionSeconds, readPeerCurrentSongId } from "../../src/routes/api/shared.js";

const DEV = "airplay:00226CFFA0C0";

beforeEach(() => {
  h.ap.position = 0;
  h.ap.songId = undefined;
  h.ap.media = undefined;
  h.bridge = null;
});

describe("AirPlay 源端进度/当前曲：桥兜底", () => {
  it("RAOP relTime=0（桥播放）时取泵派生位置", async () => {
    h.bridge = { state: "PLAYING", position: 8.4, duration: 180 };
    await expect(readPeerPositionSeconds(DEV)).resolves.toBe(8.4);
  });

  it("RAOP 有非零位置时优先 RAOP（非桥路径不变）", async () => {
    h.ap.position = 12.5;
    h.bridge = { state: "PLAYING", position: 8.4, duration: 180 };
    await expect(readPeerPositionSeconds(DEV)).resolves.toBe(12.5);
  });

  it("两条链都没位置时返回 0 而不是 null（不改变旧行为）", async () => {
    h.bridge = { state: "PLAYING", position: 0, duration: 180 };
    await expect(readPeerPositionSeconds(DEV)).resolves.toBe(0);
  });

  it("RAOP 无 media 时用桥的当前曲校正下标", async () => {
    h.bridge = { state: "PLAYING", position: 8.4, duration: 180, media: { songId: "song-bridge" } };
    await expect(readPeerCurrentSongId(DEV)).resolves.toBe("song-bridge");
  });

  it("RAOP 有 media 时直接用 RAOP，不被桥覆盖", async () => {
    h.ap.media = { songId: "song-raop" };
    h.bridge = { state: "PLAYING", position: 8.4, duration: 180, media: { songId: "song-bridge" } };
    await expect(readPeerCurrentSongId(DEV)).resolves.toBe("song-raop");
  });
});
