<template>
  <div class="history-page">
    <div class="page-header">
      <h2>{{ t('history.title') }}<template v-if="total > 0">{{ t('history.count', { count: total }) }}</template></h2>
      <el-popconfirm
        :title="t('history.clearConfirm')"
        :confirm-button-text="t('history.clearAction')"
        :cancel-button-text="t('common.cancel')"
        @confirm="clearAllHistory"
        width="220"
      >
        <template #reference>
          <el-button type="danger" :loading="clearing" plain :disabled="total === 0"><MfIcon name="Trash2" />{{ t('history.clearButton') }}</el-button>
        </template>
      </el-popconfirm>
    </div>
    <SongTable :songs="list" :loading="loading" show-played-at :on-window="onWindow" @play="playSong" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { ElMessage } from "element-plus";
import { usePlayerStore } from "@/stores/player";
import api from "@/api";
import SongTable from "@/components/SongTable.vue";
import { useInfiniteList } from "@/composables/useInfiniteList";

const playerStore = usePlayerStore();
const { t } = useI18n();
const { list, loading, total, init, onWindow } = useInfiniteList<any>(
  async (offset, size) => {
    const page = Math.floor(offset / size) + 1;
    const res = await api.get("/rest/api/v1/history", { params: { page, pageSize: size } });
    return { items: res.data.items || [], total: res.data.total || 0 };
  },
  // chunk 需与后端 pageSize 上限(200)对齐。prefetchBlocks/concurrency 调大:
  // 预取跑道更长、并发更高,滚动更丝滑不卡骨架。
  { chunk: 200, keepRows: 300, prefetchBlocks: 2, concurrency: 3 }
);

const clearing = ref(false);

function playSong(song: any) { playerStore.playSong(song); }

async function clearAllHistory() {
  clearing.value = true;
  try {
    await api.delete("/rest/api/v1/history");
    init();
    ElMessage.success(t("history.cleared"));
  } catch {
    ElMessage.error(t("history.clearFailed"));
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