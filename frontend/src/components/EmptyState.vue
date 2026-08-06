<template>
  <div class="fnos-empty-state" :class="{ compact }">
    <div class="empty-icon">
      <slot name="icon">
        <MfIcon v-if="icon" :name="icon" :size="compact ? 36 : 48" />
      </slot>
    </div>
    <div class="empty-title">{{ title }}</div>
    <div class="empty-desc" v-if="description">{{ description }}</div>
    <div class="empty-action" v-if="$slots.action">
      <slot name="action" />
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  icon?: string;
  title: string;
  description?: string;
  compact?: boolean;
}>();
</script>

<style lang="scss" scoped>
.fnos-empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 60px 24px;
  color: var(--fnos-text-secondary);
  &.compact { padding: 36px 20px; }
  .empty-icon {
    width: 80px; height: 80px; border-radius: 50%;
    background: rgba(255,255,255,0.06);
    display: flex; align-items: center; justify-content: center;
    margin-bottom: 18px; color: var(--fnos-text-muted);
    .compact & { width: 56px; height: 56px; margin-bottom: 12px; }
  }
  .empty-title { font-size: 16px; font-weight: 600; color: var(--fnos-text-primary); margin-bottom: 6px; }
  .empty-desc { font-size: 13px; color: var(--fnos-text-tertiary); max-width: 360px; line-height: 1.6; }
  .empty-action { margin-top: 16px; }
}
</style>
