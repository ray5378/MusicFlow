<!--
  MusicFetch 任务列表面板（可复用）。
  ------------------------------------------------------------------------------
  「下载任务」与「洗版任务」现在是两个独立 tab，但列表本身完全同构 —— 只是要看的
  job kind 不同。与其把上百行模板复制两份（迟早漂移），不如抽成这个面板，由 props
  的 `kinds` 决定拉哪几类任务：
    - 下载任务 tab：kinds = ["search", "library", "retry", "manual"]（全部非洗版）
    - 洗版任务 tab：kinds = ["upgrade"]
  面板自带筛选、轮询、详情弹窗与逐条操作，父组件只需 `ref.refresh()` 在新建任务后
  把它刷一下。
-->
<template>
  <div class="job-list-panel">
    <div class="jobs-toolbar">
      <div class="jobs-filters">
        <span class="hint">{{ t('admin.fetch.jobs.autoRefreshHint') }}</span>
        <el-select v-model="statusFilter" size="small" class="filter-select" @change="refresh">
          <el-option :label="t('admin.fetch.jobs.filterAll')" value="" />
          <el-option v-for="s in jobStatusOptions" :key="s" :label="statusText(s)" :value="s" />
        </el-select>
        <el-select v-model="limit" size="small" class="limit-select" @change="refresh">
          <el-option label="20" :value="20" />
          <el-option label="50" :value="50" />
          <el-option label="100" :value="100" />
        </el-select>
      </div>
      <el-button size="small" :loading="jobsLoading" @click="refresh"><MfIcon name="RefreshCw" />{{ t('admin.fetch.jobs.refresh') }}</el-button>
      <el-button size="small" type="danger" plain @click="doClearJobs">{{ t('admin.fetch.jobs.clearAll') }}</el-button>
    </div>

    <el-alert v-if="jobsError" type="error" :closable="false" :title="jobsError" class="jobs-error" />

    <el-table v-if="jobs.length" :data="jobs" stripe v-loading="jobsLoading" @row-dblclick="openDetail">
      <el-table-column :label="t('admin.fetch.jobs.colId')" width="120">
        <template #default="{ row }"><span class="mono">{{ shortId(row.id) }}</span></template>
      </el-table-column>
      <el-table-column v-if="showKind" :label="t('admin.fetch.jobs.colKind')" width="100">
        <template #default="{ row }">{{ kindText(row.kind) }}</template>
      </el-table-column>
      <el-table-column :label="t('admin.fetch.jobs.colStatus')" width="110">
        <template #default="{ row }">
          <el-tag :type="statusTagType(row.status)" size="small">{{ statusText(row.status) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column :label="t('admin.fetch.jobs.colTotal')" width="80" align="center">
        <template #default="{ row }">{{ row.counts?.total ?? 0 }}</template>
      </el-table-column>
      <el-table-column :label="t('admin.fetch.jobs.colDone')" width="80" align="center">
        <template #default="{ row }">{{ row.counts?.done ?? 0 }}</template>
      </el-table-column>
      <el-table-column :label="t('admin.fetch.jobs.colFailed')" width="80" align="center">
        <template #default="{ row }"><span :class="{ 'cell-fail': (row.counts?.failed ?? 0) > 0 }">{{ row.counts?.failed ?? 0 }}</span></template>
      </el-table-column>
      <el-table-column :label="t('admin.fetch.jobs.colSkipped')" width="80" align="center">
        <template #default="{ row }">{{ row.counts?.skipped ?? 0 }}</template>
      </el-table-column>
      <el-table-column :label="t('admin.fetch.jobs.colBytes')" width="110">
        <template #default="{ row }">{{ formatBytes(row.counts?.bytes) }}</template>
      </el-table-column>
      <el-table-column :label="t('admin.fetch.jobs.colCreatedAt')" width="150">
        <template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column :label="t('admin.fetch.jobs.colActions')" width="160" fixed="right">
        <template #default="{ row }">
          <el-button size="small" @click="openDetail(row)">{{ t('admin.fetch.jobs.view') }}</el-button>
          <el-button v-if="isActiveStatus(row.status)" size="small" type="danger" plain @click="doCancel(row)">{{ t('admin.fetch.jobs.cancel') }}</el-button>
          <el-button v-if="!isActiveStatus(row.status)" size="small" type="danger" plain @click="doDeleteJob(row)">{{ t('admin.fetch.jobs.delete') }}</el-button>
        </template>
      </el-table-column>
    </el-table>
    <EmptyState
      v-else-if="!jobsLoading"
      icon="box"
      :title="t('admin.fetch.jobs.emptyTitle')"
      :description="t('admin.fetch.jobs.emptyDesc')"
      compact
    />

    <!-- ===== 任务详情 ===== -->
    <el-dialog v-model="detailVisible" :title="t('admin.fetch.jobs.detailTitle')" width="min(1160px, 96vw)" :append-to-body="true">
      <div v-if="detail" v-loading="detailLoading" class="detail-body">
        <div class="detail-head">
          <div class="detail-meta">
            <span class="mono">{{ detail.id }}</span>
            <el-tag :type="statusTagType(detail.status)" size="small">{{ statusText(detail.status) }}</el-tag>
            <el-tag v-if="showKind" size="small" type="info">{{ kindText(detail.kind) }}</el-tag>
          </div>
          <div class="detail-counts">
            <span>{{ t('admin.fetch.jobs.colTotal') }}: {{ detail.counts?.total ?? 0 }}</span>
            <span>{{ t('admin.fetch.jobs.colDone') }}: {{ detail.counts?.done ?? 0 }}</span>
            <span v-if="(detail.counts?.failed ?? 0) > 0" class="cell-fail">{{ t('admin.fetch.jobs.colFailed') }}: {{ detail.counts.failed }}</span>
            <span>{{ t('admin.fetch.jobs.colSkipped') }}: {{ detail.counts?.skipped ?? 0 }}</span>
            <span>{{ t('admin.fetch.jobs.colBytes') }}: {{ formatBytes(detail.counts?.bytes) }}</span>
            <span>{{ t('admin.fetch.jobs.duration') }}: {{ jobDuration(detail) }}</span>
          </div>
        </div>
        <el-alert
          v-if="detail.error"
          type="error"
          :closable="false"
          :title="t('admin.fetch.jobs.jobError', { error: detail.error })"
        />
        <div class="detail-actions">
          <el-button size="small" type="warning" :disabled="!(detail.counts?.failed ?? 0)" @click="doRetryAll">
            <MfIcon name="RotateCcw" />{{ t('admin.fetch.jobs.retryAll') }}
          </el-button>
          <el-button v-if="isActiveStatus(detail.status)" size="small" type="danger" plain @click="doCancel(detail)">{{ t('admin.fetch.jobs.cancel') }}</el-button>
        </div>
        <el-table v-if="detail.items && detail.items.length" :data="detail.items" stripe size="small" class="detail-table">
          <el-table-column :label="t('admin.fetch.jobs.detailColSong')" min-width="170">
            <template #default="{ row }">
              <div class="song-cell">
                <span class="song-title">{{ row.title }}</span>
                <span v-if="row.artist" class="song-artist">{{ row.artist }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column :label="t('admin.fetch.jobs.detailColStatus')" width="110">
            <template #default="{ row }">
              <el-tag :type="statusTagType(row.status)" size="small">{{ statusText(row.status) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column :label="t('admin.fetch.jobs.detailColSource')" width="120">
            <template #default="{ row }">{{ sourceText(row.chosen) }}</template>
          </el-table-column>
          <el-table-column :label="t('admin.fetch.jobs.detailColQuality')" width="150">
            <template #default="{ row }">{{ qualityText(row.chosen) }}</template>
          </el-table-column>
          <el-table-column :label="t('admin.fetch.jobs.detailColError')" min-width="150" show-overflow-tooltip>
            <template #default="{ row }">
              <span v-if="row.errorCode" class="cell-fail">{{ errorText(row.errorCode) }}</span>
              <span v-else-if="row.errorMsg">{{ row.errorMsg }}</span>
            </template>
          </el-table-column>
          <el-table-column :label="t('admin.fetch.jobs.detailColPath')" min-width="180" show-overflow-tooltip>
            <template #default="{ row }"><span class="mono">{{ row.finalPath || '-' }}</span></template>
          </el-table-column>
          <el-table-column :label="t('admin.fetch.jobs.detailColReplaced')" min-width="200" show-overflow-tooltip>
            <template #default="{ row }">
              <span v-if="row.replaced">
                {{ t('admin.fetch.jobs.replaced') }}
                <span class="mono">{{ replacedText(row.replaced) }}</span>
              </span>
            </template>
          </el-table-column>
          <el-table-column :label="t('admin.fetch.jobs.detailColActions')" width="90">
            <template #default="{ row }">
              <el-button size="small" :disabled="!canRetryItem(row.status)" @click="retryItem(row)">{{ t('admin.fetch.jobs.retry') }}</el-button>
            </template>
          </el-table-column>
        </el-table>
        <div v-else class="hint empty-items">{{ t('admin.fetch.jobs.noItems') }}</div>
      </div>
      <div v-else v-loading="detailLoading" class="detail-empty"></div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import { ElMessage, ElMessageBox } from "element-plus";
import EmptyState from "@/components/EmptyState.vue";
import { apiErrorText } from "@/utils/apiError";
import {
  listFetchJobs,
  getFetchJob,
  cancelFetchJob,
  clearFetchJobs,
  deleteFetchJob,
  retryFetchJob,
} from "@/api/fetch";
import type { FetchJobSummary, FetchJobDetail } from "@/api/fetch";
import {
  isActiveStatus,
  statusText as fmtStatusText,
  statusTagType,
  errorText as fmtErrorText,
  kindText as fmtKindText,
  shortId,
  formatBytes,
  formatDateTime,
  jobDuration,
  sourceText,
  qualityText,
  replacedText,
  type TFn,
} from "./jobFormat";

const props = withDefaults(
  defineProps<{
    /** 只拉这几类任务（后端 kind IN 过滤）。下载面板传全部非洗版，洗版面板传 ["upgrade"]。 */
    kinds: string[];
    /** 是否显示「类型」列（单一面板内 kind 唯一时无意义）。 */
    showKind?: boolean;
    /** 是否在挂载时立即拉一次。 */
    immediate?: boolean;
  }>(),
  { showKind: false, immediate: true },
);

const emit = defineEmits<{ (e: "created", payload: { id: string }): void }>();

const { t } = useI18n();
const tt = t as unknown as TFn;

// 模板里保持与原实现同名的薄封装，避免大面积改模板。
const statusText = (s?: string) => fmtStatusText(tt, s);
const errorText = (c?: string) => fmtErrorText(tt, c);
const kindText = (k?: string) => fmtKindText(tt, k);

const jobs = ref<FetchJobSummary[]>([]);
const jobsLoading = ref(false);
const jobsError = ref("");
const statusFilter = ref("");
const limit = ref(50);
const jobStatusOptions = ["pending", "running", "done", "partial", "cancelled", "failed"];

async function fetchJobList(): Promise<FetchJobSummary[]> {
  return listFetchJobs({
    limit: limit.value,
    status: statusFilter.value || undefined,
    kinds: props.kinds,
  });
}

async function refresh() {
  jobsLoading.value = true;
  jobsError.value = "";
  try {
    jobs.value = await fetchJobList();
    ensurePolling();
  } catch (e: any) {
    jobsError.value = apiErrorText(e, t("admin.fetch.jobs.loadFailed"));
  } finally {
    jobsLoading.value = false;
  }
}

// 进行中的任务每 2 秒轮询一次；全部结束/取消后自动停止。
let pollTimer: ReturnType<typeof setInterval> | null = null;

function hasActiveJobs(): boolean {
  return jobs.value.some((j) => isActiveStatus(j.status));
}
function ensurePolling() {
  if (hasActiveJobs()) {
    if (!pollTimer) pollTimer = setInterval(pollTick, 2000);
  } else {
    stopPolling();
  }
}
function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
async function pollTick() {
  try {
    jobs.value = await fetchJobList();
    if (detailVisible.value && detailId.value) {
      const d = await getFetchJob(detailId.value);
      if (d) detail.value = d;
    }
  } catch {
    /* 轮询失败静默，下个 tick 再试 */
  }
  if (!hasActiveJobs()) stopPolling();
}

// ---------- 任务详情 ----------
const detailVisible = ref(false);
const detailId = ref("");
const detail = ref<FetchJobDetail | null>(null);
const detailLoading = ref(false);

async function openDetail(job: any) {
  detailId.value = job.id;
  detailVisible.value = true;
  detailLoading.value = true;
  try {
    detail.value = await getFetchJob(job.id);
    ensurePolling();
  } catch (e: any) {
    detail.value = null;
    ElMessage.error(apiErrorText(e, t("admin.fetch.jobs.detailFailed")));
  } finally {
    detailLoading.value = false;
  }
}

// 删除单条任务记录（仅终态；运行中先取消）。
async function doDeleteJob(job: any) {
  try {
    await ElMessageBox.confirm(
      t("admin.fetch.jobs.deleteConfirm", { id: shortId(job.id) }),
      t("admin.fetch.jobs.delete"),
      { type: "warning" },
    );
  } catch {
    return;
  }
  try {
    await deleteFetchJob(job.id);
    ElMessage.success(t("admin.fetch.jobs.deleted"));
    if (detailVisible.value && detailId.value === job.id) detailVisible.value = false;
    await refresh();
  } catch (e: any) {
    ElMessage.error(apiErrorText(e, t("admin.fetch.jobs.deleteFailed")));
  }
}

// 一键清空任务记录（只清终态）。
async function doClearJobs() {
  try {
    await ElMessageBox.confirm(t("admin.fetch.jobs.clearConfirm"), t("admin.fetch.jobs.clearAll"), {
      type: "warning",
    });
  } catch {
    return;
  }
  try {
    const r = await clearFetchJobs();
    ElMessage.success(t("admin.fetch.jobs.cleared", { n: r.cleared ?? 0 }));
    await refresh();
  } catch (e: any) {
    ElMessage.error(apiErrorText(e, t("admin.fetch.jobs.clearFailed")));
  }
}

async function doCancel(job: any) {
  try {
    await ElMessageBox.confirm(
      t("admin.fetch.jobs.cancelConfirm", { id: shortId(job.id) }),
      t("admin.fetch.jobs.cancel"),
      { type: "warning" },
    );
  } catch {
    return;
  }
  try {
    await cancelFetchJob(job.id);
    ElMessage.success(t("admin.fetch.jobs.cancelled"));
    await refresh();
    if (detailVisible.value && detailId.value === job.id && detail.value) {
      const d = await getFetchJob(job.id);
      if (d) detail.value = d;
    }
  } catch (e: any) {
    ElMessage.error(apiErrorText(e, t("admin.fetch.jobs.cancelFailed")));
  }
}

// 顶部按钮：重试当前任务的全部失败项（job 级端点，onlyFailed）。
async function doRetryAll() {
  if (!detail.value) return;
  try {
    const newId = await retryFetchJob(detail.value.id, { onlyFailed: true });
    ElMessage.success(t("admin.fetch.jobs.retryStarted", { id: shortId(newId) }));
    detailVisible.value = false;
    emit("created", { id: newId });
    await refresh();
  } catch (e: any) {
    ElMessage.error(apiErrorText(e, t("admin.fetch.jobs.retryFailed")));
  }
}

// 逐曲重试：同走 job 级端点，传 targetIds 只重试该曲（targetId 缺失时退回只重试失败项）。
function canRetryItem(s?: string): boolean {
  return s === "failed" || s === "skipped" || s === "cancelled";
}
async function retryItem(item: any) {
  try {
    const opts = detail.value && item.targetId
      ? { targetIds: [item.targetId as string] }
      : { onlyFailed: true };
    const newId = await retryFetchJob(detailId.value, opts);
    ElMessage.success(t("admin.fetch.jobs.retryStarted", { id: shortId(newId) }));
    detailVisible.value = false;
    emit("created", { id: newId });
    await refresh();
  } catch (e: any) {
    ElMessage.error(apiErrorText(e, t("admin.fetch.jobs.retryFailed")));
  }
}

onMounted(() => {
  if (props.immediate) refresh();
});
onUnmounted(stopPolling);

defineExpose({ refresh });
</script>

<style lang="scss" scoped>
.hint { font-size: 12px; color: var(--fnos-text-tertiary); line-height: 1.6; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.cell-fail { color: var(--fnos-red); font-weight: 600; }

.jobs-toolbar {
  display: flex; justify-content: space-between; align-items: center;
  flex-wrap: wrap; gap: 12px; margin-bottom: 12px;
}
.jobs-filters { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.filter-select { width: 140px; }
.limit-select { width: 100px; }
.jobs-error { margin-bottom: 12px; }

.detail-body { min-height: 120px; }
.detail-empty { min-height: 160px; }
.detail-head { display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 10px; margin-bottom: 10px; }
.detail-meta { display: flex; align-items: center; gap: 10px; }
.detail-counts { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; color: var(--fnos-text-tertiary); }
.detail-actions { display: flex; gap: 10px; margin: 12px 0; flex-wrap: wrap; }
.detail-table { margin-top: 4px; }
.song-cell { display: flex; flex-direction: column; }
.song-title { color: var(--fnos-text-primary); }
.song-artist { font-size: 12px; color: var(--fnos-text-tertiary); }
.empty-items { padding: 24px 0; text-align: center; }

@media (max-width: 768px) {
  .jobs-filters { width: 100%; }
  .detail-head { flex-direction: column; align-items: flex-start; }
  .detail-counts { gap: 6px 12px; }
  .mono { word-break: break-all; }
}
</style>
