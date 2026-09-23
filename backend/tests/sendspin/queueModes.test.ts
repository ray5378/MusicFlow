// ==================== Sendspin 服务器权威 —— 队列全模式端到端复测 ====================
//
// 链路(全真实,不 mock):
//   real sendspin server(绑 :38927) + createSendspinProtocolPlayer(真实传输层)
//     → UniversalPlayer → QueueController(队列/切歌/模式) ↔ PlayerController(乐观窗口+决策)
//     → PlaybackTracker(自然结束判定)→ handleDecision → 自动切歌。
//
// 唯一注入:overridePumpSource 提供合成静音 PCM(替代真实网络曲源解码),
// pump 仍按组时间线真实推流并按真实时间自然结束 → 驱动 pollState IDLE → 自动切歌。
// 这样排队列全模式的断言完全走真实 QueueController/PlayerController 决策链路。
//
// 覆盖:顺序 + 自动下一曲、单曲循环、列表循环、随机、跳过/换源回退、手动 next/prev、
//       pause/resume(freeze 不推进)、seek(跳转)、stopPlayback/resumePlayback、clear。
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { sqlite } from "../../src/db/index.js";
import { PlayerController } from "../../src/services/player/PlayerController.js";
import { QueueController } from "../../src/services/player/QueueController.js";
import { UniversalPlayer } from "../../src/services/player/UniversalPlayer.js";
import { PlaybackState, type PlayerState } from "../../src/services/player/types.js";
import { setSendspinIdentityDir, startSendspinService, stopSendspinService } from "../../src/services/sendspin/index.js";
import { createSendspinProtocolPlayer } from "../../src/services/sendspin/protocolPlayer.js";
import { overridePumpSource } from "../../src/services/sendspin/streamEngine.js";
import { setNowUsOverride } from "../../src/services/sendspin/clock.js";

const RATE = 48000;
const CH = 2;
const AUDIO_MS = 5000; // 每首歌的合成时长(track 播完即自然结束,触发自动切歌)
// ⚠️ 必须**大于**预填充缓冲(默认 3s,见 prefill_buffer_ms):曲长短于缓冲时整首会被
//   瞬间灌完,「按实时播完 → 自然结束 → 自动切歌」的仿真前提不成立(2026-09-24)。
const BASE = "http://lan-base";

// ⚠️ 本文件**显式关掉预填充**(SENDSPIN_PREFILL_MS=800 = 插件页「关闭预填充」档),
//   理由:预填充会把「已推送」与「可听」拉开整整一个缓冲深度的**静默期** ——
//   实测(2026-09-24 起)对外上报的 position 已改为**可听位置**(= 已推送 − 设备缓冲深度),
//   于是 3s 预填充下起播后前 ~3.8s 位置恒为 0(声音还没出来)。本文件测的是
//   QueueController 的**模式语义**(顺序/循环/随机/pause/seek/stop),
//   深缓冲的静默期只会让「位置是否推进」的断言失真,不是被测对象。
//   关掉后缓冲深度 = 首帧锚点 800ms,与 4.0.18 之前的行为一致。
const PREV_PREFILL_MS = process.env.SENDSPIN_PREFILL_MS;

let tmpDir: string;
let srcTmpDir: string;

beforeAll(async () => {
  // 建最小架构表(与 integration.test.ts 同款,幂等)。
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS songs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      artist TEXT DEFAULT '',
      album TEXT DEFAULT '',
      duration INTEGER DEFAULT 0,
      suffix TEXT DEFAULT 'mp3',
      path TEXT NOT NULL,
      type TEXT DEFAULT 'local',
      plugin_entry TEXT
    );
  `);

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sendspin-modes-"));
  srcTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sendspin-src-"));
  process.env.SENDSPIN_PREFILL_MS = "800"; // 见文件头注释:本文件按浅缓冲(旧行为)仿真
  setSendspinIdentityDir(tmpDir);
  await startSendspinService();
});

afterAll(async () => {
  overridePumpSource(null);
  await stopSendspinService();
  if (PREV_PREFILL_MS === undefined) delete process.env.SENDSPIN_PREFILL_MS;
  else process.env.SENDSPIN_PREFILL_MS = PREV_PREFILL_MS;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(srcTmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  // ⚠️ 假定时器**不接管 process.hrtime**(见 clock.ts setNowUsOverride 注释),
  //   而上报的「可听位置」= 已推送 −(cursorUs − nowUs())。不接管的话 nowUs() 静止、
  //   cursorUs 随实产样本飞涨 → 位置恒被钳到 0,「位置有没有推进」全部失真。
  setNowUsOverride(() => BigInt(Date.now()) * 1000n);
});

afterEach(() => {
  setNowUsOverride(null);
  vi.useRealTimers();
});

/** 记录被 pump 真正开播过的 songId(注入源回调)。 */
const played: string[] = [];
function silenceSeconds(sec: number): Float32Array {
  return new Float32Array(Math.floor(RATE * CH * sec));
}
overridePumpSource(async (songId: string) => {
  played.push(songId);
  return { pcm: silenceSeconds(AUDIO_MS / 1000), durationMs: AUDIO_MS };
});
function resetPlayed(): void { played.length = 0; lastSeenState = null; }

/** 组装真实链路:QueueController ↔ PlayerController + 真实 sendspin ProtocolPlayer。 */
function setup(clientId = "c1") {
  const pc = new PlayerController();
  const qc = new QueueController();
  pc.onDecision = (decision, playerId) => { qc.handleDecision(decision, playerId).catch(() => {}); };
  const p = createSendspinProtocolPlayer(clientId);
  const up = new UniversalPlayer(`sendspin:${clientId}`, "room");
  up.attachProtocol(p as any);
  qc.registerPlayer(clientId, up, pc);
  qc.setQueue(clientId, [], -1, BASE);
  qc.setPlayMode(clientId, "order"); // 钉死顺序,默认断言确定;各模式测试再各自切换。
  return { pc, qc, p, id: clientId };
}

// 已上报过的 playbackState(变化才 re-report)。仿真实事件驱动:
// PlayerController 对决策做 250ms+500ms 去抖。若每个时间步都 re-report 同态
// IDLE,去抖定时器会被反复重置而永不触发决策转发(生产按 5s 轮询,不会这样)。
// 只有 playbackState 变化才 report → 单次状态迁移只喂一次 tracker,+750ms 后向前转发。
let lastSeenState: PlaybackState | null = null;

/** 推进仿真时间 stepMs 并(若 playbackState 变化)上报一次真实 pollState(驱动决策链)。 */
async function crank(pc: PlayerController, p: any, stepMs = 200): Promise<void> {
  await vi.advanceTimersByTimeAsync(stepMs);
  const st = await p.pollState();
  if (st.playbackState !== lastSeenState) {
    pc.reportState(st);
    lastSeenState = st.playbackState;
  }
}

/** 反复 crank 直到条件满足(默认最多 600 步),超时抛错。 */
async function crankUntil(pc: PlayerController, p: any, cond: () => boolean, note = "条件", maxSteps = 600): Promise<void> {
  if (cond()) return;
  for (let i = 0; i < maxSteps; i++) {
    await crank(pc, p);
    if (cond()) return;
  }
  throw new Error(`crankUntil 超时: ${note}`);
}

// ---------------------------------------------------------------------------
// 1) 顺序 + 自动下一曲 + 播完置为 ended
// ---------------------------------------------------------------------------
describe("Sendspin 队列全模式", () => {
  it("顺序播放:s1→s2→s3 自动切歌;最后一首播完 markEnded", async () => {
    resetPlayed();
    const { pc, qc, p, id } = setup();
    await qc.playFrom(id, [
      { songId: "s1", title: "t1", mime: "audio/opus", duration: 1 },
      { songId: "s2", title: "t2", mime: "audio/opus", duration: 1 },
      { songId: "s3", title: "t3", mime: "audio/opus", duration: 1 },
    ], 0, BASE);
    expect(played[0]).toBe("s1"); // 起播 s1
    expect(qc.snapshot(id).currentIndex).toBe(0);

    // 自动切到 s2、s3
    await crankUntil(pc, p, () => played.length >= 2, "s1→s2");
    expect(played.slice(0, 2)).toEqual(["s1", "s2"]);
    expect(qc.snapshot(id).currentIndex).toBe(1);
    await crankUntil(pc, p, () => played.length >= 3, "s2→s3");
    expect(played.slice(0, 3)).toEqual(["s1", "s2", "s3"]);
    expect(qc.snapshot(id).currentIndex).toBe(2);

    // s3 播完 → order 末尾 → markEnded(不新增播放)
    await crankUntil(pc, p, () => qc.snapshot(id).ended, "s3 播完 ended", 300);
    expect(played.length).toBe(3);
    expect(qc.snapshot(id).isActive).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 2) 单曲循环
  // -------------------------------------------------------------------------
  it("单曲循环 one:自然结束重复当前曲,cursor 不动", async () => {
    resetPlayed();
    const { pc, qc, p, id } = setup();
    qc.setPlayMode(id, "one");
    await qc.playFrom(id, [
      { songId: "a1", title: "t1", mime: "audio/opus" },
      { songId: "a2", title: "t2", mime: "audio/opus" },
    ], 0, BASE);
    expect(played[0]).toBe("a1");

    // 让首曲自然结束,应重复 a1 而非进 a2
    await crankUntil(pc, p, () => played.length >= 4, "one 重复循环", 300);
    expect(played.slice(0, 4)).toEqual(["a1", "a1", "a1", "a1"]);
    expect(qc.snapshot(id).currentIndex).toBe(0);
    expect(qc.snapshot(id).ended).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 3) 列表循环
  // -------------------------------------------------------------------------
  it("列表循环 all:s3 播完绕回 s1", async () => {
    resetPlayed();
    const { pc, qc, p, id } = setup();
    qc.setPlayMode(id, "all");
    await qc.playFrom(id, [
      { songId: "c1", title: "t1", mime: "audio/opus" },
      { songId: "c2", title: "t2", mime: "audio/opus" },
      { songId: "c3", title: "t3", mime: "audio/opus" },
    ], 2, BASE); // 从 c3 起播
    expect(played[0]).toBe("c3");

    await crankUntil(pc, p, () => played.length >= 4, "all 绕回", 300);
    // c3 自然结束 → 绕回队列头 c1
    expect(played.slice(0, 4)).toEqual(["c3", "c1", "c2", "c3"]);
    expect(qc.snapshot(id).ended).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 4) 随机播放
  // -------------------------------------------------------------------------
  it("随机播放 shuffle:序列一轮不重复,连续两首不撞车", async () => {
    resetPlayed();
    const { pc, qc, p, id } = setup();
    qc.setPlayMode(id, "shuffle");
    await qc.playFrom(id, [
      { songId: "r1", title: "t1", mime: "audio/opus" },
      { songId: "r2", title: "t2", mime: "audio/opus" },
      { songId: "r3", title: "t3", mime: "audio/opus" },
      { songId: "r4", title: "t4", mime: "audio/opus" },
    ], 0, BASE);
    // 整列表播放 + shuffle → 服务端随机挑首(不再固定 r1)。
    expect(["r1", "r2", "r3", "r4"]).toContain(played[0]);

    // 连播 6 首:shuffleOrder 保证一轮 4 首不重复推进。
    await crankUntil(pc, p, () => played.length >= 6, "shuffle 推进", 400);
    const seq = played.slice(0, 6);
    for (const s of seq) expect(["r1", "r2", "r3", "r4"]).toContain(s);
    for (let i = 1; i < 4; i++) expect(seq[i]).not.toBe(seq[i - 1]); // 序列内不撞车
    // 第 5、6 首是第二轮(重洗后),仍为合法曲目。
    expect(["r1", "r2", "r3", "r4"]).toContain(seq[4]);
    expect(qc.snapshot(id).ended).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 5) 跳过 / 换源回退:优先可播曲目,死源直接跳过留队列
  // -------------------------------------------------------------------------
  it("换源回退/跳过:不可播的本地死源被跳过并切到下一首可播曲", async () => {
    resetPlayed();
    const goodFile = path.join(srcTmpDir, "good.mp3");
    fs.writeFileSync(goodFile, "fake");
    // 死源:本地路径解析成功但文件不存在 → probeLocalSourceOk=false → skip
    sqlite.prepare("INSERT OR REPLACE INTO songs (id,title,path,type) VALUES (?,?,?,?)")
      .run("dead1", "dead", "l:fake:/nonexistent/missing.mp3", "local");
    // 可播:本地文件存在 → probeLocalSourceOk=true
    sqlite.prepare("INSERT OR REPLACE INTO songs (id,title,path,type) VALUES (?,?,?,?)")
      .run("good1", "good", `l:fake:${goodFile}`, "local");

    const { qc, id } = setup();
    await qc.playFrom(id, [
      { songId: "dead1", title: "dead", mime: "audio/mpeg" },
      { songId: "good1", title: "good", mime: "audio/mpeg" },
    ], 0, BASE);

    // 起播即跳到 good1(dead1 被 judgePlayable 判 skip),cursor 落在 1。
    expect(played[0]).toBe("good1");
    expect(qc.snapshot(id).currentIndex).toBe(1);
    expect(played).not.toContain("dead1");
  });

  // -------------------------------------------------------------------------
  // 6) 手动 next / prev
  // -------------------------------------------------------------------------
  it("手动 next/prev 立即切换播放,currentIndex 正确", async () => {
    resetPlayed();
    const { pc, qc, p, id } = setup();
    await qc.playFrom(id, [
      { songId: "n1", title: "t1", mime: "audio/opus" },
      { songId: "n2", title: "t2", mime: "audio/opus" },
      { songId: "n3", title: "t3", mime: "audio/opus" },
    ], 0, BASE);
    expect(played[0]).toBe("n1");

    await qc.next(id, BASE);
    await crank(pc, p);
    expect(qc.snapshot(id).currentIndex).toBe(1);
    expect(played[played.length - 1]).toBe("n2");

    await qc.next(id, BASE);
    await crank(pc, p);
    expect(played[played.length - 1]).toBe("n3");

    await qc.prev(id, BASE);
    await crank(pc, p);
    expect(qc.snapshot(id).currentIndex).toBe(1);
    expect(played[played.length - 1]).toBe("n2");
  });

  // -------------------------------------------------------------------------
  // 7) pause/resume:暂停冻结 position,恢复后继续推进
  // -------------------------------------------------------------------------
  it("pause 冻结进度,resume 后继续推进并可自然结束", async () => {
    resetPlayed();
    const { pc, qc, p, id } = setup();
    await qc.playFrom(id, [{ songId: "s1", title: "t1", mime: "audio/opus", duration: 1 }], 0, BASE);
    await crank(pc, p, 50); // 先让 pump 起步

    await qc.transport(id, "pause"); // → player.pause → pump.pause
    const posPaused = (await p.pollState()).position;
    // 暂停期间推进大量仿真时间,position 不应前进(current 也不应清空)。
    for (let i = 0; i < 10; i++) await crank(pc, p, 200);
    const posAfter = (await p.pollState()).position;
    expect(posAfter).toBe(posPaused);
    expect((await p.pollState()).playbackState).not.toBe(PlaybackState.IDLE);

    // 恢复 → 继续推进:pump.resume 唤醒,position 越过暂停点、回到 PLAYING。
    // 注:本文件已关预填充(缓冲深度 = 首帧锚点 800ms),故起播 ~0.8s 后即可听位置 > 0,
    //     暂停点稳定落在轨内(合成轨 5000ms);步长过大会直接推完 → IDLE。
    await qc.transport(id, "play"); // transport 用 "play" 映射 player.resume → pump.resume
    await crank(pc, p, 100); // 恢复后推一帧
    const resumed = await p.pollState();
    expect(resumed.playbackState).toBe(PlaybackState.PLAYING);
    expect(Number(resumed.position)).toBeGreaterThan(Number(posPaused));
  });

  // -------------------------------------------------------------------------
  // 8) seek 跳转
  // -------------------------------------------------------------------------
  it("seek 跳转改 writing position 并继续播放", async () => {
    resetPlayed();
    const { pc, qc, p, id } = setup();
    await qc.playFrom(id, [{ songId: "s1", title: "t1", mime: "audio/opus", duration: 1 }], 0, BASE);
    await crank(pc, p, 50);

    await qc.transport(id, "seek", 0.2); // 跳到 200ms
    expect((await p.pollState()).position).toBeCloseTo(0.2, 1);
    // 跳转后仍处于播放推进(pump 按 position 取帧)。
    expect((await p.pollState()).playbackState).toBe(PlaybackState.PLAYING);
    await crank(pc, p, 50);
    expect((await p.pollState()).playbackState).toBe(PlaybackState.PLAYING);
  });

  // -------------------------------------------------------------------------
  // 9) stopPlayback 冻结自动推进;resumePlayback 解冻
  // -------------------------------------------------------------------------
  it("stopPlayback 后自然播完不再自动切歌;resumePlayback 解冻", async () => {
    resetPlayed();
    const { pc, qc, p, id } = setup();
    await qc.playFrom(id, [
      { songId: "s1", title: "t1", mime: "audio/opus" },
      { songId: "s2", title: "t2", mime: "audio/opus" },
    ], 0, BASE);
    expect(played[0]).toBe("s1");

    qc.stopPlayback(id); // 冻结自动推进(isActive=false)
    // pump 仍会把 s1 自然播完 → IDLE。但 stopPlayback 已 resetTracker → lastPlaying 清零,
    // 该 IDLE 不会触发 advance,故不切到 s2。
    await vi.advanceTimersByTimeAsync(500); // s1(300ms)播完 → current 置空
    pc.reportState(await p.pollState());    // IDLE 上报
    await vi.advanceTimersByTimeAsync(800); // 决策去抖窗口走完,确认不蹦出 s2
    expect(played.length).toBe(1); // 没有切到 s2
    expect(qc.snapshot(id).isActive).toBe(false);

    qc.resumePlayback(id); // 解冻(仅本地状态,不立即 cast)
    expect(qc.snapshot(id).isActive).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 10) clear 清空
  // -------------------------------------------------------------------------
  it("clear 清空队列并置 inactive", async () => {
    resetPlayed();
    const { qc, id } = setup();
    await qc.playFrom(id, [{ songId: "x1", title: "t1", mime: "audio/opus" }], 0, BASE);
    expect(qc.snapshot(id).items.length).toBe(1);
    qc.clear(id);
    expect(qc.snapshot(id).items.length).toBe(0);
    expect(qc.snapshot(id).isActive).toBe(false);
    expect(qc.snapshot(id).currentIndex).toBe(-1);
  });
});