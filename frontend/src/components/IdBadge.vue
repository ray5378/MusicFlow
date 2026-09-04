<template>
  <span class="id-badge" :class="{ copied: copied === id }" :title="t('idBadge.copyTip', { id })" @click.stop="onCopy">
    <span class="id-prefix">{{ prefix }}</span>
    <span class="id-value">{{ id }}</span>
    <MfIcon name="CopyDocument" class="id-copy-icon" />
  </span>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { ElMessage } from "element-plus";
import MfIcon from "./MfIcon.vue";

const { t } = useI18n();

const props = withDefaults(defineProps<{
  id: string;
  prefix?: string;
  copyLabel?: string;
}>(), { prefix: "", copyLabel: "" });

const copied = ref("");
const timer = ref<ReturnType<typeof setTimeout> | null>(null);

async function onCopy() {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(props.id);
    } else {
      const ta = document.createElement("textarea");
      ta.value = props.id;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    copied.value = props.id;
    if (props.copyLabel) ElMessage.success(t("idBadge.copied", { label: props.copyLabel }));
    if (timer.value) clearTimeout(timer.value);
    timer.value = setTimeout(() => { copied.value = ""; }, 2000);
  } catch {
    ElMessage.error(t("idBadge.copyFailed"));
  }
}
</script>

<style scoped lang="scss">
.id-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 260px;
  padding: 1px 8px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.05);
  color: rgba(255, 255, 255, 0.55);
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  cursor: pointer;
  user-select: none;
  transition: all 0.2s;

  &:hover {
    border-color: rgba(255, 255, 255, 0.35);
    background: rgba(255, 255, 255, 0.1);
    color: rgba(255, 255, 255, 0.9);
  }

  .id-value {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .id-copy-icon {
    flex-shrink: 0;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.45);
  }

  &.copied {
    border-color: rgba(255, 197, 45, 0.6);
    color: #ffc52d;
    .id-copy-icon { color: #ffc52d; }
  }
}
</style>
