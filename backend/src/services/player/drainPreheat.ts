// ==================== 曲末提前预解析下一首（C 方案，2026-10-28）====================
//
// **要解决的问题**（230/240 真机抓包确证）：AirPlay 群组 / sendspin 组在**每首歌结束时**，
// 服务端 RTP 从 125pps 退化到约 1pps 静音块，持续 3~7 秒（用户观感「卡顿几秒又恢复」）。
// 逐行时间线（21:35:55 那次换歌，实测）：
//
//   21:36:00.749  IDLE pos=249.2 dur=250                 ← 上一首判定结束
//   21:36:01.501  QueueController[playCurrent] idx=2256 song=e44b0974…
//   21:36:01.503  [RESOLVE-AUDIO] resolve e44b0974 -> e44b0974 (local-probe-ok) ms=1
//   21:36:01.504  sessions: prepare warm-reuse           ← 会话复用，很快，不是瓶颈
//   21:36:01.511  [Sendspin][pump][play] 开始获取音源
//   21:36:02.541  [RESOLVE-AUDIO] resolve e44b0974 -> e44b0974 (local-probe-ok) ms=1030
//   21:36:03.475  [BUF-STREAM] buf-start http://192.168.10.240:5444/dav/…/一个人想着一个人.flac
//   21:36:03.848  pump 音源就绪 dur=199000ms window=true  ← 距 playCurrent **2.34 秒**
//   21:36:03.848  gap-fill chunks=293 ms=2338            ← 只补 2.34s，盖不住整段静默
//
// **关键判断**：这 2.34 秒不是「数据不够」，是**排序不对**。「下一首是谁」在曲末前几十秒
// 就已经确定（`peekUpcomingPositions` 是纯只读、四种 playMode 全覆盖），完全可以在曲末
// 之前把 resolve / 取流提前做完，让 `playCurrent` 之后的「音源就绪」尽量趋零。
//
// ### 与既有 prefetchUpcoming 的分工（互补，不是替代）
//   · `prefetchUpcoming`（source/prefetchCache.ts）：**队列变动时**触发，解决「源慢不慢」
//     （把整曲字节取进 membuf）。它**不调用** `resolvePlayableRow` —— 见该文件
//     `doPrefetch`：只走 `resolvePreferredSong` + `resolveNetworkInput` +
//     `fetchWholeSongBuffered`。所以 `[RESOLVE-AUDIO]` 那 1030ms **一次都没被它排掉**。
//   · **本模块**：**曲末前 9 秒**触发，补的正是 `resolvePlayableRow`（`[RESOLVE-AUDIO]`
//     的唯一出处，src/services/source/resolveAudio.ts:24 建 logger / :198 打 resolve 行），
//     顺带让 `prefetchSong` 再跑一次（它自带五道闸门 + 同曲去重，命中即返回）。
//
// ### 三条红线（违反即事故）
//   1. **绝不阻塞、绝不抛**：全 fire-and-forget，任何异常就地吞掉打 debug。调用方是
//      PlaybackTracker 的 500ms 本地节拍，异常冒泡会打断「是否该切歌」的判定 ——
//      为了省 2 秒而让播放器跳错歌，是本末倒置。
//   2. **幂等**：每个 (playerId, 这一首的下一曲 songId) 只预热一次；切歌（playCurrent）与
//      seek（transport）时清标记。**绝不能每 500ms tick 都真跑一次** —— 那是把 IO 全抢走，
//      比不预热更糟（预取/探测会与正在播的那条流争带宽，正好撞上排空窗口）。
//   3. **不改既有语义**：`prefetchUpcoming` / `prefetchSong` / `resolvePlayableRow` 一个字都
//      不改。本模块只在它们**前面**多调一次，失败即退化成「改动前的行为」。
//
// ### LEAD = 9000ms 的由来
//   要覆盖实测 2.34s 就绪 + 余量；同时必须**明显大于**曲末排空窗口（那 3~7 秒静音块正在
//   跑 drain），否则预热探测会与排空循环抢 IO，反而把静音块拉长。
//
// ### 触发链（谁在什么时机调本模块）
//   PlaybackTracker.update()/tick()   —— 每次位置推进就回调（纯通知，不带阈值）
//     → PlayerController.onPositionAdvance(playerId, posSec, durSec)
//     → QueueController.notePositionAdvance（stripPlayerPrefix + flowOwned 过滤）
//     → preheatNextOnDrain（**在窗口内**才继续，幂等，fire-and-forget）
// "阈值"与"幂等"只有本文件一处真相，不在 tracker 里复制一份。
import { peekUpcomingPositions, type QueuePeekSource } from "./preProbeScheduler.js";
import { prefetchSong } from "../source/prefetchCache.js";
import { getCachedPlayability } from "../source/online/streamFallback.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("DrainPreheat");

/**
 * 曲末预热窗口（ms）：播放位置进入「本曲已知时长 − 本值」之后才开始预热。
 * 9000 = 覆盖实测 2.34s「音源就绪」+ 余量，且明显大于曲末排空窗口（3~7s）。
 */
export const DRAIN_PREHEAT_LEAD_MS = 9_000;

/** 预热执行器的返回：只要有「有没有判出可播行」＋判定路径就够，不关心行内容。 */
export interface DrainPreheatResolveResult {
  /** 判出来的可播行（null = 无源 / 未知）。本模块只用来区分 done / skip。 */
  row: object | null;
  /** `resolvePlayableRow` 的 reason（fresh-cache / local-probe-ok / preferred-swap / …）。 */
  reason: string;
}

/** 预热执行器（测试可替换，见 setDrainPreheatExecutorForTest）。 */
export type DrainPreheatExecutor = (songId: string) => Promise<DrainPreheatResolveResult>;

/** 日志里的 resolve 结果三态：命中快缓存 / 真跑完 / 无源（或异常）。 */
export type DrainPreheatOutcome = "done" | "skip" | "cached";

// ---------------- 幂等标记 ----------------

/** playerId（裸 id）→ 本代次已预热过的**下一曲队列行 songId**。
 *  不按 songId 做 key：同一首可能在两个设备上同时播，预热要按「谁要播」分别记。
 *  key 存 songId 而不是时间戳：换歌后 songId 变了 ⇒ 自然允许再触发一次，
 *  所以「切歌」这一维不需要额外逻辑；playCurrent / seek 里的 reset 是**额外**的
 *  保险（同一首被手动重播 / 拖回曲末时要能再来一次）。 */
const marks = new Map<string, string>();

// ---------------- 执行器 ----------------

/**
 * 真实执行器：**先 resolve，再让 prefetchSong 跑一遍字节预取**。
 *
 * 顺序不能反：`prefetchSong` 内部自己会调 `resolvePreferredSong`（播放优选，实测 1.85~2.53s），
 * 先 resolve 一次能把 webdav 成功记忆 / 可播性缓存填好，prefetch 就不必重复探测同一条路。
 *
 * `resolvePlayableRow` 用**惰性 import**：它经 streamFallback → preferredSource → 插件
 * registry 拉进一大片模块，静态 import 有环风险（prefetchCache 对同一批模块也是惰性 import，
 * 模式已验证）。
 *
 * ⚠️ `resolvePlayableRow` 只读不写：不改队列、不改可播性正/负缓存、不判跳。
 *    唯一副作用是「探测成功记忆」（webdavOkCache，5 分钟）—— 那正是我们要的成绩。
 */
async function defaultExecutor(songId: string): Promise<DrainPreheatResolveResult> {
  const { resolvePlayableRow } = await import("../source/resolveAudio.js");
  const r = await resolvePlayableRow(songId);
  // 字节预取：与既有 prefetchUpcoming 并存（幂等 / 五道闸门 / 并发 1 都在 prefetchCache 内）。
  // 失败绝不能冒泡:prefetchSong 内部已吞掉 runOne 的异常,这里再兜一层 —— 它读 settings
  // 的那部分(并发上限/预算)是同步的,DB 异常会当场抛。
  try {
    void prefetchSong(songId);
  } catch (e: any) {
    log.debug(`曲末预热：prefetchSong 排程异常（已忽略）: ${String(e?.message || e).slice(0, 120)}`);
  }
  return { row: r.row as object | null, reason: r.reason };
}

let executor: DrainPreheatExecutor = defaultExecutor;

// ---------------- 公开入口 ----------------

/**
 * 「下一首是谁」—— 一律由 `peekUpcomingPositions` 算（四种 playMode 全覆盖、只读不改状态）。
 * **绝不自己重写**：playMode 有 one/order/all/shuffle 四种，重写必错（这是 C 方案明确禁止的）。
 * 拿不到（队列末尾 / peek 抛错 / 空 id）⇒ undefined，调用方静默返回。
 */
export function peekNextSongId(
  peek: QueuePeekSource | undefined,
  opts?: { skipDead?: boolean; lookahead?: number },
): string | undefined {
  if (!peek) return undefined;
  try {
    const skipDead = opts?.skipDead === true;
    // 不跳过判死曲时保持原语义(只取第 1 个位置);跳过时才多看几个。
    const want = Math.max(1, Math.min(8, opts?.lookahead ?? (skipDead ? 4 : 1)));
    const { positions } = peekUpcomingPositions(peek, want);
    for (const p of positions) {
      if (typeof p !== "number" || !Number.isInteger(p) || p < 0) continue;
      const songId = peek.items?.[p]?.songId;
      if (typeof songId !== "string" || songId.length === 0) continue;
      if (skipDead && isDeadSong(songId)) continue;
      return songId;
    }
    return undefined;
  } catch (e: any) {
    log.debug(`曲末预热：peek 下一首异常（已忽略）: ${String(e?.message || e).slice(0, 120)}`);
    return undefined;
  }
}

/**
 * 该曲是否**已被判死**(明确且未过期的负判定)。
 *
 * 必须与 `QueueController.judgePlayable` 的**第一道闸**同一判据 —— 起播时会跳过的歌,
 * 预览也不该把它当「下一首」去预热。2026-10-30 真机:预热 `0ea5a2da` 用了 4.8s,
 * 起播 4s 后却零日志判死并跳到 `b13bc96b`,两次解析全白做,且真正要播的那首没预热
 * (gap-fill 从 103ms 回落到 3000ms)。
 *
 * 只认 `"unplayable"`:`unknown` / `transient` / `playable` 一律照常预热 ——
 * 「不把不知道当成死的」是 2026-09-11 就定下的边界,这里不越界。
 */
function isDeadSong(songId: string): boolean {
  try {
    return getCachedPlayability(songId) === "unplayable";
  } catch {
    return false;
  }
}

/**
 * 曲末预热入口（同步、永不抛、永不 reject）。
 *
 * @param playerId 裸 player id（QueueController 已 stripPlayerPrefix）
 * @param peek     队列只读视图（`QueueData` 结构性满足）；undefined = 没有队列
 * @param posMs    当前播放位置（ms）
 * @param durMs    本曲已知时长（ms）；<=0 表示未知 ⇒ 不预热（没有窗口可算）
 */
export function preheatNextOnDrain(
  playerId: string,
  peek: QueuePeekSource | undefined,
  posMs: number,
  durMs: number,
): void {
  try {
    if (!playerId) return;
    if (!Number.isFinite(posMs) || !Number.isFinite(durMs)) return;
    if (!(durMs > 0)) return; // 时长未知 ⇒ 没有「曲末」可算
    if (posMs < durMs - DRAIN_PREHEAT_LEAD_MS) return; // 还没进窗口
    // skipDead:与起播判据对齐,避免预热一首「马上会被跳过」的歌(见 isDeadSong)。
    const songId = peekNextSongId(peek, { skipDead: true });
    if (!songId) return; // 队列末尾 / 单曲循环外的无可定下一首 → 静默
    if (marks.get(playerId) === songId) return; // 幂等：本代次已预热过（命中不打日志）
    // 先落标记再开跑：宁可「这次失败不重试」，也不要每 500ms 重来一次。
    marks.set(playerId, songId);
    void runPreheat(playerId, songId, posMs, durMs).catch(() => {
      /* runPreheat 自身已全包 try/catch，这里只是不让 unhandledRejection 有机会出现 */
    });
  } catch (e: any) {
    log.debug(`曲末预热：排程异常（已忽略）: ${String(e?.message || e).slice(0, 120)}`);
  }
}

// ---------------- 下推钩子(2026-10-30) ----------------

/** 预热成功后的旁路通知:`(songId) => void`。
 *
 *  为什么需要:预热在主进程算完的结论只写进**主进程**的 module-local 缓存,而真正
 *  起播的泵在 sendspin 子进程里读不到(实测泵命中 fresh-cache 0 次)。这个钩子把
 *  「已可播」这件事下推过去,让子进程提前把探测做完。
 *  默认 null = 什么都不做(测试 / 未启用 sendspin 时零行为)。 */
export type DrainPreheatWarmHook = (songId: string) => void;

let warmHook: DrainPreheatWarmHook | null = null;

/** 注册下推钩子(null = 注销)。由主进程 boot 时接上 sendspin 的实现。 */
export function setDrainPreheatWarmHook(fn: DrainPreheatWarmHook | null): void {
  warmHook = fn;
}

/** 真正执行预热 + 打一行可在真机上 grep 的日志。只在真的执行时被调用（幂等命中不会进来）。 */
async function runPreheat(
  playerId: string,
  songId: string,
  posMs: number,
  durMs: number,
): Promise<void> {
  const t0 = Date.now();
  let outcome: DrainPreheatOutcome = "skip";
  try {
    const r = await executor(songId);
    if (!r?.row) {
      outcome = "skip"; // 无源：不预热（也绝不写负缓存 —— 那是 PreProbe 的地盘）
    } else if (r.reason === "fresh-cache" || r.reason === "reuse-active") {
      outcome = "cached"; // 零成本命中，说明前面已经排掉了
    } else {
      outcome = "done"; // 真跑了一遍探测/优选，把 1030ms 搬到了曲末之前
    }
  } catch (e: any) {
    outcome = "skip";
    log.debug(
      `[drain-preheat] ${playerId}: 预热 resolve 异常（已忽略）: ${String(e?.message || e).slice(0, 160)}`,
    );
  }
  // 旁路下推:放在日志之前 —— 日志本身失败也不该阻断下推(两者互不依赖)。
  // outcome!=="skip" 才意味着「确实判出了一行可播源」,skip(无源)下推没有意义。
  if (warmHook && outcome !== "skip") {
    try {
      warmHook(songId);
    } catch {
      /* 红线:下推失败绝不冒到 tracker */
    }
  }
  try {
    log.info(
      `曲末预热 ev=drain-preheat song=${songId} posMs=${Math.round(posMs)}` +
        ` durMs=${Math.round(durMs)} resolve=${outcome} ms=${Date.now() - t0}`,
    );
  } catch {
    /* 日志失败也不许冒到 tracker —— 红线 1 */
  }
}

// ---------------- 清理（切歌 / seek） ----------------

/** 清掉该 player 的幂等标记：切歌（playCurrent）与 seek 时调。 */
export function resetDrainPreheat(playerId: string): void {
  if (playerId) marks.delete(playerId);
}

// ---------------- 测试用 ----------------

/** 全量清空（含执行器复位）。 */
export function resetDrainPreheatForTest(): void {
  marks.clear();
  executor = defaultExecutor;
}

/** 替换执行器（null = 恢复真实实现）。用于「预热抛错必须被吞掉」等用例。 */
export function setDrainPreheatExecutorForTest(fn: DrainPreheatExecutor | null): void {
  executor = fn ?? defaultExecutor;
}

/** 观测用：当前幂等标记快照（playerId → songId）。 */
export function drainPreheatMarksForTest(): Array<[string, string]> {
  return [...marks.entries()];
}
