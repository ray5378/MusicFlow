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

        <el-form-item>
          <el-button type="success" plain :loading="testing" @click="testSource">测试连接</el-button>
          <el-button v-if="hasWebRotation" type="warning" plain :loading="purging" @click="purgeWebSongs">立即清理</el-button>
          <span v-if="testResult" class="test-result" :class="{ ok: testResult.success }">{{ testResult.message }}</span>
        </el-form-item>
        <el-alert
          v-if="isSourcePlugin(editing)"
          type="info"
          :closable="false"
          show-icon
          title="说明"
          :description="editing.manifest?.description || '填写在线源服务地址后,即可在「在线音乐搜索」中搜索并导入为在线歌曲。'"
        />
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

const plugins = ref<any[]>([]);
const loading = ref(false);
const showAddDialog = ref(false);
const newPlugin = reactive({ name: "", description: "" });

const showConfigDialog = ref(false);
const editing = ref<any>(null);
const editConfig = reactive<any>({});
const testing = ref(false);
const saving = ref(false);
const purging = ref(false);
const testResult = ref<any>(null);

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

async function togglePlugin(plugin: any) {
  await api.put(`/rest/api/v1/plugins/${plugin.id}/toggle`);
  ElMessage.success("已更新");
}

function editPlugin(plugin: any) {
  editing.value = plugin;
  const cfg = parseConfig(plugin);
  const schema = parseManifest(plugin).configSchema || [];
  // Reset and seed editConfig from the stored config, falling back to schema defaults.
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

onMounted(loadPlugins);
</script>

<style lang="scss" scoped>
.admin-plugins { padding: 24px 32px 130px; max-width: 1200px; margin: 0 auto; }
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; flex-wrap: wrap; gap: 12px; h2 { font-size: 28px; font-weight: 700; margin: 0; } }
.test-result { margin-left: 12px; font-size: 13px; color: var(--el-color-danger); &.ok { color: var(--el-color-success); } }
.field-hint { margin-left: 12px; font-size: 12px; color: var(--el-text-color-secondary); line-height: 1.5; display: inline-block; max-width: 360px; }
@media (max-width: 768px) {
  .admin-plugins { padding: 20px 16px; }
  .page-header h2 { font-size: 24px; }
  :deep(.el-table) { font-size: 13px; }
}
</style>
