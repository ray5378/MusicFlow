// MusicFetch 任务列表 / 任务详情共用的展示辅助（全部是纯函数，无状态）。
//
// 为什么抽成独立模块：「下载任务」与「洗版任务」现在是两个独立的列表面板组件
// （JobListPanel.vue 复用两份）。若各自在 `<script setup>` 里各留一套「状态码 → 文案」
// 映射，迟早会漂移 —— 一边补了新错误码、另一边忘了补，用户就又看到裸码
// （COOLDOWN_SKIPPED 就是这么漏出来的）。共用一份是唯一能防住这件事的写法。
import type { FetchChosen } from "@/api/fetch";

/** 仍在推进的状态：只有这两个算「任务没结束」。 */
export const ACTIVE_STATUS = ["pending", "running"] as const;

export function isActiveStatus(s?: string): boolean {
  return !!s && (ACTIVE_STATUS as readonly string[]).includes(s);
}

/** 状态码 → i18n key（admin.fetch.status.*）。 */
export const STATUS_KEY: Record<string, string> = {
  pending: "pending",
  running: "running",
  done: "done",
  partial: "partial",
  cancelled: "cancelled",
  failed: "failed",
  queued: "queued",
  probing: "probing",
  downloading: "downloading",
  verifying: "verifying",
  tagging: "tagging",
  transcoding: "transcoding",
  moving: "moving",
  scanned: "scanned",
  skipped: "skipped",
  downloadable: "downloadable",
  belowBar: "belowBar",
  noCandidate: "noCandidate",
};

/** 失败原因码 → i18n key（admin.fetch.errorCode.*）。**新增后端错误码必须同步这里**。 */
export const ERROR_CODE_KEY: Record<string, string> = {
  NO_CANDIDATE: "noCandidate",
  BELOW_BAR: "belowBar",
  COOLDOWN_SKIPPED: "cooldownSkipped",
  ALREADY_IN_LIBRARY: "alreadyInLibrary",
  DUPLICATE_TARGET: "duplicateTarget",
  FAKE_LOSSLESS: "fakeLossless",
  INTEGRITY_FAILED: "integrityFailed",
  HTTP_403: "http403",
  TIMEOUT: "timeout",
  STALL: "stall",
  TAG_FAILED: "tagFailed",
  TRANSCODE_FAILED: "transcodeFailed",
  DISK_FULL: "diskFull",
  MOVE_FAILED: "moveFailed",
  SCAN_FAILED: "scanFailed",
  SSRF_BLOCKED: "ssrfBlocked",
  UNKNOWN: "unknown",
};

/** 任务类型（kind）→ i18n key（admin.fetch.kind.*）。 */
export const KIND_KEY: Record<string, string> = {
  search: "search",
  library: "library",
  upgrade: "upgrade",
  retry: "retry",
  manual: "manual",
};

/** vue-i18n 的 `t` 在这里只需「键 → 文案」这一种用法。 */
export type TFn = (key: string, ...args: any[]) => string;

export function statusText(t: TFn, s?: string): string {
  if (!s) return "-";
  const k = STATUS_KEY[s];
  return k ? t(`admin.fetch.status.${k}`) : s;
}

export function statusTagType(s?: string): "success" | "info" | "warning" | "danger" {
  if (!s) return "info";
  if (["done", "scanned", "downloadable"].includes(s)) return "success";
  if (["failed", "partial"].includes(s)) return "danger";
  if (
    ["running", "probing", "downloading", "verifying", "tagging", "transcoding", "moving", "belowBar"].includes(s)
  ) {
    return "warning";
  }
  return "info";
}

/** 失败原因码 → 文案（按码给文案，**绝不裸显码**）。 */
export function errorText(t: TFn, code?: string): string {
  if (!code) return "";
  const k = ERROR_CODE_KEY[code];
  if (k) return t(`admin.fetch.errorCode.${k}`);
  const sk = STATUS_KEY[code];
  return sk ? t(`admin.fetch.status.${sk}`) : code;
}

/** 任务类型 → 文案。 */
export function kindText(t: TFn, k?: string): string {
  if (!k) return "-";
  const key = KIND_KEY[k];
  return key ? t(`admin.fetch.kind.${key}`) : k;
}

export function shortId(id?: string): string {
  if (!id) return "-";
  return id.length > 10 ? id.slice(0, 8) + "..." : id;
}

export function formatBytes(n?: number): string {
  if (!n || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatDateTime(v?: string | number): string {
  if (!v) return "-";
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function jobDuration(job: { startedAt?: string | number; createdAt?: string | number; finishedAt?: string | number }): string {
  const start = job.startedAt || job.createdAt;
  const end = job.finishedAt;
  if (!start || !end) return "-";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!isFinite(ms) || ms < 0) return "-";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function sourceText(chosen?: FetchChosen): string {
  if (!chosen) return "-";
  return chosen.platform || chosen.pluginId || "-";
}

export function qualityText(chosen?: FetchChosen): string {
  if (!chosen) return "-";
  const p = chosen.probed ?? chosen.declared;
  const parts: string[] = [];
  if (p && typeof p === "object") {
    if (p.codec) parts.push(String(p.codec));
    if (p.bitrateKbps) parts.push(`${p.bitrateKbps} kbps`);
    if (p.sampleRateHz) parts.push(`${p.sampleRateHz} Hz`);
    if (p.bitDepth) parts.push(`${p.bitDepth} bit`);
  } else if (typeof p === "string" && p) {
    parts.push(p);
  }
  return parts.length ? parts.join(" / ") : "-";
}

/** 洗版结果里的 replaced 字段容错展示（形状可能缺字段）。 */
export function replacedText(r: any): string {
  if (!r || typeof r !== "object") return "";
  const from = r.originalPath || "";
  const to = r.newPath || r.movedTo || "";
  if (from && to) return `${from} -> ${to}`;
  return to || from || "";
}
