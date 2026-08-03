<template>
  <div class="login-page">
    <div class="login-card">
      <div class="login-header">
        <el-icon :size="48" color="#c35f33"><Headset /></el-icon>
        <h1>Music Free</h1>
        <p>自托管音乐库</p>
      </div>
      <el-form @submit.prevent="handleLogin" :model="form" class="login-form">
        <el-form-item>
          <el-input v-model="form.username" placeholder="用户名" prefix-icon="User" size="large" />
        </el-form-item>
        <el-form-item>
          <el-input v-model="form.password" type="password" placeholder="密码" prefix-icon="Lock" size="large" show-password @keyup.enter="handleLogin" />
        </el-form-item>
        <el-button type="primary" @click="handleLogin" :loading="loading" size="large" class="login-btn">登录</el-button>
      </el-form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "@/stores/auth";
import { Headset } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";

const router = useRouter();
const authStore = useAuthStore();
const loading = ref(false);
const form = reactive({ username: "", password: "" });

async function handleLogin() {
  if (!form.username || !form.password) { ElMessage.warning("请输入用户名和密码"); return; }
  loading.value = true;
  try { await authStore.login(form.username, form.password); ElMessage.success("登录成功"); router.push("/"); }
  catch (e: any) { ElMessage.error(e.response?.data?.error || "登录失败"); }
  finally { loading.value = false; }
}
</script>

<style lang="scss" scoped>
.login-page { display: flex; align-items: center; justify-content: center; height: 100vh; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%); }
.login-card { background: #fff; border-radius: 12px; padding: 48px 40px; width: 400px; box-shadow: 0 20px 60px rgba(0,0,0,0.3);
  .login-header { text-align: center; margin-bottom: 32px; h1 { margin: 12px 0 4px; font-size: 28px; color: #333; } p { color: #999; font-size: 14px; } }
  .login-btn { width: 100%; margin-top: 8px; }
}
</style>
