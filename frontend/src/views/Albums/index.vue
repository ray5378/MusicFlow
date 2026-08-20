<template>
  <div class="albums-page">
    <div class="page-header">
      <h2>专辑</h2>
      <div class="header-actions">
        <span class="search-label">搜索</span>
        <el-dropdown trigger="click" @command="onSearchSourceCommand">
          <el-button>
            {{ currentSourceLabel }}
            <el-icon class="el-icon--right"><MfIcon name="ChevronDown" /></el-icon>
          </el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="local">本地</el-dropdown-item>
              <el-dropdown-item v-for="(p, i) in searchProviders" :key="p.id" :command="p.id" :divided="i === 0">{{ p.name }}</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-input v-model="searchQuery" :placeholder="searchPlaceholder" prefix-icon="Search" clearable style="width: 300px" @input="onSearchInput" @clear="onSearchClear" />
      </div>
    </div>
    <div class="album-grid" v-if="isLocalMode" ref="gridEl" v-loading="loading">
      <template v-for="g in gridViews" :key="g.item ? g.item.id : 'ph-' + g.idx">
      <div
        v-if="g.item"
        class="album-card fnos-card-sheen"
        :style="{ '--stagger': g.idx }"
        @contextmenu="openContextMenu($event, albumActions(g.item), g.item.name, albumMeta(g.item))"
        v-longpress="() => openActionSheet(albumActions(g.item), g.item.name, albumMeta(g.item))"
      >
        <div class="album-cover mf-coverwrap" @click="open(g.item)">
          <img v-if="g.item.coverArt" :src="coverUrl(g.item.coverArt)" loading="lazy" decoding="async" />
          <div v-else class="cover-placeholder"><MfIcon name="Disc3" :size="48"  /></div>
          <CoverPlay size="md" :label="`播放 ${g.item.name}`" :action="() => playAl(g.item)" />
        </div>
        <div class="album-info" @click="open(g.item)">
          <div class="album-name">{{ g.item.name }}</div>
          <div class="album-artist">{{ g.item.artist }}</div>
          <div class="album-meta">{{ g.item.year || '' }} {{ g.item.songCount }}首</div>
        </div>
      </div>
      <div v-else class="album-card is-placeholder">
        <div class="album-cover ph-cover"></div>
        <div class="album-placeholder"><span class="ph-bar"></span><span class="ph-bar short"></span></div>
      </div>
      </template>
    </div>

    <!-- 远程搜索结果(插件模式):由启用的 albumSearch 插件(如 go-music-dl)提供,可「加入库」为专辑歌单 -->
    <div v-else-if="isRemoteMode" class="remote-results" v-loading="remoteSearching">
      <div v-if="remoteItems.length === 0 && !remoteSearching" class="remote-empty">
        <MfIcon name="Disc3" :size="40" />
        <p>{{ searchQuery.trim() ? "没有找到相关专辑" : `输入关键词,搜索${currentProviderName}支持的全网专辑` }}</p>
      </div>
      <div v-else class="album-grid">
        <div class="album-card fnos-card-sheen" v-for="(item, i) in remoteItems" :key="i">
          <div class="album-cover mf-coverwrap" @click="openRemote(item)">
            <img v-if="item.cover" :src="item.cover" loading="lazy" decoding="async" referrerpolicy="no-referrer" />
            <div v-else class="cover-placeholder"><MfIcon name="Disc3" :size="48" /></div>
            <span class="remote-source-tag">{{ item.platformLabel }}</span>
            <CoverPlay size="md" :label="`播放 ${item.name}`" :action="() => playRemoteAl(item)" />
          </div>
          <div class="album-info" @click="openRemote(item)">
            <div class="album-name">{{ item.name }}</div>
            <div class="album-artist">{{ item.artist }}</div>
            <div class="album-meta">{{ item.year || "" }} {{ item.trackCount ? item.trackCount + "首" : "" }}</div>
          </div>
          <el-button
            class="remote-import-btn"
            size="small"
            type="primary"
            :loading="importingId === item.source + ':' + item.id"
            :disabled="item._imported"
            @click="importAlbum(item)"
          >{{ item._imported ? "已加入库" : "加入库" }}</el-button>
        </div>
      </div>

      <!-- 远程专辑详情:点击卡片 → 预览专辑歌曲(未入库也可播放/加入库) -->
      <RemoteDetailDialog
        v-model="remoteDetailVisible"
        kind="album"
        :provider-id="searchMode"
        :item="remoteDetailItem"
        @imported="loadAlbums"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import CoverPlay from "@/components/CoverPlay.vue";
import RemoteDetailDialog from "@/components/RemoteDetailDialog.vue";
import { useItemActions } from "@/composables/useItemActions";
import { usePlayContent } from "@/composables/usePlayContent";
import { useEntitySearch, playRemoteCollection } from "@/composables/useEntitySearch";
import { useCardGrid } from "@/composables/useCardGrid";
import api from "@/api";
import { coverUrl } from "@/utils/cover";

const router = useRouter();
const { openContextMenu, openActionSheet, menuGuard, albumActions } = useItemActions();
const play = usePlayContent();

// 远程搜索共享逻辑(本地/插件搜索来源下拉):插件没声明 albumSearch 就不出现在下拉里
const {
  searchMode, searchProviders, remoteItems, remoteSearching, importingId,
  isLocalMode, isRemoteMode, currentProviderName, currentSourceLabel,
  loadSearchProviders, onSearchSourceCommand, doRemoteSearch, importAlbum,
  setLocalLoader, setAfterRemoteImport,
} = useEntitySearch("album");
const searchPlaceholder = computed(() =>
  isRemoteMode.value ? `搜索${currentProviderName}全网专辑...` : "搜索专辑...",
);

function open(album: any) {
  if (menuGuard()) return;
  router.push(`/albums/${album.id}`);
}
function albumMeta(album: any) {
  return [album.artist, album.year, album.songCount ? `${album.songCount} 首` : ""]
    .filter(Boolean)
    .join(" · ");
}
async function playAl(album: any) {
  if (menuGuard()) return;
  const n = await play.playAlbum(album.id);
  if (n) ElMessage.success(`正在播放「${album.name}」`);
  else ElMessage.warning("该专辑暂无可播放歌曲");
}

// ===== 远程专辑:悬浮播放(未入库直接播) + 点击卡片看详情 =====
const remoteDetailVisible = ref(false);
const remoteDetailItem = ref<any>(null);
function openRemote(item: any) {
  if (menuGuard()) return;
  remoteDetailItem.value = item;
  remoteDetailVisible.value = true;
}
async function playRemoteAl(item: any) {
  if (menuGuard()) return;
  const n = await playRemoteCollection("album", searchMode.value, item);
  if (n) ElMessage.success(`正在播放「${item.name}」`);
  else ElMessage.warning("该专辑暂无可播放歌曲");
}
// 本地专辑网格:窗口化分块加载(与 HA 卡片同构),整页展示 + 滚动懒加载 + 越界剪枝。
const cardGrid = useCardGrid<any>(
  async (offset, size) => {
    const page = Math.floor(offset / size) + 1;
    const res = await api.get("/rest/api/v1/albums", {
      params: { page, pageSize: size, query: searchQuery.value },
    });
    return { items: res.data.items || [], total: res.data.total || 0 };
  },
  { chunk: 60, keepRows: 80, prefetchBlocks: 1, concurrency: 2, minTileWidth: 180, gap: 20, coverRatio: 1, rowFooter: 80 }
);
const gridEl = cardGrid.gridEl;
const loading = cardGrid.loading;
const gridViews = computed(() => {
  const start = cardGrid.startIndex.value;
  const end = cardGrid.endIndex.value;
  const arr: { idx: number; item: any }[] = [];
  for (let i = Math.max(0, start); i < end; i++) arr.push({ idx: i, item: cardGrid.list.value[i] });
  return arr;
});
const searchQuery = ref("");
let searchTimer: ReturnType<typeof setTimeout> | null = null;

// 重新拉取本地专辑(窗口化)。
async function loadAlbums() { cardGrid.reload(); }

function onSearchInput() {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if (isRemoteMode.value) doRemoteSearch(searchQuery.value);
    else loadAlbums();
  }, 300);
}

function onSearchClear() {
  if (isRemoteMode.value) { doRemoteSearch(searchQuery.value); return; }
  loadAlbums();
}

// 切到插件搜索模式时,若已有关键词立即搜;切回本地由 composable 触发 localLoader
watch(() => searchMode.value, () => {
  if (isRemoteMode.value && searchQuery.value.trim()) doRemoteSearch(searchQuery.value);
});

onMounted(() => {
  setLocalLoader(loadAlbums);
  setAfterRemoteImport(loadAlbums); // 「加入库」成功后刷新本地列表
  loadSearchProviders();
  loadAlbums();
  nextTick(() => cardGrid.bindGrid());
});

// 首块拉到总数后重算一次可见窗口;之后由滚动驱动。
watch(cardGrid.total, (t) => { if (t > 0) cardGrid.recomputeGrid(); });
</script>

<style lang="scss" scoped>
.albums-page { padding: 24px 32px 130px; max-width: 1400px; margin: 0 auto; }
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; flex-wrap: wrap; gap: 12px; h2 { font-size: 28px; font-weight: 700; margin: 0; } .header-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; } }
.search-label { font-size: 14px; color: var(--fnos-text-secondary); margin-right: 2px; white-space: nowrap; }
.remote-results {
  .remote-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 60px 0; color: var(--fnos-text-tertiary); font-size: 13px; }
  .remote-source-tag {
    position: absolute; top: 8px; left: 8px; z-index: 2;
    padding: 2px 8px; border-radius: 6px; font-size: 11px;
    background: rgba(0,0,0,0.55); color: #fff; backdrop-filter: blur(4px);
  }
  .remote-import-btn { position: absolute; right: 8px; bottom: 8px; z-index: 2; }
}
.album-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 20px; }
.album-card.is-placeholder {
  cursor: default;
  .ph-cover { aspect-ratio: 1; border-radius: var(--fnos-radius-lg); background: linear-gradient(90deg, rgba(255,255,255,0.05) 25%, rgba(255,255,255,0.1) 37%, rgba(255,255,255,0.05) 63%); background-size: 400% 100%; animation: mf-ph 1.2s ease-in-out infinite; }
  .album-placeholder { padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 8px;
    .ph-bar { height: 12px; width: 60%; border-radius: 6px; background: rgba(255,255,255,0.08);
      &.short { width: 40%; }
    }
  }
}
@keyframes mf-ph { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }
.album-card {
  cursor: pointer;
  border-radius: var(--fnos-radius-lg);
  overflow: hidden;
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.06);
  transition: transform 0.22s ease, background 0.22s ease, box-shadow 0.22s ease;
  animation: home-card-in 0.45s ease backwards;  /* backwards: 动画结束后回退到元素常态（无 transform 残留），both 会保持 translateY(0) 终态形成永久 stacking context，旧 Chromium 上可能穿透 fixed 弹窗 */
  animation-delay: min(calc(var(--stagger, 0) * 0.03s), 0.6s);
  &:hover { transform: translateY(-5px); background: rgba(255,255,255,0.08); box-shadow: 0 14px 34px rgba(0,0,0,0.4); }
  &:active { transform: translateY(-2px) scale(0.98); }
  .album-cover { aspect-ratio: 1; overflow: hidden; position: relative;
    img { width: 100%; height: 100%; object-fit: cover; transition: transform 0.45s ease; }
    .cover-placeholder { width: 100%; height: 100%; background: rgba(255,255,255,0.06); display: flex; align-items: center; justify-content: center; color: var(--fnos-text-muted); }
  }
  &:hover .album-cover img { transform: scale(1.05); }
  .album-info:hover .album-name { color: var(--fnos-red); }
  .album-info { padding: 12px 14px 14px;
    .album-name { font-weight: 500; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fnos-text-primary); transition: color 0.18s ease; }
    .album-artist { font-size: 12px; color: var(--fnos-text-tertiary); margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .album-meta { font-size: 11px; color: var(--fnos-text-muted); margin-top: 2px; }
  }
}
@keyframes home-card-in {
  from { opacity: 0; transform: translateY(14px); }
  to   { opacity: 1; transform: translateY(0); }
}

@media (max-width: 768px) {
  .albums-page { padding: 20px 16px; }
  .page-header { flex-direction: column; align-items: flex-start; }
  .page-header .el-input { width: 100% !important; flex: 1; }
  .album-grid { grid-template-columns: repeat(2, 1fr); gap: 14px; }
  .album-card .album-info { padding: 10px 10px 12px; }
  .album-card .album-info .album-name { font-size: 13px; }
  /* 移动端只保留专辑名 + 艺术家，年份/曲目数收进长按面板 */
  .album-card .album-info .album-meta { display: none; }
}
</style>