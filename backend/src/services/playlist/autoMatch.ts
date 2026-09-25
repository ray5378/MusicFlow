// ==================== 播放触发的歌单自动匹配 + 队列补齐 ====================
//
// 背景(2026-09-25 收敛):
//   歌单里存在「未匹配行」(playable=0 / song_id 为空,常见原因:加导入门禁前误匹配到本地、
//   或在线源后来下架)。用户在歌单页点「播放全部」/ 投屏起播时,这些行**不进队列**,
//   歌就永远播不到。
//
// 服务端已有的 matchPlaylistInBackground(services/plugin/shared.ts)负责「怎么匹配」
// (能力挑选 → 每歌单锁 → 全局批量闸 → 并发搜索 → 门禁导入 → WS 播进度),这里只负责
//  ① 何时触发(起播之后,而不是之前 —— 绝不阻塞播放)
//  ② 节流(同一歌单 24h 内只自动跑一轮)
//  ③ **精确**判断「这条队列还是刚才那个歌单吗」,再把新匹配到的曲目补到队尾
//
// 关于 ③ 为什么必须靠内存标记:三张队列表都没有来源字段,只能靠「队列长度 + 首曲 id」
// 快照去猜——用户中途加一首就对不上、两个同长度歌单会撞车。QueueData.contentContext
// 由起播入口写入,精确且进程重启即失效(失效 = 放弃补齐,安全语义)。

import { getQueueController } from "../player/index.js";
import { resolveContentSongs, songsToQueueItems } from "../content.js";
import { matchPlaylistInBackground, type AutoMatchStats } from "../plugin/shared.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("PlaylistAutoMatch");

/** 同一歌单自动匹配的节流窗口。**播放触发的**自动匹配不需要每次都真跑在线搜索:
 *  反复点「播放全部」会连续打在线源(实测 71 条约 91s,连点即 429)。手动「批量匹配」
 *  按钮走 force=true,不受此窗口限制。 */
const AUTO_MATCH_TTL_MS = 24 * 60 * 60 * 1000;
const lastAutoMatchAt = new Map<string, number>();

/** 排队等待全局批量闸的上限。播放早已起播,没必要为补几首歌无限排队(闸门可能被
 *  全库扫描占住几十分钟),超时即放弃本轮——下播时再试,不影响已经在听的歌。 */
const LOCK_WAIT_MS = 5 * 60 * 1000;

/** 节流表上限,防止长时间运行后 Map 慢增长(只留最近跑过的歌单)。 */
const THROTTLE_MAP_MAX = 2000;

function markAutoMatch(playlistId: string): void {
  if (lastAutoMatchAt.size >= THROTTLE_MAP_MAX) {
    const now = Date.now();
    for (const [k, t] of lastAutoMatchAt) if (now - t >= AUTO_MATCH_TTL_MS) lastAutoMatchAt.delete(k);
    if (lastAutoMatchAt.size >= THROTTLE_MAP_MAX) lastAutoMatchAt.clear();
  }
  lastAutoMatchAt.set(playlistId, Date.now());
}

export interface AutoMatchOnPlaybackOptions {
  /** 要补齐的队列 playerId(裸 id 或带 `dlna:` / `group:` 前缀均可) */
  playerId?: string;
  /** 该队列的内容来源标记(形如 `playlist:<playlistId>`);
   *  与队列实际的标记不符 => 视为「用户已经切到别的内容」,放弃补齐。 */
  contentContext?: string;
  /** QueueController.enqueue 用的 baseUrl(取流前缀)。 */
  baseUrl?: string;
  /** 忽略节流窗口强制执行(手动按钮 / 需要重跑时用)。 */
  force?: boolean;
  /** 排队等批量闸的超时(ms),默认 LOCK_WAIT_MS。 */
  lockWaitMs?: number;
}

export interface AutoMatchOnPlaybackResult {
  /** 被跳过的原因(不补队列、不算失败);undefined 表示真的跑了一轮。 */
  skipped?: "throttled" | "context-mismatch" | "no-queue";
  /** 本轮有多少条目被尝试匹配(0 = 已全部匹配)。 */
  total: number;
  /** 其中成功导入并链接到歌单的条数。 */
  matched: number;
  /** 实际追加到队尾的曲目数。 */
  appended: number;
  /** 因排队超时放弃(不影响播放)。 */
  lockTimeout?: boolean;
}

/**
 * 起播之后对歌单做一次「自动匹配 + 补齐」。
 *
 * **约定:调用方必须 fire-and-forget,绝不 await 住起播流程** —— 本函数会走全局批量闸,
 * 可能排队数分钟,期间用户已经在听歌了。
 */
export async function runPlaylistAutoMatch(
  playlistId: string,
  opts: AutoMatchOnPlaybackOptions = {},
): Promise<AutoMatchOnPlaybackResult> {
  const result: AutoMatchOnPlaybackResult = { total: 0, matched: 0, appended: 0 };

  if (!opts.force) {
    const last = lastAutoMatchAt.get(playlistId);
    if (last && Date.now() - last < AUTO_MATCH_TTL_MS) {
      result.skipped = "throttled";
      return result;
    }
  }

  // ① 等批量闸(带超时)。matchPlaylistInBackground 内部会 await acquireBatchLock(),
  //    这里只做「超时就走人」的兜底,防止本 Promise 被永久挂住。
  //    注意超时后那个匹配仍会在后台跑完(并释放锁),只是我们不再等它。
  const waitMs = opts.lockWaitMs ?? LOCK_WAIT_MS;
  // 「匹配跑完」与「等太久」两条 Promise 竞速,谁先到走谁 —— 不再像旧实现那样
  // 无论 2 秒跑完还是卡满闸门都一律死等 waitMs(默认 5 分钟)才去做补齐。
  // onFinished 由 matchPlaylistInBackground 在释放每歌单锁与全局批量闸**之后**触发。
  // 战果必须用对象成员承载:TS 的控制流分析不追踪回调内的赋值,裸 let 会被窄化到
  // null/never,取 .total/.matched 会直接编译报错。
  const box: { value: AutoMatchStats | null } = { value: null };
  const finished = new Promise<void>((resolve) => {
    void matchPlaylistInBackground(playlistId, (r) => { box.value = r; resolve(); }).catch(() => resolve());
  });
  const timeout = new Promise<void>((resolve) => { const h = setTimeout(resolve, waitMs); h.unref?.(); });
  await Promise.race([finished, timeout]);
  const stats = box.value;
  if (stats === null) {
    // 闸门被全库扫描之类占着 —— 放弃本轮等待(后台那轮跑完会自行释放闸)。
    result.lockTimeout = true;
    log.info(`[auto-match] ${playlistId}: 等批量闸超时(${waitMs}ms)放弃本轮,不影响播放`);
    // 后台那轮的拒绝不要变成 unhandled rejection。
    void finished.catch(() => {});
    return result;
  }
  result.total = stats.total;
  result.matched = stats.matched;
  // 只有**真的拿到锁跑完**才记节流:
  //  ·超时分支——已在上面提前返回,不吃额度;
  //  ·被并发锁挡下的空跑(concurrencySkipped)——一次什么都没做的调用,也不该占额度。
  if (!stats.concurrencySkipped) markAutoMatch(playlistId);

  // ② 补齐:只有明确给了 playerId + contentContext 才做,且必须**标记一致**。
  if (!opts.playerId || !opts.contentContext) return result;
  const qc = getQueueController();
  if (qc.getContentContext(opts.playerId) !== opts.contentContext) {
    // 用户中途切了内容(单曲点播 / 换歌单 / 队列已重建)——宁可不补,也不补错队列。
    result.skipped = "context-mismatch";
    return result;
  }

  let extra: any[] = [];
  try {
    const resolved = await resolveContentSongs("playlist", playlistId);
    if (resolved?.rows?.length) {
      const items = songsToQueueItems(resolved.rows) as any[];
      const have = new Set(qc.snapshot(opts.playerId).items.map((i: any) => i.songId));
      extra = items.filter((it) => !have.has(it.songId));
    }
  } catch (e: any) {
    log.warn(`[auto-match] ${playlistId}: 解析歌单失败,跳过补齐: ${e.message}`);
    return result;
  }

  if (extra.length > 0) {
    try {
      await qc.enqueue(opts.playerId, extra, opts.baseUrl ?? "");
      result.appended = extra.length;
      log.info(`[auto-match] ${playlistId}: 已把 ${extra.length} 首新匹配曲目补齐到队尾`);
    } catch (e: any) {
      log.warn(`[auto-match] ${playlistId}: 补齐队列失败: ${e.message}`);
    }
  }

  // ③ 回执:只要本轮有新绑定的曲目就广播。WEB 歌单页据此刷新列表并对用户给出
  //    「已补齐 N 首」提示 —— 投屏路径下补齐改由服务端做,这里保持与原前端自建队
  //    补齐**同等的可见反馈**(appended=0 时只刷新不弹提示)。动态 import 解环。
  if (result.matched > 0) {
    try {
      const { broadcastToClients } = await import("../ws/index.js");
      broadcastToClients({
        type: "playlist_appended",
        playlistId,
        peerId: opts.playerId,
        count: result.appended,
        matched: result.matched,
      });
    } catch { /* WS 不可用不影响补齐结果 */ }
  }
  return result;
}
