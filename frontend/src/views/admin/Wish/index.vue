<template>
  <div class="admin-wish">
    <div class="page-header"><h2>许愿管理</h2></div>
    <el-table :data="wishes" stripe v-loading="loading">
      <el-table-column prop="songTitle" label="歌曲" min-width="200" />
      <el-table-column prop="artist" label="艺术家" width="150" />
      <el-table-column prop="album" label="专辑" width="150" />
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="row.status === 'fulfilled' ? 'success' : row.status === 'pending' ? 'warning' : 'info'" size="small">
            {{ row.status === 'fulfilled' ? '已实现' : row.status === 'pending' ? '待处理' : row.status }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="120">
        <template #default="{ row }">
          <el-button size="small" @click="fulfillWish(row)">检索下载</el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { ElMessage } from "element-plus";
import api from "@/api";

const wishes = ref<any[]>([]);
const loading = ref(false);

async function loadWishes() {
  loading.value = true;
  try { wishes.value = (await api.get("/rest/api/v1/wish")).data; }
  catch { wishes.value = []; }
  finally { loading.value = false; }
}

function fulfillWish(wish: any) { ElMessage.info("检索下载功能需要后端插件支持"); }

onMounted(loadWishes);
</script>

<style lang="scss" scoped>
.admin-wish { padding: 24px; }
.page-header { margin-bottom: 20px; h2 { font-size: 24px; font-weight: 600; } }
</style>
