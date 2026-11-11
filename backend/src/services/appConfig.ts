// ==================== 应用级可运营配置 ====================
//
// 这些值原先只能写在 docker-compose 的 environment 里,改一次要重建容器。
// 现在统一走「设置表优先 + 环境变量兜底」:前端「系统设置 → 服务配置」改完即时生效。
// 为什么单独一个模块而不是塞进 utils/env:CORS 中间件在启动时就装配,env 又被 db 依赖,
// 若 env 反向 import settings(→db)会形成循环;这里从上层汇总,不参与 db 初始化链。
import { getSetting, setSetting } from "./settings.js";
import { getCorsOrigins, getPlayHistoryRetentionDays } from "../utils/env.js";

/** 跨域来源白名单(JSON 数组串)。空数组 = 反射请求方 Origin。 */
export const CORS_ORIGINS_KEY = "app.corsOrigins";
/** 播放记录保留天数(0 = 不清理)。 */
export const PLAY_HISTORY_RETENTION_KEY = "app.playHistoryRetentionDays";

export function corsOrigins(): string[] {
  const raw = getSetting(CORS_ORIGINS_KEY, "");
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr.map((x) => String(x).trim()).filter(Boolean);
    } catch {
      /* 历史值可能是逗号串 */
    }
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return getCorsOrigins();
}

export function playHistoryRetentionDays(): number {
  const raw = getSetting(PLAY_HISTORY_RETENTION_KEY, "");
  if (raw !== "") {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return getPlayHistoryRetentionDays();
}

export interface AppConfigPatch {
  corsOrigins?: unknown;
  playHistoryRetentionDays?: unknown;
}

/**
 * 保存服务配置并回读生效值。
 * 白名单只接受 `*` 与 http(s) 来源(其余丢弃,避免写成任意串导致 CORS 静默失效);
 * 保留天数夹在 0..3650。
 */
export function saveAppConfig(input: AppConfigPatch): { corsOrigins: string[]; playHistoryRetentionDays: number } {
  const out = { corsOrigins: corsOrigins(), playHistoryRetentionDays: playHistoryRetentionDays() };
  if (input.corsOrigins !== undefined) {
    const raw = Array.isArray(input.corsOrigins)
      ? input.corsOrigins
      : String(input.corsOrigins).split(/[\n,]/);
    const list = raw
      .map((s) => String(s).trim())
      .filter(Boolean)
      .filter((s) => s === "*" || /^https?:\/\/[^\s]+$/i.test(s));
    out.corsOrigins = Array.from(new Set(list));
    setSetting(CORS_ORIGINS_KEY, JSON.stringify(out.corsOrigins));
  }
  if (input.playHistoryRetentionDays !== undefined) {
    const n = Number(input.playHistoryRetentionDays);
    if (Number.isFinite(n)) {
      out.playHistoryRetentionDays = Math.min(3650, Math.max(0, Math.floor(n)));
      setSetting(PLAY_HISTORY_RETENTION_KEY, String(out.playHistoryRetentionDays));
    }
  }
  return out;
}
