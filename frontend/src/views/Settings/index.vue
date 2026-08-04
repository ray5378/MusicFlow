<template>
  <div class="settings-page">
    <div class="page-header"><h2>设置</h2></div>
    <el-card>
      <div class="setting-item">
        <div class="setting-label"><div class="title">用户信息</div><div class="desc">当前登录用户的基本信息</div></div>
        <div class="setting-value">
          <el-descriptions :column="1" border size="small">
            <el-descriptions-item label="用户名">{{ authStore.username }}</el-descriptions-item>
            <el-descriptions-item label="角色">{{ authStore.isAdmin ? '管理员' : '普通用户' }}</el-descriptions-item>
          </el-descriptions>
        </div>
      </div>
      <div class="setting-item">
        <div class="setting-label"><div class="title">修改用户名</div><div class="desc">修改后使用新用户名登录</div></div>
        <div class="setting-value">
          <el-button type="primary" plain @click="showNameDialog = true">修改用户名</el-button>
        </div>
      </div>
    </el-card>

    <el-dialog v-model="showNameDialog" title="修改用户名" width="400px">
      <el-form label-width="80px">
        <el-form-item label="新用户名"><el-input v-model="newName" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showNameDialog = false">取消</el-button>
        <el-button type="primary" @click="changeUsername">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { ElMessage } from "element-plus";
import api from "@/api";
import { useAuthStore } from "@/stores/auth";
const authStore = useAuthStore();

const showNameDialog = ref(false);
const newName = ref("");

async function changeUsername() {
  const name = newName.value.trim();
  if (!name) { ElMessage.warning("请输入新用户名"); return; }
  try {
    const res = await api.put(`/rest/api/v1/users/${authStore.userId}/username`, { username: name });
    authStore.setUsername(res.data.username);
    showNameDialog.value = false;
    ElMessage.success("用户名已修改");
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || "修改失败");
  }
}
</script>

<style lang="scss" scoped>
.settings-page { padding: 24px; }
.page-header { margin-bottom: 20px; h2 { font-size: 24px; font-weight: 600; } }
.setting-item { display: flex; justify-content: space-between; align-items: flex-start; padding: 16px 0; border-bottom: 1px solid #f0f0f0;
  &:last-child { border-bottom: none; }
  .setting-label { .title { font-weight: 500; } .desc { font-size: 12px; color: #999; margin-top: 4px; } }
}
</style>
