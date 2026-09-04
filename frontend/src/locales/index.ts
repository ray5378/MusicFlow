// vue-i18n 实例:中英双语,默认简体中文。消息目录放在同目录 JSON(zh-CN/en-US),
// CI 用 scripts/check-i18n 校验两目录键完全对齐 + 源码无硬编码中文。
import { createI18n } from "vue-i18n";
import zhCN from "./zh-CN.json";
import enUS from "./en-US.json";

export const DEFAULT_LOCALE = "zh-CN";
export type AppLocale = "zh-CN" | "en-US";
export const SUPPORTED_LOCALES: AppLocale[] = ["zh-CN", "en-US"];

export const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: DEFAULT_LOCALE,
  fallbackLocale: DEFAULT_LOCALE,
  messages: {
    "zh-CN": zhCN,
    "en-US": enUS,
  },
});

// 供无组件上下文的 .ts 模块(utils/composables/stores)调用的全局翻译 helper。
export function gt(key: string, params?: Record<string, unknown>): string {
  return i18n.global.t(key, params || {});
}