<template>
  <div class="admin-plugins">
    <div class="page-header">
      <h2>插件管理</h2>
      <el-button type="primary" @click="showAddDialog = true">添加插件</el-button>
    </div>
    <el-table :data="plugins" stripe v-loading="loading" v-if="plugins.length > 0">
      <el-table-column prop="name" label="插件名称" min-width="200" />
      <el-table-column prop="version" label="版本" width="100" />
      <el-table-column prop="description" label="说明" min-width="240" show-overflow-tooltip />
      <el-table-column label="状态" width="100">
        <template #default="{ row }"><el-switch v-model="row.enabled" :active-value="1" :inactive-value="0" @change="togglePlugin(row)" /></template>
      </el-table-column>
      <el-table-column label="操作" width="140">
        <template #default="{ row }">
          <el-button size="small" type="primary" plain @click="editPlugin(row)">配置</el-button>
        </template>
      </el-table-column>
    </el-table>
    <EmptyState v-else icon="cable" title="暂无插件" description="插件用于扩展搜索、下载、刮削等功能">
      <template #action>
        <el-button type="primary" @click="showAddDialog = true">添加插件</el-button>
      </template>
    </EmptyState>

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

    <el-dialog v-model="showConfigDialog" :title="`配置插件 · ${editing?.name || ''}`" width="560px">
      <el-form label-width="110px" v-if="editing">
        <template v-if="isSourcePlugin(editing)">
          <el-form-item label="服务地址">
            <el-input v-model="editConfig.baseUrl" placeholder="http://192.168.x.x:18180" />
          </el-form-item>
          <el-form-item label="搜索平台">
            <el-select v-model="editConfig.sources" multiple collapse-tags style="width: 100%">
              <el-option v-for="p in sourceOptions" :key="p.value" :label="p.label" :value="p.value" />
            </el-select>
          </el-form-item>
          <el-form-item>
            <el-button type="success" plain :loading="testing" @click="testSource">测试连接</el-button>
            <span v-if="testResult" class="test-result" :class="{ ok: testResult.success }">{{ testResult.message }}</span>
          </el-form-item>
          <el-alert type="info" :closable="false" show-icon
            title="说明"
            description="填写你在局域网部署的 go-music-dl 网页服务地址。保存并启用后,即可在「在线音乐搜索」中搜索全网歌曲并导入为在线歌曲。" />
        </template>
        <template v-else>
          <el-form-item label="描述"><el-input v-model="editing.description" type="textarea" /></el-form-item>
        </template>
      </el-form>
      <template #footer>
        <el-button @click="showConfigDialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveConfig">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from "vue";
import { ElMessage } from "element-plus";
import EmptyState from "@/components/EmptyState.vue";
import api from "@/api";

const plugins = ref<any[]>([]);
const loading = ref(false);
const showAddDialog = ref(false);
const newPlugin = reactive({ name: "", description: "" });

const showConfigDialog = ref(false);
const editing = ref<any>(null);
const editConfig = reactive<any>({ baseUrl: "", sources: [] });
const testing = ref(false);
const saving = ref(false);
const testResult = ref<any>(null);

const sourceOptions = [
  { value: "netease", label: "网易云" },
  { value: "qq", label: "QQ 音乐" },
  { value: "kugou", label: "酷狗" },
  { value: "kuwo", label: "酷我" },
  { value: "migu", label: "咪咕" },
  { value: "qianqian", label: "千千" },
  { value: "soda", label: "汽水" },
  { value: "fivesing", label: "5sing" },
  { value: "jamendo", label: "Jamendo" },
  { value: "joox", label: "JOOX" },
  { value: "bilibili", label: "Bilibili" },
  { value: "apple", label: "Apple Music" },
];

function isSourcePlugin(plugin: any) {
  const manifest = plugin?.manifest && typeof plugin.manifest === "object"
    ? plugin.manifest
    : (typeof plugin?.manifest === "string" ? JSON.parse(plugin.manifest || "{}") : {});
  return manifest?.type === "source" || manifest?.provider === "go-music-dl";
}

function parseConfig(plugin: any) {
  try { return typeof plugin.config === "string" ? JSON.parse(plugin.config || "{}") : plugin.config || {}; }
  catch { return {}; }
}

async function loadPlugins() {
  loading.value = true;
  try {
    const res = await api.get("/rest/api/v1/plugins");
    plugins.value = (res.data || []).map((p: any) => ({ ...p, manifest: p.manifest, config: p.config }));
  } catch { plugins.value = []; }
  finally { loading.value = false; }
}

async function togglePlugin(plugin: any) {
  await api.put(`/rest/api/v1/plugins/${plugin.id}/toggle`);
  ElMessage.success("已更新");
}

function editPlugin(plugin: any) {
  editing.value = plugin;
  const cfg = parseConfig(plugin);
  editConfig.baseUrl = cfg.baseUrl || "";
  editConfig.sources = Array.isArray(cfg.sources) ? cfg.sources : [];
  testResult.value = null;
  showConfigDialog.value = true;
}

async function testSource() {
  if (!editing.value) return;
  testing.value = true;
  testResult.value = null;
  try {
    // Persist the baseUrl first so the backend reads the latest config.
    await saveConfig({ silent: true });
    const res = await api.post(`/rest/api/v1/online/${providerId(editing.value)}/test`, {});
    testResult.value = { success: res.data.success, message: res.data.message || res.data.error || "未知结果" };
  } catch (e: any) {
    testResult.value = { success: false, message: e?.response?.data?.error || e.message || "连接失败" };
  } finally { testing.value = false; }
}

function providerId(plugin: any) {
  const manifest = typeof plugin?.manifest === "string" ? JSON.parse(plugin.manifest || "{}") : plugin?.manifest || {};
  return manifest?.provider || "go-music-dl";
}

async function saveConfig(opts?: { silent?: boolean }) {
  if (!editing.value) return;
  saving.value = true;
  try {
    const cfg: any = { baseUrl: (editConfig.baseUrl || "").trim() };
    if (editConfig.sources.length > 0) cfg.sources = editConfig.sources;
    await api.put(`/rest/api/v1/plugins/${editing.value.id}`, { config: cfg });
    if (!opts?.silent) {
      ElMessage.success("已保存");
      showConfigDialog.value = false;
      loadPlugins();
    }
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || "保存失败");
  } finally { saving.value = false; }
}

async function addPlugin() {
  if (!newPlugin.name) { ElMessage.warning("请输入插件名称"); return; }
  await api.post("/rest/api/v1/plugins", newPlugin);
  showAddDialog.value = false;
  newPlugin.name = "";
  newPlugin.description = "";
  ElMessage.success("添加成功");
  loadPlugins();
}

onMounted(loadPlugins);
</script>

<style lang="scss" scoped>
.admin-plugins { padding: 24px 32px 130px; max-width: 1200px; margin: 0 auto; }
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; flex-wrap: wrap; gap: 12px; h2 { font-size: 28px; font-weight: 700; margin: 0; } }
.test-result { margin-left: 12px; font-size: 13px; color: var(--el-color-danger); &.ok { color: var(--el-color-success); } }
@media (max-width: 768px) {
  .admin-plugins { padding: 20px 16px; }
  .page-header h2 { font-size: 24px; }
  :deep(.el-table) { font-size: 13px; }
}
</style>
