<template>
  <div class="song-list" :style="{ '--st-cols': gridColumns }" v-loading="loading">
    <div class="list-header" v-if="!isMobile">
      <span v-if="selectable" class="col col-select">
        <el-checkbox :model-value="allSelected" :indeterminate="someSelected" @change="toggleAll" />
      </span>
      <span class="col col-index">#</span>
      <span class="col col-title">{{ t('songTable.title') }}</span>
      <span v-if="showSource" class="col col-source">{{ t('songTable.source') }}</span>
      <span v-if="showArtist" class="col col-artist">{{ t('songTable.artist') }}</span>
      <span v-if="showAlbum" class="col col-album">{{ t('songTable.album') }}</span>
      <span v-if="showPlayedAt" class="col col-played-at">{{ t('songTable.playedAt') }}</span>
      <span class="col col-duration"><MfIcon name="Clock" /></span>
      <span class="col col-actions"></span>
    </div>

    <div class="list-body" ref="listBodyEl" :style="virtualized ? { paddingTop: padTop + 'px', paddingBottom: padBottom + 'px' } : undefined">
    <template v-for="(row, i) in visibleRows" :key="row && row.song ? (row.song.id || `ext-${rowGlobalIdx(i)}`) : `load-${rowGlobalIdx(i)}`">
    <div
      v-if="row"
      class="song-row"
      :class="{
        active: isCurrent(row.song),
        playing: isCurrent(row.song) && playerStore.isPlaying,
        'is-main-row': row.isMain,
        'is-sub-row': !row.isMain && !!row.groupId,
      }"
      @click="onRowClick(row.song)"
      @contextmenu="onContext(row.song, $event)"
      v-longpress="() => onLongPress(row.song)"
    >
      <span v-if="selectable" class="col col-select" @click.stop>
        <el-checkbox :model-value="isSelected(row.song.id)" @change="toggleOne(row.song, $event)" />
      </span>
      <span class="col col-index">
        <span class="row-index">{{ (offset || 0) + rowGlobalIdx(i) + 1 }}</span>
        <span class="row-playing"><span></span><span></span><span></span></span>
        <span class="row-hover-play"><MfIcon name="Play" :size="16" /></span>
      </span>
      <span class="col col-title">
        <div class="song-cover-wrap" @click.stop="emitPlay(row.song)">
          <!-- 用原生 <img loading="lazy"> 而非 el-image:
               - 客户端(MusicFlow-client)用视口内构建+Image.network,Web 端对应
                 行为就是视口内才加载。原生 loading="lazy" 由浏览器 IntersectionObserver
                 驱动,比 el-image 的 useLazyLoad 在 SPA 嵌套滚动容器下判定更可靠
                 (el-image 在专辑详情页的 main 滚动容器下曾不触发请求)。
               - decoding="async" 避免解码阻塞首屏。 -->
          <img
            v-if="row.song.coverArt && !imgErrors.has(row.song.id)"
            :src="coverSrc(row.song)"
            class="song-cover"
            loading="lazy"
            decoding="async"
            referrerpolicy="no-referrer"
            @error="markCoverError(row.song.id)"
          />
          <div v-else class="cover-placeholder"><MfIcon name="Headphones" /></div>
          <div class="cover-play"><MfIcon name="Play" :size="20" /></div>
        </div>
        <div class="title-meta">
          <div class="song-title" :class="{ 'is-active': isCurrent(row.song) }">
            <MfIcon v-if="row.isMain && row.groupId" name="ChevronDown" class="group-caret" :class="{ open: isGroupExpanded(row.groupId) }" :size="14" @click.stop="toggleGroup(row.groupId)" />
            <span class="sub-prefix" v-if="!row.isMain && row.groupId">{{ sourceShortLabel(row.song) }}</span>
            {{ row.song.title }}
            <el-tooltip v-if="row.song.isMatched === false" :content="row.song.unavailableReason || t('songTable.libraryNotFound')" placement="top">
              <MfIcon name="TriangleAlert" class="unmatched-icon" :size="14" />
            </el-tooltip>
          </div>
          <div class="song-bitrate" v-if="showBitrate && row.song.bitRate">{{ row.song.bitRate }}kbps · {{ (row.song.suffix || '').toUpperCase() }}</div>
          <div class="song-mobile-meta">{{ [row.song.artist, row.song.album].filter(Boolean).join(' · ') || (row.song.isMatched === false ? t('songTable.unmatched') : '—') }}</div>
        </div>
      </span>
      <span v-if="showSource" class="col col-source">
        <span
          v-if="row.isMain && row.groupId && row.song.sources && row.song.sources.length > 1"
          class="source-group"
          :class="{ open: isGroupExpanded(row.groupId) }"
          @click.stop="toggleGroup(row.groupId)"
        >
          <span class="source-badge" :style="{ backgroundColor: sourceLabelFor(row.song)!.color }">{{ sourceLabelFor(row.song)!.label }}</span>
          <span class="source-count">{{ isGroupExpanded(row.groupId) ? t('layout.collapse') : '+' + (row.song.sources.length - 1) }}</span>
        </span>
        <template v-else>
          <el-tooltip v-if="sourceLabelFor(row.song)" :content="sourceTooltip(row.song)" placement="top">
            <span class="source-badge" :style="{ backgroundColor: sourceLabelFor(row.song)!.color }">{{ sourceLabelFor(row.song)!.label }}</span>
          </el-tooltip>
          <span v-else class="source-empty">—</span>
        </template>
      </span>
      <span v-if="showArtist" class="col col-artist">{{ row.song.artist || '—' }}</span>
      <span v-if="showAlbum" class="col col-album">{{ row.song.album || '—' }}</span>
      <span v-if="showPlayedAt" class="col col-played-at">{{ formatPlayedAt(row.song.playedAt) }}</span>
      <span class="col col-duration">{{ formatDuration(row.song.duration) }}</span>
      <span class="col col-actions">
        <slot name="row-actions" :row="row.song" />
        <button v-if="!remote" class="row-btn" :class="{ active: fav.isFavorite(row.song.id) }" @click.stop="toggleFavorite(row.song)" :title="fav.isFavorite(row.song.id) ? t('layout.unlike') : t('songTable.like')">
          <MfIcon name="Heart" :filled="fav.isFavorite(row.song.id)" :size="16" />
        </button>
        <button v-if="!remote" class="row-btn" @click.stop="openAddToPlaylist(row.song)" :title="t('layout.addToPlaylist')">
          <MfIcon name="Plus" :size="16" />
        </button>
        <button class="row-btn" @click.stop="onContext(row.song, $event)" :title="t('songTable.moreActions')">
          <MfIcon name="MoreHorizontal" :size="16" />
        </button>
      </span>
    </div>
    <div v-else class="song-row is-loading">
      <span v-if="selectable" class="col col-select"></span>
      <span class="col col-index"><span class="row-index">{{ (offset || 0) + rowGlobalIdx(i) + 1 }}</span></span>
      <span class="col col-title"><span class="loading-bar"></span></span>
      <span v-if="showSource" class="col col-source">–</span>
      <span v-if="showArtist" class="col col-artist"><span class="loading-bar short"></span></span>
      <span v-if="showAlbum" class="col col-album"><span class="loading-bar"></span></span>
      <span v-if="showPlayedAt" class="col col-played-at">–</span>
      <span class="col col-duration">–</span>
      <span class="col col-actions"></span>
    </div>
    </template>
    </div>

    <div v-if="!loading && songs.length === 0" class="empty-state">
      <MfIcon name="Headphones" :size="48" />
      <p>{{ emptyText || t('songTable.empty') }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, useSlots } from "vue";
import { useI18n } from "vue-i18n";
import { usePlayerStore } from "@/stores/player";
import { useFavoritesStore } from "@/stores/favorites";
import { useItemActions } from "@/composables/useItemActions";
import { useIsMobile } from "@/composables/useIsMobile";
import { coverUrl } from "@/utils/cover";
import api from "@/api";

const props = withDefaults(
  defineProps<{
    songs: any[];
    /** 行号起点（分页时传 (page-1)*pageSize） */
    offset?: number;
    showArtist?: boolean;
    showAlbum?: boolean;
    showBitrate?: boolean;
    /** 音乐库页面显示「来源」列(web 歌曲:插件·平台徽标) */
    showSource?: boolean;
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
    /** 远程(未入库)搜索结果行:封面用远程 URL、隐藏「喜欢/加歌单」等依赖库内 id 的按钮 */
    remote?: boolean;
    /**
     * 无限滚动(窗口化加载)模式下的窗口回调:虚拟列表每次重算可见行区间后调用,
     * 由父级 useInfiniteList 据此按块预取 + 剪枝。传入后本表即视为「全长稀疏数组」,
     * 未加载槽位(songs[i] === undefined)渲染为占位行。
     */
    onWindow?: (start: number, end: number) => void;
  }>(),
  {
    songs: () => [],
    offset: 0,
    showArtist: true,
    showAlbum: true,
    showBitrate: true,
    showSource: false,
    showPlayedAt: false,
    selectable: false,
    loading: false,
    emptyText: "",
    extraActions: undefined,
    allowUnmatchedPlay: false,
    remote: false,
    onWindow: undefined,
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

const { t } = useI18n();

const isCurrent = (song: any) => !!playerStore.currentSong && playerStore.currentSong.id === song.id;

// 封面地址:远程行(remote 或 coverArt 是完整 URL)直接用远程 URL,库内歌曲走后端取封
function coverSrc(song: any): string {
  if (!song.coverArt) return "";
  if (props.remote || /^https?:\/\//i.test(song.coverArt)) return song.coverArt;
  return coverUrl(song.coverArt, 120);
}

// ==================== 来源列(web 歌曲:插件 · 平台徽标)====================
// 平台中文名优先取已启用插件 manifest.platformLabels(合并),缺省走内置兜底映射;
// 品牌色固定内置(manifest 不提供颜色)。插件 id → 插件名映射同样来自插件注册表。
const FALLBACK_PLATFORMS: Record<string, { label: string; color: string }> = {
  netease: { label: "platform.netease", color: "#e21a1a" },
  qq: { label: "platform.qq", color: "#12b7f5" },
  kugou: { label: "platform.kugou", color: "#28c76f" },
  kuwo: { label: "platform.kuwo", color: "#ff7f27" },
  migu: { label: "platform.migu", color: "#f26d21" },
  qianqian: { label: "platform.qianqian", color: "#8e44ad" },
  soda: { label: "platform.soda", color: "#00b8a9" },
  fivesing: { label: "5sing", color: "#4aa3df" },
  jamendo: { label: "Jamendo", color: "#7f8c8d" },
  joox: { label: "JOOX", color: "#ff4d4d" },
  bilibili: { label: "Bilibili", color: "#fb7299" },
  apple: { label: "Apple Music", color: "#fa57c1" },
};
// i18n keys referenced by FALLBACK_PLATFORMS (translated at render; non-key labels pass through)
const FALLBACK_PLATFORM_LABEL_KEYS = new Set(
  Object.values(FALLBACK_PLATFORMS).map((p) => p.label).filter((k) => k.startsWith("platform."))
);
// 模块级缓存:整页共享,只拉一次 /rest/api/v1/plugins
let platformLabelsCache: Record<string, string> | null = null;
let pluginNamesCache: Record<string, string> | null = null;
async function ensurePluginMeta() {
  if (platformLabelsCache && pluginNamesCache) return;
  try {
    const res = await api.get("/rest/api/v1/plugins");
    const labels: Record<string, string> = {};
    const names: Record<string, string> = {};
    for (const p of (res.data || []) as any[]) {
      const m = p.manifest;
      if (m?.id) names[m.id] = m.name || m.id;
      if (m?.platformLabels) Object.assign(labels, m.platformLabels);
    }
    platformLabelsCache = labels;
    pluginNamesCache = names;
  } catch {
    platformLabelsCache = {};
    pluginNamesCache = {};
  }
}
function sourceMeta(song: any): { label: string; color: string; pluginName: string } | null {
  const src = (song.sourcePlatform || "").toLowerCase();
  if (!src || !song.isWeb) return null;
  const mergedLabel = platformLabelsCache?.[src] || "";
  const base = FALLBACK_PLATFORMS[src] || { label: src, color: "rgba(0,0,0,.55)" };
  // mergedLabel is a plugin-provided display name (pass through); base.label is an i18n key (translate).
  const label = mergedLabel || (FALLBACK_PLATFORM_LABEL_KEYS.has(base.label) ? t(base.label) : base.label);
  return {
    label,
    color: base.color,
    pluginName: pluginNamesCache?.[song.sourcePluginId] || song.sourcePluginId || "",
  };
}
function sourceTooltip(song: any): string {
  const meta = sourceMeta(song);
  if (!meta) return "";
  return meta.pluginName ? `${meta.pluginName} · ${meta.label}` : meta.label;
}

// 行来源标签:本地/WebDAV 用固定标签,web 走平台徽标(sourceMeta)。
// 合并主行/子行与单源行的来源列统一走这里(行类型 local | webdav | web)。
function sourceLabelFor(song: any): { label: string; color: string } | null {
  const st = song?.type || song?.rowType || "local";
  if (st === "local") return { label: t("songTable.localSource"), color: "#3f7ef0" };
  if (st === "webdav") return { label: "WebDAV", color: "#2ea46c" };
  return sourceMeta(song);
}
// 展开子行标题前缀的短标签(仅本地/WebDAV 显示,web 子行徽标已在其来源列)
function sourceShortLabel(song: any): string {
  const st = song?.type || song?.rowType || "local";
  if (st === "local") return t("songTable.localSource");
  if (st === "webdav") return "WebDAV";
  return "";
}

// ==================== 同曲多源合并展示 ====================
// 后端序列化时组内成员行都带 sources(组内全部源,local > webdav > web)。
// 组内多源(>1)时合并为一行主行(主行 = sources[0],核心曲库优先),来源标签
// 显示「主源 +N」,点击展开/收起子行(每行可单独播放/删除)。单源行保持原样。
// 仅 showSource 且非移动端启用;虚拟滚动模式在窗口切片内合并(组内成员行可能
// 分布在未加载块,靠 sources 元数据仍能正确显示主行/子行)。
const expandedGroups = ref<Set<string>>(new Set());
function toggleGroup(groupId: string) {
  const next = new Set(expandedGroups.value);
  if (next.has(groupId)) next.delete(groupId);
  else next.add(groupId);
  expandedGroups.value = next;
}
function isGroupExpanded(groupId?: string) {
  return !!groupId && expandedGroups.value.has(groupId);
}

interface DisplayRow {
  song: any;
  isMain: boolean;
  groupId?: string;
}

// 显示行:组内多源合并(主行 + 可选展开子行),undefined 槽位保留给加载占位。
// 非合并模式(remote/未开来源列/移动端)返回原行,行为与旧版完全一致。
const displayRows = computed<Array<DisplayRow | undefined>>(() => {
  const merging = props.showSource && !isMobile.value;
  const source = virtualized.value ? props.songs.slice(startIndex.value, endIndex.value) : props.songs;
  // 非 merging 模式也必须包成 DisplayRow:模板统一按 row.song 取值,
  // 直接返回裸 song 会让 row.song 变 undefined 导致整表渲染崩溃(v1.13.19 回归)。
  if (!merging) return (source as any[]).map((s) => (s ? { song: s, isMain: false } : undefined));
  const out: Array<DisplayRow | undefined> = [];
  const seen = new Set<string>();
  for (const s of source) {
    if (!s) { out.push(undefined); continue; }
    if (seen.has(s.id)) continue;
    const sources = Array.isArray(s.sources) && s.sources.length > 1 ? s.sources : null;
    if (sources) {
      const main = sources[0];
      const gid = main.groupId || s.groupId || "";
      out.push({ song: main, isMain: true, groupId: gid });
      for (const m of sources) seen.add(m.id);
      if (gid && isGroupExpanded(gid)) {
        for (let k = 1; k < sources.length; k++) out.push({ song: sources[k], isMain: false, groupId: gid });
      }
    } else {
      out.push({ song: s, isMain: false });
      seen.add(s.id);
    }
  }
  return out;
});

const slots = useSlots();
// Playlist detail injects an extra "remove" row action via #row-actions; widen
// the actions column so those buttons never overlap the duration column.
const hasExtraRowActions = computed(() => !!slots["row-actions"]);

const gridColumns = computed(() => {
  const cols: string[] = [];
  if (props.selectable) cols.push("44px");
  cols.push("56px");
  cols.push("1fr");
  if (props.showSource) cols.push("92px");
  if (props.showArtist) cols.push("180px");
  if (props.showAlbum) cols.push("200px");
  if (props.showPlayedAt) cols.push("160px");
  cols.push("80px");
  cols.push(hasExtraRowActions.value ? "180px" : "90px");
  return cols.join(" ");
});

const selectedIds = ref<Set<string>>(new Set());
// 行内封面加载失败的 song.id:改用 .cover-placeholder 兜底,避免空白/裂图。
const imgErrors = ref<Set<string>>(new Set());
function markCoverError(id: string) {
  if (imgErrors.value.has(id)) return;
  const next = new Set(imgErrors.value);
  next.add(id);
  imgErrors.value = next;
}
// 无限滚动模式下 songs 是全长稀疏数组,可能存在 undefined 未加载槽位,一律跳过。
const filledSongs = computed(() => props.songs.filter((s) => !!s));
const allSelected = computed(() => filledSongs.value.length > 0 && filledSongs.value.every((s) => isSelected(s.id)));
const someSelected = computed(() => filledSongs.value.some((s) => isSelected(s.id)));
function isSelected(id: string) {
  return selectedIds.value.has(id);
}
function emitSelect() {
  const rows = filledSongs.value.filter((s) => isSelected(s.id));
  emit("select", rows);
}
function toggleAll(val: boolean | string | number) {
  if (val) filledSongs.value.forEach((s) => selectedIds.value.add(s.id));
  else filledSongs.value.forEach((s) => selectedIds.value.delete(s.id));
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
    const valid = new Set(rows.filter((s) => !!s).map((s) => s.id));
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
// 桌面端行高固定(64px + margin 2*2 = 68px)、移动端行高不定且较长;超过阈值即虚拟化,
// 用 padding-top/bottom 占位保持滚动条范围不变(不新增依赖、不改滚动架构)。
// 移动端行高取偏大的估值 + 缓冲行,避免行重叠;小列表(< 阈值)保持全量渲染零影响。
const rowH = computed(() => (isMobile.value ? 96 : 68));
const VIRTUAL_THRESHOLD = 200;
const BUFFER = 6;
const listBodyEl = ref<HTMLElement | null>(null);
const scrollParentEl = ref<HTMLElement | Window | null>(null);
const startIndex = ref(0);
const endIndex = ref(0);
const virtualized = computed(() => props.songs.length > VIRTUAL_THRESHOLD);
// 显示行 = displayRows(窗口切片 + 同曲多源合并);窗口/padding 仍按 props.songs
// 原始索引计算(虚拟滚动范围不变,合并后行数略少 → 底部少量留白,无碍)。
const visibleRows = computed(() => displayRows.value);
/** 行号/索引换算:虚拟化时加上窗口起点,保证显示的行号仍是全局序号 */
const rowGlobalIdx = (i: number) => (virtualized.value ? startIndex.value : 0) + i;
const padTop = computed(() => startIndex.value * rowH.value);
const padBottom = computed(() => (props.songs.length - endIndex.value) * rowH.value);

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
  const s = Math.max(0, Math.floor((scrollTopV - listTopInSp) / rowH.value) - BUFFER);
  const e = Math.min(total, Math.ceil((scrollTopV + vh - listTopInSp) / rowH.value) + BUFFER);
  startIndex.value = s;
  endIndex.value = Math.max(e, s);
  // 无限滚动模式:把可见行区间交给父级窗口化加载器(按块预取 + 剪枝)。
  if (props.onWindow) props.onWindow(s, Math.max(e, s));
}

let scrollBound = false;
let scrollHandler: (() => void) | null = null;
const raf = { id: 0 };
// 与 useCardGrid 同款:滚动事件合并到一帧一次 recompute,避免快速滚动时
// 每个 scroll tick 都触发窗口重算/预取调用(拖拽/惯性滚动尤其频繁)。
function scheduleRecompute() {
  if (raf.id) return;
  raf.id = requestAnimationFrame(() => {
    raf.id = 0;
    recomputeWindow();
  });
}
function bindScroll() {
  if (scrollBound || !virtualized.value) return;
  const sp = findScrollParent(listBodyEl.value);
  scrollParentEl.value = sp;
  scrollHandler = () => scheduleRecompute();
  sp.addEventListener("scroll", scrollHandler, { passive: true });
  window.addEventListener("resize", scrollHandler);
  scrollBound = true;
  scheduleRecompute();
}
function unbindScroll() {
  if (!scrollBound) return;
  const sp = scrollParentEl.value;
  if (sp && scrollHandler) {
    sp.removeEventListener("scroll", scrollHandler);
    window.removeEventListener("resize", scrollHandler);
  }
  if (raf.id) cancelAnimationFrame(raf.id);
  raf.id = 0;
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
  void ensurePluginMeta();
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
  .col-source {
    .source-badge {
      display: inline-block;
      padding: 2px 9px;
      border-radius: 10px;
      color: #fff;
      font-size: 11px;
      font-weight: 600;
      line-height: 16px;
      white-space: nowrap;
      box-shadow: 0 1px 3px rgba(0, 0, 0, .3);
    }
    .source-empty { font-size: 12px; color: var(--fnos-text-tertiary); }
    // 同曲多源主行的「主源 +N」展开按钮
    .source-group {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
      padding: 1px 6px 1px 2px;
      border-radius: 12px;
      transition: background 0.15s;
      &:hover { background: rgba(255, 255, 255, 0.08); }
      &.open { background: rgba(255, 255, 255, 0.08); }
      .source-count {
        font-size: 11px;
        font-weight: 600;
        color: var(--fnos-text-secondary);
        white-space: nowrap;
      }
    }
  }
  // 展开的子行(同曲其它来源):视觉降级,来源徽标明确展示各平台
  &.is-sub-row {
    background: rgba(255, 255, 255, 0.02);
    .song-title { color: var(--fnos-text-secondary); font-weight: 400; }
    .col-source { padding-left: 12px; }
  }
  // 主行标题前的组展开箭头
  .group-caret {
    color: var(--fnos-text-tertiary);
    vertical-align: -2px;
    cursor: pointer;
    transition: transform 0.15s;
    &.open { transform: rotate(180deg); }
    &:hover { color: var(--fnos-text-primary); }
  }
  .sub-prefix {
    font-size: 11px;
    font-weight: 600;
    color: var(--fnos-text-muted);
    margin-right: 4px;
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

// 无限滚动:未加载槽位的占位行(灰条骨架,等待对应块到达后替换)。
.song-row.is-loading {
  .col { display: flex; align-items: center; }
  .col-title { padding-left: 8px; }
}
.loading-bar {
  display: inline-block;
  height: 12px;
  width: 40%;
  max-width: 240px;
  border-radius: 6px;
  background: linear-gradient(90deg, var(--fnos-bg-muted, rgba(128,128,128,.12)) 25%, rgba(128,128,128,.22) 37%, var(--fnos-bg-muted, rgba(128,128,128,.12)) 63%);
  background-size: 400% 100%;
  animation: st-loading 1.2s ease-in-out infinite;
  &.short { width: 22%; }
}
@keyframes st-loading {
  0% { background-position: 100% 0; }
  100% { background-position: 0 0; }
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
  .col-artist, .col-album, .col-source, .col-played-at { display: none; }
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
