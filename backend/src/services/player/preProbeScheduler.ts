// 服务端预探测调度器(2026-09-11)
//
// 目的:让投屏 / Web / 本机播放三条链路在「推进到坏源那一刻」不必阻塞探测 ——
// 判定提前算好放在 streamFallback 的缓存里,推进时命中即零成本越过。
//
// 窗口的定义是**内容**而不是**位置**:向前扫描,凑够 N 首「已确认可播」的歌,
// 而不是取接下来 N 个位置。死源会被越过,由「连续无源 ≥ M」判定枯竭。
//
// 三条硬不变量(违反即事故,守卫已锁):
//   1. **只读 peek** —— 绝不允许调用会推进状态的 pickNext / shuffleNextIndex
//      (那会让「每探一次 = 偷偷跳一首歌」);
//   2. **只探测 + 写缓存** —— 不改队列、不改 currentIndex、不改洗牌序列;
//   3. **枯竭才上报,触底一律静默** —— 触底 = order 播到末尾 / shuffle 轮次末 /
//      队列总长不足 / 向前覆盖超 T 分钟。判据只看「连续无源是否到 M」,
//      与走了多少步无关。否则每次播到歌单末尾都会误报「大面积无源」。
//
// 成本模型:健康队列恰好探 N 次(凑够即停);最坏走 N×M 个位置
// (N=3, M=50 → 150)。这是「保证 N 首可播」的固有成本,不是可优化掉的东西。
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { songs } from "../../db/schema.js";
import {
  configureStreamFallbackCache,
  ensurePlayableStream,
  getCachedPlayability,
} from "../source/online/streamFallback.js";
import { preProbeActive, readPreProbeConfig, type PreProbeConfig } from "../plugin/core/preProbe.js";
import type { PlayMode } from "./types.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("PreProbe");

/** 队列的**只读**视图(`QueueData` 结构性满足)。peek 只读它,绝不写回。 */
export interface QueuePeekSource {
  items: Array<{ songId: string; duration?: number }>;
  currentIndex: number;
  playMode: PlayMode;
  shuffleOrder?: number[];
  shufflePos?: number;
}

/** 下发给客户端 / Web 的预探测状态位。 */
export interface PreProbeStatus {
  /** 前方已确认可播数(缓冲水位)。 */
  ready: number;
  /** 本次扫描实际探测的位置数。 */
  scanned: number;
  /** 本次扫描观察到的最大连续无源数。 */
  misses: number;
  /** 枯竭:连续无源 ≥ M,或整队无源(绕圈上限耗尽)。 */
  exhausted: boolean;
  /** 枯竭冷却截止(ms epoch);null = 未冷却。 */
  cooldownUntil: number | null;
  /** 本次状态生成时间 —— 前端「手动关闭」的去重键(playerId + at)。 */
  at: number;
}

export const EMPTY_PRE_PROBE_STATUS: PreProbeStatus = {
  ready: 0,
  scanned: 0,
  misses: 0,
  exhausted: false,
  cooldownUntil: null,
  at: 0,
};

/** 单曲探测判定(三态:transient 不算「明确无源」,故不计入连续无源)。 */
type ProbeVerdict = "playable" | "unplayable" | "unknown";

/**
 * 只读生成「从当前曲往前」的位置流。
 *
 * **绝不修改入参**:shuffle 走到序列末尾时返回 `reachedEnd: true` 而不是重洗
 * (重洗会改 shuffleOrder/shufflePos,那就不是 peek 了)。
 *
 * @param maxPositions 位置流长度上限(N×M)
 */
export function peekUpcomingPositions(
  q: QueuePeekSource,
  maxPositions: number,
): { positions: number[]; reachedEnd: boolean } {
  const positions: number[] = [];
  const n = q.items.length;
  if (n === 0 || q.currentIndex < 0 || maxPositions <= 0) {
    return { positions, reachedEnd: true };
  }
  const push = (idx: number) => {
    if (positions.length < maxPositions) positions.push(idx);
  };

  if (q.playMode === "one") {
    // 单曲循环:下一首永远是当前曲,窗口退化为 1 首。
    push(q.currentIndex);
    return { positions, reachedEnd: true };
  }

  if (q.playMode === "shuffle") {
    const order = q.shuffleOrder || [];
    let pos = (q.shufflePos ?? -1) + 1;
    while (pos < order.length && positions.length < maxPositions) {
      const idx = order[pos];
      if (typeof idx === "number" && idx >= 0 && idx < n) push(idx);
      pos++;
    }
    // 序列走到底 → 触底(未来不可知,等实际重洗后再补探)。
    return { positions, reachedEnd: pos >= order.length };
  }

  // order:沿下标前进到底为止;all:回绕,但一轮内不重复(最多 n-1 个)。
  const total = q.playMode === "all" ? n - 1 : n - 1 - q.currentIndex;
  let taken = 0;
  let idx = q.currentIndex + 1;
  while (taken < total && positions.length < maxPositions) {
    if (idx >= n) {
      if (q.playMode !== "all") break;
      idx = 0;
    }
    if (idx === q.currentIndex) break; // 回绕到自己 → 一轮结束
    push(idx);
    taken++;
    idx++;
  }
  return { positions, reachedEnd: taken >= total };
}

export class PreProbeScheduler {
  /**
   * 状态变化订阅者(2026-09-11 起为**多监听**)。
   *
   * 此前是单回调属性 `onChange`,只能挂一份 —— 而预探测现在同时服务两条独立链路:
   *   - QueueController(投屏/DLNA/组):状态变化 → emit `queue_changed`(裸 deviceId 键);
   *   - PeerManager(本机 Web/Flutter):状态变化 → emit `peer_queue_changed`(local: 键)。
   * 单回调会让后注册者把先注册者顶掉(投屏或本机之一静默失效),故改 Set。
   */
  private changeHandlers = new Set<(playerId: string) => void>();
  /** 单次扫描完成回调(守卫测试用它精确等待扫描结束;也可用于将来看门狗)。 */
  onScanComplete: ((playerId: string) => void) | null = null;

  /** 注册状态变化监听;返回取消函数。 */
  addOnChange(fn: (playerId: string) => void): () => void {
    this.changeHandlers.add(fn);
    return () => { this.changeHandlers.delete(fn); };
  }

  /** 广播状态变化;单个订阅者抛错不影响其它订阅者与扫描流程。 */
  private notifyChange(playerId: string): void {
    for (const fn of this.changeHandlers) {
      try { fn(playerId); } catch (e: any) {
        log.warn(`[PreProbe] ${playerId}: onChange 订阅者异常: ${e?.message || e}`);
      }
    }
  }

  private statuses = new Map<string, PreProbeStatus>();
  /** 同曲冷却:两次**真实探测**的最小间隔(songId → ms)。 */
  private lastProbeAt = new Map<string, number>();
  /** 同曲上一次判定 —— 负缓存已过期但同曲冷却未过时沿用,不制造「未知」模糊态。 */
  private lastVerdict = new Map<string, "playable" | "unplayable">();
  /** 枯竭冷却(playerId → ms)。 */
  private cooldownUntil = new Map<string, number>();
  private running = new Set<string>();
  private pending = new Set<string>();

  /** 读取状态位(未扫描过 / 插件关闭 → 空状态)。 */
  status(playerId: string): PreProbeStatus {
    if (!preProbeActive()) return EMPTY_PRE_PROBE_STATUS;
    const st = this.statuses.get(playerId);
    if (!st) return EMPTY_PRE_PROBE_STATUS;
    // 冷却到期后 exhausted 自动回落 —— 前端提示随状态消失,不留说谎的告警。
    if (st.exhausted && st.cooldownUntil !== null && Date.now() >= st.cooldownUntil) {
      return { ...st, exhausted: false, cooldownUntil: null };
    }
    return st;
  }

  /** 清枯竭冷却(队列构成/播放模式变化后调用:旧的「大面积无源」结论作废)。 */
  clearCooldown(playerId: string): void {
    this.cooldownUntil.delete(playerId);
  }

  /**
   * 触发一次预探测(fire-and-forget)。
   *
   * 防抖方式:同一 playerId 进行中 → 只标记 pending,扫描结束后补跑一次
   * (不重复开并发)。枯竭冷却中直接跳过。
   */
  schedule(playerId: string, getQueue: () => QueuePeekSource | undefined): void {
    if (!playerId) return;
    if (!preProbeActive()) return;
    const cfg = readPreProbeConfig();
    if (!cfg.enabled) return;
    // 缓存 TTL 由配置驱动(此处调用而非插件内,规避 core 插件的静态循环依赖)。
    configureStreamFallbackCache({ negativeTtlMs: cfg.negativeTtlSeconds * 1000 });
    if (this.isCoolingDown(playerId)) return;
    if (this.running.has(playerId)) {
      this.pending.add(playerId);
      return;
    }
    void this.runLoop(playerId, getQueue, cfg);
  }

  /** 整队无源(绕圈上限耗尽)上报:与「扫描枯竭」共用同一状态位。 */
  markAllUnplayable(playerId: string): void {
    const now = Date.now();
    const prev = this.status(playerId);
    this.statuses.set(playerId, {
      ready: 0,
      scanned: prev.scanned,
      misses: prev.misses,
      exhausted: true,
      cooldownUntil: null,
      at: now,
    });
    log.warn(`[PreProbe] ${playerId}: 整队无源,已停止推进并上报`);
    this.notifyChange(playerId);
  }

  /** 队列清空/设备注销时清状态(冷却与同曲记录保留,那是全局的)。
   *  不广播 —— 调用方(clear)本来就会发一次 queue_changed。 */
  clear(playerId: string): void {
    this.statuses.delete(playerId);
    this.cooldownUntil.delete(playerId);
    this.pending.delete(playerId);
  }

  /** 测试用:清空全部内存状态。 */
  resetForTest(): void {
    this.statuses.clear();
    this.lastProbeAt.clear();
    this.lastVerdict.clear();
    this.cooldownUntil.clear();
    this.running.clear();
    this.pending.clear();
  }

  private isCoolingDown(playerId: string): boolean {
    const until = this.cooldownUntil.get(playerId);
    if (!until) return false;
    if (Date.now() >= until) {
      this.cooldownUntil.delete(playerId);
      return false;
    }
    return true;
  }

  private async runLoop(
    playerId: string,
    getQueue: () => QueuePeekSource | undefined,
    cfg: PreProbeConfig,
  ): Promise<void> {
    this.running.add(playerId);
    try {
      do {
        this.pending.delete(playerId);
        const q = getQueue();
        if (!q) break;
        await this.scan(playerId, q, cfg);
        this.onScanComplete?.(playerId);
      } while (this.pending.has(playerId) && !this.isCoolingDown(playerId));
    } catch (e: any) {
      log.warn(`[PreProbe] ${playerId}: 扫描异常: ${e?.message || e}`);
    } finally {
      this.running.delete(playerId);
    }
  }

  private async scan(playerId: string, q: QueuePeekSource, cfg: PreProbeConfig): Promise<void> {
    const maxPositions = cfg.lookaheadSongs * cfg.deadRunLimit;
    const { positions, reachedEnd } = peekUpcomingPositions(q, maxPositions);

    let collected = 0;
    let deadRun = 0;
    let maxDeadRun = 0;
    let scanned = 0;
    let exhausted = false;
    let coveredSec = 0;
    const tLimitSec = cfg.windowMinutes * 60;

    let i = 0;
    let stop = false;
    while (i < positions.length && !stop) {
      if (collected >= cfg.lookaheadSongs || deadRun >= cfg.deadRunLimit) break;
      const batch = positions.slice(i, i + Math.max(1, cfg.concurrency));
      i += batch.length;
      const verdicts = await Promise.all(
        batch.map(p => this.probePosition(q.items[p], cfg)),
      );
      for (let k = 0; k < batch.length; k++) {
        const p = batch[k];
        const item = q.items[p];
        const dur = typeof item?.duration === "number" && item.duration > 0 ? item.duration : 0;
        // 时间上限:向前覆盖超 T 分钟 → 视为触底(静默)。
        // (一首 10 分钟的歌,"提前 3 首"就等于提前 30 分钟,已超出直链保质期。)
        if (coveredSec > 0 && coveredSec + dur > tLimitSec) {
          stop = true;
          break;
        }
        coveredSec += dur;
        scanned++;
        const v = verdicts[k];
        if (v === "playable") {
          collected++;
          if (deadRun > maxDeadRun) maxDeadRun = deadRun;
          deadRun = 0;
        } else if (v === "unplayable") {
          deadRun++;
        }
        // "unknown"(网络异常/冷却沿用不明)→ 既不算命中也不算无源,
        // 单次网络抖动不该让扫描提前判枯竭。
        if (collected >= cfg.lookaheadSongs || deadRun >= cfg.deadRunLimit) {
          if (deadRun > maxDeadRun) maxDeadRun = deadRun;
          break;
        }
      }
    }
    if (deadRun > maxDeadRun) maxDeadRun = deadRun;
    // 位置流未走完就因时间上限停下 → 不是故障,静默。
    const touchedEnd = reachedEnd || i >= positions.length || stop;

    if (deadRun >= cfg.deadRunLimit) exhausted = true;
    const now = Date.now();
    const cooldownUntil =
      exhausted && cfg.exhaustedCooldownSeconds > 0
        ? now + cfg.exhaustedCooldownSeconds * 1000
        : null;

    const prev = this.statuses.get(playerId);
    // 触底且没凑够 N → **不覆盖既有状态**:扫描对「未来」得不出结论时,
    // 不能把已上报的整队无源洗掉(比如 playCurrent 刚因绕圈上限上报完,
    // 随后的常规扫描触底,若覆盖会让告警闪灭)。只更新水位数字。
    const keepPrev = !exhausted && touchedEnd && collected < cfg.lookaheadSongs && !!prev;
    if (keepPrev) {
      this.statuses.set(playerId, { ...prev!, ready: collected, scanned });
    } else {
      this.statuses.set(playerId, {
        ready: collected,
        scanned,
        misses: maxDeadRun,
        exhausted,
        cooldownUntil,
        at: now,
      });
    }
    if (exhausted) {
      if (cooldownUntil) this.cooldownUntil.set(playerId, cooldownUntil);
      log.warn(
        `[PreProbe] ${playerId}: 枯竭 —— 连续 ${deadRun} 首探不到可用音源` +
        `(已探 ${scanned} 个位置${touchedEnd ? ",触及队列末端" : ""}),` +
        (cfg.exhaustedCooldownSeconds > 0 ? `冷却 ${cfg.exhaustedCooldownSeconds}s` : "未设冷却"),
      );
    }
    // 只有状态真的变化才广播(避免每次切歌都多发一条快照)。
    const changed =
      !prev ||
      prev.ready !== collected ||
      prev.scanned !== scanned ||
      prev.misses !== maxDeadRun ||
      prev.exhausted !== exhausted;
    if (changed) this.notifyChange(playerId);
  }

  /**
   * 判定单个位置的 songId 当前可播性。
   *
   * 三层闸(短路顺序即优先级):
   *   1. 缓存命中(正/负/退避) → 零成本直返;
   *   2. 同曲冷却内不重探 —— 负缓存过期但冷却未过时**沿用上一次判定**,
   *      不制造第三种「未知」模糊态;
   *   3. 真实探测(预算内超时,不阻塞播放路径)。
   */
  private async probePosition(
    item: { songId: string } | undefined,
    cfg: PreProbeConfig,
  ): Promise<ProbeVerdict> {
    const songId = item?.songId;
    if (!songId) return "unknown";

    const cached = getCachedPlayability(songId);
    if (cached === "playable") return "playable";
    if (cached === "unplayable") return "unplayable";
    // transient = 网络抖动,退避期内不重探,也不判定「这首歌没有源」。
    if (cached === "transient") return "unknown";

    const now = Date.now();
    const last = this.lastProbeAt.get(songId);
    if (last && cfg.probeCooldownSeconds > 0 && now - last < cfg.probeCooldownSeconds * 1000) {
      const prev = this.lastVerdict.get(songId);
      return prev === "playable" ? "playable" : prev === "unplayable" ? "unplayable" : "unknown";
    }

    let songRow: any;
    try {
      songRow = db.select().from(songs).where(eq(songs.id, songId)).get();
    } catch {
      return "unknown";
    }
    if (!songRow) {
      // 曲库里没有这首歌 → 播不出来。
      this.lastProbeAt.set(songId, now);
      this.lastVerdict.set(songId, "unplayable");
      return "unplayable";
    }
    if (!songRow.pluginEntry || typeof songRow.pluginEntry !== "string") {
      // 本地 / WebDAV 行:预探测不代劳(本地零成本由 playCurrent 即时裁决,
      // WebDAV 有 5 分钟失败记忆),一律按「未确认可播」处理,不计入无源。
      return "unknown";
    }

    this.lastProbeAt.set(songId, now);
    try {
      const url = await ensurePlayableStream(songRow, cfg.probeTimeoutMs);
      if (url) {
        this.lastVerdict.set(songId, "playable");
        return "playable";
      }
    } catch {
      return "unknown";
    }
    // ensurePlayableStream 返 null 时再确认一次:网络异常会写成 transient,
    // 那属于「不知道」而不是「没有源」。
    const after = getCachedPlayability(songId);
    if (after === "transient") return "unknown";
    this.lastVerdict.set(songId, "unplayable");
    return "unplayable";
  }
}

let singleton: PreProbeScheduler | null = null;

export function getPreProbeScheduler(): PreProbeScheduler {
  if (!singleton) singleton = new PreProbeScheduler();
  return singleton;
}
