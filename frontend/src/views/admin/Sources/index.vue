<template>
  <div class="admin-sources">
    <div class="page-header">
      <h2>{{ t('admin.sources.title') }}</h2>
      <el-button type="primary" @click="showAddDialog = true">{{ t('admin.sources.add') }}</el-button>
    </div>
    <div class="source-grid" v-if="sources.length > 0">
      <el-card v-for="source in sources" :key="source.id" class="source-card">
        <div class="source-header">
          <div class="source-info">
            <h3>{{ source.name }}</h3>
            <el-tag :type="source.enabled ? 'success' : 'info'" size="small">{{ source.type }}</el-tag>
          </div>
          <el-dropdown @command="(cmd: string) => handleCommand(cmd, source)">
            <MfIcon name="MoreHorizontal" class="more-btn"  />
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="test"><MfIcon name="Cable" />{{ t('admin.sources.testConnection') }}</el-dropdown-item>
                <el-dropdown-item command="scan"><MfIcon name="Play" />{{ t('admin.sources.fullScan') }}</el-dropdown-item>
                <el-dropdown-item command="scan-incremental"><MfIcon name="RefreshCw" />{{ t('admin.sources.incrementalScan') }}</el-dropdown-item>
                <el-dropdown-item command="edit"><MfIcon name="Pencil" />{{ t('admin.sources.editConfig') }}</el-dropdown-item>
                <el-dropdown-item command="delete" divided><MfIcon name="Trash2" />{{ t('common.delete') }}</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
        <div class="source-config">
          <p v-if="source.config?.url"><strong>URL:</strong> {{ source.config.url }}</p>
          <p v-if="source.config?.root_path"><strong>{{ t('admin.sources.rootPath') }}:</strong> {{ source.config.root_path }}</p>
          <p v-if="source.config?.username"><strong>{{ t('common.username') }}:</strong> {{ source.config.username }}</p>
          <p><strong>{{ t('common.status') }}:</strong> <el-tag :type="source.enabled ? 'success' : 'info'" size="small">{{ source.enabled ? t('common.enabled') : t('common.disabled') }}</el-tag></p>
          <p>
            <strong>{{ t('admin.sources.autoScan') }}:</strong>
            <el-tag v-if="source.config?.scanAutoEnabled" type="warning" size="small">{{ t('admin.sources.autoScanOn', { time: source.config?.scanAutoTimeOfDay || '03:00' }) }}</el-tag>
            <el-tag v-else type="info" size="small">{{ t('admin.sources.autoScanOff') }}</el-tag>
          </p>
        </div>

        <!-- Scan progress -->
        <div v-if="source._scanProgress" class="scan-progress">
          <div class="progress-header">
            <span class="progress-label">
              {{ source._scanProgress.phase === 'traverse' ? t('admin.sources.scanningDir') : source._scanProgress.phase === 'scanning' ? t('admin.sources.scraping') : t('admin.sources.scanDone') }}
              <el-tag v-if="source._scanTrigger === 'auto'" size="small" type="info" class="auto-tag">{{ t('admin.sources.autoTriggered') }}</el-tag>
            </span>
            <span class="progress-count" v-if="source._scanProgress.phase === 'scanning'">
              <el-tag size="small" :type="source._scanProgress.mode === 'incremental' ? 'warning' : 'primary'" class="mode-tag">
                {{ source._scanProgress.mode === 'incremental' ? t('admin.sources.incremental') : t('admin.sources.full') }}
              </el-tag>
              {{ source._scanProgress.processedFiles }} / {{ source._scanProgress.totalFiles }}
              <span v-if="source._scanProgress.totalFiles > 0">({{ Math.round((source._scanProgress.processedFiles / source._scanProgress.totalFiles) * 100) }}%)</span>
            </span>
          </div>
          <el-progress
            v-if="source._scanProgress.phase === 'scanning' && source._scanProgress.totalFiles > 0"
            :percentage="Math.round((source._scanProgress.processedFiles / source._scanProgress.totalFiles) * 100)"
            :stroke-width="8"
            :status="source._scanProgress.phase === 'done' ? 'success' : undefined"
          />
          <el-progress
            v-else-if="source._scanProgress.phase === 'traverse' || source._scanProgress.phase === 'scanning'"
            :percentage="100"
            :indeterminate="true"
            :stroke-width="8"
          />
          <!-- Directory progress during scan -->
          <div v-if="source._scanProgress.phase === 'scanning'" class="dir-progress">
            {{ t('admin.sources.scanDir') }} {{ source._scanProgress.processedDirs }} / {{ source._scanProgress.totalDirs }}
          </div>
          <!-- Currently scraping track -->
          <div v-if="source._scanProgress.phase === 'scanning' && source._scanProgress.currentTrack" class="progress-current">
            <MfIcon name="Play" class="current-icon"  />
            <span class="current-name">{{ t('admin.sources.scrapingTrack', { track: source._scanProgress.currentTrack }) }}</span>
          </div>
          <div class="progress-stats" v-if="source._scanProgress.phase !== 'traverse'">
            <span>{{ t('admin.sources.scraped', { count: source._scanProgress.processedFiles || 0 }) }}</span>
            <span>{{ t('admin.sources.added', { count: source._scanProgress.added || 0 }) }}</span>
            <span>{{ t('admin.sources.updated', { count: source._scanProgress.updated || 0 }) }}</span>
            <span>{{ t('admin.sources.skipped', { count: source._scanProgress.skipped || 0 }) }}</span>
            <!-- 失败与跳过分开显示:失败>0 才出现,红色,避免被「跳过」掩盖 -->
            <span v-if="source._scanProgress.failed" class="stat-fail">{{ t('admin.sources.failed', { count: source._scanProgress.failed }) }}</span>
          </div>
        </div>

        <div class="source-actions">
          <el-button size="small" @click="testConnection(source)" :loading="source._testing">{{ t('admin.sources.testConnection') }}</el-button>
          <el-button size="small" type="primary" @click="scanSource(source, 'full')" :loading="source._scanning" :disabled="source._scanning">{{ t('admin.sources.fullScan') }}</el-button>
          <el-button size="small" type="warning" @click="scanSource(source, 'incremental')" :loading="source._scanning" :disabled="source._scanning">{{ t('admin.sources.incrementalScan') }}</el-button>
          <el-button v-if="source._scanning" size="small" type="danger" @click="stopScan(source)">{{ t('admin.sources.stopScan') }}</el-button>
        </div>
      </el-card>
    </div>
    <EmptyState v-else icon="folder-open" :title="t('admin.sources.emptyTitle')" :description="t('admin.sources.emptyDesc')">
      <template #action>
        <el-button type="primary" @click="showAddDialog = true">{{ t('admin.sources.add') }}</el-button>
      </template>
    </EmptyState>

    <!-- Add dialog -->
    <el-dialog v-model="showAddDialog" :title="t('admin.sources.addDialogTitle')" width="500px" :append-to-body="true">
      <el-form label-width="100px">
        <el-form-item :label="t('common.name')"><el-input v-model="newSource.name" :placeholder="t('admin.sources.namePlaceholder')" /></el-form-item>
        <el-form-item :label="t('common.type')">
          <el-select v-model="newSource.type">
            <el-option label="WebDAV" value="webdav" />
            <el-option :label="t('admin.sources.localDir')" value="local" />
          </el-select>
        </el-form-item>
        <template v-if="newSource.type === 'webdav'">
          <el-form-item label="WebDAV URL"><el-input v-model="newSource.config.url" placeholder="http://192.168.1.100:5000/dav" /></el-form-item>
          <el-form-item :label="t('common.username')"><el-input v-model="newSource.config.username" :placeholder="t('common.optional')" /></el-form-item>
          <el-form-item :label="t('common.password')"><el-input v-model="newSource.config.password" type="password" :placeholder="t('common.optional')" show-password /></el-form-item>
          <el-form-item :label="t('admin.sources.rootPath')"><el-input v-model="newSource.config.root_path" placeholder="/music" /></el-form-item>
        </template>
        <template v-else>
          <el-form-item :label="t('admin.sources.localPath')" :description="t('admin.sources.localPathDesc')">
            <el-input v-model="newSource.config.path" placeholder="/local/music" />
          </el-form-item>
        </template>
        <el-divider />
        <el-form-item :label="t('admin.sources.autoScan')">
          <el-switch v-model="newSource.autoEnabled" />
          <span class="form-hint">{{ t('admin.sources.autoScanHint') }}</span>
        </el-form-item>
        <el-form-item v-if="newSource.autoEnabled" :label="t('admin.sources.autoScanTime')">
          <el-time-picker v-model="newSource.autoTime" format="HH:mm" value-format="HH:mm" :clearable="false" :placeholder="t('admin.sources.autoScanTimePlaceholder')" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showAddDialog = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" @click="addSource">{{ t('common.add') }}</el-button>
      </template>
    </el-dialog>

    <!-- Pencil dialog -->
    <el-dialog v-model="showEditDialog" :title="t('admin.sources.editDialogTitle')" width="500px" :append-to-body="true">
      <el-form label-width="100px">
        <el-form-item :label="t('common.name')"><el-input v-model="editSource.name" /></el-form-item>
        <template v-if="editSource.type === 'webdav'">
          <el-form-item label="WebDAV URL"><el-input v-model="editSource.config.url" /></el-form-item>
          <el-form-item :label="t('common.username')"><el-input v-model="editSource.config.username" /></el-form-item>
          <el-form-item :label="t('common.password')"><el-input v-model="editSource.config.password" type="password" show-password /></el-form-item>
          <el-form-item :label="t('admin.sources.rootPath')"><el-input v-model="editSource.config.root_path" /></el-form-item>
        </template>
        <template v-else>
          <el-form-item :label="t('admin.sources.localPath')" :description="t('admin.sources.localPathDesc')">
            <el-input v-model="editSource.config.path" placeholder="/local/music" />
          </el-form-item>
        </template>
        <el-form-item :label="t('common.enable')">
          <el-switch v-model="editSource.enabled" :active-value="1" :inactive-value="0" />
        </el-form-item>
        <el-divider />
        <el-form-item :label="t('admin.sources.autoScan')">
          <el-switch v-model="editSource.config.scanAutoEnabled" />
          <span class="form-hint">{{ t('admin.sources.autoScanHint') }}</span>
        </el-form-item>
        <el-form-item v-if="editSource.config.scanAutoEnabled" :label="t('admin.sources.autoScanTime')">
          <el-time-picker v-model="editSource.config.scanAutoTimeOfDay" format="HH:mm" value-format="HH:mm" :clearable="false" :placeholder="t('admin.sources.autoScanTimePlaceholder')" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showEditDialog = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" @click="saveEdit">{{ t('common.save') }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import { ElMessage, ElMessageBox } from "element-plus";
import EmptyState from "@/components/EmptyState.vue";
import api from "@/api";

const { t } = useI18n();
const sources = ref<any[]>([]);
const showAddDialog = ref(false);
const showEditDialog = ref(false);
const newSource = reactive({ name: "", type: "webdav", autoEnabled: false, autoTime: "03:00", config: { url: "", username: "", password: "", root_path: "", path: "" } });
const editSource = reactive({ id: "", name: "", type: "webdav", enabled: 1, config: { url: "", username: "", password: "", root_path: "", path: "", scanAutoEnabled: false, scanAutoTimeOfDay: "03:00" } });
let pollTimer: ReturnType<typeof setInterval> | null = null;

async function loadSources() {
  try {
    // 保留进行中的扫描运行态：重载卡片数据时不把已显示的进度抹掉（否则轮询会闪一下）。
    const prev = new Map(sources.value.map((s: any) => [s.id, s]));
    const res = await api.get("/rest/api/v1/sources");
    sources.value = res.data.map((s: any) => {
      const old = prev.get(s.id);
      return {
        ...s,
        _testing: false,
        _scanning: old?._scanning ?? false,
        _scanProgress: old?._scanProgress ?? null,
        _scanTrigger: old?._scanTrigger ?? null,
      };
    });
  } catch { sources.value = []; }
}

async function addSource() {
  if (!newSource.name) { ElMessage.warning(t("admin.sources.requiredName")); return; }
  try {
    const config: Record<string, any> = newSource.type === "webdav"
      ? { url: newSource.config.url, username: newSource.config.username, password: newSource.config.password, root_path: newSource.config.root_path }
      : { path: newSource.config.path };
    config.scanAutoEnabled = newSource.autoEnabled;
    config.scanAutoTimeOfDay = newSource.autoTime;
    await api.post("/rest/api/v1/sources", { name: newSource.name, type: newSource.type, config });
    showAddDialog.value = false;
    newSource.name = ""; newSource.autoEnabled = false; newSource.autoTime = "03:00";
    newSource.config = { url: "", username: "", password: "", root_path: "", path: "" };
    ElMessage.success(t("common.addSuccess"));
    loadSources();
  } catch (e: any) { ElMessage.error(e.response?.data?.error || t("common.addFailed")); }
}

function handleCommand(cmd: string, source: any) {
  switch (cmd) {
    case "test": testConnection(source); break;
    case "scan": scanSource(source, "full"); break;
    case "scan-incremental": scanSource(source, "incremental"); break;
    case "edit": openEdit(source); break;
    case "delete": deleteSource(source); break;
  }
}

async function testConnection(source: any) {
  source._testing = true;
  try {
    const res = await api.post(`/rest/api/v1/sources/${source.id}/test`);
    if (res.data.success) ElMessage.success(t("admin.sources.connectionSuccess", { message: res.data.message || t("admin.sources.serverReachable") }));
    else ElMessage.error(t("admin.sources.connectionFailed", { message: res.data.error }));
  } catch (e: any) { ElMessage.error(t("admin.sources.connectionFailed", { message: e.response?.data?.error || e.message })); }
  finally { source._testing = false; }
}

// 常驻轮询「聚合扫描状态」：任何触发方式（手动点按 / 每日定时 / 其它标签页发起）的扫描
// 都能实时显示进度，而不是只在完成后才看到最终态。3s 一次，仅本页挂载期间运行。
async function pollScanStatus() {
  let jobs: Record<string, any>;
  try {
    const res = await api.get("/rest/api/v1/sources/scan-status");
    jobs = res.data?.jobs || {};
  } catch { return; }
  let needReload = false;
  for (const s of sources.value) {
    const job = jobs[s.id];
    if (job && job.status === "running") {
      s._scanning = true;
      s._scanTrigger = job.trigger || null;
      s._scanProgress = job.progress
        ? { ...job.progress, mode: job.mode || job.progress.mode }
        : {
            phase: "traverse", mode: job.mode, totalDirs: 0, processedDirs: 0,
            totalFiles: 0, processedFiles: 0, added: 0, updated: 0, skipped: 0, failed: 0, currentTrack: "",
          };
      continue;
    }
    const wasRunning = s._scanning || !!s._scanProgress;
    s._scanning = false;
    s._scanProgress = null;
    s._scanTrigger = null;
    if (wasRunning && job) {
      needReload = true;
      if (job.status === "completed") {
        const r = job.result;
        ElMessage.success(t("admin.sources.scanDoneSummary", { added: r?.added || 0, updated: r?.updated || 0, removed: r?.removed || 0 }));
        // 成功 toast 只报新增/更新/移除 —— 有失败必须单独提示,否则用户以为「跳过」而已。
        if (r?.failed) ElMessage.warning(t("admin.sources.failed", { count: r.failed }));
      } else if (job.status === "stopped") {
        ElMessage.info(t("admin.sources.scanStopped"));
      } else if (job.status === "failed") {
        ElMessage.error(t("admin.sources.scanFailed", { error: job.error }));
      }
    }
  }
  if (needReload) loadSources();
}

async function stopScan(source: any) {
  try {
    const res = await api.post(`/rest/api/v1/sources/${source.id}/scan-stop`);
    if (res.data.success) ElMessage.info(t("admin.sources.stoppingScan"));
    else ElMessage.error(res.data.error || t("admin.sources.stopFailed"));
  } catch (e: any) { ElMessage.error(e.response?.data?.error || e.message); }
}

async function scanSource(source: any, mode: "full" | "incremental" = "full") {
  source._scanning = true;
  try {
    const res = await api.post(`/rest/api/v1/sources/${source.id}/scan`, { mode });
    if (res.data.success) {
      ElMessage.info(mode === "incremental" ? t("admin.sources.incrementalScanStarted") : t("admin.sources.fullScanStarted"));
      pollScanStatus();
    } else {
      source._scanning = false;
      ElMessage.error(res.data.error || t("admin.sources.scanStartFailed"));
    }
  } catch (e: any) {
    source._scanning = false;
    ElMessage.error(e.response?.data?.error || e.message);
  }
}

function openEdit(source: any) {
  editSource.id = source.id; editSource.name = source.name; editSource.type = source.type;
  editSource.enabled = source.enabled;
  // 定时增量扫描两键回填：缺省时归一成「关 + 03:00」，避免开关/时间选择器拿到 undefined。
  editSource.config = {
    ...source.config,
    scanAutoEnabled: !!source.config?.scanAutoEnabled,
    scanAutoTimeOfDay: source.config?.scanAutoTimeOfDay || "03:00",
  };
  showEditDialog.value = true;
}

async function saveEdit() {
  try {
    await api.put(`/rest/api/v1/sources/${editSource.id}`, { name: editSource.name, enabled: editSource.enabled, config: editSource.config });
    showEditDialog.value = false; ElMessage.success(t("common.saveSuccess")); loadSources();
  } catch (e: any) { ElMessage.error(e.response?.data?.error || t("common.saveFailed")); }
}

async function deleteSource(source: any) {
  await ElMessageBox.confirm(t("admin.sources.confirmDeleteSource", { name: source.name }), t("common.confirmDelete"), { type: "warning" });
  try { await api.delete(`/rest/api/v1/sources/${source.id}`); ElMessage.success(t("common.deleted")); loadSources(); }
  catch (e: any) { ElMessage.error(e.response?.data?.error || t("common.deleteFailed")); }
}

onMounted(() => {
  loadSources();
  // 常驻低频轮询：让定时/他人触发的扫描也能实时可见（先拉数据、再起轮询，二者不互斥）。
  pollTimer = setInterval(pollScanStatus, 3000);
});
onUnmounted(() => {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
});
</script>

<style lang="scss" scoped>
.admin-sources { padding: 24px 32px 130px; max-width: 1200px; margin: 0 auto; }
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; flex-wrap: wrap; gap: 12px; h2 { font-size: 28px; font-weight: 700; margin: 0; } }
.source-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 16px; }
.source-card {
  background: rgba(255,255,255,0.04) !important;
  border: 1px solid rgba(255,255,255,0.07) !important;
  border-radius: var(--fnos-radius-lg) !important;
  color: var(--fnos-text-primary-dim);
  .source-header { display: flex; justify-content: space-between; align-items: center;
    .source-info { display: flex; align-items: center; gap: 8px; h3 { margin: 0; font-size: 16px; color: var(--fnos-text-primary); } }
    .more-btn { cursor: pointer; font-size: 18px; color: var(--fnos-text-secondary); &:hover { color: var(--fnos-red); } }
  }
  .source-config { margin: 12px 0; color: var(--fnos-text-tertiary); font-size: 13px; p { margin: 6px 0; } }
  .scan-progress {
    margin: 12px 0; padding: 12px; background: rgba(27, 115, 251, 0.08); border-radius: 8px; border: 1px solid rgba(27, 115, 251, 0.15);
    .progress-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;
      .progress-label { font-weight: 500; color: var(--fnos-blue); font-size: 13px; }
      .progress-count { font-size: 12px; color: var(--fnos-text-tertiary); .mode-tag { margin-right: 4px; } }
    }
    .dir-progress { margin-top: 8px; font-size: 12px; color: var(--fnos-text-tertiary); }
    .progress-current { display: flex; align-items: center; gap: 6px; margin-top: 10px; padding: 6px 10px; background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px;
      .current-icon { color: var(--fnos-blue); }
      .current-name { font-size: 12px; color: var(--fnos-text-primary-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    }
    .progress-stats { display: flex; gap: 16px; margin-top: 8px; font-size: 12px; color: var(--fnos-text-tertiary); span { &:first-child { color: var(--fnos-green); } &:nth-child(2) { color: var(--fnos-green); } &:nth-child(3) { color: var(--fnos-orange); } } }
    .progress-stats .stat-fail { color: var(--fnos-red); font-weight: 600; }
  }
  .source-actions { display: flex; flex-wrap: wrap; gap: 8px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.06);
    .el-button { margin-left: 0; flex: 1 1 auto; min-width: 84px; }
  }
}
:deep(.el-card) { background: rgba(255,255,255,0.04) !important; border: 1px solid rgba(255,255,255,0.07) !important; }
.form-hint { margin-left: 8px; color: var(--fnos-text-tertiary); font-size: 12px; }
.auto-tag { margin-left: 6px; }
@media (max-width: 768px) {
  .admin-sources { padding: 20px 16px; }
  .page-header h2 { font-size: 24px; }
  .source-grid { grid-template-columns: 1fr; }
  .source-actions { flex-wrap: wrap; }
  .source-actions .el-button { margin-left: 0; }
  .scan-progress .progress-header { flex-direction: column; align-items: flex-start; gap: 4px; }
  .scan-progress .progress-stats { flex-wrap: wrap; gap: 8px 12px; }
}
</style>
