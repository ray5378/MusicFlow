// vue-i18n 实例:中英双语,默认简体中文。消息目录放在同目录 JSON(zh-CN/en-US),
// CI 用 scripts/check-i18n 校验两目录键完全对齐 + 源码无硬编码中文。
// 注:en-US.json 不再静态引入,入口包只内联 zh-CN,英文本地化包按需动态加载。
import { createI18n } from "vue-i18n";
import zhCN from "./zh-CN.json";

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
    // 占位键:让 locale / setLocaleMessage 的类型收窄到支持的两种语言;
    // 真实英文文案在 loadLocaleMessages 时再注入,不会进入入口包。
    "en-US": {},
  },
});

// 英文本地化包按需加载:入口包不再内联 en-US.json,仅英文用户启动/切语言时才拉取。
let enLoaded = false;
let enLoading: Promise<void> | null = null;
export function loadLocaleMessages(locale: AppLocale): Promise<void> {
  if (locale !== "en-US") return Promise.resolve();
  if (enLoaded) return Promise.resolve();
  if (!enLoading) {
    enLoading = import("./en-US.json").then((m) => {
      i18n.global.setLocaleMessage("en-US", m.default as Record<string, unknown>);
      enLoaded = true;
    });
  }
  return enLoading;
}

// 供无组件上下文的 .ts 模块(utils/composables/stores)调用的全局翻译 helper。
export function gt(key: string, params?: Record<string, unknown>): string {
  return i18n.global.t(key, params || {});
}
