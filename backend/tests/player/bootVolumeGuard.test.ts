// ==================== 启动期 HA 音量回放守卫 ====================
//
// 现场:容器重启后 `airplay_device_state` 在启动 ~31s 被写成 20。服务端自身不在
// 启动时写音量,写方 UA = `HomeAssistant/…aiohttp` —— HA 在实体重建时回放了旧的
// `volume_level`。这里用纯函数把「启动窗口 + HA UA + 每 peer 第一笔」三个条件
// 固化成契约,防止后续把守卫改宽/改窄。
import { describe, it, expect } from "vitest";
import {
  BOOT_VOLUME_GUARD_MS,
  HA_UA_PREFIX,
  shouldIgnoreBootVolumeEcho,
} from "../../src/services/player/bootVolumeGuard.js";

const HA_UA = "HomeAssistant/2026.10.2 aiohttp/3.14.5 Python/3.14";

describe("shouldIgnoreBootVolumeEcho", () => {
  it("启动窗口内 + HA UA → 拦第一笔", () => {
    const seen = new Set<string>();
    const opts = { bootAt: 1000, ua: HA_UA, peerId: "airplay:x", op: "volume" as const, seen };
    expect(shouldIgnoreBootVolumeEcho({ ...opts, now: 1000 + 31_000 })).toBe(true);
    // 同一 peer 的第二笔放行(用户随后在 HA 里手动调音量要生效)
    expect(shouldIgnoreBootVolumeEcho({ ...opts, now: 1000 + 32_000 })).toBe(false);
  });

  it("超出启动窗口 → 放行(无论 UA)", () => {
    const seen = new Set<string>();
    expect(
      shouldIgnoreBootVolumeEcho({
        now: 1000 + BOOT_VOLUME_GUARD_MS + 1,
        bootAt: 1000,
        ua: HA_UA,
        peerId: "airplay:x",
        op: "volume",
        seen,
      }),
    ).toBe(false);
    expect(seen.size).toBe(0);
  });

  it("非 HA 客户端 → 放行(App / Web / 卡片不受影响)", () => {
    const seen = new Set<string>();
    for (const ua of ["", "okhttp/4.12", "Mozilla/5.0", "MusicFlow-card"]) {
      expect(
        shouldIgnoreBootVolumeEcho({
          now: 1000 + 5_000,
          bootAt: 1000,
          ua,
          peerId: "airplay:x",
          op: "volume",
          seen,
        }),
      ).toBe(false);
    }
    expect(seen.size).toBe(0);
  });

  it("volume 与 mute 各拦各的第一笔(互不消耗)", () => {
    const seen = new Set<string>();
    const base = { now: 1000 + 5_000, bootAt: 1000, ua: HA_UA, peerId: "airplay:x", seen };
    expect(shouldIgnoreBootVolumeEcho({ ...base, op: "volume" })).toBe(true);
    expect(shouldIgnoreBootVolumeEcho({ ...base, op: "mute" })).toBe(true);
    expect(shouldIgnoreBootVolumeEcho({ ...base, op: "volume" })).toBe(false);
    expect(shouldIgnoreBootVolumeEcho({ ...base, op: "mute" })).toBe(false);
  });

  it("不同 peer 各自独立", () => {
    const seen = new Set<string>();
    const base = { now: 1000 + 5_000, bootAt: 1000, ua: HA_UA, op: "volume" as const, seen };
    expect(shouldIgnoreBootVolumeEcho({ ...base, peerId: "airplay:a" })).toBe(true);
    expect(shouldIgnoreBootVolumeEcho({ ...base, peerId: "airplay:b" })).toBe(true);
  });

  it("UA 前缀匹配大小写不敏感,且只认 HomeAssistant/", () => {
    expect(HA_UA_PREFIX.test("homeassistant/2026.10.2")).toBe(true);
    expect(HA_UA_PREFIX.test("HomeAssistantCore/1.0")).toBe(false);
    expect(HA_UA_PREFIX.test("xHomeAssistant/1.0")).toBe(false);
  });
});
