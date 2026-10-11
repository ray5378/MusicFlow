// ==================== 插件平台元数据(共享加载器) ====================
//
// 「来源平台 → 显示名」的两层来源:内置静态映射 `PLATFORM_META`(本模块导出,
// 含 i18n key + 品牌色)是静态第一层;插件在 manifest 声明的 `platformLabels`
// (如 huawei → 华为音乐)是动态第二层兜底 —— 新平台插件**无需改前端映射表**。
//
// 模块级缓存:整个应用只拉一次 /rest/api/v1/plugins;失败置空缓存(下次调用
// 重试),不阻塞渲染——调用方先渲染内置映射,manifest 数据到达后补充。

import api from "@/api";

/**
 * 内置「来源平台 → 显示名(i18n key) + 品牌强调色」静态映射(第一层)。
 * 由 PlatformBadge.vue 抽取而来,供徽标/歌曲信息弹窗等多处共用,避免复制映射表。
 * 注意:`label` 是 i18n key(如 `platform.netease`),**转译由调用方 `t(...)` 完成**
 * (util 层拿不到 vue-i18n 的 t);缺翻译时调用方回退该平台 id 原文。
 */
export const PLATFORM_META: Record<string, { label: string; color: string }> = {
  netease: { label: "platform.netease", color: "#e21a1a" },
  qq: { label: "platform.qq", color: "#12b7f5" },
  kugou: { label: "platform.kugou", color: "#28c76f" },
  kuwo: { label: "platform.kuwo", color: "#ff7f27" },
  migu: { label: "platform.migu", color: "#f26d21" },
  qianqian: { label: "platform.qianqian", color: "#8e44ad" },
  soda: { label: "platform.soda", color: "#00b8a9" },
  huawei: { label: "platform.huawei", color: "#0d5eff" },
  apple: { label: "platform.apple", color: "#fa233b" },
};

let labelsCache: Record<string, string> | null = null;
let namesCache: Record<string, string> | null = null;
let loading: Promise<void> | null = null;

/** 拉取并缓存所有已启用插件的 platformLabels 与 id→name 映射(幂等)。 */
export function ensurePluginMeta(): Promise<void> {
  if (labelsCache && namesCache) return Promise.resolve();
  if (!loading) {
    loading = api
      .get("/rest/api/v1/plugins")
      .then((res: any) => {
        const labels: Record<string, string> = {};
        const names: Record<string, string> = {};
        for (const p of (res.data || []) as any[]) {
          const m = p.manifest;
          if (m?.id) names[m.id] = m.name || m.id;
          if (m?.platformLabels) Object.assign(labels, m.platformLabels);
        }
        labelsCache = labels;
        namesCache = names;
      })
      .catch(() => {
        labelsCache = labelsCache || {};
        namesCache = namesCache || {};
      })
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

/** 平台显示名(manifest.platformLabels 动态层);无则空串。 */
export function platformLabelOf(src: string): string {
  return (src && labelsCache?.[src]) || "";
}

/** 插件 id → 插件名;无则空串。 */
export function pluginNameOf(id: string): string {
  return (id && namesCache?.[id]) || "";
}
