<template>
  <div class="albums-page">
    <div class="page-header">
      <h2>专辑</h2>
      <el-input v-model="searchQuery" placeholder="搜索专辑..." prefix-icon="Search" clearable style="width: 300px" @input="onSearchInput" @clear="onSearchClear" />
    </div>
    <div class="album-grid" v-loading="loading">
      <div class="album-card" v-for="album in albums" :key="album.id" @click="router.push(`/albums/${album.id}`)">
        <div class="album-cover">
          <img v-if="album.coverArt" :src="`/rest/getCoverArt?id=${album.coverArt}&size=300`" />
          <div v-else class="cover-placeholder"><el-icon :size="48"><Service /></el-icon></div>
        </div>
        <div class="album-info">
          <div class="album-name">{{ album.name }}</div>
          <div class="album-artist">{{ album.artist }}</div>
          <div class="album-meta">{{ album.year || '' }} {{ album.songCount }}首</div>
        </div>
      </div>
    </div>
    <div class="pagination-bar">
      <el-pagination
        layout="total, sizes, prev, pager, next, jumper"
        :total="total"
        :page-size="pageSize"
        :page-sizes="[15, 25, 50, 100]"
        :current-page="currentPage"
        background
        @current-change="onPageChange"
        @size-change="onSizeChange"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRouter } from "vue-router";
import { Service as Disc } from "@element-plus/icons-vue";
import api from "@/api";

const router = useRouter();
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

function onPageChange(page: number) { currentPage.value = page; loadAlbums(); }

function onSizeChange(size: number) {
  pageSize.value = size;
  localStorage.setItem("albumsPageSize", String(size));
  currentPage.value = 1;
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
.albums-page { padding: 24px; }
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; h2 { font-size: 24px; font-weight: 600; } }
.album-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 20px; }
.album-card { cursor: pointer; border-radius: 8px; overflow: hidden; background: #fff; box-shadow: 0 2px 8px rgba(0,0,0,0.08); transition: transform 0.2s, box-shadow 0.2s;
  &:hover { transform: translateY(-4px); box-shadow: 0 4px 16px rgba(0,0,0,0.12); }
  .album-cover { aspect-ratio: 1; overflow: hidden;
    img { width: 100%; height: 100%; object-fit: cover; }
    .cover-placeholder { width: 100%; height: 100%; background: #f0f0f0; display: flex; align-items: center; justify-content: center; color: #ccc; }
  }
  .album-info { padding: 12px;
    .album-name { font-weight: 500; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .album-artist { font-size: 12px; color: #999; margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .album-meta { font-size: 11px; color: #bbb; margin-top: 2px; }
  }
}
.pagination-bar { margin-top: 24px; display: flex; justify-content: center; }
</style>