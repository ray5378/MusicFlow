// 界面语言偏好:默认简体中文,持久化到 localStorage,并同步 Element Plus 的内置
// 组件文案(el-config-provider locale)。默认 zh-CN,不做浏览器探测("先做中英文,默认中文")。
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import zhCn from "element-plus/es/locale/lang/zh-cn";
import en from "element-plus/es/locale/lang/en";
import {
  DEFAULT_LOCALE,
  i18n,
  SUPPORTED_LOCALES,
  type AppLocale,
} from "@/locales";

const STORAGE_KEY = "mf_lang";

const ELEMENT_LOCALES: Record<AppLocale, typeof zhCn> = {
  "zh-CN": zhCn,
  "en-US": en,
};

function normalizeLang(value: string | null): AppLocale {
  return SUPPORTED_LOCALES.includes(value as AppLocale)
    ? (value as AppLocale)
    : DEFAULT_LOCALE;
}

export const useLocaleStore = defineStore("locale", () => {
  const lang = ref<AppLocale>(normalizeLang(localStorage.getItem(STORAGE_KEY)));
  const elementLocale = computed(() => ELEMENT_LOCALES[lang.value]);

  function apply(l: AppLocale) {
    i18n.global.locale.value = l;
    document.documentElement.lang = l;
  }

  function setLang(l: AppLocale) {
    const next = normalizeLang(l);
    if (next === lang.value) {
      apply(next);
      return;
    }
    lang.value = next;
    localStorage.setItem(STORAGE_KEY, next);
    apply(next);
  }

  // 首帧即落地:保证组件在 instance 挂起前已拿到正确语言。
  apply(lang.value);

  return { lang, elementLocale, setLang };
});