<template>
  <div>
    <!-- ===== Desktop right-click context menu ===== -->
    <teleport to="body">
      <div v-if="menu.open && menu.mode === 'desktop'" class="ctx-backdrop" @click="closeMenu" @contextmenu.prevent="closeMenu"></div>
      <div
        v-if="menu.open && menu.mode === 'desktop'"
        class="ctx-menu fnos-glass"
        :style="menuPos"
        @click.stop
        @contextmenu.prevent.stop
      >
        <div v-if="menu.title" class="ctx-head">
          <div class="ctx-head-title">{{ menu.title }}</div>
          <div v-if="menu.subtitle" class="ctx-head-sub">{{ menu.subtitle }}</div>
        </div>
        <template v-for="(a, i) in menu.actions" :key="i">
          <div v-if="a.divider" class="ctx-divider"></div>
          <button
            v-else
            class="ctx-item"
            :class="{ danger: a.danger, disabled: a.disabled }"
            :disabled="a.disabled || a.loading"
            @click="runAction(a)"
          >
            <span class="ctx-icon"><component :is="a.icon" v-if="a.icon" /></span>
            <span class="ctx-label">{{ a.label }}</span>
            <span v-if="a.loading" class="ctx-spin"><MfIcon name="Loader2" class="is-loading"  spin /></span>
          </button>
        </template>
      </div>

      <!-- ===== Mobile long-press action sheet ===== -->
      <transition name="sheet">
        <div v-if="menu.open && menu.mode === 'mobile'" class="sheet-backdrop" @click="lazyClose"></div>
      </transition>
      <transition name="sheet">
        <div v-if="menu.open && menu.mode === 'mobile'" class="action-sheet fnos-glass">
          <div class="sheet-grip"></div>
          <div class="sheet-head" v-if="menu.title">
            <div class="sheet-title">{{ menu.title }}</div>
            <div class="sheet-sub" v-if="menu.subtitle">{{ menu.subtitle }}</div>
          </div>
          <button
            v-for="(a, i) in sheetActions"
            :key="i"
            class="sheet-item"
            :class="{ danger: a.danger, disabled: a.disabled }"
            :disabled="a.disabled || a.loading"
            @click="runAction(a)"
          >
            <span class="sheet-icon"><component :is="a.icon" v-if="a.icon" /></span>
            <span class="sheet-label">{{ a.label }}</span>
          </button>
          <button class="sheet-cancel" @click="closeMenu">取消</button>
        </div>
      </transition>
    </teleport>

    <!-- ===== Add to playlist dialog ===== -->
    <el-dialog v-model="addDlg.open" title="添加到歌单" width="420px" align-center @close="closeAddDlg">
      <div class="pl-dialog-song" v-if="addDlg.song">
        将「{{ addDlg.song.title }} - {{ addDlg.song.artist }}」添加到：
      </div>
      <div class="pl-list" v-loading="addDlg.loading">
        <div
          v-for="pl in addDlg.playlists"
          :key="pl.id"
          class="pl-item"
          :class="{ active: addDlg.addingId === pl.id }"
          @click="addToPlaylist(pl)"
        >
          <MfIcon name="List" class="pl-icon"  />
          <div class="pl-info">
            <div class="pl-name">{{ pl.name }}</div>
            <div class="pl-meta">{{ pl.songCount }} 首</div>
          </div>
          <MfIcon name="Loader2" v-if="addDlg.addingId === pl.id" class="is-loading pl-spin"  spin />
        </div>
        <div v-if="addDlg.playlists.length === 0 && !addDlg.loading" class="pl-empty">暂无歌单，先创建一个吧</div>
      </div>
      <div class="pl-create">
        <el-input v-model="addDlg.newName" placeholder="新建歌单名称..." clearable @keyup.enter="createAndAdd" />
        <el-button type="primary" @click="createAndAdd" :disabled="!addDlg.newName">新建并添加</el-button>
      </div>
    </el-dialog>

    <!-- ===== Song info dialog ===== -->
    <el-dialog v-model="infoDlg.open" title="歌曲信息" width="420px" align-center>
      <div class="info-grid" v-if="infoDlg.song">
        <div class="info-row"><span class="info-k">标题</span><span class="info-v">{{ infoDlg.song.title }}</span></div>
        <div class="info-row"><span class="info-k">艺术家</span><span class="info-v">{{ infoDlg.song.artist || '—' }}</span></div>
        <div class="info-row"><span class="info-k">专辑</span><span class="info-v">{{ infoDlg.song.album || '—' }}</span></div>
        <div class="info-row"><span class="info-k">时长</span><span class="info-v">{{ fmt(infoDlg.song.duration) }}</span></div>
        <div class="info-row" v-if="infoDlg.song.bitRate"><span class="info-k">码率</span><span class="info-v">{{ infoDlg.song.bitRate }}kbps · {{ (infoDlg.song.suffix || '').toUpperCase() }}</span></div>
        <div class="info-row" v-if="infoDlg.song.albumId"><span class="info-k">专辑ID</span><span class="info-v mono">{{ infoDlg.song.albumId }}</span></div>
        <div class="info-row" v-if="infoDlg.song.artistId"><span class="info-k">艺人ID</span><span class="info-v mono">{{ infoDlg.song.artistId }}</span></div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";

import { useItemActions, MenuAction } from "@/composables/useItemActions";

const { menu, addDlg, infoDlg, closeMenu, addToPlaylist, createAndAdd, closeAddDlg } = useItemActions();

const MENU_W = 224;
const menuPos = computed(() => {
  const rows = menu.actions.filter((a) => !a.divider).length;
  const dividers = menu.actions.filter((a) => a.divider).length;
  const h = 12 + rows * 38 + dividers * 11 + (menu.title ? 44 : 0);
  const x = Math.min(menu.x, window.innerWidth - MENU_W - 10);
  const y = Math.min(menu.y, window.innerHeight - h - 10);
  return { left: `${Math.max(8, x)}px`, top: `${Math.max(8, y)}px`, width: `${MENU_W}px` };
});

/** Ignore the synthetic click that follows a long-press. */
function lazyClose() {
  if (Date.now() - menu.openedAt < 400) return;
  closeMenu();
}

// mobile sheet: drop dividers
const sheetActions = computed(() => menu.actions.filter((a) => !a.divider));

function runAction(a: MenuAction) {
  if (a.disabled || a.loading) return;
  closeMenu();
  a.onClick?.();
}

function fmt(sec: number) {
  if (!sec) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
</script>

<style lang="scss" scoped>
.fnos-glass {
  background: rgba(28, 26, 38, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.12);
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(22px) saturate(180%);
  -webkit-backdrop-filter: blur(22px) saturate(180%);
  border-radius: 14px;
}

.ctx-backdrop { position: fixed; inset: 0; z-index: 4000; }
.ctx-menu {
  position: fixed; z-index: 4001; padding: 6px;
  animation: ctx-in 0.12s ease;
}
@keyframes ctx-in { from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: scale(1); } }
.ctx-head {
  padding: 8px 12px 9px; margin-bottom: 4px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  .ctx-head-title { font-size: 13px; font-weight: 600; color: var(--fnos-text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ctx-head-sub { font-size: 11.5px; color: var(--fnos-text-tertiary); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
}
.ctx-divider { height: 1px; background: rgba(255, 255, 255, 0.08); margin: 5px 8px; }
.ctx-item {
  width: 100%; display: flex; align-items: center; gap: 10px;
  padding: 9px 12px; border: none; background: transparent;
  color: var(--fnos-text-primary); font-size: 13.5px; border-radius: 9px;
  cursor: pointer; text-align: left; transition: background 0.14s;
  &:hover:not(:disabled) { background: rgba(246, 44, 85, 0.16); color: #fff; }
  &.danger { color: #ff6b6b; &:hover { background: rgba(255, 80, 80, 0.16); } }
  &.disabled { opacity: 0.4; cursor: default; }
  .ctx-icon { width: 18px; display: flex; align-items: center; justify-content: center; color: var(--fnos-text-secondary); }
  .ctx-item:hover .ctx-icon { color: inherit; }
  .ctx-label { flex: 1; }
  .ctx-spin { color: var(--fnos-text-tertiary); }
}

.sheet-backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); z-index: 4000; }
.action-sheet {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 4001;
  border-radius: 20px 20px 0 0; padding: 10px 12px calc(14px + env(safe-area-inset-bottom));
  /* 滑入/滑出动画由外层 <transition name="sheet"> 统一驱动（enter/leave 双向），
     不再叠加 CSS animation —— 两套动画竞争 transform 会产生抖动/回闪。 */
}
.sheet-grip { width: 40px; height: 4px; border-radius: 2px; background: rgba(255, 255, 255, 0.25); margin: 4px auto 10px; }
.sheet-head {
  padding: 2px 14px 12px; text-align: center;
  border-bottom: 1px solid rgba(255, 255, 255, 0.07); margin-bottom: 6px;
  .sheet-title { font-size: 15px; font-weight: 600; color: var(--fnos-text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sheet-sub { font-size: 12.5px; color: var(--fnos-text-tertiary); margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
}
.sheet-item {
  width: 100%; display: flex; align-items: center; gap: 14px;
  padding: 14px 14px; border: none; background: transparent;
  color: var(--fnos-text-primary); font-size: 16px; border-radius: 12px; cursor: pointer;
  &:active { background: rgba(255, 255, 255, 0.08); }
  &.danger { color: #ff6b6b; }
  .sheet-icon { width: 22px; display: flex; align-items: center; justify-content: center; color: var(--fnos-text-secondary); }
}
.sheet-cancel {
  width: 100%; margin-top: 8px; padding: 14px; border: none;
  background: rgba(255, 255, 255, 0.06); color: var(--fnos-text-primary);
  font-size: 16px; font-weight: 600; border-radius: 12px; cursor: pointer;
  &:active { background: rgba(255, 255, 255, 0.12); }
}

.pl-dialog-song { font-size: 13px; color: var(--fnos-text-tertiary); margin-bottom: 12px; }
.pl-list { max-height: 320px; overflow-y: auto; }
.pl-item {
  display: flex; align-items: center; gap: 10px; padding: 10px 12px;
  border-radius: 8px; cursor: pointer; transition: background 0.2s;
  &:hover { background: rgba(255, 255, 255, 0.06); }
  .pl-icon { font-size: 18px; color: var(--fnos-text-tertiary); }
  .pl-info { flex: 1; .pl-name { font-size: 14px; font-weight: 500; } .pl-meta { font-size: 12px; color: var(--fnos-text-tertiary); } }
  .pl-spin { color: var(--fnos-text-tertiary); }
}
.pl-empty { text-align: center; color: var(--fnos-text-muted); font-size: 13px; padding: 20px 0; }
.pl-create { display: flex; gap: 8px; margin-top: 12px; padding-top: 12px; border-top: 1px solid rgba(255, 255, 255, 0.08); }

.info-grid { display: flex; flex-direction: column; gap: 12px; }
.info-row { display: flex; gap: 12px; font-size: 14px; .info-k { width: 64px; color: var(--fnos-text-tertiary); flex-shrink: 0; } .info-v { flex: 1; color: var(--fnos-text-primary); word-break: break-all; } .info-v.mono { font-family: monospace; font-size: 12px; } }

.sheet-enter-active, .sheet-leave-active { transition: opacity 0.2s ease; }
.sheet-enter-from, .sheet-leave-to { opacity: 0; }
.sheet-enter-active .action-sheet, .sheet-leave-active .action-sheet { transition: transform 0.22s ease; }
.sheet-enter-from .action-sheet, .sheet-leave-to .action-sheet { transform: translateY(100%); }
</style>
