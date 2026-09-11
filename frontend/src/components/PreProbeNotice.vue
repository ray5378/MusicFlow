<template>
  <transition name="preprobe-fade">
    <div
      v-if="visible"
      class="preprobe-notice"
      :class="{ 'panel-open': playerStore.showPlaylist }"
      role="status"
    >
      <div class="preprobe-body">
        <div class="preprobe-title">
          <MfIcon name="TriangleAlert" :size="14" />
          <span>{{ t('player.preProbe.title') }}</span>
          <span v-if="peerName" class="preprobe-peer">{{ peerName }}</span>
        </div>
        <div class="preprobe-text">
          {{ t('player.preProbe.exhaustedText', { misses: pp!.misses, seconds: remainingSeconds }) }}
        </div>
        <div class="preprobe-sub">{{ t('player.preProbe.readyText', { ready: pp!.ready }) }}</div>
      </div>
      <button class="preprobe-close" :aria-label="t('common.close')" @click="dismiss">
        <MfIcon name="X" :size="14" />
      </button>
    </div>
  </transition>
</template>

<script setup lang="ts">
// 服务端预探测「大面积无源」右上角持久轻提示(2026-09-11)。
//
// 生命周期是**状态驱动**而不是计时器驱动:
//   - "不自动关闭" = 没有消失计时器 —— 用户不点关闭就一直挂着;
//   - 但 `exhausted` 回落(冷却到期,服务端 status() 自动回落)时随状态消失 ——
//     留着一条与事实不符的告警,用户下次就不信它了。
//
// 关闭去重键 = 当前 peerId + preProbe.at:关闭后**同一事件**不再出现,
// 下一次新的枯竭(新的 at)会重新出现 —— 既不"关不掉"也不"永久静音"。
// 关闭记录存内存:刷新后若仍枯竭会再出现一次,不写 localStorage(会变永久静音)。
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import { usePlayerStore } from "@/stores/player";
import MfIcon from "@/components/MfIcon.vue";

const { t } = useI18n();
const playerStore = usePlayerStore();

const pp = computed(() => playerStore.activePreProbe);
const peerName = computed(() => playerStore.activePreProbePeerName);
const peerKey = computed(() => playerStore.currentPeerId);

const dismissed = ref(new Set<string>());
const visible = computed(() => {
  const p = pp.value;
  if (!p || !p.exhausted) return false;
  return !dismissed.value.has(`${peerKey.value}:${p.at}`);
});
function dismiss(): void {
  const p = pp.value;
  if (p) dismissed.value.add(`${peerKey.value}:${p.at}`);
}

// 剩余冷却秒数:1s tick 只刷新显示数字,不影响生命周期(不是"自动关闭"计时器)。
const nowRef = ref(Date.now());
let tick: ReturnType<typeof setInterval> | null = null;
onMounted(() => { tick = setInterval(() => { nowRef.value = Date.now(); }, 1000); });
onUnmounted(() => { if (tick) clearInterval(tick); });
const remainingSeconds = computed(() => {
  const until = pp.value?.cooldownUntil;
  if (!until) return 0;
  return Math.max(0, Math.ceil((until - nowRef.value) / 1000));
});
</script>

<style scoped>
/* 右上角固定层。队列面板(360px, z-index 200)展开时避让到其左侧;
   ≤768px(与 MainLayout 断点一致)改为顶部通栏。z-index 260:高于队列面板(200)
   与展开按钮(210),低于全屏播放层(300)—— 全屏时不显示是有意为之。 */
.preprobe-notice {
  position: fixed;
  top: 24px;
  right: 24px;
  z-index: 260;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  max-width: min(360px, calc(100vw - 48px));
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--el-bg-color, #fff);
  border: 1px solid var(--el-border-color-light, #e4e7ed);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.12);
  transition: right 0.25s ease;
}
.preprobe-notice.panel-open {
  right: calc(360px + 24px);
}
.preprobe-body {
  flex: 1;
  min-width: 0;
}
.preprobe-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--el-color-warning, #e6a23c);
}
.preprobe-peer {
  font-weight: 400;
  font-size: 12px;
  color: var(--el-text-color-secondary, #909399);
}
.preprobe-text {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-primary, #303133);
}
.preprobe-sub {
  margin-top: 2px;
  font-size: 12px;
  color: var(--el-text-color-secondary, #909399);
}
.preprobe-close {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--el-text-color-secondary, #909399);
  cursor: pointer;
}
.preprobe-close:hover {
  background: var(--el-fill-color, #f0f2f5);
  color: var(--el-text-color-primary, #303133);
}
@media (max-width: 768px) {
  .preprobe-notice,
  .preprobe-notice.panel-open {
    top: 12px;
    left: 12px;
    right: 12px;
    max-width: none;
  }
}
.preprobe-fade-enter-active,
.preprobe-fade-leave-active {
  transition: opacity 0.25s ease, transform 0.25s ease;
}
.preprobe-fade-enter-from,
.preprobe-fade-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}
</style>
