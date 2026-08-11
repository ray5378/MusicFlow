<template>
  <div class="favorites-page" v-loading="loading">
    <div class="fav-header">
      <div class="fav-cover">
        <MfIcon name="Heart" :filled="true" :size="64" class="fav-heart" />
      </div>
      <div class="fav-meta">
        <div class="label">我喜欢</div>
        <h1>我喜欢</h1>
        <div class="info">{{ songs.length }}首 · 喜欢的音乐都在这里</div>
        <div class="actions">
          <el-button type="primary" @click="playAll" :disabled="songs.length === 0">播放全部</el-button>
          <el-button @click="togglePool"><MfIcon name="Wand2" />{{ inPool ? '移出每日推荐池' : '加入每日推荐池' }}</el-button>
        </div>
      </div>
    </div>
    <SongTable :songs="pagedSongs" :offset="(currentPage - 1) * pageSize" show-bitrate @play="playSong" />

    <div class="pagination-bar" v-if="songs.length > 0">
      <PagePagination :total="songs.length" :page="currentPage" :page-size="pageSize" storage-key="favPageSize" @change="onPageChange" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { usePlayerStore } from "@/stores/player";
import { useFavoritesStore } from "@/stores/favorites";
import { ElMessage } from "element-plus";
import api from "@/api";
import PagePagination from "@/components/PagePagination.vue";
import SongTable from "@/components/SongTable.vue";

const playerStore = usePlayerStore();
const favoritesStore = useFavoritesStore();
const songs = ref<any[]>([]);
const loading = ref(false);
// 前端分页（getStarred 一次性返回全部收藏，本地切片展示）
const currentPage = ref(1);
const pageSize = ref(parseInt(localStorage.getItem("favPageSize") || "25"));
if (![15, 25, 50, 100].includes(pageSize.value)) pageSize.value = 25;
const pagedSongs = computed(() => {
  const start = (currentPage.value - 1) * pageSize.value;
  return songs.value.slice(start, start + pageSize.value);
});
// Whether "我喜欢的音乐" is in the daily-recommend pool.
const inPool = ref(false);

async function loadPoolStatus() {
  try {
    const res = await api.get("/rest/api/v1/recommend-pool/favorites/status");
    inPool.value = !!res.data.inPool;
  } catch { inPool.value = false; }
}

async function togglePool() {
  try {
    if (inPool.value) {
      await api.delete("/rest/api/v1/recommend-pool/favorites");
      inPool.value = false;
      ElMessage.success("已将「我喜欢的音乐」移出每日推荐池");
    } else {
      const res = await api.post("/rest/api/v1/recommend-pool/favorites");
      inPool.value = true;
      ElMessage.success(res.data.message || "已将「我喜欢的音乐」加入每日推荐池");
    }
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || "操作失败");
  }
}

function playSong(song: any) { playerStore.playSong(song); }
function playAll() { if (songs.value.length > 0) playerStore.playQueue(songs.value); }

async function loadFavorites() {
  loading.value = true;
  try {
    const res = await api.get("/rest/getStarred?f=json");
    songs.value = res.data["subsonic-response"]?.starred?.song || [];
  } catch { songs.value = []; }
  finally { loading.value = false; }
}

function onPageChange(page: number, size?: number) {
  currentPage.value = page;
  if (size) pageSize.value = size;
}

onMounted(() => { loadFavorites(); favoritesStore.loadFavorites(); loadPoolStatus(); });
</script>

<style lang="scss" scoped>
.favorites-page { padding: 24px 32px 130px; max-width: 1400px; margin: 0 auto; }
.fav-header { display: flex; gap: 24px; margin-bottom: 24px;
  .fav-cover { width: 200px; height: 200px; border-radius: var(--fnos-radius-lg); background: linear-gradient(135deg, #f5b942, #e94560); display: flex; align-items: center; justify-content: center; color: #fff; flex-shrink: 0; box-shadow: 0 10px 30px rgba(233,69,96,0.35);
    .fav-heart { color: #fff; } }
  .fav-meta { display: flex; flex-direction: column; justify-content: center;
    .label { font-size: 12px; color: var(--fnos-text-tertiary); text-transform: uppercase; letter-spacing: 0.06em; }
    h1 { font-size: 28px; font-weight: 700; margin: 8px 0; color: var(--fnos-text-primary); }
    .info { color: var(--fnos-text-tertiary); font-size: 14px; }
    .actions { margin-top: 16px; }
  }
}
.song-cover { width: 40px; height: 40px; border-radius: 4px; object-fit: cover; }
.cover-placeholder { width: 40px; height: 40px; border-radius: 4px; background: rgba(255,255,255,0.06); display: flex; align-items: center; justify-content: center; color: var(--fnos-text-muted); font-size: 18px; }
@media (max-width: 768px) {
  .favorites-page { padding: 20px 16px; }
  .fav-header { flex-direction: column; align-items: center; text-align: center; gap: 16px; }
  .fav-header .fav-cover { width: 160px; height: 160px; }
  .fav-header .fav-meta .actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }
}
</style>