// MusicFetch 质量判定：档位分类 / 假无损识别 / 达标判定 / 候选打分排序。
//
// 设计原则：**全部是纯函数**（无 IO、无副作用、不读全局配置），配置一律由入参传入，
// 便于单测覆盖每一个拒绝分支，也便于上层在不同任务里传入不同门槛。
import type { Candidate, CandidateQuality, QualityConfig, QualityTier } from "./types.js";

/** 无损容器集合（用于档位判定与假无损判定的前置过滤）。 */
const LOSSLESS_CONTAINERS: ReadonlySet<string> = new Set(["flac", "ape", "wav", "alac", "aiff"]);

/** 有损档位阶梯（从高到低），用于把比特率归到最接近且不超过的档。 */
const LOSSY_TIERS: ReadonlyArray<{ tier: QualityTier; kbps: number }> = [
  { tier: "320", kbps: 320 },
  { tier: "256", kbps: 256 },
  { tier: "192", kbps: 192 },
  { tier: "128", kbps: 128 },
];

/** 档位序值：unknown 最低、hires 最高，用于「>= 门槛」与打分比较。 */
export const TIER_RANK: Record<QualityTier, number> = {
  unknown: 0,
  "128": 1,
  "192": 2,
  "256": 3,
  "320": 4,
  lossless: 5,
  hires: 6,
};

/** 数字档 → 该档对应的最低比特率（用于「门槛与 minBitrateKbps 取严者」）。 */
const TIER_MIN_KBPS: Partial<Record<QualityTier, number>> = {
  "128": 128,
  "192": 192,
  "256": 256,
  "320": 320,
};

/**
 * 由「字节数 / 时长」换算有效比特率（kbps）。
 * 时长 <= 0 或字节数 <= 0 时无法换算，返回 0（调用方按「缺失」处理）。
 */
export function effectiveBitrateKbps(bytes: number, durationSec: number): number {
  if (!(bytes > 0) || !(durationSec > 0)) return 0;
  return (bytes * 8) / durationSec / 1000;
}

/**
 * 取一个质量描述的「可信比特率」：**真实探针（bytes/duration）优先**，
 * 缺失时回落到信源声明值。
 *
 * 为什么探针优先：信源（尤其洛雪系）普遍虚标，字节数才是落盘后真实体量；
 * 架构决策也明确「达标判定以 probed 为准」。
 */
function pickBitrateKbps(q: CandidateQuality | undefined): number {
  if (!q) return 0;
  const eff = effectiveBitrateKbps(q.bytes ?? 0, q.durationSec ?? 0);
  if (eff > 0) return eff;
  return q.bitrateKbps ?? 0;
}

/**
 * 取候选的可信质量描述：probed 优先，缺失回落 declared。
 *
 * ⚠️ 两条不同的比特率来源，优先级**刻意不同**（勿合并）：
 *
 * 1) `probed`（下载后真实探针）：`pickBitrateKbps` 以 **bytes/duration** 为准 ——
 *    probe 模块从容器里读出的是**精确字节数**，比信源声明更可信（信源普遍虚标）。
 *    这条不变量是 Requirement 3「复筛严格」的基石，**绝不能被下面的改动破坏**。
 *
 * 2) `declared`（下载前声明）：inspect 预探走的是 `/music/inspect`，服务端 `size`
 *    用 `FormatSize` 输出 `%.1f MB`（**只有 1 位小数**），回传的 `bytes` 是
 *    「按 0.1MB 量化后还原」的近似值（小文件误差可达 ±5%）；而同一次应答里的
 *    `bitrateKbps` 是服务端用**真实 Content-Range 字节数**算出的整型 kbps，是精确的。
 *    故 declared 路径**优先采信 `bitrateKbps`**，仅当它缺失时才回落 `bytes/durationSec`。
 *
 * 实现方式：declared 同时带 `bitrateKbps` 与 `bytes` 时，把 `bytes` 让位（置 undefined），
 * 于是两处下游取值（`pickBitrateKbps` / `isFakeLossless`）自然走 bitrate 分支，
 * 无需改动 probed 那侧的取值顺序。
 */
function pickQuality(c: Candidate): CandidateQuality | undefined {
  if (c.probed) return c.probed;
  const d = c.declared;
  if (!d) return undefined;
  if (typeof d.bitrateKbps === "number" && d.bitrateKbps > 0 && d.bytes !== undefined) {
    return { ...d, bytes: undefined };
  }
  return d;
}

/**
 * 判定质量档位。
 * - hires：无损容器且（采样率 > 48000 或 位深 > 16）；
 * - lossless：无损容器且（位深未给 或 位深 >= 16）；
 * - 有损：按可信比特率归到 320/256/192/128（取最接近且不超过的档，> 320 归 320）；
 * - 判不出来（无容器且无比特率 / 比特率低于 128 档）→ unknown。
 */
export function classifyTier(q: CandidateQuality): QualityTier {
  const container = (q.container ?? "").toLowerCase();
  if (LOSSLESS_CONTAINERS.has(container)) {
    const sr = q.sampleRateHz ?? 0;
    const bd = q.bitDepth ?? 0;
    if ((sr > 0 && sr > 48000) || (bd > 0 && bd > 16)) return "hires";
    // 位深未给（多数信源不返回位深）→ 按容器认定为无损；位深 < 16 的「无损容器」
    // （如 8bit wav）不配称无损，继续按比特率归类。
    if (bd === 0 || bd >= 16) return "lossless";
  }
  const kbps = pickBitrateKbps(q);
  if (kbps > 0) {
    // > 320 一律归入 320 档（例如 1411kbps 的 wav 已在上一步判为 lossless）。
    if (kbps > 320) return "320";
    for (const t of LOSSY_TIERS) {
      if (kbps >= t.kbps) return t.tier;
    }
    // 低于 128kbps：没有更低的档位可归，判不出来。
    return "unknown";
  }
  return "unknown";
}

/** 候选所属档位（probed 优先，缺失回落 declared，都没有 → unknown）。 */
function tierOf(c: Candidate): QualityTier {
  const q = pickQuality(c);
  return q ? classifyTier(q) : "unknown";
}

/**
 * 假无损判定：只针对**标称无损容器**生效。
 *
 * - off：恒 false（用户明确关闭检测）；
 * - meta：encoder 字符串命中 fakeLosslessEncoderHints 即判假（最省，但依赖信源给 encoder）；
 * - bitrate：有效比特率 < fakeLosslessMinEffBitrate 即判假（命中「有损转 flac」最有效）；
 * - spectrum：频谱分析，本轮不实现，恒返回 { fake: false, reason: 'not-implemented' }。
 *
 * reason 写清判定依据（例如 'effective 612kbps < 700'），直接进用户可见的失败原因。
 */
export function isFakeLossless(c: Candidate, cfg: QualityConfig): { fake: boolean; reason: string } {
  const q = pickQuality(c);
  if (!q) return { fake: false, reason: "无质量信息，无法判定" };
  const container = (q.container ?? "").toLowerCase();
  if (!LOSSLESS_CONTAINERS.has(container)) {
    return { fake: false, reason: `容器 ${container || "-"} 非无损容器，不适用假无损检测` };
  }
  const mode = cfg.fakeLosslessDetect;
  if (mode === "off") return { fake: false, reason: "假无损检测已关闭" };
  if (mode === "spectrum") return { fake: false, reason: "not-implemented" };

  if (mode === "meta") {
    const encoder = (q.encoder ?? "").toLowerCase();
    const hit = cfg.fakeLosslessEncoderHints.find((h) => h.length > 0 && encoder.includes(h.toLowerCase()));
    if (hit) return { fake: true, reason: `encoder 命中假无损特征「${hit}」` };
    return { fake: false, reason: encoder ? "encoder 未命中假无损特征" : "信源未提供 encoder，无法判定" };
  }

  // bitrate 模式
  const kbps = pickBitrateKbps(q);
  if (kbps <= 0) return { fake: false, reason: "无有效比特率，无法判定" };
  const shown = Math.round(kbps);
  if (kbps < cfg.fakeLosslessMinEffBitrate) {
    return { fake: true, reason: `effective ${shown}kbps < ${cfg.fakeLosslessMinEffBitrate}` };
  }
  return { fake: false, reason: `effective ${shown}kbps >= ${cfg.fakeLosslessMinEffBitrate}` };
}

/** 标题是否命中排除关键词（大小写不敏感）。 */
function hitsExcludeKeywords(title: string, keywords: string[]): string | undefined {
  const t = (title ?? "").toLowerCase();
  if (!t) return undefined;
  return keywords.find((k) => k.length > 0 && t.includes(k.toLowerCase()));
}

/** 非录音室版本特征（live / remix / acoustic / cover），用于打分惩罚。 */
const NON_STUDIO_PATTERN: RegExp = /(^|[^a-z])(live|remix|acoustic|cover)([^a-z]|$)/i;

/**
 * 达标判定：按顺序检查，任一不通过即返回 ok=false 并带中文原因（面向用户展示）。
 *
 * 顺序：容器白名单 → 时长区间 → 时长偏差 → 采样率上下限 → 档位下限
 *      → 有损比特率下限（与档位下限取严者）→ 标题关键词 → 假无损。
 *
 * `opts.tolerateUnknown`：**预筛阶段**开关。信源（尤其聚合源 go-music-dl / lx-source）
 * 常常只给一个 URL，不声明容器/比特率/档位；此时若按「未知即一票否决」处理，会在
 * 还没比音质之前就把全部候选杀掉（真实线上事故）。开启后，「容器未声明」「档位 unknown」
 * 两类**未知**放行到下载后的探针复筛；而**已声明**的可信信号（坏容器 / 低档位 / 低比特率）
 * 一律照旧拒绝 —— 宽容只针对「未知」，绝不放过「已知的差」。
 */
export function meetsFloor(
  c: Candidate,
  cfg: QualityConfig,
  target?: { durationSec?: number },
  opts?: { tolerateUnknown?: boolean },
): { ok: boolean; reason?: string } {
  const q = pickQuality(c);

  // 1) 容器白名单
  if (cfg.allowedContainers.length > 0) {
    const container = (q?.container ?? "").toLowerCase();
    if (!container) {
      // 信源未声明容器：预筛阶段放行（下载后由探针拿到真实容器再复核）；
      // 探针阶段（tolerateUnknown 未开）仍严格拒绝。
      if (!opts?.tolerateUnknown) {
        return { ok: false, reason: "信源未声明容器，无法确认格式" };
      }
    } else if (!cfg.allowedContainers.some((a) => a.toLowerCase() === container)) {
      // 已声明的容器不在白名单 → 无论哪个阶段都拒绝（这是可信信号）。
      return { ok: false, reason: `容器 ${container} 不在允许列表（${cfg.allowedContainers.join("/")}）` };
    }
  }

  const duration = q?.durationSec ?? 0;

  // 2) 时长区间（时长未知时不判，交由下载后的探针复核）
  if (duration > 0) {
    if (duration < cfg.minDurationSec) {
      return { ok: false, reason: `时长 ${Math.round(duration)}s 短于下限 ${cfg.minDurationSec}s` };
    }
    if (duration > cfg.maxDurationSec) {
      return { ok: false, reason: `时长 ${Math.round(duration)}s 长于上限 ${cfg.maxDurationSec}s` };
    }
  }

  // 3) 与目标时长的偏差
  if (target?.durationSec && target.durationSec > 0 && duration > 0) {
    const diff = Math.abs(duration - target.durationSec);
    if (diff > cfg.durationToleranceSec) {
      return {
        ok: false,
        reason: `时长 ${duration.toFixed(1)}s 与目标 ${target.durationSec.toFixed(1)}s 偏差 ${diff.toFixed(1)}s 超过容差 ${cfg.durationToleranceSec}s`,
      };
    }
  }

  // 4) 采样率上下限
  const sr = q?.sampleRateHz ?? 0;
  if (sr > 0) {
    if (sr < cfg.minSampleRateHz) {
      return { ok: false, reason: `采样率 ${sr}Hz 低于下限 ${cfg.minSampleRateHz}Hz` };
    }
    if (sr > cfg.maxSampleRateHz) {
      return { ok: false, reason: `采样率 ${sr}Hz 高于上限 ${cfg.maxSampleRateHz}Hz` };
    }
  }

  const tier = tierOf(c);

  // 5) 档位下限（tolerateUnknown 时，档位 unknown 放行到探针阶段复核）
  if (cfg.qualityFloor !== "any" && !(opts?.tolerateUnknown && tier === "unknown")) {
    const floorRank = TIER_RANK[cfg.qualityFloor];
    if (TIER_RANK[tier] < floorRank) {
      return { ok: false, reason: `质量档位 ${tier} 低于门槛 ${cfg.qualityFloor}` };
    }
  }

  // 6) 有损比特率下限：与「数字档位门槛」取严者
  if (tier === "128" || tier === "192" || tier === "256" || tier === "320") {
    const floorKbps =
      cfg.qualityFloor !== "any" ? (TIER_MIN_KBPS[cfg.qualityFloor] ?? 0) : 0;
    const need = Math.max(cfg.minBitrateKbps, floorKbps);
    const kbps = pickBitrateKbps(q);
    if (kbps > 0 && need > 0 && kbps < need) {
      return { ok: false, reason: `比特率 ${Math.round(kbps)}kbps 低于下限 ${need}kbps` };
    }
  }

  // 7) 标题关键词
  const hit = hitsExcludeKeywords(c.title ?? "", cfg.excludeTitleKeywords);
  if (hit) {
    return { ok: false, reason: `标题命中排除关键词「${hit}」` };
  }

  // 8) 假无损
  if (cfg.rejectFakeLossless) {
    const fake = isFakeLossless(c, cfg);
    if (fake.fake) {
      return { ok: false, reason: `疑似假无损（${fake.reason}）` };
    }
  }

  return { ok: true };
}

/**
 * 候选打分：档位主导（每档 10000 分，档位差无法被比特率拉近），
 * 再叠加比特率、采样率，减去信源优先级惩罚，最后按版本/关键词减分。
 */
export function scoreCandidate(c: Candidate, cfg: QualityConfig): number {
  const q = pickQuality(c);
  const tier = q ? classifyTier(q) : "unknown";
  const kbps = pickBitrateKbps(q);
  const sr = q?.sampleRateHz ?? 0;
  let score = TIER_RANK[tier] * 10000 + kbps + sr / 1000 - (c.sourceRank ?? 0) * 50;

  const title = c.title ?? "";
  if (cfg.preferStudioVersion && NON_STUDIO_PATTERN.test(title)) score -= 500;
  if (hitsExcludeKeywords(title, cfg.excludeTitleKeywords)) score -= 2000;
  return score;
}

/**
 * 候选排序：去重（按 id，保留首次出现）→ 过滤不达标 → 可选「只要无损」→ 按分数降序。
 *
 * preferLossless：只要池中**存在**无损档（lossless/hires）候选，就剔除全部有损候选，
 * 避免「有损排在无损前面」被先下载。
 *
 * ⚠️ 预筛用**宽容模式**（`tolerateUnknown:true`）：此刻只有信源声明值，聚合源普遍不声明
 * 容器/比特率，若按严格口径会把整池候选误杀（真实线上事故）。真实音质由 orchestrator
 * 下载后的 probed 复筛（严格口径）把关；已声明的坏容器/低档位在此仍会被剔除。
 */
export function rankCandidates(
  cands: Candidate[],
  cfg: QualityConfig,
  target?: { durationSec?: number },
): Candidate[] {
  const seen = new Set<string>();
  const unique: Candidate[] = [];
  for (const c of cands) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    unique.push(c);
  }

  // 预筛阶段只能用信源的**声明值**（此时还没下载、没有 probed）。
  // 聚合源普遍不报容器/比特率 → 必须容忍 unknown，否则全部候选会在此被误杀；
  // 真实音质由 orchestrator 下载后的 probed 复筛（strict）把关。
  const passed = unique.filter((c) => meetsFloor(c, cfg, target, { tolerateUnknown: true }).ok);

  let pool = passed;
  if (cfg.preferLossless) {
    const lossless = passed.filter((c) => {
      const t = tierOf(c);
      return t === "lossless" || t === "hires";
    });
    if (lossless.length > 0) pool = lossless;
  }

  // Array.prototype.sort 在 ES2019+ 稳定，同分保持入池顺序（即 sourceRank 语义）。
  return pool
    .map((c) => ({ c, s: scoreCandidate(c, cfg) }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.c);
}

/**
 * 是否值得「用 next 替换已入库的 current」（自动择优更高音质）。
 *
 * - upgradeCrossTierOnly 为真：必须跨档（next 档位严格更高）；
 * - 为假：允许同档内的比特率小幅提升；
 * - 两种模式都要求比特率提升 >= upgradeMinStepKbps（任一侧比特率缺失时只比档位）。
 */
export function shouldUpgrade(
  current: { tier: QualityTier; bitrateKbps?: number },
  next: { tier: QualityTier; bitrateKbps?: number },
  cfg: { upgradeCrossTierOnly: boolean; upgradeMinStepKbps: number },
): boolean {
  const curRank = TIER_RANK[current.tier];
  const nextRank = TIER_RANK[next.tier];
  if (cfg.upgradeCrossTierOnly) {
    if (nextRank <= curRank) return false;
  } else if (nextRank < curRank) {
    return false;
  }
  const cb = current.bitrateKbps;
  const nb = next.bitrateKbps;
  // 比特率缺失（无损档常缺）→ 只比档位，档位已通过即视为可升级。
  if (cb === undefined || nb === undefined) return true;
  return nb - cb >= cfg.upgradeMinStepKbps;
}
