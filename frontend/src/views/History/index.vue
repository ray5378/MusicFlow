<template>
  <div class="history-page">
    <div class="page-header">
      <h2>播放历史</h2>
      <el-popconfirm
        title="确定清空所有播放历史？此操作不可恢复"
        confirm-button-text="清空"
        cancel-button-text="取消"
        @confirm="clearAllHistory"
        width="220"
      >
        <template #reference>
          <el-button type="danger" :loading="clearing" plain :disabled="total === 0"><MfIcon name="Trash2" />清空历史</el-button>
        </template>
      </el-popconfirm>
    </div>
    <el-table :data="songs" stripe @row-dblclick="playSong" @row-contextmenu="onRowContextMenu" v-longpress="onTableLongPress" highlight-current-row v-loading="loading">
      <el-table-column v-if="!isMobile" type="index" width="60" label="#" :index="indexMethod" />
      <el-table-column label="" :width="isMobile ? 52 : 60">
        <template #default="{ row }">
          <img v-if="row.coverArt" :src="`/rest/getCoverArt?id=${row.coverArt}&size=80`" class="song-cover" />
          <div v-else class="cover-placeholder"><MfIcon name="Headphones" /></div>
        </template>
      </el-table-column>
      <el-table-column prop="title" label="标题" min-width="160">
        <template v-if="isMobile" #default="{ row }">
          <div class="m-title">{{ row.title }}</div>
          <div class="m-sub">{{ [row.artist, row.album].filter(Boolean).join(' · ') || '—' }}</div>
        </template>
      </el-table-column>
      <el-table-column v-if="!isMobile" prop="artist" label="艺术家" width="180" />
      <el-table-column v-if="!isMobile" prop="album" label="专辑" width="200" />
      <el-table-column label="播放时间" :width="isMobile ? 96 : 160">
        <template #default="{ row }">{{ formatPlayedAt(row.playedAt) }}</template>
      </el-table-column>
      <el-table-column label="时长" :width="isMobile ? 58 : 100"><template #default="{ row }">{{ formatDuration(row.duration) }}</template></el-table-column>
      <el-table-column v-if="!isMobile" label="操作" width="80" fixed="right">
        <template #default="{ row }">
          <el-tooltip content="播放" placement="top">
            <el-button circle size="small" @click="playSong(row)"><MfIcon name="Play" /></el-button>
          </el-tooltip>
        </template>
      </el-table-column>
    </el-table>
    <div class="pagination-bar">
      <PagePagination :total="total" :page="currentPage" :page-size="pageSize" storage-key="historyPageSize" @change="onPageChange" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { ElMessage } from "element-plus";
import { usePlayerStore } from "@/stores/player";
import api from "@/api";
import PagePagination from "@/components/PagePagination.vue";
import { useSongTableMenu } from "@/composables/useSongTableMenu";
import { useIsMobile } from "@/composables/useIsMobile";

const playerStore = usePlayerStore();
const songs = ref<any[]>([]);
const isMobile = useIsMobile();
const { onRowContextMenu, onTableLongPress } = useSongTableMenu(songs);
const loading = ref(false);
const clearing = ref(false);
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

function onPageChange(page: number, size?: number) {
  currentPage.value = page;
  if (size) pageSize.value = size;
  loadHistory();
}

async function clearAllHistory() {
  clearing.value = true;
  try {
    await api.delete("/rest/api/v1/history");
    currentPage.value = 1;
    songs.value = [];
    total.value = 0;
    ElMessage.success("播放历史已清空");
  } catch {
    ElMessage.error("清空失败,请重试");
  } finally {
    clearing.value = false;
  }
}

onMounted(loadHistory);
</script>

<style lang="scss" scoped>
.history-page { padding: 24px 32px 130px; max-width: 1400px; margin: 0 auto; }
.page-header { margin-bottom: 20px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; h2 { font-size: 28px; font-weight: 700; } }
.song-cover { width: 40px; height: 40px; border-radius: 4px; object-fit: cover; }
.cover-placeholder { width: 40px; height: 40px; border-radius: 4px; background: rgba(255,255,255,0.06); display: flex; align-items: center; justify-content: center; color: var(--fnos-text-muted); font-size: 18px; }
.pagination-bar { margin-top: 20px; display: flex; justify-content: center; }

@media (max-width: 768px) {
  .history-page { padding: 20px 16px; }
  .page-header { flex-direction: column; align-items: flex-start; }
}
</style>