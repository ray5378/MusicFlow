// ==================== 起播 TTFB 探针配置(settings 表,前端「媒体获取」页可开关) ====================
//
// 2026-10-13 用户拍板:「设置里加个探针开关,默认关闭,用户可以随时开关它」。
// 与 prefetchConfig 同范式:settings 表单键 `stream.probe.settings`(JSON 全量快照),
// 读优先级 **settings(UI 保存过) > env > 默认**;PUT 为**合并**语义。
//
// 默认**关闭**:探针是金丝雀(空闲时段上游/取链健康的心跳,见 streamProbe.ts 头部),
// 不是播放链路的一环 —— 开不开完全由用户决定。env `STREAM_PROBE_ENABLED=1` 仅在
// 「从没在 UI 保存过」时兜底开启(部署期注入用);一旦 UI 保存过该字段,以 UI 为准
// (避免「运维注入了 env、用户在 UI 关了没效果」的割裂,与 prefetchConfig 同纪律)。
// 歌曲同此机制:`STREAM_PROBE_SONG_ID=<songId>` 在 UI 从没保存过时充当初始探测歌曲
// (仅开=1 而无歌时,开启请求会被 setStreamProbeSettings 以 i18n 键拒绝)。
//
// 探针歌曲必须**钉死具体 songId**(用户在 UI 选):自动选歌会悄悄换测量对象、
// 源死了天天误报 —— 这是生产卫生条件,不是 UI 简化问题。因此开启前必须已有歌曲。

import { getSetting, setSetting } from "../settings.js";

/** settings 表键(与 prefetch.settings 等其它设置键隔离)。 */
export const STREAM_PROBE_SETTINGS_KEY = "stream.probe.settings";

export interface StreamProbeSettings {
  /** 探针总开关。默认 false(用户显式开启才跑)。 */
  enabled: boolean;
  /** 探针歌曲 id(库内 songId)。空 = 未选定(开启会被拒绝)。 */
  songId: string;
}

/** 读当前生效配置。settings 无记录(或坏 JSON)⇒ 逐字段回落 env/默认(全关)。 */
export function getStreamProbeSettings(): StreamProbeSettings {
  const raw = getSetting(STREAM_PROBE_SETTINGS_KEY, "");
  let saved: Record<string, unknown> | null = null;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) saved = parsed as Record<string, unknown>;
    } catch {
      /* 坏 JSON ⇒ 当作没保存过,回落 env/默认 */
    }
  }
  const enabled = typeof saved?.enabled === "boolean"
    ? saved.enabled
    : process.env.STREAM_PROBE_ENABLED === "1";
  const songId = typeof saved?.songId === "string" && saved.songId.trim()
    ? saved.songId.trim()
    : (process.env.STREAM_PROBE_SONG_ID || "").trim();
  return { enabled, songId };
}

export type SetProbeResult =
  | { ok: true; settings: StreamProbeSettings }
  | { ok: false; error: string };

/**
 * 合并式保存:只改 patch 里带上来的字段,其余保持现值。
 * `enabled=true` 但合并后选不出歌曲 ⇒ 拒绝(返回 i18n 键,路由层转 400)——
 * 没有钉死的测量对象,探针就只是噪声源(见文件头)。
 */
export function setStreamProbeSettings(patch: unknown): SetProbeResult {
  const cur = getStreamProbeSettings();
  const p = (patch && typeof patch === "object" ? patch as Record<string, unknown> : {}) as Record<string, unknown>;
  const next: StreamProbeSettings = { ...cur };
  if (typeof p.enabled === "boolean") next.enabled = p.enabled;
  if (typeof p.songId === "string") next.songId = p.songId.trim();
  if (next.enabled && !next.songId) {
    return { ok: false, error: "errors.streamProbe.songRequired" };
  }
  setSetting(STREAM_PROBE_SETTINGS_KEY, JSON.stringify(next));
  return { ok: true, settings: next };
}

/** 恢复默认(删记录 ⇒ 回落 env/默认:关、无歌曲)。供测试复用。 */
export function resetStreamProbeSettings(): StreamProbeSettings {
  setSetting(STREAM_PROBE_SETTINGS_KEY, "");
  return getStreamProbeSettings();
}
