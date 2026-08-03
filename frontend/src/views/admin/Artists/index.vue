<template>
  <div class="admin-artists">
    <div class="page-header"><h2>艺术家管理</h2></div>
    <el-card>
      <h3>批量匹配艺术家头像</h3>
      <p style="color: #999; margin-bottom: 16px">自动为缺失头像的艺术家从外部来源获取头像</p>
      <el-form label-width="120px">
        <el-form-item label="仅缺失头像"><el-switch v-model="config.missingOnly" /></el-form-item>
        <el-form-item label="允许覆盖"><el-switch v-model="config.allowOverwrite" /></el-form-item>
      </el-form>
      <el-button type="primary" @click="startBatchMatch" :loading="running">创建批量匹配任务</el-button>
      <div v-if="task" style="margin-top: 16px">
        <el-progress :percentage="task.progress" />
        <p>已处理 {{ task.processed }}/{{ task.total }} | 成功: {{ task.success }} | 失败: {{ task.failed }}</p>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive } from "vue";
import { ElMessage } from "element-plus";

const config = reactive({ missingOnly: true, allowOverwrite: false });
const running = ref(false);
const task = ref<any>(null);

async function startBatchMatch() {
  running.value = true;
  ElMessage.info("批量匹配功能需要后端插件支持");
  setTimeout(() => { running.value = false; }, 2000);
}
</script>

<style lang="scss" scoped>
.admin-artists { padding: 24px; }
.page-header { margin-bottom: 20px; h2 { font-size: 24px; font-weight: 600; } }
</style>
