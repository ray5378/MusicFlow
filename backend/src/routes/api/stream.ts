// 自动生成 —— 由 index.ts 物理拆分而来（stream 域，2 条路由）。零逻辑改动。
import type { Hono } from "hono";
import {
  BusinessErrorCode,
  MAX_PROBE_BATCH,
  PERM,
  apiError,
  db,
  ensurePlayableStream,
  eq,
  getCachedPlayability,
  permMiddleware,
  songs,
} from "./shared.js";

export function registerStream(app: Hono): void {
app.use("/v1/stream", permMiddleware(PERM.LIBRARY_STREAM));

app.post("/v1/stream/probe", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const songIds = Array.isArray(body.songIds)
    ? body.songIds.filter((s: any) => typeof s === "string").slice(0, MAX_PROBE_BATCH)
    : [];
  if (!songIds.length) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.plugin.songIdsRequired"));
  const results = await Promise.all(songIds.map(async (id: string) => {
    const song = db.select().from(songs).where(eq(songs.id, id)).get();
    if (!song) return { songId: id, ok: false, local: false, verdict: "unplayable" as const, reason: "歌曲不存在" };
    // 本地歌曲(或已缓存文件的 web 歌曲):无需探测。
    // 注意 web 行不再按「无 url」误判为本地——纯核实源(huawei-chart 等)导入的
    // 歌曲就是空直链,须走 ensurePlayableStream 兜底解析(内部已处理空 url)。
    if ((song.type || "local") !== "web" || song.cachePath) {
      return { songId: id, ok: true, local: true, verdict: "playable" as const };
    }
    const original = song.url;
    try {
      const url = await ensurePlayableStream(song as any);
      if (url) return { songId: id, ok: true, local: false, verdict: "playable" as const, fallback: url !== original };
      // 返 null 必须再分「全平台无源」与「网络抖动」——把后者当死链跳掉是事故。
      const cached = getCachedPlayability(id);
      const verdict = cached === "unplayable" ? "unplayable" as const
        : cached === "playable" ? "playable" as const
          : cached === "transient" ? "transient" as const
            : "unknown" as const;
      return {
        songId: id, ok: false, local: false, verdict,
        reason: verdict === "unplayable" ? "无可用音源" : "探测未定(网络异常,不据此跳过)",
      };
    } catch (e: any) {
      return { songId: id, ok: false, local: false, verdict: "transient" as const, reason: String(e?.message || e).slice(0, 120) };
    }
  }));
  return c.json({ success: true, results });
});

// 今日漫游(combo,合并前两者)。body 可选 { targets: ["daily"|"local"|"roam"] },
// 缺省全刷。**默认路径(不带 pluginId)为异步**:202 + taskId,前端轮询 GET /v1/tasks/:id
// 取 task.result({ success, seedSalt, results })——生成跑在一次性批量子进程里(方案3)。
}
