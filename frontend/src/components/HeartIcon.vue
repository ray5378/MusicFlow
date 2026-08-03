<template>
  <!-- Heart icon: outline always visible, filled (red) only on the inside when liked -->
  <svg
    class="heart-icon"
    :class="{ filled }"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
    />
    <path
      class="heart-fill"
      d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"
      fill="currentColor"
    />
  </svg>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ filled?: boolean; size?: number | string }>(), {
  filled: false,
  size: 18,
});
</script>

<style scoped>
.heart-icon {
  display: inline-block;
  vertical-align: middle;
}
.heart-fill {
  opacity: 0;
  transition: opacity 0.2s ease;
  color: #e94560;
}
.heart-icon.filled .heart-fill {
  opacity: 1;
}
</style>
