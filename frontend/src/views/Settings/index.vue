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
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { useAuthStore } from "@/stores/auth";
const authStore = useAuthStore();
</script>

<style lang="scss" scoped>
.settings-page { padding: 24px; }
.page-header { margin-bottom: 20px; h2 { font-size: 24px; font-weight: 600; } }
.setting-item { display: flex; justify-content: space-between; align-items: flex-start; padding: 16px 0; border-bottom: 1px solid #f0f0f0;
  &:last-child { border-bottom: none; }
  .setting-label { .title { font-weight: 500; } .desc { font-size: 12px; color: #999; margin-top: 4px; } }
}
</style>
