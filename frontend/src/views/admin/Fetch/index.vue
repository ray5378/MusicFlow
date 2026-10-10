<template>
  <div class="admin-fetch">
    <div class="page-header">
      <h2>{{ t('admin.fetch.title') }}</h2>
      <el-button :loading="jobsLoading" @click="refreshJobs"><MfIcon name="RefreshCw" />{{ t('admin.fetch.jobs.refresh') }}</el-button>
    </div>

    <el-tabs v-model="activeTab" class="fetch-tabs">
      <!-- ===== 1. 配置 ===== -->
      <el-tab-pane :label="t('admin.fetch.tabConfig')" name="config">
        <div v-loading="configLoading" class="config-wrap">
          <el-form label-position="top" class="config-form">
            <el-divider content-position="left">{{ t('admin.fetch.config.basic') }}</el-divider>
            <div class="config-grid">
              <el-form-item :label="t('admin.fetch.config.enabled')">
                <div class="field-inline">
                  <el-switch v-model="config.enabled" />
                  <span class="hint">{{ t('admin.fetch.config.enabledHint') }}</span>
                </div>
              </el-form-item>
              <el-form-item :label="t('admin.fetch.config.downloadRoot')">
                <el-input v-model="config.downloadRoot" />
                <div class="hint">{{ t('admin.fetch.config.downloadRootHint') }}</div>
              </el-form-item>
              <el-form-item :label="t('admin.fetch.config.cacheRoot')">
                <el-input v-model="config.cacheRoot" />
                <div class="hint">{{ t('admin.fetch.config.cacheRootHint') }}</div>
              </el-form-item>
            </div>

            <el-divider content-position="left">{{ t('admin.fetch.config.quality') }}</el-divider>
            <div class="config-grid">
              <el-form-item :label="t('admin.fetch.config.qualityFloor')">
                <el-select v-model="config.qualityFloor">
                  <el-option v-for="o in floorOptions" :key="o" :label="floorLabel(o)" :value="o" />
                </el-select>
              </el-form-item>
              <el-form-item :label="t('admin.fetch.config.minBitrateKbps')">
                <el-input-number v-model="config.minBitrateKbps" :min="0" :step="32" controls-position="right" />
              </el-form-item>
              <el-form-item :label="t('admin.fetch.config.minSampleRateHz')">
                <el-input-number v-model="config.minSampleRateHz" :min="0" :step="1000" controls-position="right" />
              </el-form-item>
              <el-form-item :label="t('admin.fetch.config.preferLossless')">
                <el-switch v-model="config.preferLossless" />
              </el-form-item>
              <el-form-item :label="t('admin.fetch.config.rejectFakeLossless')">
                <el-switch v-model="config.rejectFakeLossless" />
              </el-form-item>
            </div>

            <el-divider content-position="left">{{ t('admin.fetch.config.semantics') }}</el-divider>
            <div class="config-grid">
              <el-form-item :label="t('admin.fetch.config.skipIfInLibrary')">
                <el-switch v-model="config.skipIfInLibrary" />
                <div class="hint">{{ t('admin.fetch.config.skipIfInLibraryHint') }}</div>
              </el-form-item>
              <el-form-item :label="t('admin.fetch.config.strictBestTier')">
                <el-switch v-model="config.strictBestTier" />
                <div class="hint">{{ t('admin.fetch.config.strictBestTierHint') }}</div>
              </el-form-item>
              <el-form-item :label="t('admin.fetch.config.integrityLevel')">
                <el-select v-model="config.integrityLevel">
                  <el-option v-for="o in integrityOptions" :key="o" :label="integrityLabel(o)" :value="o" />
                </el-select>
                <div class="hint">{{ t('admin.fetch.config.integrityLevelHint') }}</div>
              </el-form-item>
            </div>

            <el-divider content-position="left">{{ t('admin.fetch.config.transcode') }}</el-divider>
            <el-alert class="transcode-warn" type="warning" :closable="false" show-icon>
              {{ t('admin.fetch.config.transcodeWarn') }}
            </el-alert>
            <div class="config-grid">
              <el-form-item :label="t('admin.fetch.config.transcodeEnabled')">
                <el-switch v-model="config.transcodeEnabled" />
              </el-form-item>
              <el-form-item :label="t('admin.fetch.config.transcodeTarget')">
                <el-select v-model="config.transcodeTarget">
                  <el-option label="FLAC" value="flac" />
                  <el-option label="ALAC" value="alac" />
                  <el-option label="WAV" value="wav" />
                </el-select>
              </el-form-item>
              <el-form-item :label="t('admin.fetch.config.transcodeSampleRateHz')">
                <el-input-number v-model="config.transcodeSampleRateHz" :min="0" :step="1000" controls-position="right" />
              </el-form-item>
              <el-form-item :label="t('admin.fetch.config.transcodeBitDepth')">
                <el-select v-model="config.transcodeBitDepth">
                  <el-option label="16 bit" :value="16" />
                  <el-option label="24 bit" :value="24" />
                </el-select>
              </el-form-item>
              <el-form-item :label="t('admin.fetch.config.transcodeKeepOriginal')">
                <el-switch v-model="config.transcodeKeepOriginal" />
                <div class="hint">{{ t('admin.fetch.config.transcodeKeepOriginalHint') }}</div>
              </el-form-item>
            </div>

            <el-divider content-position="left">{{ t('admin.fetch.config.concurrency') }}</el-divider>
            <div class="config-grid">
              <el-form-item :label="t('admin.fetch.config.maxConcurrentDownloads')">
                <el-input-number v-model="config.maxConcurrentDownloads" :min="1" :max="32" controls-position="right" />
              </el-form-item>
              <el-form-item :label="t('admin.fetch.config.maxConcurrentPerHost')">
                <el-input-number v-model="config.maxConcurrentPerHost" :min="1" :max="16" controls-position="right" />
              </el-form-item>
              <el-form-item :label="t('admin.fetch.config.perHostMinIntervalMs')">
                <el-input-number v-model="config.perHostMinIntervalMs" :min="0" :step="100" controls-position="right" />
              </el-form-item>
              <el-form-item :label="t('admin.fetch.config.rateLimitKBps')">
                <el-input-number v-model="config.rateLimitKBps" :min="0" :step="128" controls-position="right" />
                <div class="hint">{{ t('admin.fetch.config.rateLimitHint') }}</div>
              </el-form-item>
            </div>

            <el-divider content-position="left">{{ t('admin.fetch.config.conflict') }}</el-divider>
            <div class="config-grid">
              <el-form-item :label="t('admin.fetch.config.fileConflictPolicy')">
                <el-select v-model="config.fileConflictPolicy">
                  <el-option v-for="o in conflictOptions" :key="o" :label="conflictLabel(o)" :value="o" />
                </el-select>
                <div class="hint">{{ t('admin.fetch.config.fileConflictPolicyHint') }}</div>
              </el-form-item>
            </div>

            <el-divider content-position="left">{{ t('admin.fetch.config.sources') }}</el-divider>
            <el-form-item :label="t('admin.fetch.config.sourcePriority')">
              <div class="hint">{{ t('admin.fetch.config.sourcePriorityHint') }}</div>
              <div class="priority-list">
                <div v-for="(s, i) in config.sourcePriority" :key="s + '#' + i" class="priority-row">
                  <span class="priority-idx">{{ i + 1 }}</span>
                  <el-input v-model="config.sourcePriority[i]" size="small" class="priority-input" />
                  <el-button size="small" :disabled="i === 0" :title="t('common.moveUp')" @click="movePriority(i, -1)">&#8593;</el-button>
                  <el-button size="small" :disabled="i === config.sourcePriority.length - 1" :title="t('common.moveDown')" @click="movePriority(i, 1)">&#8595;</el-button>
                  <el-button size="small" type="danger" plain :title="t('admin.fetch.config.sourceRemove')" @click="removePriority(i)"><MfIcon name="X" /></el-button>
                </div>
                <div v-if="!config.sourcePriority.length" class="hint">{{ t('admin.fetch.config.sourcePriorityEmpty') }}</div>
                <div class="priority-add">
                  <el-input v-model="priorityInput" size="small" :placeholder="t('admin.fetch.config.sourcePriorityPlaceholder')" @keyup.enter="addPriority" />
                  <el-button size="small" @click="addPriority"><MfIcon name="Plus" />{{ t('admin.fetch.config.sourceAdd') }}</el-button>
                </div>
                <div class="avail-sources">
                  <span class="hint">{{ t('admin.fetch.config.sourceAvailable') }}:</span>
                  <template v-if="availableSources.length">
                    <el-tag
                      v-for="src in availableSources"
                      :key="src.pluginId"
                      class="src-tag"
                      size="small"
                      @click="addSourceTag(src)"
                    >{{ src.platform || src.pluginId }}</el-tag>
                  </template>
                  <span v-else class="hint">{{ t('admin.fetch.config.sourceAvailableEmpty') }}</span>
                </div>
              </div>
            </el-form-item>
          </el-form>

          <div class="config-actions">
            <el-button type="primary" :loading="configSaving" @click="saveConfig">{{ t('admin.fetch.config.save') }}</el-button>
          </div>
        </div>
      </el-tab-pane>

      <!-- ===== 2. 新建任务 + 预览 ===== -->
      <el-tab-pane :label="t('admin.fetch.tabCreate')" name="create">
        <el-form label-position="top" class="create-form">
          <el-form-item :label="t('admin.fetch.create.inputLabel')">
            <div class="hint">{{ t('admin.fetch.create.inputHint') }}</div>
            <el-input v-model="targetsText" type="textarea" :rows="8" :placeholder="t('admin.fetch.create.placeholder')" />
          </el-form-item>
          <div class="create-actions">
            <span class="hint">{{ t('admin.fetch.create.parsedCount', { count: parsedCount }) }}</span>
            <span class="hint">{{ t('admin.fetch.create.dryRunHint') }}</span>
            <el-button :loading="previewLoading" @click="doPreview"><MfIcon name="Search" />{{ t('admin.fetch.create.preview') }}</el-button>
            <el-button type="primary" :loading="startLoading" @click="doStart"><MfIcon name="Download" />{{ t('admin.fetch.create.start') }}</el-button>
          </div>
        </el-form>

        <div v-if="previewSummary" class="preview-block">
          <el-divider content-position="left">{{ t('admin.fetch.create.previewResult') }}</el-divider>
          <div class="summary-bar">
            <el-tag type="success">{{ t('admin.fetch.create.summaryDownloadable', { count: previewSummary.downloadable }) }}</el-tag>
            <el-tag type="warning">{{ t('admin.fetch.create.summaryBelowBar', { count: previewSummary.belowBar }) }}</el-tag>
            <el-tag type="info">{{ t('admin.fetch.create.summaryNoCandidate', { count: previewSummary.noCandidate }) }}</el-tag>
            <el-tag>{{ t('admin.fetch.create.summaryTotal', { count: previewSummary.total }) }}</el-tag>
          </div>
          <el-table :data="previewItems" stripe>
            <el-table-column prop="title" :label="t('admin.fetch.create.colTitle')" min-width="180" />
            <el-table-column prop="artist" :label="t('admin.fetch.create.colArtist')" width="140" />
            <el-table-column :label="t('admin.fetch.create.colStatus')" width="110">
              <template #default="{ row }">
                <el-tag :type="statusTagType(row.status)" size="small">{{ statusText(row.status) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column :label="t('admin.fetch.create.colTier')" width="120">
              <template #default="{ row }">{{ row.tier || '-' }}</template>
            </el-table-column>
            <el-table-column :label="t('admin.fetch.create.colReason')" min-width="200" show-overflow-tooltip>
              <template #default="{ row }">{{ row.reason ? errorText(row.reason) : '' }}</template>
            </el-table-column>
          </el-table>
        </div>
      </el-tab-pane>

      <!-- ===== 3. 任务列表 + 详情 ===== -->
      <el-tab-pane :label="t('admin.fetch.tabJobs')" name="jobs">
        <div class="jobs-toolbar">
          <div class="jobs-filters">
            <span class="hint">{{ t('admin.fetch.jobs.autoRefreshHint') }}</span>
            <el-select v-model="statusFilter" size="small" class="filter-select" @change="refreshJobs">
              <el-option :label="t('admin.fetch.jobs.filterAll')" value="" />
              <el-option v-for="s in jobStatusOptions" :key="s" :label="statusText(s)" :value="s" />
            </el-select>
            <el-select v-model="limit" size="small" class="limit-select" @change="refreshJobs">
              <el-option label="20" :value="20" />
              <el-option label="50" :value="50" />
              <el-option label="100" :value="100" />
            </el-select>
          </div>
          <el-button size="small" :loading="jobsLoading" @click="refreshJobs"><MfIcon name="RefreshCw" />{{ t('admin.fetch.jobs.refresh') }}</el-button>
        </div>

        <el-alert v-if="jobsError" type="error" :closable="false" :title="jobsError" class="jobs-error" />

        <el-table v-if="jobs.length" :data="jobs" stripe v-loading="jobsLoading" @row-dblclick="openDetail">
          <el-table-column :label="t('admin.fetch.jobs.colId')" width="120">
            <template #default="{ row }"><span class="mono">{{ shortId(row.id) }}</span></template>
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
      </el-tab-pane>
    </el-tabs>

    <!-- ===== 任务详情 ===== -->
    <el-dialog v-model="detailVisible" :title="t('admin.fetch.jobs.detailTitle')" width="920px" :append-to-body="true">
      <div v-if="detail" v-loading="detailLoading" class="detail-body">
        <div class="detail-head">
          <div class="detail-meta">
            <span class="mono">{{ detail.id }}</span>
            <el-tag :type="statusTagType(detail.status)" size="small">{{ statusText(detail.status) }}</el-tag>
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
          <el-table-column :label="t('admin.fetch.jobs.detailColQuality')" width="170">
            <template #default="{ row }">{{ qualityText(row.chosen) }}</template>
          </el-table-column>
          <el-table-column :label="t('admin.fetch.jobs.detailColError')" min-width="170" show-overflow-tooltip>
            <template #default="{ row }">
              <span v-if="row.errorCode" class="cell-fail">{{ errorText(row.errorCode) }}</span>
              <span v-else-if="row.errorMsg">{{ row.errorMsg }}</span>
            </template>
          </el-table-column>
          <el-table-column :label="t('admin.fetch.jobs.detailColPath')" min-width="180" show-overflow-tooltip>
            <template #default="{ row }"><span class="mono">{{ row.finalPath || '-' }}</span></template>
          </el-table-column>
          <el-table-column :label="t('admin.fetch.jobs.detailColActions')" width="90" fixed="right">
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
import { ref, reactive, computed, onMounted, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import { ElMessage, ElMessageBox } from "element-plus";
import EmptyState from "@/components/EmptyState.vue";
import { apiErrorText } from "@/utils/apiError";
import {
  getFetchConfig,
  updateFetchConfig,
  getFetchSources,
  previewFetch,
  createFetchTask,
  listFetchJobs,
  getFetchJob,
  cancelFetchJob,
  retryFetchJob,
} from "@/api/fetch";
import type {
  FetchConfig,
  FetchChosen,
  FetchSourceInfo,
  FetchPreviewItem,
  FetchPreviewSummary,
  FetchJobSummary,
  FetchJobDetail,
  FetchTargetInput,
} from "@/api/fetch";

const { t } = useI18n();

const activeTab = ref("config");

// ---------- 配置 ----------
function defaultConfig(): Required<FetchConfig> {
  return {
    enabled: true,
    downloadRoot: "/MUSIC/DOWNLOAD",
    cacheRoot: "/MUSIC/DOWNLOADCACHE",
    qualityFloor: "320",
    minBitrateKbps: 320,
    minSampleRateHz: 44100,
    preferLossless: true,
    rejectFakeLossless: true,
    skipIfInLibrary: true,
    strictBestTier: true,
    integrityLevel: "probe",
    transcodeEnabled: true,
    transcodeTarget: "flac",
    transcodeSampleRateHz: 44100,
    transcodeBitDepth: 16,
    transcodeKeepOriginal: false,
    maxConcurrentDownloads: 2,
    maxConcurrentPerHost: 1,
    perHostMinIntervalMs: 500,
    rateLimitKBps: 0,
    fileConflictPolicy: "keepBetter",
    sourcePriority: [],
  };
}

const config = reactive<Required<FetchConfig>>(defaultConfig());
const configLoading = ref(false);
const configSaving = ref(false);
const priorityInput = ref("");
const availableSources = ref<FetchSourceInfo[]>([]);

const floorOptions = ["lossless", "hires", "320", "256", "192", "128", "any"];
const integrityOptions = ["length", "magic", "probe", "decodable"];
const conflictOptions = ["skip", "overwrite", "rename", "keepBetter"];

function floorLabel(v: string): string {
  if (v === "lossless" || v === "hires" || v === "any") return t(`admin.fetch.floor.${v}`);
  return `${v} kbps`;
}
function integrityLabel(v: string): string {
  return t(`admin.fetch.integrityOption.${v}`);
}
function conflictLabel(v: string): string {
  return t(`admin.fetch.conflictOption.${v}`);
}

async function loadConfig() {
  configLoading.value = true;
  try {
    const remote = await getFetchConfig();
    Object.assign(config, { ...defaultConfig(), ...remote });
    if (!Array.isArray(config.sourcePriority)) config.sourcePriority = [];
  } catch (e: any) {
    ElMessage.error(apiErrorText(e, t("admin.fetch.config.saveFailed")));
  } finally {
    configLoading.value = false;
  }
}

async function loadSources() {
  try {
    availableSources.value = await getFetchSources();
  } catch {
    availableSources.value = [];
  }
}

async function saveConfig() {
  configSaving.value = true;
  try {
    await updateFetchConfig({ ...config });
    ElMessage.success(t("admin.fetch.config.saved"));
  } catch (e: any) {
    ElMessage.error(apiErrorText(e, t("admin.fetch.config.saveFailed")));
  } finally {
    configSaving.value = false;
  }
}

function addPriority() {
  const v = priorityInput.value.trim();
  if (!v) return;
  if (!config.sourcePriority.includes(v)) config.sourcePriority.push(v);
  priorityInput.value = "";
}
function addSourceTag(src: FetchSourceInfo) {
  const id = src.pluginId || src.platform;
  if (id && !config.sourcePriority.includes(id)) config.sourcePriority.push(id);
}
function removePriority(i: number) {
  config.sourcePriority.splice(i, 1);
}
function movePriority(i: number, delta: number) {
  const j = i + delta;
  if (j < 0 || j >= config.sourcePriority.length) return;
  const list = config.sourcePriority;
  [list[i], list[j]] = [list[j], list[i]];
}

// ---------- 新建任务 ----------
const targetsText = ref("");
const previewLoading = ref(false);
const startLoading = ref(false);
const previewSummary = ref<FetchPreviewSummary | null>(null);
const previewItems = ref<FetchPreviewItem[]>([]);

function parseTargets(text: string): FetchTargetInput[] {
  const out: FetchTargetInput[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const idx = line.lastIndexOf(" - ");
    if (idx > 0) {
      const title = line.slice(0, idx).trim();
      const artist = line.slice(idx + 3).trim();
      if (title) out.push(artist ? { title, artist } : { title });
    } else {
      out.push({ title: line });
    }
  }
  return out;
}

const parsedCount = computed(() => parseTargets(targetsText.value).length);

async function doPreview() {
  const targets = parseTargets(targetsText.value);
  if (!targets.length) {
    ElMessage.warning(t("admin.fetch.create.emptyInput"));
    return;
  }
  previewLoading.value = true;
  try {
    const res = await previewFetch(targets);
    previewSummary.value = res.summary;
    previewItems.value = res.items;
  } catch (e: any) {
    ElMessage.error(apiErrorText(e, t("admin.fetch.create.previewFailed")));
  } finally {
    previewLoading.value = false;
  }
}

async function doStart() {
  const targets = parseTargets(targetsText.value);
  if (!targets.length) {
    ElMessage.warning(t("admin.fetch.create.emptyInput"));
    return;
  }
  startLoading.value = true;
  try {
    const jobId = await createFetchTask(targets, false);
    ElMessage.success(t("admin.fetch.create.started", { id: shortId(jobId) }));
    activeTab.value = "jobs";
    await refreshJobs();
  } catch (e: any) {
    ElMessage.error(apiErrorText(e, t("admin.fetch.create.startFailed")));
  } finally {
    startLoading.value = false;
  }
}

// ---------- 任务列表 ----------
const jobs = ref<FetchJobSummary[]>([]);
const jobsLoading = ref(false);
const jobsError = ref("");
const statusFilter = ref("");
const limit = ref(50);
const jobStatusOptions = ["pending", "running", "done", "partial", "cancelled", "failed"];
const ACTIVE_STATUS = ["pending", "running"];

function isActiveStatus(s?: string): boolean {
  return !!s && ACTIVE_STATUS.includes(s);
}

async function fetchJobList(): Promise<FetchJobSummary[]> {
  return listFetchJobs({ limit: limit.value, status: statusFilter.value || undefined });
}

async function refreshJobs() {
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

// 进行中的任务每 2 秒轮询一次;全部结束/取消后自动停止。
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
    /* 轮询失败静默,下个 tick 再试 */
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
    await refreshJobs();
    if (detailVisible.value && detailId.value === job.id && detail.value) {
      const d = await getFetchJob(job.id);
      if (d) detail.value = d;
    }
  } catch (e: any) {
    ElMessage.error(apiErrorText(e, t("admin.fetch.jobs.cancelFailed")));
  }
}

// 顶部按钮:重试当前任务的全部失败项。
async function doRetryAll() {
  if (!detail.value) return;
  try {
    const newId = await retryFetchJob(detail.value.id, true);
    ElMessage.success(t("admin.fetch.jobs.retryStarted", { id: shortId(newId) }));
    detailVisible.value = false;
    activeTab.value = "jobs";
    await refreshJobs();
  } catch (e: any) {
    ElMessage.error(apiErrorText(e, t("admin.fetch.jobs.retryFailed")));
  }
}

// 逐曲重试:契约没有单曲重试端点,故为该曲目单独建一个新任务。
function canRetryItem(s?: string): boolean {
  return s === "failed" || s === "skipped" || s === "cancelled";
}
async function retryItem(item: any) {
  try {
    const newId = await createFetchTask([{ title: item.title, artist: item.artist || undefined }], false);
    ElMessage.success(t("admin.fetch.jobs.retryStarted", { id: shortId(newId) }));
    detailVisible.value = false;
    activeTab.value = "jobs";
    await refreshJobs();
  } catch (e: any) {
    ElMessage.error(apiErrorText(e, t("admin.fetch.jobs.retryFailed")));
  }
}

// ---------- 展示辅助 ----------
const STATUS_KEY: Record<string, string> = {
  pending: "pending",
  running: "running",
  done: "done",
  partial: "partial",
  cancelled: "cancelled",
  failed: "failed",
  queued: "queued",
  probing: "probing",
  downloading: "downloading",
  verifying: "verifying",
  tagging: "tagging",
  transcoding: "transcoding",
  moving: "moving",
  scanned: "scanned",
  skipped: "skipped",
  downloadable: "downloadable",
  belowBar: "belowBar",
  noCandidate: "noCandidate",
};

function statusText(s?: string): string {
  if (!s) return "-";
  const k = STATUS_KEY[s];
  return k ? t(`admin.fetch.status.${k}`) : s;
}

function statusTagType(s?: string): "success" | "info" | "warning" | "danger" {
  if (!s) return "info";
  if (["done", "scanned", "downloadable"].includes(s)) return "success";
  if (["failed", "partial"].includes(s)) return "danger";
  if (["running", "probing", "downloading", "verifying", "tagging", "transcoding", "moving", "belowBar"].includes(s)) return "warning";
  return "info";
}

// 失败原因码 -> 中文/英文文案(按码给文案,不要裸码)。
const ERROR_CODE_KEY: Record<string, string> = {
  NO_CANDIDATE: "noCandidate",
  BELOW_BAR: "belowBar",
  ALREADY_IN_LIBRARY: "alreadyInLibrary",
  DUPLICATE_TARGET: "duplicateTarget",
  FAKE_LOSSLESS: "fakeLossless",
  INTEGRITY_FAILED: "integrityFailed",
  HTTP_403: "http403",
  TIMEOUT: "timeout",
  STALL: "stall",
  TAG_FAILED: "tagFailed",
  TRANSCODE_FAILED: "transcodeFailed",
  DISK_FULL: "diskFull",
  MOVE_FAILED: "moveFailed",
  SCAN_FAILED: "scanFailed",
  SSRF_BLOCKED: "ssrfBlocked",
  UNKNOWN: "unknown",
};

function errorText(code?: string): string {
  if (!code) return "";
  const k = ERROR_CODE_KEY[code];
  if (k) return t(`admin.fetch.errorCode.${k}`);
  const sk = STATUS_KEY[code];
  return sk ? t(`admin.fetch.status.${sk}`) : code;
}

function shortId(id?: string): string {
  if (!id) return "-";
  return id.length > 10 ? id.slice(0, 8) + "..." : id;
}

function formatBytes(n?: number): string {
  if (!n || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDateTime(v?: string | number): string {
  if (!v) return "-";
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function jobDuration(job: FetchJobSummary): string {
  const start = job.startedAt || job.createdAt;
  const end = job.finishedAt;
  if (!start || !end) return "-";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!isFinite(ms) || ms < 0) return "-";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function sourceText(chosen?: FetchChosen): string {
  if (!chosen) return "-";
  return chosen.platform || chosen.pluginId || "-";
}

function qualityText(chosen?: FetchChosen): string {
  if (!chosen) return "-";
  const p = chosen.probed ?? chosen.declared;
  const parts: string[] = [];
  if (p && typeof p === "object") {
    if (p.codec) parts.push(String(p.codec));
    if (p.bitrateKbps) parts.push(`${p.bitrateKbps} kbps`);
    if (p.sampleRateHz) parts.push(`${p.sampleRateHz} Hz`);
    if (p.bitDepth) parts.push(`${p.bitDepth} bit`);
  } else if (typeof p === "string" && p) {
    parts.push(p);
  }
  return parts.length ? parts.join(" / ") : "-";
}

onMounted(() => {
  loadConfig();
  loadSources();
  refreshJobs();
});
onUnmounted(stopPolling);
</script>

<style lang="scss" scoped>
.admin-fetch { padding: 24px 32px 130px; max-width: 1400px; margin: 0 auto; }
.page-header {
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 8px; flex-wrap: wrap; gap: 12px;
  h2 { font-size: 28px; font-weight: 700; margin: 0; }
}
.fetch-tabs { margin-top: 8px; }
.hint { font-size: 12px; color: var(--fnos-text-tertiary); line-height: 1.6; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.cell-fail { color: var(--fnos-red); font-weight: 600; }

/* 配置 */
.config-wrap { max-width: 960px; }
.config-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 4px 20px;
  align-items: start;
}
.config-form :deep(.el-form-item) { margin-bottom: 16px; }
.field-inline { display: flex; align-items: center; gap: 10px; }
.transcode-warn { margin: 4px 0 16px; }
.config-actions { margin-top: 8px; }

.priority-list { width: 100%; }
.priority-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.priority-idx { flex: 0 0 18px; text-align: center; font-size: 12px; color: var(--fnos-text-tertiary); }
.priority-input { flex: 1; min-width: 0; }
.priority-add { display: flex; gap: 8px; margin-top: 8px; max-width: 460px; }
.avail-sources { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.src-tag { cursor: pointer; }

/* 新建任务 */
.create-form { max-width: 900px; }
.create-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.preview-block { margin-top: 8px; }
.summary-bar { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }

/* 任务列表 */
.jobs-toolbar {
  display: flex; justify-content: space-between; align-items: center;
  flex-wrap: wrap; gap: 12px; margin-bottom: 12px;
}
.jobs-filters { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.filter-select { width: 140px; }
.limit-select { width: 100px; }
.jobs-error { margin-bottom: 12px; }

/* 详情 */
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
  .admin-fetch { padding: 20px 16px; }
  .page-header h2 { font-size: 24px; }
  .config-grid { grid-template-columns: 1fr; }
  .jobs-filters { width: 100%; }
}
</style>
