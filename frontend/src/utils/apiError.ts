/**
 * 后端错误体 → 可展示文案（前端唯一出口）。
 *
 * 背景：后端 `apiError(code, "errors.xxx")` 回的 `error` 字段是 **i18n key**
 * （如 `errors.renderer.operationForbidden`），而前端没有统一翻译层 ——
 * 直接弹出去就是一串 `errors.…` 裸 key，比"保存失败"更没用。
 *
 * 规则：带 `errors.` 前缀的裸 key 一律回退到调用方给的本页文案；
 * 其余（插件自报的中文/英文原文、`No stream url` 这类服务端原样消息）原样展示。
 * 空字符串也回退（`||` 语义与替换前的写法一致）。
 *
 * 用法：`ElMessage.error(apiErrorText(e, t("settings.dsp.saveFailed")))`
 */
export function apiErrorText(e: unknown, fallback: string): string {
  const data = (e as any)?.response?.data;
  const raw = data?.error ?? data?.message;
  return typeof raw === "string" && raw && !raw.startsWith("errors.") ? raw : fallback;
}
