// ==================== ② 段「响度归一化」的可配置项（对齐 MA 的两个常量）====================
//
// 六段流水线的 ② 段（`docs/audio-pipeline-plan.md` §3.1）：把每首歌拉到同一个目标响度，
// 让「这首歌特别小声、下一首特别大声」不再需要手动拧音量。判决链在 `loudness.ts`
// （chooseMode → computeGainDb），滤镜串在 `pipeline.ts`（loudnessFilter），
// **本文件只管「用户能配的两个值 + 它们落在哪个设置键上」**。
//
// 取值口径照 MA（`music-assistant/server`，核对方式见 plan「引证改为按 commit 拉取」条）：
//   - `CONF_ENTRY_VOLUME_NORMALIZATION_TARGET`：`range=(-30, -5)`、`default_value=-14`
//     （`constants.py:459-468`）——本文件的 `TARGET_LUFS_MIN/MAX/DEFAULT_TARGET_LUFS` 与它逐项相同；
//   - 目标值在出流侧拼进滤镜串：`loudnorm=I={target_loudness}`（MA `controllers/streams/audio.py:1755`）。
//
// ⚠️ **有意与 MA 不同的一点，不要在别处写成「与 MA 一致」**：MA 的
// `volume_normalization` / `volume_normalization_target` 是**队列级**配置
// （`controllers/player_queues/config.py` 里挂在 queue 上，按 `queue_id` 取值），
// 我们这边 ② 段的 af 链是**每条流起流时一次性算定**的（`resolveLoudnessAf` 只认 `rowId`），
// 没有"队列"这一层可挂，故收敛成**服务端全局**一项，与 `pipeline.*` 同族、同一套读写缓存。
//
// 缺省策略：`enabled` 缺省 **开**（P0 起就是"始终归一化"，加开关不该顺手改缺省行为）；
// `targetLufs` 缺省 **-14**（MA 默认值，也是 D1 当初采纳的推荐值）。
import { getSetting, getSettingBool, setSetting } from "../settings.js";

/** ② 段总开关的设置键。 */
export const NORMALIZATION_ENABLED_KEY = "loudness.normalization";
/** 目标响度的设置键（整数 LUFS，存成字符串）。 */
export const NORMALIZATION_TARGET_KEY = "loudness.targetLufs";

/** 目标响度缺省值（= MA `CONF_ENTRY_VOLUME_NORMALIZATION_TARGET.default_value`）。 */
export const DEFAULT_TARGET_LUFS = -14;
/** 目标响度下限（= MA 同一 ConfigEntry 的 `range[0]`）。 */
export const TARGET_LUFS_MIN = -30;
/** 目标响度上限（= MA 同一 ConfigEntry 的 `range[1]`）。 */
export const TARGET_LUFS_MAX = -5;

export interface NormalizationSettings {
  /**
   * ② 段是否生效。`false` = 不加 loudnorm、也不加静态增益；
   * **③ 段 DSP 与 ⑤ 段限制器照旧**（这两段是独立的开关/常量，见 `LoudnessAfOpts.normalization` 的注释）。
   */
  enabled: boolean;
  /** 目标响度（整数 LUFS，已夹到 `[TARGET_LUFS_MIN, TARGET_LUFS_MAX]`）。 */
  targetLufs: number;
}

/**
 * 把任意入参夹成合法的目标响度：先取整再夹到区间，非数值回退缺省。
 * 导出是为了让「越界值一律夹、非数值才忽略」这条纪律只有一个落点（路由与解析共用）。
 */
export function clampTargetLufs(v: unknown): number {
  const n = typeof v === "number" ? v : Number.parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return DEFAULT_TARGET_LUFS;
  return Math.min(TARGET_LUFS_MAX, Math.max(TARGET_LUFS_MIN, Math.round(n)));
}

/** 读设置面板需要的两个值（缺省：开 + -14）。 */
export function readNormalizationSettings(): NormalizationSettings {
  return {
    enabled: getSettingBool(NORMALIZATION_ENABLED_KEY, true),
    targetLufs: clampTargetLufs(getSetting(NORMALIZATION_TARGET_KEY, String(DEFAULT_TARGET_LUFS))),
  };
}

/**
 * 部分更新（只改传进来的字段）。未知字段忽略、不抛 —— 与管道开关同一套"逐项提交"纪律。
 * 目标响度写了区间外的值**夹到边界**（用户在面板上看到的就是真正生效的值），
 * 写了非数值才忽略。返回更新后的快照，调用方直接回显。
 */
export function updateNormalizationSettings(patch: unknown): NormalizationSettings {
  const p = (patch && typeof patch === "object" ? patch : {}) as Record<string, unknown>;
  if (typeof p.enabled === "boolean") setSetting(NORMALIZATION_ENABLED_KEY, p.enabled ? "1" : "0");
  if (p.targetLufs !== undefined && p.targetLufs !== null) {
    const n = Number(p.targetLufs);
    if (Number.isFinite(n)) setSetting(NORMALIZATION_TARGET_KEY, String(clampTargetLufs(n)));
  }
  return readNormalizationSettings();
}
