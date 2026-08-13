<template>
  <div class="song-list" :style="{ '--st-cols': gridColumns }" v-loading="loading">
    <div class="list-header" v-if="!isMobile">
      <span v-if="selectable" class="col col-select">
        <el-checkbox :model-value="allSelected" :indeterminate="someSelected" @change="toggleAll" />
      </span>
      <span class="col col-index">#</span>
      <span class="col col-title">标题</span>
      <span v-if="showArtist" class="col col-artist">艺术家</span>
      <span v-if="showAlbum" class="col col-album">专辑</span>
      <span v-if="showPlayedAt" class="col col-played-at">播放时间</span>
      <span class="col col-duration"><MfIcon name="Clock" /></span>
      <span class="col col-actions"></span>
    </div>

    <div class="list-body" ref="listBodyEl" :style="virtualized ? { paddingTop: padTop + 'px', paddingBottom: padBottom + 'px' } : undefined">
    <div
      v-for="(song, i) in visibleSongs"
      :key="song.id || `ext-${rowGlobalIdx(i)}`"
      class="song-row"
      :class="{
        active: isCurrent(song),
        playing: isCurrent(song) && playerStore.isPlaying,
      }"
      @click="onRowClick(song)"
      @contextmenu="onContext(song, $event)"
      v-longpress="() => onLongPress(song)"
    >
      <span v-if="selectable" class="col col-select" @click.stop>
        <el-checkbox :model-value="isSelected(song.id)" @change="toggleOne(song, $event)" />
      </span>
      <span class="col col-index">
        <span class="row-index">{{ (offset || 0) + rowGlobalIdx(i) + 1 }}</span>
        <span class="row-playing"><span></span><span></span><span></span></span>
        <span class="row-hover-play"><MfIcon name="Play" :size="16" /></span>
      </span>
      <span class="col col-title">
        <div class="song-cover-wrap" @click.stop="emitPlay(song)">
          <el-image v-if="song.coverArt" :src="`/rest/getCoverArt?id=${song.coverArt}&size=120`" class="song-cover" fit="cover" lazy>
            <template #error><div class="cover-placeholder"><MfIcon name="Headphones" /></div></template>
          </el-image>
          <div v-else class="cover-placeholder"><MfIcon name="Headphones" /></div>
          <div class="cover-play"><MfIcon name="Play" :size="20" /></div>
        </div>
        <div class="title-meta">
          <div class="song-title" :class="{ 'is-active': isCurrent(song) }">
            {{ song.title }}
            <el-tooltip v-if="song.isMatched === false" :content="song.unavailableReason || '曲库中未找到'" placement="top">
              <MfIcon name="TriangleAlert" class="unmatched-icon" :size="14" />
            </el-tooltip>
          </div>
          <div class="song-bitrate" v-if="showBitrate && song.bitRate">{{ song.bitRate }}kbps · {{ (song.suffix || '').toUpperCase() }}</div>
          <div class="song-mobile-meta">{{ [song.artist, song.album].filter(Boolean).join(' · ') || (song.isMatched === false ? '未匹配' : '—') }}</div>
        </div>
      </span>
      <span v-if="showArtist" class="col col-artist">{{ song.artist || '—' }}</span>
      <span v-if="showAlbum" class="col col-album">{{ song.album || '—' }}</span>
      <span v-if="showPlayedAt" class="col col-played-at">{{ formatPlayedAt(song.playedAt) }}</span>
      <span class="col col-duration">{{ formatDuration(song.duration) }}</span>
      <span class="col col-actions">
        <slot name="row-actions" :row="song" />
        <button class="row-btn" :class="{ active: fav.isFavorite(song.id) }" @click.stop="toggleFavorite(song)" :title="fav.isFavorite(song.id) ? '取消喜欢' : '我喜欢'">
          <MfIcon name="Heart" :filled="fav.isFavorite(song.id)" :size="16" />
        </button>
        <button class="row-btn" @click.stop="openAddToPlaylist(song)" title="添加到歌单">
          <MfIcon name="Plus" :size="16" />
        </button>
        <button class="row-btn" @click.stop="onContext(song, $event)" title="更多操作">
          <MfIcon name="MoreHorizontal" :size="16" />
        </button>
      </span>
    </div>
    </div>

    <div v-if="!loading && songs.length === 0" class="empty-state">
      <MfIcon name="Headphones" :size="48" />
      <p>{{ emptyText || '暂无歌曲' }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, useSlots } from "vue";
import { usePlayerStore } from "@/stores/player";
import { useFavoritesStore } from "@/stores/favorites";
import { useItemActions } from "@/composables/useItemActions";
import { useIsMobile } from "@/composables/useIsMobile";

const props = withDefaults(
  defineProps<{
    songs: any[];
    /** 行号起点（分页时传 (page-1)*pageSize） */
    offset?: number;
    showArtist?: boolean;
    showAlbum?: boolean;
    showBitrate?: boolean;
    /** 历史页显示「播放时间」列 */
    showPlayedAt?: boolean;
    /** 歌单页多选（批量操作） */
    selectable?: boolean;
    loading?: boolean;
    emptyText?: string;
    /** 追加到歌曲右键菜单/操作面板的页面级操作 */
    extraActions?: (row: any) => any[];
    /** 允许点击「曲库中未找到」的行触发 play(由页面自行处理转在线匹配) */
    allowUnmatchedPlay?: boolean;
  }>(),
  {
    songs: () => [],
    offset: 0,
    showArtist: true,
    showAlbum: true,
    showBitrate: true,
    showPlayedAt: false,
    selectable: false,
    loading: false,
    emptyText: "",
    extraActions: undefined,
    allowUnmatchedPlay: false,
  }
);

const emit = defineEmits<{
  (e: "play", song: any): void;
  (e: "select", rows: any[]): void;
}>();

const playerStore = usePlayerStore();
const fav = useFavoritesStore();
const isMobile = useIsMobile();
const { openContextMenu, openActionSheet, menuGuard, songActions, openAddToPlaylist } = useItemActions();

const isCurrent = (song: any) => !!playerStore.currentSong && playerStore.currentSong.id === song.id;

const slots = useSlots();
// Playlist detail injects an extra "remove" row action via #row-actions; widen
// the actions column so those buttons never overlap the duration column.
const hasExtraRowActions = computed(() => !!slots["row-actions"]);

const gridColumns = computed(() => {
  const cols: string[] = [];
  if (props.selectable) cols.push("44px");
  cols.push("56px");
  cols.push("1fr");
  if (props.showArtist) cols.push("180px");
  if (props.showAlbum) cols.push("200px");
  if (props.showPlayedAt) cols.push("160px");
  cols.push("80px");
  cols.push(hasExtraRowActions.value ? "180px" : "90px");
  return cols.join(" ");
});

const selectedIds = ref<Set<string>>(new Set());
const allSelected = computed(() => props.songs.length > 0 && props.songs.every((s) => isSelected(s.id)));
const someSelected = computed(() => props.songs.some((s) => isSelected(s.id)));
function isSelected(id: string) {
  return selectedIds.value.has(id);
}
function emitSelect() {
  const rows = props.songs.filter((s) => isSelected(s.id));
  emit("select", rows);
}
function toggleAll(val: boolean | string | number) {
  if (val) props.songs.forEach((s) => selectedIds.value.add(s.id));
  else props.songs.forEach((s) => selectedIds.value.delete(s.id));
  selectedIds.value = new Set(selectedIds.value);
  emitSelect();
}
function toggleOne(song: any, val: boolean | string | number) {
  if (val) selectedIds.value.add(song.id);
  else selectedIds.value.delete(song.id);
  selectedIds.value = new Set(selectedIds.value);
  emitSelect();
}
watch(
  () => props.songs,
  (rows) => {
    const valid = new Set(rows.map((s) => s.id));
    selectedIds.value = new Set([...selectedIds.value].filter((id) => valid.has(id)));
  }
);

function buildActions(song: any) {
  const acts = songActions(song);
  const extra = props.extraActions;
  if (extra) {
    const list = extra(song) || [];
    if (list.length > 0) {
      acts.push({ divider: true });
      acts.push(...list);
    }
  }
  return acts;
}
function onContext(song: any, e?: MouseEvent) {
  if (e) {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(e, buildActions(song), song.title, [song.artist, song.album].filter(Boolean).join(" · "));
  } else {
    openContextMenu(new MouseEvent("contextmenu"), buildActions(song), song.title, [song.artist, song.album].filter(Boolean).join(" · "));
  }
}
function onLongPress(song: any) {
  openActionSheet(buildActions(song), song.title, [song.artist, song.album].filter(Boolean).join(" · "));
}
function onRowClick(song: any) {
  if (menuGuard()) return;
  emitPlay(song);
}
function emitPlay(song: any) {
  if (song.isMatched === false && !props.allowUnmatchedPlay) return;
  emit("play", song);
}

async function toggleFavorite(song: any) {
  try {
    await fav.toggleFavorite(song.id);
  } catch {
    /* noop */
  }
}

function formatDuration(sec: number) {
  const m = Math.floor((sec || 0) / 60);
  const s = Math.floor((sec || 0) % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
function formatPlayedAt(t: string) {
  if (!t) return "-";
  const d = new Date(t);
  if (isNaN(d.getTime())) return "-";
  return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

// ==================== 虚拟滚动（大列表 windowing）====================
// 桌面端行高固定(64px + margin 2*2 = 68px)才可虚拟化;移动端行高不定且列表
// 通常较短,保持全量渲染。仅 songs > VIRTUAL_THRESHOLD 时启用,小列表零影响。
// 方案:监听最近滚动容器,按 scrollTop 计算可见行区间,前后留 BUFFER 缓冲行,
// 用 padding-top/bottom 占位保持滚动条范围不变(不新增依赖、不改滚动架构)。
const ROW_HEIGHT = 68;
const VIRTUAL_THRESHOLD = 200;
const BUFFER = 6;
const listBodyEl = ref<HTMLElement | null>(null);
const scrollParentEl = ref<HTMLElement | Window | null>(null);
const startIndex = ref(0);
const endIndex = ref(0);
const virtualized = computed(() => !isMobile.value && props.songs.length > VIRTUAL_THRESHOLD);
const visibleSongs = computed(() =>
  virtualized.value ? props.songs.slice(startIndex.value, endIndex.value) : props.songs
);
/** 行号/索引换算:虚拟化时加上窗口起点,保证显示的行号仍是全局序号 */
const rowGlobalIdx = (i: number) => (virtualized.value ? startIndex.value : 0) + i;
const padTop = computed(() => startIndex.value * ROW_HEIGHT);
const padBottom = computed(() => (props.songs.length - endIndex.value) * ROW_HEIGHT);

function findScrollParent(el: HTMLElement | null): HTMLElement | Window {
  let node = el?.parentElement ?? null;
  while (node) {
    const oy = getComputedStyle(node).overflowY;
    if (oy === "auto" || oy === "scroll") return node;
    node = node.parentElement;
  }
  return window;
}

function recomputeWindow() {
  const sp = scrollParentEl.value;
  const body = listBodyEl.value;
  if (!sp || !body) return;
  const isWin = sp === window;
  const scrollTopV = isWin ? window.scrollY : (sp as HTMLElement).scrollTop;
  const vh = isWin ? window.innerHeight : (sp as HTMLElement).clientHeight;
  // 列表相对滚动容器内容坐标系的顶部偏移(行位置 = listTopInSp + i*ROW_HEIGHT)。
  const bodyRect = body.getBoundingClientRect();
  const spTop = isWin ? 0 : (sp as HTMLElement).getBoundingClientRect().top;
  const listTopInSp = bodyRect.top - spTop + scrollTopV;
  const total = props.songs.length;
  const s = Math.max(0, Math.floor((scrollTopV - listTopInSp) / ROW_HEIGHT) - BUFFER);
  const e = Math.min(total, Math.ceil((scrollTopV + vh - listTopInSp) / ROW_HEIGHT) + BUFFER);
  startIndex.value = s;
  endIndex.value = Math.max(e, s);
}

let scrollBound = false;
let scrollHandler: (() => void) | null = null;
function bindScroll() {
  if (scrollBound || !virtualized.value) return;
  const sp = findScrollParent(listBodyEl.value);
  scrollParentEl.value = sp;
  scrollHandler = () => recomputeWindow();
  sp.addEventListener("scroll", scrollHandler, { passive: true });
  window.addEventListener("resize", scrollHandler);
  scrollBound = true;
  recomputeWindow();
}
function unbindScroll() {
  if (!scrollBound) return;
  const sp = scrollParentEl.value;
  if (sp && scrollHandler) {
    sp.removeEventListener("scroll", scrollHandler);
    window.removeEventListener("resize", scrollHandler);
  }
  scrollHandler = null;
  scrollParentEl.value = null;
  scrollBound = false;
}
watch(virtualized, (v) => {
  if (v) bindScroll();
  else {
    unbindScroll();
    startIndex.value = 0;
    endIndex.value = 0;
  }
});
// 列表长度变化(翻页/过滤)后重算窗口,避免停留在越界区间。
watch(() => props.songs.length, () => {
  if (virtualized.value) recomputeWindow();
});

onMounted(() => {
  fav.loadFavorites();
  if (virtualized.value) bindScroll();
});
onBeforeUnmount(unbindScroll);
</script>

<style lang="scss" scoped>
.song-list {
  border-radius: 12px;
  overflow: hidden;
}

.list-header {
  display: grid;
  grid-template-columns: var(--st-cols, 56px 1fr 180px 200px 80px 90px);
  align-items: center;
  padding: 0 16px;
  height: 40px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  color: var(--fnos-text-tertiary);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  background: rgba(255, 255, 255, 0.02);
  .col { padding: 0 8px; }
  .col-duration { text-align: center; }
  .col-actions { text-align: right; }
}

.song-row {
  display: grid;
  grid-template-columns: var(--st-cols, 56px 1fr 180px 200px 80px 90px);
  align-items: center;
  padding: 0 16px;
  height: 64px;
  border-radius: 8px;
  margin: 2px 0;
  cursor: pointer;
  transition: background 0.18s ease;
  color: var(--fnos-text-primary-dim);

  &:hover {
    background: rgba(255, 255, 255, 0.06);
    .col-actions :deep(.row-btn) { opacity: 1; }
    .song-cover-wrap .cover-play { opacity: 1; transform: scale(1); }
    .row-index { display: none; }
    .row-hover-play { display: inline-flex; }
  }
  &.active {
    background: linear-gradient(90deg, rgba(255, 197, 45, 0.18) 0%, rgba(255, 197, 45, 0.03) 100%);
    .row-index { display: none; }
    .row-playing { display: inline-flex; }
    .song-title { color: #ffc52d; }
  }

  .col { padding: 0 8px; min-width: 0; }
  .col-index {
    text-align: center;
    font-size: 14px;
    color: var(--fnos-text-tertiary);
    .row-index { font-variant-numeric: tabular-nums; }
    .row-playing {
      display: none;
      align-items: flex-end;
      justify-content: center;
      gap: 2px;
      height: 16px;
      span {
        display: block;
        width: 3px;
        background: #ffc52d;
        border-radius: 1px;
        animation: st-bar 0.9s ease-in-out infinite;
        &:nth-child(1) { height: 8px; animation-delay: -0.3s; }
        &:nth-child(2) { height: 14px; animation-delay: 0s; }
        &:nth-child(3) { height: 8px; animation-delay: -0.6s; }
      }
    }
    .row-hover-play {
      display: none;
      color: var(--fnos-text-primary);
      font-size: 16px;
    }
  }
  &:hover .row-hover-play { display: inline-flex; }
  .col-title {
    display: flex;
    align-items: center;
    gap: 14px;
    min-width: 0;
    .song-cover-wrap {
      position: relative;
      width: 44px; height: 44px;
      flex-shrink: 0;
      border-radius: 6px;
      overflow: hidden;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
      .song-cover, .cover-placeholder {
        width: 100%; height: 100%;
        object-fit: cover;
        border-radius: 6px;
      }
      .cover-placeholder {
        background: rgba(255, 255, 255, 0.06);
        display: flex; align-items: center; justify-content: center;
        color: rgba(255, 255, 255, 0.4);
      }
      .cover-play {
        position: absolute; inset: 0;
        background: rgba(0, 0, 0, 0.55);
        display: flex; align-items: center; justify-content: center;
        color: #fff;
        opacity: 0;
        transform: scale(0.8);
        transition: opacity 0.18s ease, transform 0.18s ease;
        cursor: pointer;
      }
    }
    .title-meta { min-width: 0; flex: 1; }
    .song-title {
      font-size: 14px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--fnos-text-primary);
      &.is-active { color: #ffc52d; font-weight: 600; }
      .unmatched-icon { color: #e6a23c; margin-left: 6px; vertical-align: middle; }
    }
    .song-mobile-meta { display: none; }
    .song-bitrate {
      font-size: 11px;
      color: var(--fnos-text-muted);
      margin-top: 2px;
      letter-spacing: 0.3px;
    }
  }
  .col-artist, .col-album, .col-played-at {
    font-size: 13px;
    color: var(--fnos-text-tertiary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .col-duration {
    text-align: center;
    font-size: 12px;
    color: var(--fnos-text-tertiary);
    font-variant-numeric: tabular-nums;
  }
  .col-actions {
    display: flex;
    gap: 4px;
    justify-content: flex-end;
    :deep(.row-btn) {
      width: 32px; height: 32px;
      border: none; background: transparent;
      color: var(--fnos-text-tertiary);
      border-radius: 8px;
      cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
      opacity: 0;
      transition: opacity 0.18s, color 0.18s, background 0.18s;
      &:hover { color: var(--fnos-text-primary); background: rgba(255, 255, 255, 0.08); }
      &.active { color: var(--fnos-red); opacity: 1; }
      &.active:hover { color: var(--fnos-red-hover); }
    }
  }
  &.active .col-actions :deep(.row-btn) { opacity: 1; }
}

@keyframes st-bar {
  0%, 100% { transform: scaleY(0.4); }
  50% { transform: scaleY(1); }
}

.empty-state {
  display: flex; flex-direction: column; align-items: center;
  gap: 12px;
  padding: 80px 0;
  color: var(--fnos-text-muted);
  p { margin: 0; font-size: 14px; }
}

@media (max-width: 1100px) {
  .list-header, .song-row {
    grid-template-columns: 48px 1fr 80px 90px !important;
  }
  .col-artist, .col-album, .col-played-at { display: none; }
  .col-actions { display: none !important; }
}

@media (max-width: 768px) {
  .list-header { display: none; }
  .song-row {
    position: relative;
    grid-template-columns: auto 1fr auto !important;
    gap: 10px;
    height: auto;
    min-height: 64px;
    padding: 10px 12px;
    border-radius: 10px;
    margin: 6px 0;
  }
  .song-row .col-index { display: none; }
  .song-row .col-title {
    flex-direction: row;
    gap: 10px;
    .song-cover-wrap { width: 46px; height: 46px; }
    .title-meta {
      .song-title {
        white-space: normal;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        line-clamp: 2;
        font-size: 13px;
      }
      .song-bitrate { display: none; }
      .song-mobile-meta {
        display: block;
        font-size: 11px;
        color: var(--fnos-text-tertiary);
        margin-top: 3px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
    }
  }
  .song-row .col-artist,
  .song-row .col-album,
  .song-row .col-played-at { display: none; }
  .song-row .col-duration {
    font-size: 11px;
    color: var(--fnos-text-tertiary);
    align-self: center;
  }
  .song-row .col-actions { display: none !important; }
  .song-row .col-title .song-cover-wrap .cover-play {
    opacity: 1;
    transform: scale(1);
    inset: auto 0 0 auto;
    background: rgba(0, 0, 0, 0.45);
    border-radius: 6px 0 6px 0;
    padding: 4px;
    width: 20px; height: 20px;
    box-sizing: content-box;
  }
}
</style>
