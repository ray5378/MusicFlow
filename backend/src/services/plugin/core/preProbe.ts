// ==================== Core plugin: 预探测(core-pre-probe) ====================
// 服务端内置行为插件(端侧零改动,可随时开关),config-only——与 core-stream-fallback /
// core-play-preference 同模式:
// **只提供配置面,逻辑留在核心**(services/player/QueueController.ts 的预探测调度器)。
//
// 它解决的问题:投屏时"下一首能不能播"此前完全没人提前看 —— 链路 A 完全不预探,
// 链路 B 只在投递那一瞬间探当前一首。结果播到死源才阻塞探测,音箱长时间不出声。
//
// 预探测在每次"触碰队列"后(起播/切歌/队列增删改序/改模式/重洗牌)向前扫描,
// 凑够 N 首「已确认可播」的歌填进滑动缓冲,投递时零等待。
//
// 为什么不做成沙箱插件:沙箱有超时与权限模型,且取不到 QueueController 的队列内存
// 结构,无法做"随队列变动持续预探测"。故按既有 core 插件惯例:配置在插件,逻辑在核心。
import type { PluginManifest } from "../../../plugins/types.js";
import type { PluginHost } from "../../../plugins/host.js";
import { getPluginConfig, isCapabilityEnabled } from "../../../plugins/registry.js";
// ⚠️ 本模块**不得**静态 import streamFallback 等会回到 registry/builtins 的重模块。
// 实测:一旦静态 import streamFallback,就形成
//   preProbe → streamFallback → registry → builtins → preProbe
// 的静态循环,本模块的 manifest 会被拖进 TDZ —— 直接 import 本模块即报
//   "Cannot access 'preProbeManifest' before initialization"
// (而 playPreference 因为只 import registry,不受影响)。
// 故 negativeTtlSeconds 的实际应用交给核心调用方:
//   import { readPreProbeConfig } from ".../core/preProbe.js";
//   import { configureStreamFallbackCache } from ".../source/online/streamFallback.js";
//   const cfg = readPreProbeConfig();
//   configureStreamFallbackCache({ negativeTtlMs: cfg.negativeTtlSeconds * 1000 });
// 缓存本身有默认 45s,即使从未同步也不会退回"永久拉黑"。

export const PRE_PROBE_PLUGIN_ID = "core-pre-probe";

export const preProbeManifest: PluginManifest = {
  id: PRE_PROBE_PLUGIN_ID,
  name: "预探测(提前找可播源)",
  version: "1.0.0",
  type: "core",
  description:
    "在队列变动后提前向前扫描,凑够若干首「已确认有可用音源」的歌填进滑动缓冲,使投屏/本机播放切歌时无需等待探测;连续多首探不到可用源时判定队列大面积无源并暂停预探测一段时间。本插件提供窗口大小、扫描与冷却参数,预探测逻辑本身在核心。",
  capabilities: ["preProbe"],
  defaultEnabled: true,
  configSchema: [
    { key: "enabled", label: "预探测", type: "switch", default: true, help: "开启后,队列变动时提前扫描后续歌曲是否有可用音源,使切歌零等待。关闭则退回「投递时才探测」的原有行为" },
    { key: "lookaheadSongs", label: "前方保持可播首数 (N)", type: "number", default: 3, help: "前方始终保持多少首「已确认可播」的歌。范围 1-5,默认 3" },
    { key: "deadRunLimit", label: "连续无源上限 (M)", type: "number", default: 50, help: "连续多少首探不到可用音源即判定「队列大面积无源」;中途命中一首可播的歌即归零重数。范围 2-200,默认 50" },
    { key: "exhaustedCooldownSeconds", label: "大面积无源后暂停(秒)", type: "number", default: 90, help: "判定大面积无源后暂停预探测多久(避免反复深扫把上游刷爆)。范围 0-600,0 = 不暂停。默认 90" },
    { key: "probeTimeoutMs", label: "预探测单曲超时(毫秒)", type: "number", default: 5000, help: "预探测路径的单曲探测超时(不阻塞播放,可比流播路径更短)。范围 1000-30000,默认 5000。流播路径仍用 12 秒,不受此项影响" },
    { key: "probeCooldownSeconds", label: "同曲探测冷却(秒)", type: "number", default: 60, help: "同一首歌两次「真实探测」的最小间隔,防止探测风暴。范围 0-600,0 = 不限制。默认 60。建议不小于「探不到记住时长」" },
    { key: "windowMinutes", label: "向前覆盖时长(分钟)", type: "number", default: 8, help: "预探测向前覆盖的时间上限(分钟),与「前方保持可播首数」取更小者。避免一首长歌把窗口撑出音源直链有效期。范围 1-60,默认 8" },
    { key: "negativeTtlSeconds", label: "探不到记住时长(秒)", type: "number", default: 45, help: "「探不到可用音源」这个判断的有效期(秒),过期即重新探测 —— 音源恢复后自动复活。范围 10-600,默认 45" },
    { key: "concurrency", label: "并发探测数", type: "number", default: 3, help: "每波同时探测几首。范围 1-5,默认 3" },
  ],
  // 插件侧 i18n 字典:默认文案即中文,故 zh 省略、只补 en。前端按当前界面语言取用。
  i18n: {
    en: {
      name: "Pre-probe (find playable sources ahead)",
      description:
        "After the queue changes, scans ahead to fill a sliding buffer with songs that are confirmed to have a playable source, so casting/playback never waits on probing. When many consecutive songs have no playable source it reports a queue-wide source outage and pauses pre-probing for a while. This plugin provides the window/scan/cooldown parameters; the pre-probe logic itself lives in the core.",
      documentation: `### Pre-probe (built-in)
When the queue changes (start / track change / reorder / mode change / reshuffle), the server scans ahead to collect **N songs confirmed to have a playable source** into a sliding buffer, so switching tracks never waits for a probe.

- **Lookahead songs (N)**: how many confirmed-playable songs to keep ahead (1-5, default 3).
- **Consecutive-miss limit (M)**: how many consecutive unplayable songs count as a queue-wide outage; a single playable hit resets the counter (2-200, default 50).
- **Cooldown after outage**: how long to pause pre-probing after an outage is detected (0-600s, 0 = no pause, default 90).
- **Probe timeout / cooldown**: per-song probe timeout for the pre-probe path only (the streaming path keeps 12s), and the minimum interval between two real probes of the same song.
- **Window minutes**: time-based cap on how far ahead to cover; the smaller of it and N wins.
- **Negative TTL**: how long a "no playable source" result is remembered (10-600s, default 45) — the source revives automatically after it expires.
- **Concurrency**: how many probes run in parallel per wave (1-5, default 3).

Unplayable songs are **never removed from the queue and never blacklisted**; they are only skipped at play time while the result is fresh.`,
      fields: {
        enabled: {
          label: "Pre-probe",
          help: "When on, the server scans ahead after queue changes so track switches are instant. When off, it falls back to probing at delivery time.",
        },
        lookaheadSongs: {
          label: "Lookahead songs (N)",
          help: "How many confirmed-playable songs to keep ahead. Range 1-5, default 3.",
        },
        deadRunLimit: {
          label: "Consecutive-miss limit (M)",
          help: "How many consecutive unplayable songs count as a queue-wide outage; one playable hit resets it. Range 2-200, default 50.",
        },
        exhaustedCooldownSeconds: {
          label: "Pause after outage (seconds)",
          help: "How long to pause pre-probing after an outage is detected. Range 0-600, 0 = never pause. Default 90.",
        },
        probeTimeoutMs: {
          label: "Pre-probe per-song timeout (ms)",
          help: "Per-song probe timeout on the pre-probe path only (it does not block playback, so it can be shorter). Range 1000-30000, default 5000. The streaming path still uses 12s.",
        },
        probeCooldownSeconds: {
          label: "Same-song probe cooldown (seconds)",
          help: "Minimum interval between two real probes of the same song, to avoid probe storms. Range 0-600, 0 = no limit. Default 60.",
        },
        windowMinutes: {
          label: "Time cover ahead (minutes)",
          help: "Time-based cap on how far ahead to cover; the smaller of it and the lookahead count wins. Range 1-60, default 8.",
        },
        negativeTtlSeconds: {
          label: "Remember 'no source' for (seconds)",
          help: "How long a 'no playable source' result stays valid; it is re-probed after that, so the song revives automatically once a source is back. Range 10-600, default 45.",
        },
        concurrency: {
          label: "Probe concurrency",
          help: "How many songs are probed in parallel per wave. Range 1-5, default 3.",
        },
      },
    },
  },
  documentation: `### 预探测(服务端内置)
队列变动后(起播 / 切歌 / 增删改序 / 改播放模式 / 重洗牌)向前扫描,把 **N 首「已确认有可用音源」**的歌填进滑动缓冲,使切歌时无需等待探测。

- **前方保持可播首数 (N)**:前方始终保持几首已确认可播(1-5,默认 3);
- **连续无源上限 (M)**:连续多少首探不到源才算「队列大面积无源」,命中一首可播即归零重数(2-200,默认 50);
- **大面积无源后暂停**:判定后暂停预探测多久(0-600 秒,0 = 不暂停,默认 90);
- **预探测单曲超时 / 同曲冷却**:前者只作用于预探测路径(流播路径仍 12 秒),后者限制同一首歌两次真实探测的最小间隔;
- **向前覆盖时长**:按时间封顶扫描范围,与 N 取更小者;
- **探不到记住时长**:负结果有效期(10-600 秒,默认 45),过期即重新探测 —— **音源恢复自动复活**;
- **并发探测数**:每波并行探测几首(1-5,默认 3)。

不可播的歌**既不摘除队列、也不拉黑**,只在判定仍有效时于播放时跳过。`,
};

/** 预探测的完整配置(已 clamp,可直接使用)。 */
export interface PreProbeConfig {
  enabled: boolean;
  /** N:前方保持几首「已确认可播」。 */
  lookaheadSongs: number;
  /** M:连续多少首探不到源即判定枯竭(命中一首可播即归零重数)。 */
  deadRunLimit: number;
  /** 枯竭后冷却秒数;0 = 不冷却。 */
  exhaustedCooldownSeconds: number;
  /** 预探测路径的单曲探测超时(毫秒);流播路径不受影响。 */
  probeTimeoutMs: number;
  /** 同一首歌两次真实探测的最小间隔秒数;0 = 不限制。 */
  probeCooldownSeconds: number;
  /** 向前覆盖的时间上限(分钟),与 lookaheadSongs 取更小者。 */
  windowMinutes: number;
  /** 负结果(探不到)的有效期秒数。 */
  negativeTtlSeconds: number;
  /** 每波并发探测数。 */
  concurrency: number;
}

export const PRE_PROBE_DEFAULTS: PreProbeConfig = {
  enabled: true,
  lookaheadSongs: 3,
  deadRunLimit: 50,
  exhaustedCooldownSeconds: 90,
  probeTimeoutMs: 5000,
  probeCooldownSeconds: 60,
  windowMinutes: 8,
  negativeTtlSeconds: 45,
  concurrency: 3,
};

/** clamp 到 [min, max];非有限数字回落 fallback。 */
function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * 读取并 clamp 预探测配置(唯一真源)。
 *
 * **必须 clamp**:`ConfigField` 没有 min/max/step,数值落库是什么就是什么
 * (与 streamFallback 读 durationTolerance 同一约定)。
 *
 * **纯函数、无副作用**:`negativeTtlSeconds` 的实际应用由核心调用方负责
 * (本模块不能静态 import streamFallback,见文件头注释)。
 */
export function readPreProbeConfig(host?: PluginHost | null): PreProbeConfig {
  const raw = (host?.config || getPluginConfig(PRE_PROBE_PLUGIN_ID) || {}) as Record<string, unknown>;
  return {
    enabled: raw.enabled !== false,
    lookaheadSongs: num(raw.lookaheadSongs, PRE_PROBE_DEFAULTS.lookaheadSongs, 1, 5),
    // M 的下限是 2:M=1 会在遇到任意一首无源时立刻判定枯竭,等于把预探测关掉。
    deadRunLimit: num(raw.deadRunLimit, PRE_PROBE_DEFAULTS.deadRunLimit, 2, 200),
    // 冷却 0 是合法值(不冷却),故下限为 0。
    exhaustedCooldownSeconds: num(raw.exhaustedCooldownSeconds, PRE_PROBE_DEFAULTS.exhaustedCooldownSeconds, 0, 600),
    probeTimeoutMs: num(raw.probeTimeoutMs, PRE_PROBE_DEFAULTS.probeTimeoutMs, 1000, 30000),
    // 同曲冷却 0 也是合法值(不限制)。
    probeCooldownSeconds: num(raw.probeCooldownSeconds, PRE_PROBE_DEFAULTS.probeCooldownSeconds, 0, 600),
    windowMinutes: num(raw.windowMinutes, PRE_PROBE_DEFAULTS.windowMinutes, 1, 60),
    negativeTtlSeconds: num(raw.negativeTtlSeconds, PRE_PROBE_DEFAULTS.negativeTtlSeconds, 10, 600),
    concurrency: num(raw.concurrency, PRE_PROBE_DEFAULTS.concurrency, 1, 5),
  };
}

/** 插件总开关:预探测是否启用(核心调度器靠此门面读取)。 */
export function preProbeActive(): boolean {
  return isCapabilityEnabled("preProbe");
}

export const preProbePlugin = {
  readConfig: readPreProbeConfig,
};
