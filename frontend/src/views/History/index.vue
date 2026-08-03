<template>
  <div class="history-page">
    <div class="page-header"><h2>播放历史</h2></div>
    <el-table :data="songs" stripe @row-dblclick="playSong" highlight-current-row v-loading="loading">
      <el-table-column type="index" width="60" label="#" :index="indexMethod" />
      <el-table-column label="" width="60">
        <template #default="{ row }">
          <img v-if="row.coverArt" :src="`/rest/getCoverArt?id=${row.coverArt}&size=80`" class="song-cover" />
          <div v-else class="cover-placeholder"><el-icon><Headset /></el-icon></div>
        </template>
      </el-table-column>
      <el-table-column prop="title" label="标题" min-width="200" />
      <el-table-column prop="artist" label="艺术家" width="180" />
      <el-table-column prop="album" label="专辑" width="200" />
      <el-table-column label="播放时间" width="160">
        <template #default="{ row }">{{ formatPlayedAt(row.playedAt) }}</template>
      </el-table-column>
      <el-table-column label="时长" width="100"><template #default="{ row }">{{ formatDuration(row.duration) }}</template></el-table-column>
      <el-table-column label="操作" width="80" fixed="right">
        <template #default="{ row }">
          <el-tooltip content="播放" placement="top">
            <el-button :icon="Play" circle size="small" @click="playSong(row)" />
          </el-tooltip>
        </template>
      </el-table-column>
    </el-table>
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
import { usePlayerStore } from "@/stores/player";
import { VideoPlay as Play, Headset } from "@element-plus/icons-vue";
import api from "@/api";

const playerStore = usePlayerStore();
const songs = ref<any[]>([]);
const loading = ref(false);
const currentPage = ref(1);
const total = ref(0);
const pageSize = ref(parseInt(localStorage.getItem("historyPageSize") || "25"));
if (![15, 25, 50, 100].includes(pageSize.value)) pageSize.value = 25;

function indexMethod(index: number) { return (currentPage.value - 1) * pageSize.value + index + 1; }
function formatDuration(sec: number) { const m = Math.floor(sec / 60); const s = Math.floor(sec % 60); return `${m}:${s.toString().padStart(2, "0")}`; }
function formatPlayedAt(t: string) {
  if (!t) return "-";
  const d = new Date(t);
  if (isNaN(d.getTime())) return "-";
  return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
function playSong(song: any) { playerStore.playSong(song); }

async function loadHistory() {
  loading.value = true;
  try {
    const res = await api.get("/rest/api/v1/history", {
      params: { page: currentPage.value, pageSize: pageSize.value },
    });
    songs.value = res.data.items || [];
    total.value = res.data.total || 0;
  } catch { songs.value = []; total.value = 0; }
  finally { loading.value = false; }
}

function onPageChange(page: number) { currentPage.value = page; loadHistory(); }

function onSizeChange(size: number) {
  pageSize.value = size;
  localStorage.setItem("historyPageSize", String(size));
  currentPage.value = 1;
  loadHistory();
}

onMounted(loadHistory);
</script>

<style lang="scss" scoped>
.history-page { padding: 24px; }
.page-header { margin-bottom: 20px; h2 { font-size: 24px; font-weight: 600; } }
.song-cover { width: 40px; height: 40px; border-radius: 4px; object-fit: cover; }
.cover-placeholder { width: 40px; height: 40px; border-radius: 4px; background: #e5e7eb; display: flex; align-items: center; justify-content: center; color: #9ca3af; font-size: 18px; }
.pagination-bar { margin-top: 20px; display: flex; justify-content: center; }
</style>