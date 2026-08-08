<template>
  <div class="albums-page">
    <div class="page-header">
      <h2>专辑</h2>
      <el-input v-model="searchQuery" placeholder="搜索专辑..." prefix-icon="Search" clearable style="width: 300px" @input="onSearchInput" @clear="onSearchClear" />
    </div>
    <div class="album-grid" v-loading="loading">
      <div
        class="album-card fnos-card-sheen"
        v-for="(album, idx) in albums"
        :key="album.id"
        :style="{ '--stagger': idx }"
        @contextmenu="openContextMenu($event, albumActions(album), album.name, albumMeta(album))"
        v-longpress="() => openActionSheet(albumActions(album), album.name, albumMeta(album))"
      >
        <div class="album-cover mf-coverwrap" @click="open(album)">
          <img v-if="album.coverArt" :src="`/rest/getCoverArt?id=${album.coverArt}&size=300`" loading="lazy" decoding="async" />
          <div v-else class="cover-placeholder"><MfIcon name="Disc3" :size="48"  /></div>
          <CoverPlay size="md" :label="`播放 ${album.name}`" :action="() => playAl(album)" />
        </div>
        <div class="album-info" @click="open(album)">
          <div class="album-name">{{ album.name }}</div>
          <div class="album-artist">{{ album.artist }}</div>
          <div class="album-meta">{{ album.year || '' }} {{ album.songCount }}首</div>
        </div>
      </div>
    </div>
    <div class="pagination-bar">
      <PagePagination :total="total" :page="currentPage" :page-size="pageSize" storage-key="albumsPageSize" @change="onPageChange" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import CoverPlay from "@/components/CoverPlay.vue";
import PagePagination from "@/components/PagePagination.vue";
import { useItemActions } from "@/composables/useItemActions";
import { usePlayContent } from "@/composables/usePlayContent";
import api from "@/api";

const router = useRouter();
const { openContextMenu, openActionSheet, menuGuard, albumActions } = useItemActions();
const play = usePlayContent();

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
const albums = ref<any[]>([]);
const loading = ref(false);
const searchQuery = ref("");
const currentPage = ref(1);
const total = ref(0);
const pageSize = ref(parseInt(localStorage.getItem("albumsPageSize") || "25"));
if (![15, 25, 50, 100].includes(pageSize.value)) pageSize.value = 25;

let searchTimer: ReturnType<typeof setTimeout> | null = null;

async function loadAlbums() {
  loading.value = true;
  try {
    const res = await api.get("/rest/api/v1/albums", {
      params: { page: currentPage.value, pageSize: pageSize.value, query: searchQuery.value },
    });
    albums.value = res.data.items || [];
    total.value = res.data.total || 0;
  } catch { albums.value = []; total.value = 0; }
  finally { loading.value = false; }
}

function onPageChange(page: number, size?: number) {
  currentPage.value = page;
  if (size) pageSize.value = size;
  loadAlbums();
}

function onSearchInput() {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { currentPage.value = 1; loadAlbums(); }, 300);
}

function onSearchClear() { currentPage.value = 1; loadAlbums(); }

onMounted(loadAlbums);
</script>

<style lang="scss" scoped>
.albums-page { padding: 24px 32px 130px; max-width: 1400px; margin: 0 auto; }
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; flex-wrap: wrap; gap: 12px; h2 { font-size: 28px; font-weight: 700; margin: 0; } }
.album-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 20px; }
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
.pagination-bar { margin-top: 24px; display: flex; justify-content: center; }
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