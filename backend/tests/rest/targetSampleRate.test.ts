// ==================== batch48 契约锁：目标采样率真的接到了出流链上 ====================
//
// 背景：v4.2.3 在 `resolveRequestAf` 里插入的降采样回落**写死 48k**
// （`aresample=resampler=swr:osr=48000`），治好了 loudnorm 恒上采样 192kHz 直喂设备
// 导致的变速变调，代价是把真支持 96K/192K 的设备一并降级。本批改读**每台播放器的
// 目标采样率**（`services/playerRate.ts`：手动 > hello 自动宣告 > 缺省 48000；
// 成组取成员最低值）。
//
// 本文件锁的是**「配置 → ffmpeg 命令」这条接线**，不是配置存取本身
// （存取/优先级/群组取最低由 `tests/services/playerRate.test.ts` 覆盖）：
//   ① 没配置 = 与 v4.2.3 逐字节一致（osr=48000、位置紧随 loudnorm、限制器仍在链尾）；
//   ② 配了 96000 → osr=96000（同一首歌同一设备，唯一变量就是配置）；
//   ③ 成组取最低值（木桶原理）真的落到链上；
//   ④ DSP 锚定率跟同一个值走（biquad 系数与采样率绑定，两处不同源 = EQ 曲线偏了）；
//   ⑤ 非法档位不生效（回落缺省，命令里绝不出现非法值）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { db } from "../../src/db/index.js";
import { playerDspConfigs, playerGroups, playerRateConfigs } from "../../src/db/schema.js";
import { resolveRequestAf } from "../../src/routes/rest/index.js";
import { playerDspFilters, setPlayerDspConfig } from "../../src/services/playerDsp.js";
import { setPlayerRate } from "../../src/services/playerRate.js";
import { getGroupManager } from "../../src/services/group/index.js";
import { setSetting } from "../../src/services/settings.js";

const PEER = "dlna:rate-target-main";
const PEER2 = "sendspin:rate-target-peer2";
/** 无测量行 ⇒ 走实时 loudnorm（链里必然有 loudnorm，才会触发降采样回落那段）。 */
const UNMEASURED = { id: "rate-target-unmeasured-song" };

/** 链里那条降采样回落的 osr 值（取不到返回 null）。 */
function osrOf(af: string[]): number | null {
  const f = af.find((x) => x.includes("aresample"));
  const m = f?.match(/osr=(\d+)/);
  return m ? Number(m[1]) : null;
}

function seedGroup(id: string, members: string[]): void {
  db.insert(playerGroups)
    .values({ id, ownerUserId: "", name: `g-${id}`, memberIds: JSON.stringify(members), volume: 20, createdAt: "", updatedAt: "" })
    .run();
  getGroupManager().loadFromDb();
}

beforeEach(() => {
  db.delete(playerRateConfigs).run();
  db.delete(playerDspConfigs).run();
  db.delete(playerGroups).run();
  getGroupManager().loadFromDb();
  setSetting("pipeline.enabled", "1");
  setSetting("pipeline.http", "1");
  setSetting("pipeline.dlna", "1");
  setSetting("loudness.normalization", "1");
});

afterEach(() => {
  setSetting("loudness.normalization", "1");
});

describe("目标采样率 → resolveRequestAf（HTTP/DLNA 转码链）", () => {
  it("没配置 = 与 v4.2.3 逐字节一致：osr=48000、紧随 loudnorm、限制器在链尾、只一条 aresample", async () => {
    const af = await resolveRequestAf(UNMEASURED, PEER);
    const lnIdx = af.findIndex((f) => f.includes("loudnorm"));
    expect(lnIdx).toBeGreaterThanOrEqual(0);
    expect(af[lnIdx + 1]).toBe("aresample=resampler=swr:osr=48000");
    expect(af[af.length - 1]).toContain("alimiter=limit=-1dB");
    expect(af.filter((f) => f.includes("aresample=")).length).toBe(1);
    expect(osrOf(af)).toBe(48000);
  });

  it("配置 96000 → osr=96000（同一设备同一首歌，唯一变量是配置）", async () => {
    setPlayerRate(PEER, 96000);
    const af = await resolveRequestAf(UNMEASURED, PEER);
    expect(osrOf(af)).toBe(96000);
    expect(af.filter((f) => f.includes("aresample=")).length).toBe(1);
    // 只是 osr 变了，链的形状（位置/限制器）没变
    const lnIdx = af.findIndex((f) => f.includes("loudnorm"));
    expect(af[lnIdx + 1]).toContain("aresample=resampler=swr:osr=96000");
    expect(af[af.length - 1]).toContain("alimiter=limit=-1dB");
  });

  it("非法档位被拒（不落库）→ 仍是缺省 48000，命令里绝不出现非法值", async () => {
    setPlayerRate(PEER, 12345);
    expect(db.select().from(playerRateConfigs).all()).toEqual([]);
    expect(osrOf(await resolveRequestAf(UNMEASURED, PEER))).toBe(48000);
  });

  it("没自报 peerId 的客户端（HTTP 老客户端）→ 缺省 48000，不会因为没键就空链", async () => {
    const af = await resolveRequestAf(UNMEASURED, undefined);
    expect(osrOf(af)).toBe(48000);
    expect(af.length).toBeGreaterThan(0);
  });

  it("成组取最低值**真的落到链上**：组里一台只吃 48K → 全组都出 48K", async () => {
    seedGroup("rg1", [PEER, PEER2]);
    setPlayerRate(PEER, 192000);
    setPlayerRate(PEER2, 96000);
    expect(osrOf(await resolveRequestAf(UNMEASURED, PEER))).toBe(96000);

    setPlayerRate(PEER2, 48000); // 组里来了一台只吃 48K 的
    expect(osrOf(await resolveRequestAf(UNMEASURED, PEER))).toBe(48000);
    expect(osrOf(await resolveRequestAf(UNMEASURED, PEER2))).toBe(48000);
  });
});

describe("目标采样率 → per-player DSP 锚定率", () => {
  it("无配置时锚定率 = 48000（与 DSP_FILTER_RATE 缺省一致，存量行为不变）", () => {
    setPlayerDspConfig(PEER, { tone: { bassDb: 4 } });
    const chain = playerDspFilters(PEER, {});
    expect(chain[0]).toBe("aresample=48000");
    expect(chain[1]).toBe("aformat=channel_layouts=stereo");
  });

  it("配置 96000 → 链首锚定率与参量 EQ 系数**都**按 96K 算", () => {
    setPlayerDspConfig(PEER, {
      tone: { bassDb: 4 },
      parametricEq: { bands: [{ type: "peak", frequency: 1000, gainDb: 6, q: 0.7 }] },
    });
    const head48 = playerDspFilters(PEER, {})[0];
    const eq48 = playerDspFilters(PEER, {}).find((f) => f.includes("biquad="));

    setPlayerRate(PEER, 96000);
    const head96 = playerDspFilters(PEER, {})[0];
    const eq96 = playerDspFilters(PEER, {}).find((f) => f.includes("biquad="));

    expect(head48).toBe("aresample=48000");
    expect(head96).toBe("aresample=96000");
    // biquad 系数与采样率绑定 ⇒ 两个率下必须给出不同的系数（同源才不会「EQ 生效但曲线偏了」）
    expect(eq48).toBeTruthy();
    expect(eq96).toBeTruthy();
    expect(eq48).not.toBe(eq96);
  });

  it("flow 模式不补链首 aresample（解码段已按会话采样率强制）", () => {
    setPlayerDspConfig(PEER, { tone: { bassDb: 4 } });
    setPlayerRate(PEER, 96000);
    const chain = playerDspFilters(PEER, { flow: true });
    expect(chain.some((f) => f.startsWith("aresample="))).toBe(false);
    expect(chain.some((f) => f.includes("equalizer="))).toBe(true);
  });
});
