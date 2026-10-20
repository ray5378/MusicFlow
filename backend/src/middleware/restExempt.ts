// ==================== `/rest/*` 全局鉴权豁免清单(单一真源) ====================
//
// index.ts 的 `/rest/*` 门禁对下列**取流端**放行,理由只有一个:调用方带不上任何
// 鉴权请求头,而它们各自持有一枚随机、短时效、绑定单曲的 token —— **token 即凭证**,
// 由对应 handler 自行校验(清单里的每一条都在 routes/rest 里有对应 handler 内的
// `resolveXxx(token)` → 失败即 403 分支)。
//
//   - `/dlna/stream/`    DLNA 音箱回连拉流(services/dlna/control.ts 签发)
//   - `/airplay/stream/` 本机 ffmpeg 解码器回环拉流(services/airplay/control.ts
//                        经 resolvePipelineInput 包装成回环 URL 后由 ffmpeg 拉取)
//   - `/membuf/`         整曲内存缓冲的回环取流端(services/source/bufferedFetch.ts)
//
// ⚠️ 这是一份**安全白名单**,不是性能开关:新增一项 = 让一条真实路径绕过全局鉴权。
// 准入必须同时满足两条 —— ①调用方结构上无法携带凭据;②该路由 handler 内自带
// token 校验且失败拒绝。两条都满足才允许进清单,否则应当走 authMiddleware。
//
// 匹配口径沿用既有实现(`includes`,与 dlna/membuf 完全一致),不引入更严的前缀匹配,
// 以免同样写法在不同条目上出现语义分叉。`/rest/api/*` 之下另有一道独立门禁
// (index.ts 的 `app.use("/rest/api/*", authMiddleware)`),故此处放松不会穿透到 API 面。
//
// 双向锁定:单测 tests/middleware/restExempt.test.ts 穷举判定,守卫
// scripts/check-airplay-stream-auth.mjs 钉住清单形态与三条 handler 的自校验接线。
export const REST_AUTH_EXEMPT_MARKERS = [
  "/dlna/stream/",
  "/airplay/stream/",
  "/membuf/",
] as const;

/** `/rest/*` 全局鉴权是否对该请求路径放行。入参是 `c.req.path`(含 `/rest` 前缀)。 */
export function isRestAuthExemptPath(path: string): boolean {
  return REST_AUTH_EXEMPT_MARKERS.some((marker) => path.includes(marker));
}
