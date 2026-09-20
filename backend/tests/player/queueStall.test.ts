// stalled 连续卡死放行:同一首第 1 次重投兜底,第 2 次起切下一首,不再 2-3 秒无限重播。
// 回归:念菩提案(死源 + BUFFERING 不推进)。
//
// 2026-09-21 追加三块(stalled 路径被"修活"后的配套护栏):
//   ① cast **抛错**不再静默 —— 原先 catch 只 endOptimistic 就结束,既不重投也不切歌,
//      队列就此停死;现在补派 stalled 走既有重投通道。
//   ② 连续 cast 失败封顶 = 一整圈(2×曲数)—— stallCounters 是「同一首」计数,切歌即归 1,
//      整队每首都投不出去时会在 all/shuffle 下无界绕圈。
//   ③ 已结束/未激活的队列不被 stalled 重投 —— 阈值从(生产不可达的)60s 降到 15s 后
//      这条路径才真正可达,而它原先全程不看 q.ended。
import { describe, it, expect, beforeAll } from "vitest";
import { QueueController } from "../../src/services/player/QueueController.js";
import { PlaybackState } from "../../src/services/player/types.js";

/** 等到条件成立(或超时)。catch 里的 stalled 派发走的是 setTimeout(0),
 *  真实定时器下要让出宏任务才能跑到。 */
async function until(cond: () => boolean, ms = 1500): Promise<void> {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** 单纯让出若干毫秒,等已排队的延迟派发跑完。 */
async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function setup(opts: { castFails?: boolean } = {}) {
  const qc = new QueueController();
  const played: string[] = [];
  let castFails = opts.castFails ?? false;
  const mockPlayer = {
    playerId: "dlna:stalltest",
    async pollState() {
      // 一直 BUFFERING:触发 HiVi 回避检查之后仍走重投/放行逻辑
      return { playerId: "dlna:stalltest", playbackState: PlaybackState.BUFFERING, position: 2, duration: 180, updatedAt: Date.now() };
    },
    async playMedia(item: any) {
      played.push(item.songId);
      if (castFails) throw new Error("device offline");
      return { mediaUri: "x" };
    },
  } as any;
  const mockCtrl = {
    beginOptimistic: () => {}, armOptimisticTimeout: () => {}, endOptimistic: () => {},
    reportState: () => {}, resetTracker: () => {}, setExpectedDuration: () => {},
  };
  qc.registerPlayer("stalltest", mockPlayer, mockCtrl);
  qc.setQueue("stalltest", [
    { songId: "s1", title: "t1", mime: "audio/mpeg", duration: 180 },
    { songId: "s2", title: "t2", mime: "audio/mpeg", duration: 180 },
  ] as any, 0, "http://base");
  return { qc, played, setCastFails: (v: boolean) => { castFails = v; } };
}

describe("stalled 连续卡死放行", () => {
  beforeAll(() => {
    if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  });

  it("第 1 次重投同一首,第 2 次切下一首", async () => {
    const { qc, played } = setup();
    await qc.handleDecision("stalled", "dlna:stalltest");
    expect(played).toEqual(["s1"]);
    expect(qc.snapshot("stalltest").currentIndex).toBe(0);
    await qc.handleDecision("stalled", "dlna:stalltest");
    expect(played).toEqual(["s1", "s2"]);
    expect(qc.snapshot("stalltest").currentIndex).toBe(1);
  });

  it("换歌后计数重置:新歌重新给一次重投机会", async () => {
    const { qc, played } = setup();
    await qc.handleDecision("stalled", "dlna:stalltest");
    await qc.handleDecision("stalled", "dlna:stalltest");
    expect(played).toEqual(["s1", "s2"]);
    // s2 再卡:计数按新歌重来,先重投 s2
    await qc.handleDecision("stalled", "dlna:stalltest");
    expect(played).toEqual(["s1", "s2", "s2"]);
  });

  it("cast 抛错不再静默:自动补派 stalled 继续推进(不再停死)", async () => {
    const { qc, played, setCastFails } = setup({ castFails: true });
    qc.setPlayMode("stalltest", "order"); // 定序:默认 shuffle 的 pickNext 是随机的
    await qc.handleDecision("stalled", "dlna:stalltest");
    expect(played, "第 1 次 cast 就抛错").toEqual(["s1"]);
    // 修复前:catch 只 endOptimistic 就结束 —— played 会永远停在 1 次,队列就此停死。
    // 现在 catch 补派一条 stalled(排在下一个宏任务,避开调用方尚未释放的 advancing)。
    setCastFails(false);
    await until(() => played.length >= 2);
    // 补派的 stalled 走既有通道:同一首的第 2 次 stalled → 放行切歌到 s2
    // (与该文件第一条用例的语义一致:第 1 次重投、第 2 次切歌)。
    expect(played).toEqual(["s1", "s2"]);
    expect(qc.snapshot("stalltest").currentIndex).toBe(1);
  });

  it("cast 连抛错按一整圈(2×曲数)封顶,不再无限重投", async () => {
    const { qc, played } = setup({ castFails: true });
    qc.setPlayMode("stalltest", "order");
    await qc.handleDecision("stalled", "dlna:stalltest");
    // 曲数 2 → 上限 4 次连续失败(每首允许「重投 1 次 + 放行切歌 1 次」)。
    // 关键:这条链是**自我续传**的(catch 补派 stalled → 又失败 → 再补派…),
    // 不封顶的话 300ms 内会远超 4 次。
    await until(() => played.length >= 4, 3000);
    await sleep(400);
    const settled = played.length;
    expect(settled, "连续失败链应自我终止(封顶 2×曲数)").toBe(4);
    expect(played.every((s) => s === "s1" || s === "s2"), "只在本队列内重投").toBe(true);
    // 外部再喂一次决策 = 一次合法重试(设备可能已恢复,不能永久拉黑)——
    // 但它同样只能花 1 次,不得再次形成续传链。
    await qc.handleDecision("stalled", "dlna:stalltest");
    await sleep(300);
    expect(played.length, "外部重试后也不得再形成链条").toBe(settled + 1);
  });

  it("已结束的队列不再被 stalled 重投(护栏)", async () => {
    const { qc, played } = setup();
    await qc.handleDecision("ended", "dlna:stalltest"); // markEnded: isActive=false, ended=true
    expect(qc.snapshot("stalltest").ended).toBe(true);
    await qc.handleDecision("stalled", "dlna:stalltest");
    await until(() => false, 50);
    expect(played, "已结束队列不得被重新 cast").toEqual([]);
  });
});
