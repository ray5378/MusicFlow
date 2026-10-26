// ==================== 预取与判官配置(settings 表,前端「媒体获取」页可调) ====================
//
// 用户 2026-10-12 拍板:「不要完全写死」—— 下一首内存预取的各档参数 + 完整性判官的
// 两条判死线,全部暴露在「插件管理 → 媒体获取」页,改完即存即生效。
//
// 存储:settings 表单键 `prefetch.settings`(JSON 全量快照)。读走 getSetting
// (5s TTL 内存缓存),setSetting 写后主动失效 —— UI 保存后下一首预取即按新值跑,
// 无需重启。
//
// 读优先级(与 log.level 同范式):
//   **settings 表(UI 保存过) > 环境变量 > 模块默认**。
//   env 只在「从没在 UI 保存过」时兜底(兼容部署期注入);一旦 UI 保存过,该字段
//   以 UI 为准 —— 避免「运维注入了 env、用户在 UI 改了没效果」的割裂。
//
// 边界:每个字段独立 clamp(单字段坏值/越界只回退那一个字段,不坏整包);
// 整数字段四舍五入;PUT 为**合并**语义(只改带上来的字段,其余保持现值)。

import { getSetting, setSetting } from "../settings.js";

/** settings 表键。 */
export const PREFETCH_SETTINGS_KEY = "prefetch.settings";

// ---------------- 流式窗口「提前 EOF」判据（2026-10-27） ----------------

/**
 * 流式窗口提前 EOF 的**判死线（秒）**：`声明时长 − 已交付时长 > 本值` ⇒ 判「源被截断」。
 *
 * 为什么是 80 而不是 15（与 metadata 真值路径同一个问题）：
 *   - 这里的「已交付时长」是**播放侧实测**（已解码样本数 / 已推送位置），不是 metadata 真值；
 *     起播时窗口可能还在边解边推、seek/重锚会让秒数有 ±1 帧的抖动，再叠上设备侧缓冲
 *     排空的那几秒 —— 口径本来就不精确。
 *   - 240 实测（2026-10-27）：插件源声明 276s，实际只给 30s（5,762,400B ÷ 192,000B/s）。
 *     这种「差几百秒」的截断用 80s 的线绰绰有余；而正常曲目末端的时长差通常 < 1s。
 *   - 与 `PREFETCH_INTEGRITY_DELTA_SEC_BITRATE`（码率推算路径同样是近似值）取同一个数，
 *     运维看日志时两条判据是同一把尺子。**宁可漏杀不可误杀**。
 *
 * env `AP2_TRUNCATE_MISSING_SEC` 可覆盖（排障/灰度用，不改库不动 UI）。
 */
export const AP2_TRUNCATE_MISSING_SEC = 80;

/** 取生效的提前 EOF 判死线（env 覆盖 > 模块默认）。 */
export function ap2TruncateMissingSec(): number {
  const n = Number(process.env.AP2_TRUNCATE_MISSING_SEC);
  return Number.isFinite(n) && n > 0 ? n : AP2_TRUNCATE_MISSING_SEC;
}

export interface PrefetchSettings {
  /** 向前预取几首(队列下一首起)。 */
  lookahead: number;
  /** 预取并发上限(1 = 串行;天翼等共享带宽的源并发只会一起变慢)。 */
  concurrency: number;
  /** 预算闸门系数:在途 + 预估 > 全局预算 × 本系数 ⇒ 放弃(给正在播的那条留份额)。 */
  budgetRatio: number;
  /** 单次预取总取流时长硬顶(秒)。 */
  deadlineSec: number;
  /** 单次预取停摆判据(秒)。 */
  stallSec: number;
  /** 预取索引条目有效期(秒)。 */
  entryTtlSec: number;
  /** 组内换源候选上限(0 = 关闭换源,判死即跳下一首)。 */
  maxAltSources: number;
  /** 完整性判官总开关。 */
  integrityEnabled: boolean;
  /** metadata 真值路径判死线(秒):实际时长比曲库基准短超过这么多 ⇒ 判死。 */
  integrityDeltaSec: number;
  /** 码率推算路径判死线(秒):duration 缺失时按 字节×8÷码率 推算,近似值 ⇒ 放宽档。 */
  integrityBitrateDeltaSec: number;
  /** 音频文件的最小合理字节数(KB,低于此判 too-small)。 */
  minAudioKB: number;
}

interface NumSpec {
  min: number;
  max: number;
  def: number;
  int?: boolean;
  /** 仅在 settings 无该字段时兜底读的 env 名(留空 = 无 env 兜底,直接用默认)。 */
  env?: string;
}

/** 数值字段的取值范围/默认/env 兜底。UI 与后端共用这一份 clamp(前端也按同范围校验)。 */
export const PREFETCH_NUM_SPECS: Record<string, NumSpec> = {
  lookahead: { min: 1, max: 5, def: 1, int: true },
  concurrency: { min: 1, max: 4, def: 1, int: true },
  budgetRatio: { min: 0.1, max: 1, def: 0.5 },
  deadlineSec: { min: 10, max: 600, def: 120, int: true },
  stallSec: { min: 5, max: 300, def: 30, int: true },
  entryTtlSec: { min: 60, max: 3600, def: 600, int: true },
  maxAltSources: { min: 0, max: 8, def: 3, int: true },
  integrityDeltaSec: { min: 1, max: 600, def: 15, int: true, env: "PREFETCH_INTEGRITY_DELTA_SEC" },
  integrityBitrateDeltaSec: {
    min: 5, max: 1800, def: 80, int: true, env: "PREFETCH_INTEGRITY_DELTA_SEC_BITRATE",
  },
  minAudioKB: { min: 8, max: 4096, def: 64, int: true },
};

function clamp(n: number, spec: NumSpec): number {
  const v = Math.min(spec.max, Math.max(spec.min, n));
  return spec.int ? Math.round(v) : v;
}

/** 单字段求解:settings 值(有且合法) > env(配了且合法) > 默认。 */
function resolveNum(key: string, fromSettings: unknown): number {
  const spec = PREFETCH_NUM_SPECS[key];
  if (fromSettings !== undefined && fromSettings !== null && fromSettings !== "") {
    const n = Number(fromSettings);
    if (Number.isFinite(n)) return clamp(n, spec);
  }
  const envName = spec.env;
  if (envName) {
    const raw = process.env[envName];
    if (raw !== undefined && raw !== "") {
      const n = Number(raw);
      if (Number.isFinite(n)) return clamp(n, spec);
    }
  }
  return spec.def;
}

/**
 * 读当前生效配置。settings 无记录(或坏 JSON)⇒ 逐字段回落 env/默认。
 * 热路径每次预取读一次(getSetting 有 5s 缓存),成本可忽略。
 */
export function getPrefetchSettings(): PrefetchSettings {
  let saved: Record<string, unknown> | null = null;
  const raw = getSetting(PREFETCH_SETTINGS_KEY, "");
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) saved = parsed as Record<string, unknown>;
    } catch {
      /* 坏 JSON ⇒ 当作没保存过,回落 env/默认 */
    }
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(PREFETCH_NUM_SPECS)) {
    out[key] = resolveNum(key, saved ? saved[key] : undefined);
  }
  // 判官总开关:settings 布尔优先;无记录时 env PREFETCH_INTEGRITY_OFF=1 可整体关闭。
  const integrityEnabled = saved && typeof saved.integrityEnabled === "boolean"
    ? saved.integrityEnabled
    : process.env.PREFETCH_INTEGRITY_OFF !== "1";
  return { ...(out as unknown as PrefetchSettings), integrityEnabled };
}

/**
 * 合并式保存:只改 patch 里带上来的字段(非 number 的数值字段/越界值忽略 —— 越界
 * 由前端同范围校验拦着,这里是后端侧的最后防线),其余保持现值。落库后即时生效。
 * 返回实际生效的全量配置,供调用方回读。
 */
export function setPrefetchSettings(patch: unknown): PrefetchSettings {
  const cur = getPrefetchSettings();
  const p = (patch && typeof patch === "object" ? (patch as Record<string, unknown>) : {}) as Record<string, unknown>;
  const next: PrefetchSettings = { ...cur };
  if (typeof p.integrityEnabled === "boolean") next.integrityEnabled = p.integrityEnabled;
  for (const [key, spec] of Object.entries(PREFETCH_NUM_SPECS)) {
    if (!(key in p)) continue;
    const n = Number((p as Record<string, unknown>)[key]);
    if (!Number.isFinite(n)) continue;
    (next as unknown as Record<string, unknown>)[key] = clamp(n, spec);
  }
  setSetting(PREFETCH_SETTINGS_KEY, JSON.stringify(next));
  return next;
}

/** 恢复默认(删记录 ⇒ 回落 env/模块默认)。供 UI「恢复默认」与测试复用。 */
export function resetPrefetchSettings(): PrefetchSettings {
  setSetting(PREFETCH_SETTINGS_KEY, "");
  return getPrefetchSettings();
}
