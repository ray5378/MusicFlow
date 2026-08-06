<template>
  <div class="admin-sources">
    <div class="page-header">
      <h2>媒体源管理</h2>
      <el-button type="primary" @click="showAddDialog = true">添加媒体源</el-button>
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
                <el-dropdown-item command="test"><MfIcon name="Cable" />测试连接</el-dropdown-item>
                <el-dropdown-item command="scan"><MfIcon name="Play" />全库扫描</el-dropdown-item>
                <el-dropdown-item command="scan-incremental"><MfIcon name="RefreshCw" />增量扫描</el-dropdown-item>
                <el-dropdown-item command="edit"><MfIcon name="Pencil" />修改配置</el-dropdown-item>
                <el-dropdown-item command="delete" divided><MfIcon name="Trash2" />删除</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
        <div class="source-config">
          <p v-if="source.config?.url"><strong>URL:</strong> {{ source.config.url }}</p>
          <p v-if="source.config?.root_path"><strong>根路径:</strong> {{ source.config.root_path }}</p>
          <p v-if="source.config?.username"><strong>用户名:</strong> {{ source.config.username }}</p>
          <p><strong>状态:</strong> <el-tag :type="source.enabled ? 'success' : 'info'" size="small">{{ source.enabled ? '已启用' : '已禁用' }}</el-tag></p>
        </div>

        <!-- Scan progress -->
        <div v-if="source._scanProgress" class="scan-progress">
          <div class="progress-header">
            <span class="progress-label">
              {{ source._scanProgress.phase === 'traverse' ? '扫描目录中...' : source._scanProgress.phase === 'scanning' ? '刮削中...' : '扫描完成' }}
            </span>
            <span class="progress-count" v-if="source._scanProgress.phase === 'scanning'">
              <el-tag size="small" :type="source._scanProgress.mode === 'incremental' ? 'warning' : 'primary'" class="mode-tag">
                {{ source._scanProgress.mode === 'incremental' ? '增量' : '全库' }}
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
            目录 {{ source._scanProgress.processedDirs }} / {{ source._scanProgress.totalDirs }}
          </div>
          <!-- Currently scraping track -->
          <div v-if="source._scanProgress.phase === 'scanning' && source._scanProgress.currentTrack" class="progress-current">
            <MfIcon name="Play" class="current-icon"  />
            <span class="current-name">正在刮削: {{ source._scanProgress.currentTrack }}</span>
          </div>
          <div class="progress-stats" v-if="source._scanProgress.phase !== 'traverse'">
            <span>已刮削 {{ source._scanProgress.processedFiles || 0 }}</span>
            <span>新增 {{ source._scanProgress.added || 0 }}</span>
            <span>更新 {{ source._scanProgress.updated || 0 }}</span>
            <span>跳过 {{ source._scanProgress.skipped || 0 }}</span>
          </div>
        </div>

        <div class="source-actions">
          <el-button size="small" @click="testConnection(source)" :loading="source._testing">测试连接</el-button>
          <el-button size="small" type="primary" @click="scanSource(source, 'full')" :loading="source._scanning" :disabled="source._scanning">全库扫描</el-button>
          <el-button size="small" type="warning" @click="scanSource(source, 'incremental')" :loading="source._scanning" :disabled="source._scanning">增量扫描</el-button>
          <el-button v-if="source._scanning" size="small" type="danger" @click="stopScan(source)">停止扫描</el-button>
        </div>
      </el-card>
    </div>
    <EmptyState v-else icon="folder-open" title="暂无媒体源" description="添加本地目录或 WebDAV 以开始管理音乐库">
      <template #action>
        <el-button type="primary" @click="showAddDialog = true">添加媒体源</el-button>
      </template>
    </EmptyState>

    <!-- Add dialog -->
    <el-dialog v-model="showAddDialog" title="添加媒体源" width="500px">
      <el-form label-width="100px">
        <el-form-item label="名称"><el-input v-model="newSource.name" placeholder="我的音乐库" /></el-form-item>
        <el-form-item label="类型">
          <el-select v-model="newSource.type">
            <el-option label="WebDAV" value="webdav" />
            <el-option label="本地目录" value="local" />
          </el-select>
        </el-form-item>
        <template v-if="newSource.type === 'webdav'">
          <el-form-item label="WebDAV URL"><el-input v-model="newSource.config.url" placeholder="http://192.168.1.100:5000/dav" /></el-form-item>
          <el-form-item label="用户名"><el-input v-model="newSource.config.username" placeholder="可选" /></el-form-item>
          <el-form-item label="密码"><el-input v-model="newSource.config.password" type="password" placeholder="可选" show-password /></el-form-item>
          <el-form-item label="根路径"><el-input v-model="newSource.config.root_path" placeholder="/music" /></el-form-item>
        </template>
        <template v-else>
          <el-form-item label="本地路径"><el-input v-model="newSource.config.path" placeholder="/path/to/music" /></el-form-item>
        </template>
      </el-form>
      <template #footer>
        <el-button @click="showAddDialog = false">取消</el-button>
        <el-button type="primary" @click="addSource">添加</el-button>
      </template>
    </el-dialog>

    <!-- Pencil dialog -->
    <el-dialog v-model="showEditDialog" title="修改媒体源配置" width="500px">
      <el-form label-width="100px">
        <el-form-item label="名称"><el-input v-model="editSource.name" /></el-form-item>
        <template v-if="editSource.type === 'webdav'">
          <el-form-item label="WebDAV URL"><el-input v-model="editSource.config.url" /></el-form-item>
          <el-form-item label="用户名"><el-input v-model="editSource.config.username" /></el-form-item>
          <el-form-item label="密码"><el-input v-model="editSource.config.password" type="password" show-password /></el-form-item>
          <el-form-item label="根路径"><el-input v-model="editSource.config.root_path" /></el-form-item>
        </template>
        <template v-else>
          <el-form-item label="本地路径"><el-input v-model="editSource.config.path" /></el-form-item>
        </template>
        <el-form-item label="启用">
          <el-switch v-model="editSource.enabled" :active-value="1" :inactive-value="0" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showEditDialog = false">取消</el-button>
        <el-button type="primary" @click="saveEdit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import EmptyState from "@/components/EmptyState.vue";
import api from "@/api";

const sources = ref<any[]>([]);
const showAddDialog = ref(false);
const showEditDialog = ref(false);
const newSource = reactive({ name: "", type: "webdav", config: { url: "", username: "", password: "", root_path: "", path: "" } });
const editSource = reactive({ id: "", name: "", type: "webdav", enabled: 1, config: { url: "", username: "", password: "", root_path: "", path: "" } });
let progressTimers: Record<string, ReturnType<typeof setInterval>> = {};

async function loadSources() {
  try {
    const res = await api.get("/rest/api/v1/sources");
    sources.value = res.data.map((s: any) => ({ ...s, _testing: false, _scanning: false, _scanProgress: null }));
    // Resume polling for any sources that were mid-scan (progress persists across page switches)
    sources.value.forEach((s: any) => checkScanStatus(s));
  } catch { sources.value = []; }
}

async function addSource() {
  if (!newSource.name) { ElMessage.warning("请输入名称"); return; }
  try {
    await api.post("/rest/api/v1/sources", {
      name: newSource.name, type: newSource.type,
      config: newSource.type === "webdav"
        ? { url: newSource.config.url, username: newSource.config.username, password: newSource.config.password, root_path: newSource.config.root_path }
        : { path: newSource.config.path }
    });
    showAddDialog.value = false;
    newSource.name = ""; newSource.config = { url: "", username: "", password: "", root_path: "", path: "" };
    ElMessage.success("添加成功");
    loadSources();
  } catch (e: any) { ElMessage.error(e.response?.data?.error || "添加失败"); }
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
    if (res.data.success) ElMessage.success(`连接成功: ${res.data.message || "服务器可达"}`);
    else ElMessage.error(`连接失败: ${res.data.error}`);
  } catch (e: any) { ElMessage.error(`连接失败: ${e.response?.data?.error || e.message}`); }
  finally { source._testing = false; }
}

function checkScanStatus(source: any) {
  // If idle and no progress data, nothing to show
  if (!source._scanProgress && !progressTimers[source.id]) {
    const existing = api.get(`/rest/api/v1/sources/${source.id}/scan-status`).then((res) => {
      const data = res.data;
      if (data.status === "running" && data.progress) {
        source._scanning = true;
        source._scanProgress = { ...data.progress };
        startProgressPolling(source);
      }
    }).catch(() => {});
  }
}

function startProgressPolling(source: any) {
  if (progressTimers[source.id]) clearInterval(progressTimers[source.id]);
  progressTimers[source.id] = setInterval(async () => {
    try {
      const res = await api.get(`/rest/api/v1/sources/${source.id}/scan-status`);
      const data = res.data;
      if (data.status === "running" && data.progress) {
        source._scanning = true;
        source._scanProgress = { ...data.progress };
      } else if (data.status === "completed") {
        clearInterval(progressTimers[source.id]);
        delete progressTimers[source.id];
        source._scanning = false;
        source._scanProgress = null;
        const r = data.result;
        ElMessage.success(`扫描完成: 新增 ${r?.added || 0}，更新 ${r?.updated || 0}，删除 ${r?.removed || 0}`);
        loadSources();
      } else if (data.status === "stopped") {
        clearInterval(progressTimers[source.id]);
        delete progressTimers[source.id];
        source._scanning = false;
        source._scanProgress = null;
        ElMessage.info("扫描已停止");
        loadSources();
      } else if (data.status === "failed") {
        clearInterval(progressTimers[source.id]);
        delete progressTimers[source.id];
        source._scanning = false;
        source._scanProgress = null;
        ElMessage.error(`扫描失败: ${data.error}`);
      }
    } catch { /* ignore */ }
  }, 2000);
}

async function stopScan(source: any) {
  try {
    const res = await api.post(`/rest/api/v1/sources/${source.id}/scan-stop`);
    if (res.data.success) ElMessage.info("正在停止扫描...");
    else ElMessage.error(res.data.error || "停止失败");
  } catch (e: any) { ElMessage.error(e.response?.data?.error || e.message); }
}

async function scanSource(source: any, mode: "full" | "incremental" = "full") {
  source._scanning = true;
  try {
    const res = await api.post(`/rest/api/v1/sources/${source.id}/scan`, { mode });
    if (res.data.success) {
      ElMessage.info(mode === "incremental" ? "增量扫描已开始..." : "全库扫描已开始...");
      startProgressPolling(source);
    } else {
      source._scanning = false;
      ElMessage.error(res.data.error || "扫描启动失败");
    }
  } catch (e: any) {
    source._scanning = false;
    ElMessage.error(e.response?.data?.error || e.message);
  }
}

function openEdit(source: any) {
  editSource.id = source.id; editSource.name = source.name; editSource.type = source.type;
  editSource.enabled = source.enabled; editSource.config = { ...source.config };
  showEditDialog.value = true;
}

async function saveEdit() {
  try {
    await api.put(`/rest/api/v1/sources/${editSource.id}`, { name: editSource.name, enabled: editSource.enabled, config: editSource.config });
    showEditDialog.value = false; ElMessage.success("保存成功"); loadSources();
  } catch (e: any) { ElMessage.error(e.response?.data?.error || "保存失败"); }
}

async function deleteSource(source: any) {
  await ElMessageBox.confirm(`确定删除媒体源「${source.name}」？`, "确认删除", { type: "warning" });
  try { await api.delete(`/rest/api/v1/sources/${source.id}`); ElMessage.success("已删除"); loadSources(); }
  catch (e: any) { ElMessage.error(e.response?.data?.error || "删除失败"); }
}

onMounted(loadSources);
onUnmounted(() => { Object.values(progressTimers).forEach(clearInterval); });
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
  }
  .source-actions { display: flex; gap: 8px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.06); }
}
:deep(.el-card) { background: rgba(255,255,255,0.04) !important; border: 1px solid rgba(255,255,255,0.07) !important; }
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
