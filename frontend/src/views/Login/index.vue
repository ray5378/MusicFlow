<template>
  <div class="login-page">
    <!-- 流动极光背景由 body.fnos-login 提供（global.scss） -->

    <!-- 边角装饰文字 -->
    <div class="corner corner-tl">PERSONAL MUSIC ARCHIVE</div>
    <div class="corner corner-bl">TRACKS // ALBUMS // ARTISTS</div>
    <div class="corner corner-br">© 2026</div>

    <!-- 登录卡片（玻璃拟态） -->
    <div class="login-card">
      <div class="login-header">
        <!-- 图标 + 品牌名 横向并列 -->
        <div class="brand-row">
          <div class="login-logo-wrap">
            <img src="/favicon.png" loading="lazy" decoding="async" alt="MusicFlow" class="login-logo" />
          </div>
          <h1>MusicFlow</h1>
        </div>
      </div>

      <el-form @submit.prevent="handleLogin" :model="form" class="login-form">
        <el-form-item>
          <el-input v-model="form.username" :placeholder="t('login.username')" prefix-icon="User" size="large" />
        </el-form-item>
        <el-form-item>
          <el-input v-model="form.password" type="password" :placeholder="t('login.password')" prefix-icon="Lock" size="large" show-password @keyup.enter="handleLogin" />
        </el-form-item>
        <el-button type="primary" @click="handleLogin" :loading="loading" size="large" class="login-btn">{{ t('login.action') }}</el-button>
      </el-form>
    </div>

    <el-dialog v-model="showPwdDialog" :title="t('login.pwd.title')" width="420px" :close-on-click-modal="false" :show-close="false" append-to-body>
      <el-alert type="warning" :closable="false" show-icon class="pwd-alert">
        {{ t('login.pwd.alert') }}
      </el-alert>
      <el-form label-width="80px" class="pwd-form">
        <el-form-item :label="t('login.pwd.new')">
          <el-input v-model="pwdForm.newPassword" type="password" :placeholder="t('login.pwd.newPlaceholder')" show-password />
        </el-form-item>
        <el-form-item :label="t('login.pwd.confirm')">
          <el-input v-model="pwdForm.confirm" type="password" :placeholder="t('login.pwd.confirmPlaceholder')" show-password @keyup.enter="submitPassword" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button type="primary" :loading="pwdLoading" @click="submitPassword">{{ t('login.pwd.submit') }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { useAuthStore } from "@/stores/auth";
import { ElMessage } from "element-plus";
import api from "@/api";

const { t } = useI18n();
const router = useRouter();
const authStore = useAuthStore();
const loading = ref(false);
const form = reactive({ username: "", password: "" });

const showPwdDialog = ref(false);
const pwdLoading = ref(false);
const pwdForm = reactive({ newPassword: "", confirm: "" });

async function handleLogin() {
  if (!form.username || !form.password) { ElMessage.warning(t("login.requireBoth")); return; }
  loading.value = true;
  try {
    const data = await authStore.login(form.username, form.password);
    if (data.mustChangePassword) {
      showPwdDialog.value = true;
      return;
    }
    ElMessage.success(t("login.success"));
    router.push("/");
  }
  catch (e: any) { ElMessage.error(e.response?.data?.error || t("login.failed")); }
  finally { loading.value = false; }
}

async function submitPassword() {
  if (pwdForm.newPassword.length < 6) { ElMessage.warning(t("login.pwd.minLen")); return; }
  if (pwdForm.newPassword !== pwdForm.confirm) { ElMessage.warning(t("login.pwd.mismatch")); return; }
  pwdLoading.value = true;
  try {
    await api.put(`/rest/api/v1/users/${authStore.userId}/password`, { newPassword: pwdForm.newPassword });
    await authStore.setPasswordChanged();
    ElMessage.success(t("login.pwd.changed"));
    showPwdDialog.value = false;
    ElMessage.success(t("login.success"));
    router.push("/");
  }
  catch (e: any) { ElMessage.error(e.response?.data?.error || t("login.pwd.failed")); }
  finally { pwdLoading.value = false; }
}
</script>

<style lang="scss" scoped>
.login-page {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100vh;
  width: 100vw;
  overflow: hidden;
  background: transparent; /* 让 body.fnos-login 的流动极光透出来 */
  color: #fff;
}

/* ===== Corner labels ===== */
.corner {
  position: absolute;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.18em;
  color: rgba(255, 255, 255, 0.55);
  font-family: var(--fnos-font);
  text-transform: uppercase;
  pointer-events: none;
  user-select: none;
  z-index: 5;
}
.corner-tl { top: 28px; left: 32px; }
.corner-bl { bottom: 28px; left: 32px; }
.corner-tr { top: 28px; right: 32px; }
.corner-br { bottom: 28px; right: 32px; }

/* ===== Login card (glass) ===== */
.login-card {
  position: relative;
  z-index: 10;
  width: 420px;
  padding: 44px 40px 36px;
  border-radius: 20px;
  background: rgba(0, 0, 0, 0.82);
  border: 1px solid rgba(255, 255, 255, 0.12);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.08);
  color: #fff;

  .login-header {
    text-align: left;
    margin-bottom: 28px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    .brand-row {
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .login-logo-wrap {
      width: 52px; height: 52px;
      border-radius: 14px;
      background: linear-gradient(135deg, var(--fnos-red) 0%, var(--fnos-orange) 100%);
      padding: 0;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 8px 24px rgba(246, 44, 85, 0.4);
      flex-shrink: 0;
    }
    .login-logo { width: 100%; height: 100%; object-fit: cover; border-radius: 14px; }
    h1 {
      margin: 0;
      font-size: 30px; font-weight: 700;
      letter-spacing: -0.3px;
      color: #fff;
    }
    .subtitle {
      margin: 6px 0 0;
      color: rgba(255, 255, 255, 0.6);
      font-size: 14px;
      font-weight: 400;
    }
  }

  .login-form {
    :deep(.el-form-item) { margin-bottom: 18px; }
    :deep(.el-input__wrapper) {
      background: rgba(0, 0, 0, 0.35) !important;
      box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.12) inset !important;
      border-radius: 10px;
      padding: 4px 12px;
      &:hover { box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.22) inset !important; }
      &.is-focus { box-shadow: 0 0 0 1px var(--fnos-red) inset !important; }
    }
    :deep(.el-input__inner) {
      color: #fff !important;
      height: 42px;
      font-size: 15px;
      &::placeholder { color: rgba(255, 255, 255, 0.4); }
    }
    :deep(.el-input__prefix-inner) { color: rgba(255, 255, 255, 0.55); }
    :deep(.el-input__suffix .el-input__icon) { color: rgba(255, 255, 255, 0.5); }
  }
  .login-btn {
    width: 100%;
    margin-top: 6px;
    height: 46px;
    font-size: 15px;
    font-weight: 600;
    border-radius: 10px;
    background: var(--fnos-red) !important;
    border: none !important;
    box-shadow: 0 8px 22px rgba(246, 44, 85, 0.45) !important;
    letter-spacing: 0.5px;
    &:hover { background: var(--fnos-red-hover) !important; }
  }
}

.pwd-alert { margin-bottom: 20px; }
.pwd-form { margin-top: 8px; }

@media (max-width: 768px) {
  .login-card { width: 92vw; padding: 32px 24px; }
  .login-card .login-header .login-logo-wrap { width: 44px; height: 44px; border-radius: 12px; }
  .login-card .login-header h1 { font-size: 24px; }
  .corner-tl, .corner-bl { font-size: 9px; }
  .corner-tr, .corner-br { display: none; }
}
</style>