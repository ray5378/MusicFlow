// 自动生成 —— 由 index.ts 物理拆分而来（dailyRecommend 域，4 条路由）。零逻辑改动。
import type { Hono } from "hono";
import {
  BusinessErrorCode,
  adminMiddleware,
  and,
  apiError,
  count,
  dailyApi,
  dailyRecommendTag,
  formatDailyTime,
  like,
  log,
  or,
  playlists,
  rearmDailyScheduler,
  sqlite,
  translate,
} from "./shared.js";

export function registerDailyRecommend(app: Hono): void {
app.get("/v1/daily-recommend", adminMiddleware, (c) => {
  const get = (k: string, def: string) => {
    const r = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(k) as any;
    return r?.value ?? def;
  };
  const getBool = (k: string, def: boolean) => {
    const v = get(k, def ? "true" : "false");
    return v === "true" || v === "1";
  };
  const candidates = dailyApi()?.loadCandidates() ?? [];
  const picked = dailyApi()?.pickDailyCandidate() ?? null;

  // Only ONE playlist ever exists: 「每日推荐」(combined: remote charts + user
  // pool, all merged into one).
  const today = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();
  const findPl = (name: string, tag: string) =>
    sqlite.prepare("SELECT id, name, song_count, created_at, comment FROM playlists WHERE name = ? AND comment LIKE ?").get(name, `%${tag}%`) as any;

  const todayPl = findPl(dailyRecommendTag() || "每日推荐", dailyRecommendTag() || "每日推荐");

  const plInfo = (row: any) => row ? {
    id: row.id, name: row.name, songCount: row.song_count || 0,
    // The daily generator stamps the generation date into the playlist's
    // comment (created_at is now fixed, since the playlist row is reused), so
    // "generated today" is detected from the comment, not created_at.
    createdToday: (row.comment || "").includes(today),
  } : null;

  return c.json({
    enabled: getBool("daily_recommend_enabled", true),
    hour: parseInt(get("daily_recommend_hour", "3"), 10) || 3,
    time: formatDailyTime(),
    candidates,
    pickedToday: picked,
    today,
    playlists: {
      today: plInfo(todayPl),
    },
  });
});

// Update daily-recommend config (master switch + schedule time).
// - `time`: "HH:MM"(新,可到分钟),写入 daily_recommend_time;
// - `hour`: 0-23 整点(旧客户端兼容),等价于把 time 设为 "HH:00";
// - 任一变更成功后立即 rearm,让下一次执行按新时刻重排(不必等 24h)。
// Note: retention is no longer used — only one "每日推荐" playlist exists and
// each run rebuilds it in place.

app.put("/v1/daily-recommend/config", adminMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const set = (k: string, v: string) =>
    sqlite.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run(k, v, new Date().toISOString());
  let changed = false;
  if (typeof body.enabled === "boolean") {
    set("daily_recommend_enabled", body.enabled ? "true" : "false");
    changed = true;
  }
  if (typeof body.time === "string" && /^([01]?\d|2[0-3]):[0-5]\d$/.test(body.time.trim())) {
    const [hh, mm] = body.time.trim().split(":");
    set("daily_recommend_time", `${hh.padStart(2, "0")}:${mm}`);
    changed = true;
  } else if (body.time !== undefined) {
    return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.common.timeHHMM"), 400);
  } else if (body.hour !== undefined) {
    // 旧客户端只发整点:等价于把 time 设为整点,保证新老配置同源生效。
    const h = parseInt(body.hour, 10);
    if (!(Number.isFinite(h) && h >= 0 && h <= 23)) {
      return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.common.hourRange"), 400);
    }
    set("daily_recommend_hour", String(h));
    set("daily_recommend_time", `${String(h).padStart(2, "0")}:00`);
    changed = true;
  }
  if (changed) rearmDailyScheduler();
  return c.json({ success: true, time: formatDailyTime() });
});

// Update the candidate pool. Body: { candidates: [{platform, url, name?}] }
// Charts named "新歌" or "欧美" (and known blocked URLs like QQ toplist/27,
// toplist/60, NetEase playlist 3779629) are filtered out and reported.

app.put("/v1/daily-recommend/candidates", adminMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const arr = Array.isArray(body.candidates) ? body.candidates : null;
  if (!arr) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.common.candidatesArray"), 400);
  const raw = arr
    .filter((x: any) => x && typeof x.url === "string" && typeof x.platform === "string" && x.platform.trim().length > 0)
    .map((x: any) => ({ platform: x.platform, url: x.url.trim(), name: typeof x.name === "string" ? x.name : undefined }));
  const blocked = raw.filter((x: any) => dailyApi()?.isCandidateBlocked(x) ?? false);
  const clean = raw.filter((x: any) => !(dailyApi()?.isCandidateBlocked(x) ?? false));
  if (clean.length === 0) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.common.candidatesEmpty"), 400);
  dailyApi()?.saveCandidates(clean);
  return c.json({ success: true, count: clean.length, blocked: blocked.length, blockedItems: blocked });
});

// Manually trigger today's daily-recommend generation.
// Builds a SINGLE combined "每日推荐" playlist from remote charts + user pool
// + local history mix. Idempotent: if today's playlist already exists, returns
// skipped=true. With { force: true } it bypasses idempotency and re-randomizes.

app.post("/v1/daily-recommend/trigger", adminMiddleware, async (c) => {
  if (!dailyApi()) return c.json(apiError(BusinessErrorCode.CONFLICT, "errors.common.dailyRecommendDisabled"), 503);
  try {
    const body = await c.req.json().catch(() => ({}));
    const opts = { force: body?.force === true, seedSalt: body?.seedSalt };
    const result = await dailyApi().generateDailyPlaylist(new Date(), opts);
    return c.json({ success: true, result }, 200);
  } catch (e: any) {
    const error = e.message || translate("errors.recommend.genFailed");
    log.error("[DAILY-RECOMMEND] trigger error", { err: error });
    return c.json({ success: false, error }, 500);
  }
});

// ==================== 推荐手动刷新(每日/本地/今日漫游) ====================
// 一键重新触发随机生成:每日推荐(force+随机盐) → 本地推荐(force+随机盐) →
// 插件任务状态:查询最近一次后台任务(运行中 / 结果,含沙箱限制错误码与修复提示)。
// 前端在发起异步刷新后轮询此端点,直到 running=false。
}
