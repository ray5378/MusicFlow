// ==================== 音频管道开关（P5-1 / P5-2） ====================
//
// 一张表统管「哪些通道的滤镜链生效」。语义照 **D9**：关闭 = **滤镜链为空，不回到绕过管道** ——
// 关掉之后仍然解码 → （空 af）→ 编码，绝不恢复「原样直出 / `?raw=1` 直透」那条已删除的路
// （见 `docs/audio-pipeline-plan.md` §9 作废断言表）。
//
// 两层判定：
//   ① **全局总开关** `pipeline.enabled`（缺省开）—— 一键回到「逐首播放 + 无归一化 + 无 DSP」，
//      照 plan §7「回退」条的措辞；
//   ② **每通道开关** `pipeline.<channel>` —— 某一类出口单独降级（老 DLNA 音箱不接受实时流等）。
// `isChannelEnabled()` 是**唯一**判定入口（两层都成立才算开），别在调用点各写一遍。
//
// 缺省全开：D5 已定「DLNA 与其它通道一致默认开启」；其余通道是 P1/P2 起就已在跑的现状，
// 没有理由在「加开关」的同时顺手改缺省行为。
//
// ⚠️ 与 `pipeline.flow` / `crossfade.mode` 的分工：那两个只管**交叉淡入**（P3），
// 本模块管**滤镜链**（P1/P2/P4）。两者相互独立 —— 全局关 = 淡入也没了（见 flowSource）。
import { getSettingBool, setSetting } from "../settings.js";

/** 管道出口分类。键名进设置库，改名等于用户配置失效（新增可以，改名不行）。 */
export type PipelineChannel = "http" | "dlna" | "sendspin" | "airplay";

/** 全部通道（顺序即设置面板的展示顺序）。 */
export const PIPELINE_CHANNELS: readonly PipelineChannel[] = ["http", "dlna", "sendspin", "airplay"];

/** 全局总开关的设置键。 */
export const PIPELINE_GLOBAL_KEY = "pipeline.enabled";

/** 每通道开关的设置键。`pipeline.http` 是 P2 就在用的键，保持不变（老配置继续有效）。 */
export const PIPELINE_CHANNEL_KEYS: Readonly<Record<PipelineChannel, string>> = {
  http: "pipeline.http",
  dlna: "pipeline.dlna",
  sendspin: "pipeline.sendspin",
  airplay: "pipeline.airplay",
};

/** 全局总开关。 */
export function isPipelineEnabled(): boolean {
  return getSettingBool(PIPELINE_GLOBAL_KEY, true);
}

/** 某通道是否启用（全局 + 该通道，两层都开）。未知通道按「跟随全局」处理。 */
export function isChannelEnabled(channel: PipelineChannel): boolean {
  if (!isPipelineEnabled()) return false;
  const key = PIPELINE_CHANNEL_KEYS[channel];
  return key ? getSettingBool(key, true) : true;
}

export interface PipelineSwitchSnapshot {
  enabled: boolean;
  channels: Record<PipelineChannel, boolean>;
}

/** 设置面板一次读全（各自生效值，不是原始键）。 */
export function readPipelineSwitches(): PipelineSwitchSnapshot {
  const channels = {} as Record<PipelineChannel, boolean>;
  for (const ch of PIPELINE_CHANNELS) channels[ch] = getSettingBool(PIPELINE_CHANNEL_KEYS[ch], true);
  return { enabled: isPipelineEnabled(), channels };
}

/**
 * 部分更新（只改传进来的字段）。未知通道名 / 非布尔值一律忽略，不抛 ——
 * 设置面板是逐项提交的，一个手抖的字段不该把整次保存打回。
 * 返回更新后的快照，调用方直接回显（与 DSP 面板同一套「真相源在服务端」的做法）。
 */
export function updatePipelineSwitches(patch: unknown): PipelineSwitchSnapshot {
  const p = (patch && typeof patch === "object" ? patch : {}) as Record<string, unknown>;
  if (typeof p.enabled === "boolean") setSetting(PIPELINE_GLOBAL_KEY, p.enabled ? "1" : "0");
  const ch = p.channels;
  if (ch && typeof ch === "object" && !Array.isArray(ch)) {
    for (const [name, value] of Object.entries(ch as Record<string, unknown>)) {
      const key = PIPELINE_CHANNEL_KEYS[name as PipelineChannel];
      if (key && typeof value === "boolean") setSetting(key, value ? "1" : "0");
    }
  }
  return readPipelineSwitches();
}

// ==================== P5-2：DLNA 单设备回退 ====================
//
// D5 的配套兜底：某台设备不接受实时流（电视 / 老旧音箱）时单独给它降级，
// **不影响其它 DLNA 设备、也不影响该设备的其它行为**。同样照 D9 ——
// 回退 = 该设备出流的滤镜链为空（仍走管道），不是恢复直透。
//
// 键按设备 id 拼在设置库里（`dlna:<deviceId>` 里的 deviceId，不是 cast token）：
// 设备数量是个位数，没必要为它单开一张表；与 `pipeline.*` 同族、同一套读写缓存。

const DLNA_FALLBACK_PREFIX = "pipeline.dlna.fallback.";

/** 该 DLNA 设备键。 */
export function dlnaFallbackKey(deviceId: string): string {
  return `${DLNA_FALLBACK_PREFIX}${deviceId}`;
}

/** 该设备是否被单独回退（缺省 false = 正常走滤镜链）。 */
export function isDlnaFallback(deviceId: string | null | undefined): boolean {
  if (!deviceId) return false;
  return getSettingBool(dlnaFallbackKey(deviceId), false);
}

/** 设置/取消某设备的回退。fallback=false 时写 "0"（与缺省等价，但仍落库，便于"我确实设过"的可观测性）。 */
export function setDlnaFallback(deviceId: string, fallback: boolean): void {
  if (!deviceId) return;
  setSetting(dlnaFallbackKey(deviceId), fallback ? "1" : "0");
}

/** 该设备这一次出流是否该带滤镜链（= 通道开关开 且 未被单独回退）。 */
export function isDlnaEffectsEnabled(deviceId: string | null | undefined): boolean {
  if (!isChannelEnabled("dlna")) return false;
  return !isDlnaFallback(deviceId);
}
