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
            <el-descriptions-item label="用户 ID">{{ authStore.userId || '-' }}</el-descriptions-item>
          </el-descriptions>
        </div>
      </div>
      <div class="setting-item">
        <div class="setting-label"><div class="title">修改用户名</div><div class="desc">修改后需使用新用户名登录</div></div>
        <div class="setting-value">
          <el-button type="primary" plain @click="showNameDialog = true">修改用户名</el-button>
        </div>
      </div>
    </el-card>

    <el-card class="mt-card">
      <div class="setting-item">
        <div class="setting-label">
          <div class="title">API Key</div>
          <div class="desc">
            供 Home Assistant 集成等第三方客户端长期使用。登录 Token 24 小时过期，常驻客户端请用这里的 Key。
            <span v-if="apiKeyExpiresAt" class="expire">（到期：{{ apiKeyExpiresAt.slice(0, 10) }}）</span>
          </div>
          <div v-if="apiKey" class="apikey-box">
            <el-input v-model="apiKey" readonly size="small" :type="apiKeyVisible ? 'text' : 'password'">
              <template #append>
                <el-button @click="apiKeyVisible = !apiKeyVisible">{{ apiKeyVisible ? '隐藏' : '显示' }}</el-button>
                <el-button @click="copyApiKey">复制</el-button>
              </template>
            </el-input>
          </div>
        </div>
        <div class="setting-value apikey-actions">
          <el-button type="primary" plain :loading="apiKeyLoading" @click="generateApiKey">
            {{ apiKey ? '重新生成' : '生成' }}
          </el-button>
          <el-button v-if="apiKey" type="danger" plain :loading="apiKeyLoading" @click="revokeApiKey">撤销</el-button>
        </div>
      </div>
    </el-card>

    <el-card class="mt-card">
      <div class="setting-item">
        <div class="setting-label"><div class="title">主题风格</div><div class="desc">当前使用飞牛音乐暗色玻璃主题</div></div>
        <div class="setting-value"><el-tag size="small" type="info">FnOS Dark</el-tag></div>
      </div>
      <div class="setting-item">
        <div class="setting-label"><div class="title">减少动画</div><div class="desc">开启后减弱页面动效，适合敏感人群</div></div>
        <div class="setting-value"><el-switch v-model="reduceMotion" @change="toggleMotion" /></div>
      </div>
    </el-card>

    <el-card class="mt-card">
      <div class="setting-item">
        <div class="setting-label"><div class="title">清除缓存</div><div class="desc">重置本地设置并重新加载页面</div></div>
        <div class="setting-value"><el-button @click="clearCache">清除缓存</el-button></div>
      </div>
      <div class="setting-item">
        <div class="setting-label"><div class="title">关于 MusicFlow</div><div class="desc">自托管音乐库播放器 · 飞牛风格重构版</div></div>
        <div class="setting-value"><span class="version">v1.0</span></div>
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
import { ref, onMounted } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import api from "@/api";
import { useAuthStore } from "@/stores/auth";
const authStore = useAuthStore();

const showNameDialog = ref(false);
const newName = ref("");

// ---------- API Key ----------
const apiKey = ref("");
const apiKeyExpiresAt = ref<string | null>(null);
const apiKeyVisible = ref(false);
const apiKeyLoading = ref(false);

async function loadApiKey() {
  try {
    const res = await api.get("/rest/api/v1/users/me/api-key");
    apiKey.value = res.data.apiKey || "";
    apiKeyExpiresAt.value = res.data.expiresAt || null;
  } catch { /* 静默：不影响页面其他部分 */ }
}

async function generateApiKey() {
  if (apiKey.value) {
    try {
      await ElMessageBox.confirm(
        "重新生成会立即让旧 Key 失效，所有使用旧 Key 的客户端（如 Home Assistant）都需要重新填写。",
        "重新生成 API Key",
        { type: "warning", confirmButtonText: "确认生成", cancelButtonText: "取消" },
      );
    } catch { return; }
  }
  apiKeyLoading.value = true;
  try {
    const res = await api.post("/rest/api/v1/users/me/api-key", {});
    apiKey.value = res.data.apiKey;
    apiKeyExpiresAt.value = res.data.expiresAt || null;
    apiKeyVisible.value = true;
    ElMessage.success("API Key 已生成");
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || "生成失败");
  } finally {
    apiKeyLoading.value = false;
  }
}

async function revokeApiKey() {
  try {
    await ElMessageBox.confirm("撤销后使用该 Key 的客户端会立即失去访问权限。", "撤销 API Key", {
      type: "warning", confirmButtonText: "确认撤销", cancelButtonText: "取消",
    });
  } catch { return; }
  apiKeyLoading.value = true;
  try {
    await api.delete("/rest/api/v1/users/me/api-key");
    apiKey.value = "";
    apiKeyExpiresAt.value = null;
    apiKeyVisible.value = false;
    ElMessage.success("API Key 已撤销");
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || "撤销失败");
  } finally {
    apiKeyLoading.value = false;
  }
}

async function copyApiKey() {
  try {
    await navigator.clipboard.writeText(apiKey.value);
    ElMessage.success("已复制到剪贴板");
  } catch {
    // 非 HTTPS 下 clipboard API 不可用,退回手动选中
    apiKeyVisible.value = true;
    ElMessage.warning("当前环境不支持自动复制，请手动选中复制");
  }
}

onMounted(loadApiKey);
const reduceMotion = ref(window.matchMedia('(prefers-reduced-motion: reduce)').matches);

function toggleMotion(v: string | number | boolean) {
  const on = Boolean(v);
  document.documentElement.style.setProperty('prefers-reduced-motion', on ? 'reduce' : 'no-preference');
  if (on) document.documentElement.classList.add('reduce-motion');
  else document.documentElement.classList.remove('reduce-motion');
  ElMessage.success(on ? '已开启减弱动画' : '已关闭减弱动画');
}

function clearCache() {
  localStorage.clear();
  ElMessage.success('本地缓存已清除，即将刷新');
  setTimeout(() => location.reload(), 800);
}

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
.settings-page { padding: 24px 32px 130px; max-width: 900px; margin: 0 auto; }
.page-header { margin-bottom: 24px; h2 { font-size: 28px; font-weight: 700; margin: 0; } }
.mt-card { margin-top: 18px; }
:deep(.el-card) { background: rgba(255,255,255,0.04) !important; border: 1px solid rgba(255,255,255,0.08) !important; border-radius: var(--fnos-radius-lg) !important; }
:deep(.el-descriptions__body) { background: transparent !important; }
:deep(.el-descriptions__label) { background: rgba(255,255,255,0.04) !important; color: var(--fnos-text-secondary) !important; }
:deep(.el-descriptions__content) { background: transparent !important; color: var(--fnos-text-primary) !important; }
.setting-item { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; padding: 16px 0; border-bottom: 1px solid rgba(255,255,255,0.06);
  &:last-child { border-bottom: none; }
  .setting-label { .title { font-weight: 600; color: var(--fnos-text-primary); } .desc { font-size: 12px; color: var(--fnos-text-tertiary); margin-top: 4px; } }
  .setting-value { flex-shrink: 0; }
  .version { font-size: 13px; color: var(--fnos-text-tertiary); }
}
.setting-label .expire { color: var(--fnos-text-secondary); }
.apikey-box { margin-top: 10px; max-width: 460px; }
.apikey-actions { display: flex; gap: 8px; }

@media (max-width: 768px) {
  .settings-page { padding: 20px 16px; }
  .page-header h2 { font-size: 24px; }
  .setting-item { flex-direction: column; gap: 10px; }
}
</style>
