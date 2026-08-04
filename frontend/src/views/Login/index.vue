<template>
  <div class="login-page">
    <div class="login-card">
      <div class="login-header">
        <el-icon :size="48" color="#c35f33"><Headset /></el-icon>
        <h1>MusicFlow</h1>
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

    <el-dialog v-model="showPwdDialog" title="修改密码" width="420px" :close-on-click-modal="false" :show-close="false" append-to-body>
      <el-alert type="warning" :closable="false" show-icon class="pwd-alert">
        当前账号仍在使用默认密码(admin/admin),为安全起见请立即修改密码。
      </el-alert>
      <el-form label-width="80px" class="pwd-form">
        <el-form-item label="新密码">
          <el-input v-model="pwdForm.newPassword" type="password" placeholder="请输入新密码" show-password />
        </el-form-item>
        <el-form-item label="确认密码">
          <el-input v-model="pwdForm.confirm" type="password" placeholder="请再次输入新密码" show-password @keyup.enter="submitPassword" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button type="primary" :loading="pwdLoading" @click="submitPassword">确定修改</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "@/stores/auth";
import { Headset } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import api from "@/api";

const router = useRouter();
const authStore = useAuthStore();
const loading = ref(false);
const form = reactive({ username: "", password: "" });

const showPwdDialog = ref(false);
const pwdLoading = ref(false);
const pwdForm = reactive({ newPassword: "", confirm: "" });

async function handleLogin() {
  if (!form.username || !form.password) { ElMessage.warning("请输入用户名和密码"); return; }
  loading.value = true;
  try {
    const data = await authStore.login(form.username, form.password);
    if (data.mustChangePassword) {
      showPwdDialog.value = true;
      return;
    }
    ElMessage.success("登录成功");
    router.push("/");
  }
  catch (e: any) { ElMessage.error(e.response?.data?.error || "登录失败"); }
  finally { loading.value = false; }
}

async function submitPassword() {
  if (pwdForm.newPassword.length < 6) { ElMessage.warning("密码至少 6 位"); return; }
  if (pwdForm.newPassword !== pwdForm.confirm) { ElMessage.warning("两次输入的密码不一致"); return; }
  pwdLoading.value = true;
  try {
    await api.put(`/rest/api/v1/users/${authStore.userId}/password`, { newPassword: pwdForm.newPassword });
    await authStore.setPasswordChanged();
    ElMessage.success("密码已修改");
    showPwdDialog.value = false;
    ElMessage.success("登录成功");
    router.push("/");
  }
  catch (e: any) { ElMessage.error(e.response?.data?.error || "修改失败"); }
  finally { pwdLoading.value = false; }
}
</script>

<style lang="scss" scoped>
.login-page { display: flex; align-items: center; justify-content: center; height: 100vh; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%); }
.login-card { background: #fff; border-radius: 12px; padding: 48px 40px; width: 400px; box-shadow: 0 20px 60px rgba(0,0,0,0.3);
  .login-header { text-align: center; margin-bottom: 32px; h1 { margin: 12px 0 4px; font-size: 28px; color: #333; } p { color: #999; font-size: 14px; } }
  .login-btn { width: 100%; margin-top: 8px; }
}
.pwd-alert { margin-bottom: 20px; }
.pwd-form { margin-top: 8px; }
</style>
