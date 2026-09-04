<template>
  <span v-if="label" class="platform-badge" :class="'src-' + source" :style="badgeStyle">
    <span class="platform-badge-text">{{ label }}</span>
  </span>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";

const { t } = useI18n();

const props = defineProps<{
  source?: string | null;
}>();

// Platform display name + brand accent colour (visible at a glance on covers).
const PLATFORMS: Record<string, { label: string; color: string }> = {
  netease: { label: "platform.netease", color: "#e21a1a" },
  qq: { label: "platform.qq", color: "#12b7f5" },
  kugou: { label: "platform.kugou", color: "#28c76f" },
  kuwo: { label: "platform.kuwo", color: "#ff7f27" },
  soda: { label: "platform.soda", color: "#00b8a9" },
};

const source = computed(() => (props.source || "").toLowerCase());
const label = computed(() => {
  const key = PLATFORMS[source.value]?.label;
  return key ? t(key) : "";
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
