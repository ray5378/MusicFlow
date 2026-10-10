// ==================== 聚合源「平台标识 / extra 档位」语义字典 ====================
//
// 📌 为什么放在插件层（`src/services/plugin/`）而不是 fetch 目录里：
//   按核心插件化规范（`backend/scripts/check-core.mts` **规则 A**），**平台/provider 标识
//   只应存在于插件体系里**，核心代码不得出现硬编码平台名。而 fetch 取链看到的 `platform`
//   与 `extra` **全部来自聚合源插件的返回值**（go-music-dl 的 `data-extra` 里带各平台的
//   hash 阶梯，migu 的 `format_type`）——它们是**插件侧载荷**，解读它们所需的字典自然
//   归插件层所有；核心只做「查字典」这一件事，不写死任何平台判断。
//
// 📌 维护约定：新增平台、或某平台改了 extra 键名 → **只改本文件**；
//   核心 `services/fetch/candidates.ts` 零改动（只 import 下面两个函数）。
//
// 📌 TODO（能力化，终局形态）：最终应由聚合源插件经新 capability 直接声明
//   「extra → 档位」映射（核心经 `services/pluginAccess` 门面调用），本字典降级为
//   内置兜底。该改动要同步 `plugins/types.ts` / `plugins/discovery.ts` /
//   `plugins/sandbox.ts` / 插件仓 `check.mjs` **四处**并联动插件版本发布，故本批
//   先完成「平台知识与核心解耦」这一步，对外函数签名保持稳定。
//
// 依赖：只依赖 fetch 的**纯类型**（`services/fetch/types.ts` 无逻辑、无循环依赖）。
import type { CandidateQuality } from "../fetch/types.js";

/** platform slug 归一化：聚合源给长名（netease/qq/kugou/...），Candidate.platform 用短码。 */
const PLATFORM_ALIAS: Record<string, string> = {
  netease: "wy",
  qq: "qq",
  kugou: "kg",
  kuwo: "kw",
  migu: "mg",
  bilibili: "bili",
  ximalaya: "xmly",
};

/** 平台标识归一化：长名 → 短码；未知平台原样返回（小写、去空白）。 */
export function normalizePlatform(raw: string | undefined | null): string {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return "";
  return PLATFORM_ALIAS[s] ?? s;
}

/** 取 extra 里第一个「有非空值」的键（键名大小写不敏感，忽略空白值）。 */
function extraStr(extra: Record<string, string> | undefined, ...keys: string[]): string | undefined {
  if (!extra || typeof extra !== "object") return undefined;
  const byLower = new Map<string, string>();
  for (const k of Object.keys(extra)) byLower.set(k.toLowerCase(), k);
  for (const want of keys) {
    const k = byLower.get(want.toLowerCase());
    if (k === undefined) continue;
    const v = (extra as Record<string, unknown>)[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

/**
 * hash 阶梯平台的档位（240 实测 extra 键）：
 *   sq_hash（无损 flac） > hq_hash / res_hash / ogg_320_hash（320） > hash / file_hash / ogg_128_hash（128）。
 * `privilege === "0"`（版权受限）→ 高档位实际取不到，阶梯封顶到 128。
 * 容器只在「证据全部来自 ogg_*_hash」时才判 ogg，否则按 mp3（**不猜 flac/ape**）。
 */
function hashLadderQuality(extra: Record<string, string>): CandidateQuality | undefined {
  const sq = extraStr(extra, "sq_hash");
  const hi320 = extraStr(extra, "hq_hash", "res_hash");
  const ogg320 = extraStr(extra, "ogg_320_hash");
  const mid = extraStr(extra, "hash", "file_hash");
  const ogg128 = extraStr(extra, "ogg_128_hash");
  const capped = extraStr(extra, "privilege") === "0";
  if (sq && !capped) return { container: "flac" };
  if ((hi320 || ogg320) && !capped) return { container: hi320 ? "mp3" : "ogg", bitrateKbps: 320 };
  if (mid || ogg128) return { container: mid ? "mp3" : "ogg", bitrateKbps: 128 };
  if (sq || hi320 || ogg320) return { container: "mp3", bitrateKbps: 128 }; // privilege=0 封顶
  return undefined;
}

/**
 * `format_type` 档位平台：ZQ（母带级）/ SQ（无损）/ HQ（高品）/ 其余（标准）。
 * ⚠️ 平台只给档位**标签**、不给位深/采样率，这里按标签语义声明（ZQ 按 24bit、SQ 按 16bit
 * 无损）；**真实值由 inspect / 下载后探针覆盖**，此处仅用于预排序与预筛。
 */
function formatTypeLadderQuality(extra: Record<string, string>): CandidateQuality | undefined {
  const t = (extraStr(extra, "format_type") ?? "").toUpperCase();
  if (!t) return undefined;
  if (t === "ZQ") return { container: "flac", bitDepth: 24 };
  if (t === "SQ") return { container: "flac", bitDepth: 16 };
  if (t === "HQ") return { container: "mp3", bitrateKbps: 320 };
  return { container: "mp3", bitrateKbps: 128 };
}

/**
 * 从信源 `extra` 推「可得档位」（纯函数，零网络）。
 *
 * 派发**优先按 extra 的键形状**，平台名只作兜底——平台的 extra 载荷自带特征键
 * （`format_type` / `sq_hash` 阶梯），形状识别比平台名更稳：平台名有长名/短码/大小写
 * 多种写法（且聚合源可能改口），而键名是**载荷契约**。两条通路都认不出时返回
 * `undefined`：**不给信息就是不猜**，交给 inspect 或下载后探针复核。
 */
export function declaredFromExtra(
  platform: string,
  extra?: Record<string, string> | null,
): CandidateQuality | undefined {
  if (!extra || typeof extra !== "object") return undefined;
  const keys = new Set(Object.keys(extra).map((k) => k.toLowerCase()));
  if (keys.has("format_type")) return formatTypeLadderQuality(extra);
  if (keys.has("sq_hash") || keys.has("hq_hash") || keys.has("res_hash") || keys.has("ogg_128_hash")) {
    return hashLadderQuality(extra);
  }
  const p = String(platform ?? "").trim().toLowerCase();
  if (p === "kugou" || p === "kg") return hashLadderQuality(extra);
  if (p === "migu" || p === "mg") return formatTypeLadderQuality(extra);
  return undefined;
}
