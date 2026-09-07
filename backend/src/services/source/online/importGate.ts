// ==================== 导入命中门禁(import-gate) ====================
//
// 所有在线歌曲导入/匹配的统一关卡:候选必须与期望曲目「规范化标题 + 规范化歌手
// (强制,不可关)+ 专辑一致(开关,默认开)+ 时长差 ≤ 容差(可设,默认 1s)」
// 全部命中才允许导入,从源头拦截元数据冒名的假源(合辑冒名翻唱、同名异曲等)。
//
// - 规范化用 normalizeTitleStrict(中英文归一,剔除全部符号与空白)——比同曲多源组的
//   normalizeGroupText 更严:元数据侧的空格/括号/全半角写法差异全部归一,防止
//   「话 (Live)」vs「话(Live)」这类空白差异绕过比对;版本词(live/remix)同样保留。
//   core-import-gate 内置插件的「专辑一致」开关与「时长容差」,不与 songGroup 共用;
// - 标题/歌手为强制命中,无开关;期望侧缺字段(无专辑/无歌手/无时长)时对应维度
//   无从比较,不否决(有比对对象才谈命中);
// - 候选侧缺字段视为「无法核实」→ 不命中(宁可拒导,不可错导)。

import { normalizeTitleStrict } from "../../plugin/shared.js";
import { getPluginConfig } from "../../../plugins/registry.js";

export const IMPORT_GATE_PLUGIN_ID = "core-import-gate";

export interface ImportGateConfig {
  /** 专辑一致开关(默认开;与同曲多源组 albumRequired 同语义但独立配置)。 */
  albumRequired: boolean;
  /** 时长容差(秒,默认 1;非法/≤0 回落 1)。 */
  durationTolerance: number;
}

/** 期望曲目(来自歌单条目/补全请求;duration 单位:秒)。 */
export interface ImportGateWant {
  title: string;
  artist?: string | null;
  album?: string | null;
  duration?: number | null;
}

/** 候选歌曲(来自在线源搜索;duration 单位:秒)。 */
export interface ImportGateCandidate {
  name: string;
  artist?: string | null;
  album?: string | null;
  duration?: number | null;
}

export interface ImportGateResult {
  ok: boolean;
  /** 首个未命中的维度(调试/日志用)。 */
  reason?: "title" | "artist" | "album" | "duration";
  detail?: string;
}

/** 读取门禁配置(core-import-gate 插件配置;未配置时取默认值)。 */
export function getImportGateConfig(): ImportGateConfig {
  const cfg = (getPluginConfig(IMPORT_GATE_PLUGIN_ID) || {}) as Record<string, unknown>;
  const tol = Number(cfg.durationTolerance);
  return {
    albumRequired: cfg.albumRequired !== false,
    durationTolerance: Number.isFinite(tol) && tol > 0 ? tol : 1,
  };
}

/** 歌手 token 化:合并歌手「A、B」拆分为规范化 token 集合(与 match.ts 同口径)。 */
function artistTokens(artist: string | null | undefined): string[] {
  return (artist || "")
    .split(/[/、&,；;，.&]|feat\.|ft\./i)
    .map((s) => normalizeTitleStrict(s))
    .filter(Boolean);
}

/**
 * 门禁判定:标题 + 歌手(强制)+ 专辑(开关)+ 时长(容差)全命中才放行。
 *
 * 维度语义:
 * - 标题:规范化后全串相等(括号内后缀词保留,与同曲多源组一致);
 * - 歌手:期望 token 全部能在候选 token 中命中(相等或互为包含;合并歌手兼容)。
 *   期望侧无歌手 → 该维度跳过;
 * - 专辑:开关开且期望侧有专辑时,候选专辑必须规范化相等;候选无专辑 = 无法核实 → 不命中;
 * - 时长:期望侧有时长时,候选必须有时长且 |差| ≤ 容差;候选无时长 = 无法核实 → 不命中。
 */
export function passesImportGate(
  want: ImportGateWant,
  cand: ImportGateCandidate,
  cfgOverride?: ImportGateConfig,
): ImportGateResult {
  const cfg = cfgOverride ?? getImportGateConfig();

  // 1. 标题(强制):规范化全串相等。
  const nt = normalizeTitleStrict(want.title || "");
  const nc = normalizeTitleStrict(cand.name || "");
  if (!nt || nt !== nc) {
    return { ok: false, reason: "title", detail: `标题不一致 want="${want.title}" cand="${cand.name}"` };
  }

  // 2. 歌手(强制,期望侧有歌手时):全部 token 命中。
  const wantArtists = artistTokens(want.artist);
  if (wantArtists.length > 0) {
    const candArtists = artistTokens(cand.artist);
    const allHit = wantArtists.every((a) =>
      candArtists.some((ca) => a === ca || a.includes(ca) || ca.includes(a)));
    if (!allHit) {
      return { ok: false, reason: "artist", detail: `歌手不一致 want="${want.artist}" cand="${cand.artist}"` };
    }
  }

  // 3. 专辑(开关,默认开;期望侧有专辑时必须核实)。
  if (cfg.albumRequired) {
    const wantAlbum = normalizeTitleStrict(want.album || "");
    if (wantAlbum) {
      const candAlbum = normalizeTitleStrict(cand.album || "");
      if (!candAlbum) {
        return { ok: false, reason: "album", detail: "候选无专辑,无法核实" };
      }
      if (candAlbum !== wantAlbum) {
        return { ok: false, reason: "album", detail: `专辑不一致 want="${want.album}" cand="${cand.album}"` };
      }
    }
  }

  // 4. 时长(期望侧有时长时必须核实;未知时长不可放过)。
  const wantDur = Number(want.duration || 0);
  if (wantDur > 0) {
    const candDur = Number(cand.duration || 0);
    if (candDur <= 0) {
      return { ok: false, reason: "duration", detail: "候选无时长,无法核实" };
    }
    if (Math.abs(candDur - wantDur) > cfg.durationTolerance) {
      return {
        ok: false,
        reason: "duration",
        detail: `时长超容差 want=${wantDur}s cand=${candDur}s tolerance=${cfg.durationTolerance}s`,
      };
    }
  }

  return { ok: true };
}
