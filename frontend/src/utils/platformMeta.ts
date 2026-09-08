// ==================== 插件平台元数据(共享加载器) ====================
//
// 「来源平台 → 显示名」的动态层:插件可在 manifest 声明 `platformLabels`
// (如 huawei → 华为音乐),前端据此渲染平台徽标/标签,新平台插件**无需改前端
// 映射表**。内置映射(PlatformBadge/SongTable 的 FALLBACK_PLATFORMS)是静态
// 第一层,本模块是动态第二层兜底。
//
// 模块级缓存:整个应用只拉一次 /rest/api/v1/plugins;失败置空缓存(下次调用
// 重试),不阻塞渲染——调用方先渲染内置映射,manifest 数据到达后补充。

import api from "@/api";

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
