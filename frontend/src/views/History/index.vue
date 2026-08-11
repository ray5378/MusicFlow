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
    <SongTable :songs="songs" :offset="(currentPage - 1) * pageSize" :loading="loading" show-played-at @play="playSong" />
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
import SongTable from "@/components/SongTable.vue";

const playerStore = usePlayerStore();
const songs = ref<any[]>([]);
const loading = ref(false);
const clearing = ref(false);
const currentPage = ref(1);
const total = ref(0);
const pageSize = ref(parseInt(localStorage.getItem("historyPageSize") || "25"));
if (![15, 25, 50, 100].includes(pageSize.value)) pageSize.value = 25;

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
.pagination-bar { margin-top: 20px; display: flex; justify-content: center; }

@media (max-width: 768px) {
  .history-page { padding: 20px 16px; }
  .page-header { flex-direction: column; align-items: flex-start; }
}
</style>