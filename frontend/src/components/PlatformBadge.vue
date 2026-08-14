<template>
  <span v-if="label" class="platform-badge" :class="'src-' + source" :style="badgeStyle">
    <span class="platform-badge-text">{{ label }}</span>
  </span>
</template>

<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  source?: string | null;
}>();

// Platform display name + brand accent colour (visible at a glance on covers).
const PLATFORMS: Record<string, { label: string; color: string }> = {
  netease: { label: "网易云", color: "#e21a1a" },
  qq: { label: "QQ音乐", color: "#12b7f5" },
  kugou: { label: "酷狗", color: "#28c76f" },
  kuwo: { label: "酷我", color: "#ff7f27" },
  soda: { label: "汽水", color: "#00b8a9" },
};

const source = computed(() => (props.source || "").toLowerCase());
const label = computed(() => PLATFORMS[source.value]?.label || "");
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
