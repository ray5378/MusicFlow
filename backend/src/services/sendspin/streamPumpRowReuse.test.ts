// 锁死对象:A 方案「源行复用」—— **同曲** seek 重建必须把上一轮生效的源行交给解析器,
// 跳过整段播放优选(`resolvePreferredSong` → 逐候选 `probeLocalSourceOk` → `verifyRow`,
// 2026-09-22 240 实测 1.85~2.53s/次且结果恒定)。
//
// 用户口径:「如果是网络源/webdav 源,在跳转进度时应该自动复用正在播放的地址才对,
// 不应该回退到查找播放源这一步」。
//
// 这里不测解析器本身(那在 tests/services/resolveAudio.test.ts),只测 **pump 的记账与透传**:
//   ① 同曲重建 → 带上首次生效的行 id;
//   ② 切歌 → 不带(上一首的源行与新曲无关);
//   ③ 复用命中却出不了流 → 清记账 + 回退完整解析一次,并以回退结果重建记账;
//   ④ 音源未回带 sourceRowId → 不产生复用(绝不复用「未知行」)。
// 音源用 overridePumpSource 注入,避开 ffmpeg / DB,只观察入参序列。
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { GroupPump, overridePumpSource, type GroupAudio } from "./streamEngine.js";
import { SAMPLE_RATE, CHANNELS } from "./encoding.js";

const SONG_SEC = 60;

interface Call {
  songId: string;
  startMs: number;
  preferRowId?: string;
}

/** 整包静音 PCM(不带 stream):seek 零成本、无 ffmpeg,用例只关心解析入参。 */
function silence(seconds = SONG_SEC): GroupAudio {
  return { pcm: new Float32Array(seconds * SAMPLE_RATE * CHANNELS), durationMs: seconds * 1000 };
}

function stubGroup() {
  const group: any = {
    name: "row-reuse-group",
    positionMs: 0,
    timelineBaseUs: 0n,
    current: null,
    commonSendAheadUs: () => 800_000,
    async pushFrame(_ts: bigint, pcm: Float32Array) {
      return Math.floor(pcm.length / CHANNELS);
    },
  };
  return group;
}

/** 带日志收集的 stub server:用于断言「回退完整解析」走的是复用失败那条分支。 */
function stubServer() {
  const logs: string[] = [];
  const server: any = { log: (_level: string, msg: string) => { logs.push(String(msg)); } };
  return { server, logs };
}

describe("GroupPump 源行复用", () => {
  const calls: Call[] = [];
  let oldSpeed: string | undefined;

  beforeEach(() => {
    calls.length = 0;
    oldSpeed = process.env.SENDSPIN_PUSH_SPEED;
    // 加速推流节奏:本用例只关心「传给音源的入参」,不需要实时 60s。
    process.env.SENDSPIN_PUSH_SPEED = "8";
  });

  afterEach(() => {
    overridePumpSource(null);
    if (oldSpeed === undefined) delete process.env.SENDSPIN_PUSH_SPEED;
    else process.env.SENDSPIN_PUSH_SPEED = oldSpeed;
  });

  it("同曲 seek 重建:第二次起流带上首次生效的行 id", async () => {
    overridePumpSource(async (songId, startMs = 0, opts) => {
      calls.push({ songId, startMs, preferRowId: opts?.preferRowId });
      return { ...silence(), sourceRowId: "row-A" };
    });
    const { server } = stubServer();
    const pump = new GroupPump(server, stubGroup());

    await pump.play("same-song");            // 首次:完整裁决
    pump.stop();
    pump.armSeek(30_000);                    // 复刻 seekCore→playCore 的序列
    await pump.play("same-song");            // 同曲重建:应复用

    expect(calls).toHaveLength(2);
    expect(calls[0].preferRowId).toBeUndefined();
    expect(calls[1].preferRowId).toBe("row-A"); // ★ 核心断言
    expect(calls[1].startMs).toBe(30_000);      // 起点仍按帧栅格对齐后透传
    pump.stop();
  }, 20_000);

  it("切歌(songId 不同)不复用上一首的源行", async () => {
    overridePumpSource(async (songId, startMs = 0, opts) => {
      calls.push({ songId, startMs, preferRowId: opts?.preferRowId });
      return { ...silence(), sourceRowId: "row-A" };
    });
    const { server } = stubServer();
    const pump = new GroupPump(server, stubGroup());

    await pump.play("song-A");
    pump.stop();
    await pump.play("song-B"); // 记账属于 song-A,与 song-B 无关

    expect(calls).toHaveLength(2);
    expect(calls[1].songId).toBe("song-B");
    expect(calls[1].preferRowId).toBeUndefined(); // ★ 不得把上一首的源行带过来
    pump.stop();
  }, 20_000);

  it("复用命中却取流失败:清记账 + 回退完整解析一次,并以回退结果重建记账", async () => {
    // 只让**第一次**复用失败:这样第 ③ 步才能证明「回退成功后记账被正确重建」,
    // 而不是一旦失败就永久退化成每次完整裁决。
    let reuseFailsLeft = 1;
    overridePumpSource(async (songId, startMs = 0, opts) => {
      calls.push({ songId, startMs, preferRowId: opts?.preferRowId });
      if (opts?.preferRowId && reuseFailsLeft-- > 0) throw new Error("源行已失效");
      return { ...silence(), sourceRowId: "row-A" };
    });
    const { server, logs } = stubServer();
    const pump = new GroupPump(server, stubGroup());

    await pump.play("s");          // ① 完整裁决 → 记账 row-A
    pump.stop();
    pump.armSeek(10_000);
    await pump.play("s");          // ② 复用 row-A 失败 → 清记账 + 回退完整裁决
    expect(pump.active).toBe(true); // 播放没有因为复用失败而停摆
    expect(logs.some((m) => m.includes("复用源行取流失败,回退完整解析"))).toBe(true);

    pump.stop();
    pump.armSeek(20_000);
    await pump.play("s");          // ③ 记账已按回退结果重建 → 再次复用
    expect(calls.map((c) => c.preferRowId)).toEqual([undefined, "row-A", undefined, "row-A"]);
    pump.stop();
  }, 20_000);

  it("音源未回带 sourceRowId:不产生复用(绝不复用未知行)", async () => {
    overridePumpSource(async (songId, startMs = 0, opts) => {
      calls.push({ songId, startMs, preferRowId: opts?.preferRowId });
      return silence(); // 无 sourceRowId(如注入音源 / 老路径)
    });
    const { server } = stubServer();
    const pump = new GroupPump(server, stubGroup());

    await pump.play("x");
    pump.stop();
    pump.armSeek(5_000);
    await pump.play("x");

    expect(calls[1].preferRowId).toBeUndefined();
    pump.stop();
  }, 20_000);
});
