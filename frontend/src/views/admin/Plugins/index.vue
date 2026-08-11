<template>
  <div class="admin-plugins">
    <el-tabs v-model="activeTab">
      <!-- ============ Installed plugins ============ -->
      <el-tab-pane label="已安装" name="installed">
        <div class="page-header">
          <h2>插件管理</h2>
          <el-button type="primary" @click="showAddDialog = true">添加插件</el-button>
        </div>

        <el-table :data="plugins" stripe v-loading="loading" v-if="plugins.length > 0">
          <el-table-column label="插件名称" min-width="200">
            <template #default="{ row }">
              <div class="plugin-name">{{ displayName(row) }}</div>
              <div class="plugin-id">{{ row.name }}</div>
            </template>
          </el-table-column>
          <el-table-column label="类型" width="110">
            <template #default="{ row }">
              <el-tag size="small" :type="typeTagColor(row)" effect="light">{{ typeLabel(row) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="version" label="版本" width="90" />
          <el-table-column label="说明" min-width="220" show-overflow-tooltip>
            <template #default="{ row }">{{ parseManifest(row).description || row.description || "—" }}</template>
          </el-table-column>
          <el-table-column label="健康" width="96">
            <template #default="{ row }">
              <el-tag size="small" :type="healthType(row.name)" effect="dark">{{ healthLabel(row.name) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-switch v-model="row.enabled" :active-value="1" :inactive-value="0" @change="togglePlugin(row)" />
            </template>
          </el-table-column>
          <el-table-column label="操作" width="140">
            <template #default="{ row }">
              <el-button size="small" type="primary" plain @click="editPlugin(row)">
                {{ hasConfig(row) ? "配置" : "详情" }}
              </el-button>
            </template>
          </el-table-column>
        </el-table>
        <EmptyState v-else icon="cable" title="暂无插件" description="插件用于扩展搜索、下载、刮削、歌词、封面、设备投屏等功能">
          <template #action>
            <el-button type="primary" @click="showAddDialog = true">添加插件</el-button>
          </template>
        </EmptyState>
      </el-tab-pane>

      <!-- ============ Plugin marketplace ============ -->
      <el-tab-pane label="插件市场" name="market">
        <div class="page-header">
          <h2>插件市场</h2>
          <el-button type="primary" plain @click="loadMarketplace" :loading="marketLoading">刷新</el-button>
        </div>

        <el-card class="market-card" shadow="never">
          <template #header>
            <div class="card-head">
              <span>注册表来源</span>
              <el-button size="small" type="primary" plain @click="showRegDialog = true">添加注册表</el-button>
            </div>
          </template>
          <el-table :data="registries" stripe v-if="registries.length > 0" size="small">
            <el-table-column prop="url" label="URL" min-width="320" show-overflow-tooltip />
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag size="small" :type="row.enabled ? 'success' : 'info'" effect="light">{{ row.enabled ? "启用" : "停用" }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="90">
              <template #default="{ row }">
                <el-button size="small" type="danger" plain @click="removeRegistry(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
          <el-empty v-else description="尚未添加任何插件注册表" :image-size="60" />
        </el-card>

        <el-card class="market-card" shadow="never">
          <template #header><span>可安装插件（按 id 去重，保留最高版本）</span></template>
          <el-table :data="marketPlugins" stripe v-loading="marketLoading" v-if="marketPlugins.length > 0">
            <el-table-column label="名称" min-width="180">
              <template #default="{ row }">
                <div class="plugin-name">{{ row.name }}</div>
                <div class="plugin-id">{{ row.id }}@{{ row.version }}</div>
              </template>
            </el-table-column>
            <el-table-column prop="description" label="说明" min-width="260" show-overflow-tooltip />
            <el-table-column label="作者" prop="author" width="120" show-overflow-tooltip />
            <el-table-column label="操作" width="100">
              <template #default="{ row }">
                <el-button size="small" type="success" plain :loading="installing === row.id" @click="installPlugin(row)">安装</el-button>
              </template>
            </el-table-column>
          </el-table>
          <el-empty v-else description="市场为空或注册表暂不可达" :image-size="60" />
        </el-card>
        <el-alert type="warning" :closable="false" show-icon class="market-warn"
          title="第三方插件以当前进程权限运行"
          description="MusicFlow-V2 的插件在当前 Node 进程内执行（无沙箱隔离），安装未知来源的插件等同于信任其代码。请仅从你信赖的注册表安装。" />
      </el-tab-pane>
    </el-tabs>

    <!-- Add plugin dialog -->
    <el-dialog v-model="showAddDialog" title="添加插件" width="500px">
      <el-form label-width="80px">
        <el-form-item label="插件名称"><el-input v-model="newPlugin.name" /></el-form-item>
        <el-form-item label="描述"><el-input v-model="newPlugin.description" type="textarea" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showAddDialog = false">取消</el-button>
        <el-button type="primary" @click="addPlugin">添加</el-button>
      </template>
    </el-dialog>

    <!-- Add registry dialog -->
    <el-dialog v-model="showRegDialog" title="添加插件注册表" width="500px">
      <el-form label-width="80px">
        <el-form-item label="URL">
          <el-input v-model="newRegistryUrl" placeholder="https://example.com/registry.json" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showRegDialog = false">取消</el-button>
        <el-button type="primary" :loading="addingReg" @click="addRegistry">添加</el-button>
      </template>
    </el-dialog>

    <!-- Config / detail dialog -->
    <el-dialog v-model="showConfigDialog" :title="`配置插件 · ${editing?.name || ''}`" width="560px">
      <el-form label-width="120px" v-if="editing">
        <!-- Config form is driven entirely by the plugin manifest's configSchema.
             No field is hardcoded to go-music-dl. -->
        <el-form-item v-for="f in configFields" :key="f.key" :label="f.label">
          <el-input
            v-if="f.type === 'text' || f.type === 'url'"
            v-model="editConfig[f.key]"
            :placeholder="f.help"
            style="width: 100%"
          />
          <el-input-number
            v-else-if="f.type === 'number'"
            v-model="editConfig[f.key]"
            :min="0"
            controls-position="right"
            style="width: 180px"
          />
          <el-radio-group v-else-if="f.type === 'radio'" v-model="editConfig[f.key]">
            <el-radio v-for="o in (f.options || [])" :key="o.value" :value="o.value">{{ o.label }}</el-radio>
          </el-radio-group>
          <el-select v-else-if="f.type === 'select'" v-model="editConfig[f.key]" style="width: 100%">
            <el-option v-for="o in (f.options || [])" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
          <el-select
            v-else-if="f.type === 'multiselect'"
            v-model="editConfig[f.key]"
            multiple
            collapse-tags
            style="width: 100%"
          >
            <el-option v-for="o in (f.options || [])" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
          <el-switch v-else-if="f.type === 'switch'" v-model="editConfig[f.key]" />
          <span v-if="f.help" class="field-hint">{{ f.help }}</span>
        </el-form-item>

        <!-- Only source plugins expose a reachable endpoint to test / web songs to purge. -->
        <el-form-item v-if="isSourcePlugin(editing) || hasWebRotation">
          <el-button v-if="isSourcePlugin(editing)" type="success" plain :loading="testing" @click="testSource">测试连接</el-button>
          <el-button v-if="hasWebRotation" type="warning" plain :loading="purging" @click="purgeWebSongs">立即清理</el-button>
          <span v-if="testResult" class="test-result" :class="{ ok: testResult.success }">{{ testResult.message }}</span>
        </el-form-item>

        <el-alert
          type="info"
          :closable="false"
          show-icon
          :title="`${typeLabel(editing)}插件`"
          :description="pluginHint(editing)"
        />
        <div v-if="capabilityList(editing).length > 0" class="cap-row">
          <span class="cap-label">能力</span>
          <el-tag v-for="cap in capabilityList(editing)" :key="cap" size="small" effect="plain">{{ capLabel(cap) }}</el-tag>
        </div>
        <div v-if="permissionList(editing).length > 0" class="cap-row">
          <span class="cap-label">权限</span>
          <el-tag v-for="perm in permissionList(editing)" :key="perm" size="small" type="warning" effect="plain">{{ permLabel(perm) }}</el-tag>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="showConfigDialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="() => saveConfig()">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from "vue";
import { ElMessage } from "element-plus";
import EmptyState from "@/components/EmptyState.vue";
import api from "@/api";

const activeTab = ref<"installed" | "market">("installed");

// ---- installed plugins ----
const plugins = ref<any[]>([]);
const loading = ref(false);
const showAddDialog = ref(false);
const newPlugin = reactive({ name: "", description: "" });

// ---- marketplace ----
const registries = ref<any[]>([]);
const marketPlugins = ref<any[]>([]);
const marketLoading = ref(false);
const installing = ref<string>("");
const showRegDialog = ref(false);
const newRegistryUrl = ref("");
const addingReg = ref(false);

// ---- config dialog ----
const showConfigDialog = ref(false);
const editing = ref<any>(null);
const editConfig = reactive<any>({});
const testing = ref(false);
const saving = ref(false);
const purging = ref(false);
const testResult = ref<any>(null);

// ---- health ----
const healthMap = ref<Record<string, any>>({});

function parseManifest(plugin: any): any {
  const m = plugin?.manifest;
  if (!m) return {};
  return typeof m === "string" ? JSON.parse(m || "{}") : m;
}

function parseConfig(plugin: any) {
  try {
    return typeof plugin.config === "string" ? JSON.parse(plugin.config || "{}") : plugin.config || {};
  } catch {
    return {};
  }
}

/** Config fields rendered in the dialog — driven by the plugin manifest. */
const configFields = computed<any[]>(() => parseManifest(editing.value).configSchema || []);

/** Whether the plugin declares the web-rotation capability (shows the purge button). */
const hasWebRotation = computed<boolean>(() =>
  (parseManifest(editing.value).capabilities || []).includes("webRotation"),
);

function isSourcePlugin(plugin: any) {
  return parseManifest(plugin).type === "source";
}

/** Manifest display name, falling back to the stored row name (= plugin id). */
function displayName(plugin: any): string {
  return parseManifest(plugin).name || plugin?.name || "";
}

function hasConfig(plugin: any): boolean {
  return (parseManifest(plugin).configSchema || []).length > 0;
}

// Plugin taxonomy — labels only. The backend decides what each type can do via
// manifest capabilities; the UI just renders whatever it declares.
const TYPE_LABELS: Record<string, string> = {
  source: "在线源",
  importer: "歌单导入",
  recommender: "推荐",
  sync: "同步",
  lyrics: "歌词",
  cover: "封面",
  renderer: "设备投屏",
  scrobbler: "播放上报",
};
const TYPE_COLORS: Record<string, string> = {
  source: "primary",
  importer: "success",
  recommender: "warning",
  sync: "info",
  lyrics: "danger",
  cover: "danger",
  renderer: "info",
  scrobbler: "info",
};
const CAP_LABELS: Record<string, string> = {
  search: "在线搜索",
  recommend: "平台推荐歌单",
  playlistSongs: "远程歌单曲目",
  stream: "音频流",
  lyrics: "在线歌词",
  webRotation: "在线歌曲轮换清理",
  playlistImport: "分享链接导入",
  playlistFile: "歌单文件导入",
  dailyPlaylist: "每日歌单生成",
  playlistSync: "歌单定时同步",
  autoMatch: "条目自动匹配",
  lyricProvider: "歌词提供方",
  coverProvider: "封面提供方",
  renderer: "设备投屏",
  scrobbler: "播放上报",
};
const PERM_LABELS: Record<string, string> = {
  log: "日志",
  storage: "存储",
  net: "网络",
  command: "命令",
  fs: "文件系统",
  "fs:music": "音乐目录",
  "fs:external": "外部目录",
  "songs:read": "读取歌曲",
  "songs:write": "写入歌曲",
  "playlists:read": "读取歌单",
  "playlists:write": "写入歌单",
  "inter-plugin": "插件间通信",
};

function typeLabel(plugin: any): string {
  const t = parseManifest(plugin).type;
  return TYPE_LABELS[t] || t || "未知";
}

function typeTagColor(plugin: any): any {
  return TYPE_COLORS[parseManifest(plugin).type] || "info";
}

function capabilityList(plugin: any): string[] {
  return parseManifest(plugin).capabilities || [];
}

function permissionList(plugin: any): string[] {
  return parseManifest(plugin).permissions || [];
}

function capLabel(cap: string): string {
  return CAP_LABELS[cap] || cap;
}

function permLabel(perm: string): string {
  return PERM_LABELS[perm] || perm;
}

// Health status -> tag color / label.
function healthType(id: string): any {
  const s = healthMap.value[id]?.status;
  if (s === "green") return "success";
  if (s === "yellow") return "warning";
  if (s === "red" || s === "down") return "danger";
  return "info";
}
function healthLabel(id: string): string {
  const s: string = healthMap.value[id]?.status || "unknown";
  return ({ green: "正常", yellow: "波动", red: "异常", down: "离线", unknown: "未知" } as Record<string, string>)[s] || "未知";
}

const TYPE_HINTS: Record<string, string> = {
  source: "填写在线源服务地址后,即可在「在线音乐搜索」中搜索并导入为在线歌曲。",
  importer: "停用后,对应平台的歌单分享链接 / 歌单文件将无法导入。",
  recommender: "停用后,不再自动生成对应的推荐歌单。",
  sync: "停用后,不再自动重新拉取已开启同步的歌单(手动同步仍可用)。",
  lyrics: "作为歌词提供方参与「能力优先」调度,首个可用方胜出。",
  cover: "作为封面提供方参与「能力优先」调度,首个可用方胜出。",
  renderer: "提供 DLNA / 设备投屏能力,可在播放器中选择设备投放。",
  scrobbler: "在播放 / 记录事件时上报到外部服务(如 Last.fm)。",
};

function pluginHint(plugin: any): string {
  const m = parseManifest(plugin);
  const extra = hasConfig(plugin) ? "" : "该插件无需额外配置,用开关启用/停用即可。";
  return [m.description, TYPE_HINTS[m.type], extra].filter(Boolean).join(" ");
}

function providerId(plugin: any): string {
  return parseManifest(plugin).id || "";
}

async function loadPlugins() {
  loading.value = true;
  try {
    const res = await api.get("/rest/api/v1/plugins");
    plugins.value = (res.data || []).map((p: any) => ({ ...p, manifest: p.manifest, config: p.config }));
  } catch {
    plugins.value = [];
  } finally {
    loading.value = false;
  }
}

async function loadHealth() {
  try {
    const res = await api.get("/rest/api/v1/plugins/health");
    const map: Record<string, any> = {};
    for (const h of res.data?.health || []) map[h.pluginId] = h;
    healthMap.value = map;
  } catch {
    healthMap.value = {};
  }
}

async function togglePlugin(plugin: any) {
  await api.put(`/rest/api/v1/plugins/${plugin.id}/toggle`);
  ElMessage.success("已更新");
  loadHealth();
}

function editPlugin(plugin: any) {
  editing.value = plugin;
  const cfg = parseConfig(plugin);
  const schema = parseManifest(plugin).configSchema || [];
  for (const key of Object.keys(editConfig)) delete editConfig[key];
  for (const f of schema) {
    let v = cfg[f.key];
    if (v === undefined) v = f.default;
    if (v === undefined) {
      if (f.type === "multiselect" || f.type === "select") v = [];
      else if (f.type === "switch") v = false;
      else if (f.type === "number") v = 0;
      else v = "";
    }
    editConfig[f.key] = v;
  }
  testResult.value = null;
  showConfigDialog.value = true;
}

async function testSource() {
  if (!editing.value) return;
  testing.value = true;
  testResult.value = null;
  try {
    await saveConfig({ silent: true });
    const res = await api.post(`/rest/api/v1/online/${providerId(editing.value)}/test`, {});
    testResult.value = { success: res.data.success, message: res.data.message || res.data.error || "未知结果" };
  } catch (e: any) {
    testResult.value = { success: false, message: e?.response?.data?.error || e.message || "连接失败" };
  } finally {
    testing.value = false;
  }
}

async function saveConfig(opts?: { silent?: boolean }) {
  if (!editing.value) return;
  saving.value = true;
  try {
    const cfg: any = {};
    for (const f of configFields.value) cfg[f.key] = editConfig[f.key];
    await api.put(`/rest/api/v1/plugins/${editing.value.id}`, { config: cfg });
    if (!opts?.silent) {
      ElMessage.success("已保存");
      showConfigDialog.value = false;
      loadPlugins();
    }
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || "保存失败");
  } finally {
    saving.value = false;
  }
}

async function addPlugin() {
  if (!newPlugin.name) {
    ElMessage.warning("请输入插件名称");
    return;
  }
  await api.post("/rest/api/v1/plugins", newPlugin);
  showAddDialog.value = false;
  newPlugin.name = "";
  newPlugin.description = "";
  ElMessage.success("添加成功");
  loadPlugins();
}

async function purgeWebSongs() {
  if (!editing.value) return;
  purging.value = true;
  try {
    await saveConfig({ silent: true });
    const res = await api.post(`/rest/api/v1/online/${providerId(editing.value)}/purge-web-songs`, {});
    if (res.data.success) {
      if (res.data.mode === "rotate") {
        ElMessage.success(`已清理 ${res.data.purged} 首歌曲,${res.data.covers} 张封面`);
      } else {
        ElMessage.info("当前为「永不过期」模式,未清理任何歌曲");
      }
    } else {
      ElMessage.warning(res.data.error || "清理失败");
    }
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || e.message || "清理失败");
  } finally {
    purging.value = false;
  }
}

// ---- marketplace ----
async function loadMarketplace() {
  marketLoading.value = true;
  try {
    const res = await api.get("/rest/api/v1/plugins/registry");
    registries.value = res.data?.registries || [];
    marketPlugins.value = res.data?.plugins || [];
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || "拉取插件市场失败");
    registries.value = [];
    marketPlugins.value = [];
  } finally {
    marketLoading.value = false;
  }
}

async function addRegistry() {
  if (!/^https?:\/\//.test(newRegistryUrl.value)) {
    ElMessage.warning("注册表 URL 必须是 http(s) 链接");
    return;
  }
  addingReg.value = true;
  try {
    await api.post("/rest/api/v1/plugins/registry", { url: newRegistryUrl.value });
    newRegistryUrl.value = "";
    showRegDialog.value = false;
    ElMessage.success("已添加");
    loadMarketplace();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || "添加失败");
  } finally {
    addingReg.value = false;
  }
}

async function removeRegistry(row: any) {
  try {
    await api.delete(`/rest/api/v1/plugins/registry/${row.id}`);
    ElMessage.success("已删除");
    loadMarketplace();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || "删除失败");
  }
}

async function installPlugin(row: any) {
  installing.value = row.id;
  try {
    await api.post("/rest/api/v1/plugins/registry/install", { downloadUrl: row.downloadUrl || row.url });
    ElMessage.success(`已安装 ${row.name}`);
    loadMarketplace();
    loadPlugins();
    loadHealth();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || "安装失败");
  } finally {
    installing.value = "";
  }
}

onMounted(() => {
  loadPlugins();
  loadHealth();
});
</script>

<style lang="scss" scoped>
.admin-plugins { padding: 24px 32px 130px; max-width: 1200px; margin: 0 auto; }
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; flex-wrap: wrap; gap: 12px; h2 { font-size: 28px; font-weight: 700; margin: 0; } }
.test-result { margin-left: 12px; font-size: 13px; color: var(--el-color-danger); &.ok { color: var(--el-color-success); } }
.plugin-name { font-weight: 600; line-height: 1.35; }
.plugin-id { font-size: 12px; color: var(--el-text-color-secondary); line-height: 1.35; }
.cap-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 12px; }
.cap-label { font-size: 12px; color: var(--el-text-color-secondary); margin-right: 2px; }
.field-hint { margin-left: 12px; font-size: 12px; color: var(--el-text-color-secondary); line-height: 1.5; display: inline-block; max-width: 360px; }
.market-card { margin-bottom: 20px; }
.market-card .card-head { display: flex; justify-content: space-between; align-items: center; }
.market-warn { margin-top: 4px; }
@media (max-width: 768px) {
  .admin-plugins { padding: 20px 16px; }
  .page-header h2 { font-size: 24px; }
  :deep(.el-table) { font-size: 13px; }
}
</style>
