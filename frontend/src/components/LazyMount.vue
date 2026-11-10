<template>
  <div ref="el">
    <slot v-if="shown" />
  </div>
</template>

<script setup lang="ts">
// 折叠区域懒挂载:滚到视口附近(rootMargin,默认提前 400px)才渲染 slot。
// 用于首页下半屏(平台精选 / 本地随机)这类「首屏看不到、数据已在内存」的分区:
// 避免首屏一次性布局上百张卡片,滚动到时再挂载(数据已在内存,无额外等待)。
import { ref, onMounted, onBeforeUnmount } from "vue";

const props = withDefaults(defineProps<{ rootMargin?: string }>(), {
  rootMargin: "400px 0px",
});

const el = ref<HTMLElement | null>(null);
const shown = ref(false);
let io: IntersectionObserver | null = null;

onMounted(() => {
  if (typeof IntersectionObserver === "undefined" || !el.value) {
    shown.value = true;
    return;
  }
  io = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      shown.value = true;
      io?.disconnect();
      io = null;
    },
    { rootMargin: props.rootMargin }
  );
  io.observe(el.value);
});

onBeforeUnmount(() => {
  io?.disconnect();
  io = null;
});
</script>
