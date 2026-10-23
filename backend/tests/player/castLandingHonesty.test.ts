// cast 落位回执的诚实性守卫(2026-10-24 真机):
//
// 「组 → 组内最后一台成员」流转时,目标端 cast 因上游出流 TTFB 过长挂死 30s,
// playCurrent 走超时分支抛错,但 playFrom 仍正常返回 —— 路由按
// `castLandingOf(device).applied` 决定回执落点,而这份 landing 是在 playMedia
// **之前**写下的(那时只知道"打算把哪个起点编进去"),于是回了 position=97,
// 目标端却静默(真正起播靠 stalled 重投,晚 38s)。
//
// 钉死:applied 的语义 = 「起点真的编进**这一次** cast 且 cast 成功」。
//   • cast 挂死 → applied=false(路由回 null,客户端不画进度条);
//   • cast 成功 → applied=true 且 requestedMs 原样保留。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { QueueController } from "../../src/services/player/QueueController.js";
import { PlaybackState } from "../../src/services/player/types.js";

const PID = "castlanding";

function setup(opts: { hang: boolean }) {
  const player = {
    playerId: `${PID}-peer`,
    async playMedia(_item: any, _baseUrl: string, _startMs?: number) {
      if (opts.hang) return await new Promise<never>(() => { /* never settle */ });
      return { mediaUri: "u" };
    },
    async stop() { /* 回收半开会话 */ },
    async pollState() {
      return {
        playerId: `${PID}-peer`,
        playbackState: PlaybackState.IDLE,
        position: 0,
        duration: 0,
        updatedAt: Date.now(),
      };
    },
  } as any;
  const ctrl = {
    beginOptimistic: () => {},
    armOptimisticTimeout: () => {},
    endOptimistic: () => {},
    reportState: () => {},
    resetTracker: () => {},
    setExpectedDuration: () => {},
  };
  const qc = new QueueController();
  qc.registerPlayer(PID, player, ctrl);
  qc.setQueue(PID, ITEMS, 0, "http://base");
  return qc;
}

const ITEMS = [{ songId: "s1", title: "t1", mime: "audio/mpeg", duration: 180 }] as any;

describe("cast 落位回执:失败不得谎报", () => {
  beforeAll(() => {
    if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
    // 测试接缝:30s → 80ms(生产不设该变量)。
    process.env.MF_CAST_TIMEOUT_MS = "80";
  });
  afterAll(() => {
    delete process.env.MF_CAST_TIMEOUT_MS;
  });

  it("cast 挂死 → applied=false(路由据此回 position=null)", async () => {
    const qc = setup({ hang: true });
    await qc.playFrom(PID, ITEMS, 0, "http://base", undefined, 97_000);
    const landing = qc.castLandingOf(PID);
    expect(landing, "landing 记录本身要保留(带 requestedMs 供排查)").toBeTruthy();
    expect(landing!.requestedMs, "请求的起点要留痕").toBe(97_000);
    expect(landing!.applied, "cast 失败 ⇒ 未落位,不得报 applied").toBe(false);
  }, 5000);

  it("cast 成功 → applied=true 且 requestedMs 原样", async () => {
    const qc = setup({ hang: false });
    await qc.playFrom(PID, ITEMS, 0, "http://base", undefined, 97_000);
    const landing = qc.castLandingOf(PID);
    expect(landing!.requestedMs).toBe(97_000);
    expect(landing!.applied).toBe(true);
  }, 5000);

  it("无起点(从 0 起播)⇒ applied=false,回执不报落点", async () => {
    const qc = setup({ hang: false });
    await qc.playFrom(PID, ITEMS, 0, "http://base");
    const landing = qc.castLandingOf(PID);
    expect(landing!.requestedMs).toBe(0);
    expect(landing!.applied).toBe(false);
  }, 5000);
});
