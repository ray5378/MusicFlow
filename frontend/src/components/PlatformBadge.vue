<template>
  <span v-if="label" class="platform-badge" :class="'src-' + source" :style="badgeStyle">
    <span class="platform-badge-text">{{ label }}</span>
  </span>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ensurePluginMeta, platformLabelOf } from "@/utils/platformMeta";

const { t } = useI18n();

const props = defineProps<{
  source?: string | null;
}>();

// 平台显示名 + 品牌强调色(可见即可辨)。静态映射是内置第一层;
// 动态层(manifest.platformLabels)在 ensurePluginMeta 到达后兜底,
// 新平台插件无需改前端映射表即可显示角标。
const PLATFORMS: Record<string, { label: string; color: string }> = {
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

const source = computed(() => (props.source || "").toLowerCase());
// 动态层就绪信号:触发一次重新计算(manifest 标签异步到达)
const dynReady = ref(false);
function loadDynamic() {
  if (!source.value || PLATFORMS[source.value]) return;
  ensurePluginMeta().finally(() => {
    dynReady.value = true;
  });
}
watch(source, loadDynamic, { immediate: true });

const label = computed(() => {
  const key = PLATFORMS[source.value]?.label;
  if (key) return t(key);
  void dynReady.value; // 依赖动态层就绪信号
  // 动态层:插件 manifest.platformLabels;最终回退平台 id 原文(仍可辨认来源)
  return platformLabelOf(source.value) || source.value;
});
const badgeStyle = computed(() => ({ backgroundColor: PLATFORMS[source.value]?.color || "rgba(0,0,0,.55)" }));
</script>

<style lang="scss" scoped>
.platform-badge {
  position: absolute;
  top: 6px;
  left: 6px;
  z-index: 2;
  padding: 2px 7px;
  border-radius: 6px;
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  line-height: 16px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, .35);
  pointer-events: none;
}
</style>
