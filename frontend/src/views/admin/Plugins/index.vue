<template>
  <div class="admin-plugins">
    <div class="page-header">
      <h2>插件管理</h2>
      <el-button type="primary" @click="showAddDialog = true">添加插件</el-button>
    </div>
    <el-table :data="plugins" stripe v-loading="loading">
      <el-table-column prop="name" label="插件名称" min-width="200" />
      <el-table-column prop="version" label="版本" width="100" />
      <el-table-column label="状态" width="100">
        <template #default="{ row }"><el-switch v-model="row.enabled" :active-value="1" :inactive-value="0" @change="togglePlugin(row)" /></template>
      </el-table-column>
      <el-table-column label="操作" width="100"><template #default="{ row }"><el-button size="small" @click="editPlugin(row)">配置</el-button></template></el-table-column>
    </el-table>

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
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from "vue";
import { ElMessage } from "element-plus";
import api from "@/api";

const plugins = ref<any[]>([]);
const loading = ref(false);
const showAddDialog = ref(false);
const newPlugin = reactive({ name: "", description: "" });

async function loadPlugins() {
  loading.value = true;
  try { plugins.value = (await api.get("/rest/api/v1/plugins")).data; }
  catch { plugins.value = []; }
  finally { loading.value = false; }
}

async function togglePlugin(plugin: any) { await api.put(`/rest/api/v1/plugins/${plugin.id}/toggle`); ElMessage.success("已更新"); }
async function editPlugin(plugin: any) { ElMessage.info("插件配置编辑功能开发中"); }
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
.admin-plugins { padding: 24px; }
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; h2 { font-size: 24px; font-weight: 600; } }
</style>
