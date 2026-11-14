<template>
  <div ref="el" :style="reserveStyle">
    <slot v-if="shown" />
  </div>
</template>

<script setup lang="ts">
// 折叠区域懒挂载：进入「滚动容器可视区 + margin」才渲染 slot。
// 用于首页下半屏（平台精选 / 本地随机）这类「首屏看不到、数据已在内存」的分区：
// 避免首屏一次性布局上百张卡片，滚动到时再挂载（数据已在内存，无额外等待）。
//
// 2026-11-14 两处修正（首页「必须滚到固定推荐底部才加载」的真因）：
// 1) 观察根必须是真实滚动容器（.main-scroll），不能留空用窗口视口：首页滚动发生
//    在内层容器上，浏览器会用该容器的可视区把目标元素裁掉，rootMargin 扩到容器
//    外面全被裁成空交集 —— 于是「提前 400px」形同虚设，实际只在滚到该块进入视野
//    那一刻才触发。
// 2) 未挂载时按 reserve 高度占位：否则外层 div 高度恒为 0，首屏之后所有分区的
//    触发点塌缩成同一条线，滚动条也早早到底，表现为「滚到固定推荐最下面，下半屏
//    才一次性全部出现」。
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";

const props = withDefaults(defineProps<{ rootMargin?: string; reserve?: number }>(), {
  rootMargin: "600px 0px",
  reserve: 0,
});

const el = ref<HTMLElement | null>(null);
const shown = ref(false);

// 未挂载时按调用方给的预估高度占位；挂载后立刻撤掉，真实高度接管。
const reserveStyle = computed<Record<string, string> | undefined>(() =>
  shown.value || !props.reserve ? undefined : { minHeight: `${props.reserve}px` }
);

const marginPx = computed(() => {
  const n = parseInt(props.rootMargin, 10);
  return Number.isFinite(n) ? n : 0;
});

/** 找到真正产生滚动的祖先容器（首页是 .main-scroll）。找不到则退回窗口视口。 */
function scrollParentOf(node: HTMLElement | null): HTMLElement | null {
  let p = node?.parentElement ?? null;
  while (p && p !== document.body && p !== document.documentElement) {
    const oy = getComputedStyle(p).overflowY;
    if (/(auto|scroll|overlay)/.test(oy) && p.scrollHeight > p.clientHeight) return p;
    p = p.parentElement;
  }
  return null;
}

/** 同步判定：目标是否已进入「滚动容器可视区 + margin」。不依赖观察器的首帧时序。 */
function nearViewport(): boolean {
  const node = el.value;
  if (!node) return false;
  const rootEl = scrollParentOf(node);
  const r = node.getBoundingClientRect();
  const top = rootEl ? rootEl.getBoundingClientRect().top : 0;
  const bottom = rootEl ? rootEl.getBoundingClientRect().bottom : window.innerHeight;
  const m = marginPx.value;
  return r.top <= bottom + m && r.bottom >= top - m;
}

let io: IntersectionObserver | null = null;

function startObserve(): void {
  if (typeof IntersectionObserver === "undefined" || !el.value) {
    shown.value = true;
    return;
  }
  io?.disconnect();
  io = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      shown.value = true;
      io?.disconnect();
      io = null;
    },
    // root 必须是滚动容器：留空（窗口视口）会被容器可视区裁掉，margin 不生效。
    { root: scrollParentOf(el.value), rootMargin: props.rootMargin }
  );
  io.observe(el.value);
}

/** 先做一次同步判定（已在阈值内立刻挂载），否则交给观察器跟随滚动。 */
function sync(): void {
  if (shown.value) return;
  if (nearViewport()) {
    shown.value = true;
    io?.disconnect();
    io = null;
    return;
  }
  startObserve();
}

onMounted(() => {
  sync();
  // 首帧布局可能未完成：下一帧再判一次（已在阈值内则当场挂载）。
  requestAnimationFrame(() => {
    if (!shown.value) sync();
  });
});

// 占位高度是首屏测量 / 下半屏数据到达之后才赋值的：从 0 高变成有高度时浏览器不会
// 为已观察元素补发通知，必须重算一次，否则「明明在阈值内却要等一次滚动」。
watch(
  () => props.reserve,
  () => {
    if (!shown.value) sync();
  },
  { flush: "post" }
);

onBeforeUnmount(() => {
  io?.disconnect();
  io = null;
});
</script>
