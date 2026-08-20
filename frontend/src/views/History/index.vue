<template>
  <div class="history-page">
    <div class="page-header">
      <h2>播放历史<template v-if="total > 0">（{{ total }} 首）</template></h2>
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
    <SongTable :songs="list" :loading="loading" show-played-at :on-window="onWindow" @play="playSong" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { ElMessage } from "element-plus";
import { usePlayerStore } from "@/stores/player";
import api from "@/api";
import SongTable from "@/components/SongTable.vue";
import { useInfiniteList } from "@/composables/useInfiniteList";

const playerStore = usePlayerStore();
const { list, loading, total, init, onWindow } = useInfiniteList<any>(
  async (offset, size) => {
    const page = Math.floor(offset / size) + 1;
    const res = await api.get("/rest/api/v1/history", { params: { page, pageSize: size } });
    return { items: res.data.items || [], total: res.data.total || 0 };
  },
  { chunk: 200 }
);

const clearing = ref(false);

function playSong(song: any) { playerStore.playSong(song); }

async function clearAllHistory() {
  clearing.value = true;
  try {
    await api.delete("/rest/api/v1/history");
    init();
    ElMessage.success("播放历史已清空");
  } catch {
    ElMessage.error("清空失败,请重试");
  } finally {
    clearing.value = false;
  }
}

onMounted(() => init());
</script>

<style lang="scss" scoped>
.history-page { padding: 24px 32px 130px; max-width: 1400px; margin: 0 auto; }
.page-header { margin-bottom: 20px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; h2 { font-size: 28px; font-weight: 700; } }

@media (max-width: 768px) {
  .history-page { padding: 20px 16px; }
  .page-header { flex-direction: column; align-items: flex-start; }
}
</style>