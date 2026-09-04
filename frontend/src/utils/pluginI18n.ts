// 插件 manifest 内联 i18n 字典的取用工具。
//
// 插件可在 manifest 声明 `i18n: { zh?, en? }`,按语言覆盖 name/description/
// platformLabels/groups 与 configSchema 各字段的 label/help/options 文案(见
// backend/src/plugins/types.ts 的 PluginI18n)。本模块在渲染插件清单/配置表单前
// 按当前界面语言解析出有效文案;未声明语言或未声明某 key 时回退 manifest 默认(中文)。
// 用 i18n.global.locale 保证随语言切换响应式重算。

import { i18n, type AppLocale } from "@/locales";

export interface ResolvedFieldText {
  label?: string;
  help?: string;
  /** option value → 本地化 label */
  options?: Record<string, string>;
}

export interface ResolvedPluginText {
  /** 单语字典里的 name/description/platformLabels,未覆盖则为 undefined(用默认)。 */
  name?: string;
  description?: string;
  platformLabels?: Record<string, string>;
  /** 配置分组 key → 标题(未被字典覆盖时前端回退核心分组翻译/分组名)。 */
  groupLabels: Record<string, string>;
  /** 取某配置字段的本地化文案(未覆盖字段返回 ,前端先用默认值再补)。 */
  fieldText(key: string): ResolvedFieldText;
}

/** 取当前语言对应的插件 i18n 文案(sub-dict)。locale 为 en-US 时选 en,否则 zh。 */
function pickText(manifest: any): any {
  const dict: any = manifest?.i18n || {};
  const locale = i18n.global.locale.value as AppLocale;
  return locale === "en-US" ? (dict.en || dict.zh || {}) : dict.zh || {};
}

export function resolvePluginI18n(manifest: any): ResolvedPluginText {
  const text: any = pickText(manifest);
  const fields: Record<string, ResolvedFieldText> = text.fields || {};
  return {
    name: text.name,
    description: text.description,
    platformLabels: text.platformLabels,
    groupLabels: text.groups || {},
    fieldText: (key) => fields[key] || {},
  };
}

/** 便捷取用:对某配置字段做本地化合并(默认文案 + 字典覆盖)。
 *  返回在原始字段上浅合并后的对象,保留 key/type/default/group 等非文案字段。 */
export function resolveField(m: any, f: any): any {
  const d = resolvePluginI18n(m).fieldText(f?.key);
  return {
    ...(f || {}),
    label: d.label ?? f?.label,
    help: d.help ?? f?.help,
    options: f?.options
      ? f.options.map((o: any) => ({ ...o, label: d.options?.[o.value] ?? o.label }))
      : f?.options,
  };
}

/** 便捷取用:取插件本地化名字(未覆盖回退默认)。 */
export function localName(m: any, fallback: string): string {
  return resolvePluginI18n(m).name ?? fallback;
}

/** 便捷取用:取插件本地化简介(未覆盖回退默认)。 */
export function localDesc(m: any, fallback: string): string {
  return resolvePluginI18n(m).description ?? fallback;
}