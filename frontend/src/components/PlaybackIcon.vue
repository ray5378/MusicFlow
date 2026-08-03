<template>
  <!-- Standard music-player icons: prev/next/play/pause/loop-one/loop-all/order -->
  <svg
    class="playback-icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    xmlns="http://www.w3.org/2000/svg"
    fill="currentColor"
  >
    <!-- 上一首: 竖线 + 左三角 -->
    <path v-if="name === 'prev'" d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/>
    <!-- 下一首: 竖线 + 右三角 -->
    <path v-else-if="name === 'next'" d="M16 6h2v12h-2zM6 18l8.5-6L6 6z"/>
    <!-- 播放: 右三角 -->
    <path v-else-if="name === 'play'" d="M8 5v14l11-7z"/>
    <!-- 暂停: 双竖线 -->
    <path v-else-if="name === 'pause'" d="M6 5h4v14H6zm8 0h4v14h-4z"/>
    <!-- 单曲循环: 数字1 + 循环箭头 -->
    <g v-else-if="name === 'loopOne'">
      <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
      <text x="12" y="15" text-anchor="middle" font-size="8.5" font-weight="bold" fill="currentColor">1</text>
    </g>
    <!-- 列表循环: 循环箭头 -->
    <path v-else-if="name === 'loopAll'" d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
    <!-- 顺序播放: 列表 + 顺序箭头 -->
    <g v-else-if="name === 'order'">
      <path d="M3 5h10v2H3zm0 6h10v2H3zm0 6h7v2H3zm13-9l4-3v10z"/>
    </g>
    <!-- 随机播放: shuffle 交叉箭头 -->
    <path v-else-if="name === 'shuffle'" d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/>
  </svg>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ name: "prev" | "next" | "play" | "pause" | "loopOne" | "loopAll" | "order" | "shuffle"; size?: number | string }>(), {
  size: 18,
});
</script>

<style scoped>
.playback-icon { display: inline-block; vertical-align: middle; }
</style>
