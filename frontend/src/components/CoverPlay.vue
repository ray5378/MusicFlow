<template>
  <button
    class="mf-cover-play"
    :class="[`sz-${size}`, { 'pos-br': corner, 'is-loading': busy }]"
    :title="label"
    :aria-label="label"
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
import { ref } from "vue";

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
  { size: "md", corner: true, label: "播放" }
);

const emit = defineEmits<{ (e: "play"): void }>();
const busy = ref(false);

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
