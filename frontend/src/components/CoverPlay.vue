<template>
  <button
    class="mf-cover-play"
    :class="[`sz-${size}`, { 'pos-br': corner, 'is-loading': busy }]"
    :title="labelText"
    :aria-label="labelText"
    @click.stop.prevent="run"
    @mousedown.stop
    @touchstart.stop
    @contextmenu.stop
  >
    <span v-if="busy" class="mf-cp-spin"></span>
    <MfIcon v-else name="play" />
  </button>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { useI18n } from "vue-i18n";

const { t } = useI18n();

const props = withDefaults(
  defineProps<{
    /** 按钮尺寸 */
    size?: "sm" | "md" | "lg";
    /** 贴右下角显示（不遮挡封面主体） */
    corner?: boolean;
    label?: string;
    /** 异步播放动作，组件自动管理 loading 状态 */
    action?: () => any | Promise<any>;
  }>(),
  { size: "md", corner: true }
);

const emit = defineEmits<{ (e: "play"): void }>();
const busy = ref(false);

// 默认提示文案不能在 defineProps 默认值里引用 t（会提升到 setup 之外），故用计算属性兜底。
const labelText = computed(() => props.label ?? t("layout.play"));

async function run() {
  if (busy.value) return;
  if (!props.action) {
    emit("play");
    return;
  }
  busy.value = true;
  try {
    await props.action();
  } finally {
    busy.value = false;
  }
}
</script>
