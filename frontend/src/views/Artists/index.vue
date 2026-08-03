<template>
  <div class="artists-page">
    <div class="page-header">
      <h2>艺术家</h2>
      <el-input v-model="searchQuery" placeholder="搜索艺术家..." prefix-icon="Search" clearable style="width: 300px" @input="onSearchInput" @clear="onSearchClear" />
    </div>
    <div class="artist-grid" v-loading="loading">
      <div class="artist-card" v-for="artist in artists" :key="artist.id" @click="router.push(`/artists/${artist.id}`)">
        <div class="artist-avatar">
          <img v-if="artist.coverArt" :src="`/rest/getCoverArt?id=${artist.coverArt}&size=300`" />
          <div v-else class="avatar-placeholder"><el-icon :size="48"><User /></el-icon></div>
        </div>
        <div class="artist-name">{{ artist.name }}</div>
        <div class="artist-meta">{{ artist.albumCount }}张专辑</div>
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
import { User } from "@element-plus/icons-vue";
import api from "@/api";

const router = useRouter();
const artists = ref<any[]>([]);
const loading = ref(false);
const searchQuery = ref("");
const currentPage = ref(1);
const total = ref(0);
const pageSize = ref(parseInt(localStorage.getItem("artistsPageSize") || "25"));
if (![15, 25, 50, 100].includes(pageSize.value)) pageSize.value = 25;

let searchTimer: ReturnType<typeof setTimeout> | null = null;

async function loadArtists() {
  loading.value = true;
  try {
    const res = await api.get("/rest/api/v1/artists", {
      params: { page: currentPage.value, pageSize: pageSize.value, query: searchQuery.value },
    });
    artists.value = res.data.items || [];
    total.value = res.data.total || 0;
  } catch { artists.value = []; total.value = 0; }
  finally { loading.value = false; }
}

function onPageChange(page: number) { currentPage.value = page; loadArtists(); }

function onSizeChange(size: number) {
  pageSize.value = size;
  localStorage.setItem("artistsPageSize", String(size));
  currentPage.value = 1;
  loadArtists();
}

function onSearchInput() {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { currentPage.value = 1; loadArtists(); }, 300);
}

function onSearchClear() { currentPage.value = 1; loadArtists(); }

onMounted(loadArtists);
</script>

<style lang="scss" scoped>
.artists-page { padding: 24px; }
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; h2 { font-size: 24px; font-weight: 600; } }
.artist-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 20px; }
.artist-card { cursor: pointer; text-align: center; padding: 16px; border-radius: 8px; transition: background 0.2s;
  &:hover { background: #f5f5f5; }
  .artist-avatar { width: 120px; height: 120px; border-radius: 50%; overflow: hidden; margin: 0 auto 12px;
    img { width: 100%; height: 100%; object-fit: cover; }
    .avatar-placeholder { width: 100%; height: 100%; background: #f0f0f0; display: flex; align-items: center; justify-content: center; color: #ccc; border-radius: 50%; }
  }
  .artist-name { font-weight: 500; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .artist-meta { font-size: 12px; color: #999; margin-top: 4px; }
}
.pagination-bar { margin-top: 24px; display: flex; justify-content: center; }
</style>