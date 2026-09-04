<template>
  <div class="settings-page">
    <div class="page-header"><h2>{{ t('settings.title') }}</h2></div>

    <!-- ===== 外观 ===== -->
    <el-card>
      <h3>{{ t('settings.appearance') }}</h3>
      <div class="setting-item">
        <div class="setting-label"><div class="title">{{ t('language.label') }}</div><div class="desc">{{ t('settings.theme.desc') }}</div></div>
        <div class="setting-value">
          <el-select :model-value="localeStore.lang" style="width: 160px" @change="onLangChange">
            <el-option label="简体中文" value="zh-CN" />
            <el-option label="English" value="en-US" />
          </el-select>
        </div>
      </div>
      <div class="setting-item">
        <div class="setting-label"><div class="title">{{ t('settings.theme.title') }}</div><div class="desc">{{ t('settings.theme.desc') }}</div></div>
        <div class="setting-value"><el-tag size="small" type="info">{{ t('settings.theme.value') }}</el-tag></div>
      </div>
      <div class="setting-item">
        <div class="setting-label"><div class="title">{{ t('settings.reduceMotion.title') }}</div><div class="desc">{{ t('settings.reduceMotion.desc') }}</div></div>
        <div class="setting-value"><el-switch v-model="reduceMotion" @change="toggleMotion" /></div>
      </div>
    </el-card>

    <!-- ===== 系统（仅管理员） ===== -->
    <template v-if="authStore.isAdmin">
      <el-card class="mt-card">
        <h3>{{ t('settings.systemInfo') }}</h3>
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item :label="t('settings.serverVersion')">{{ serverVersion }}</el-descriptions-item>
          <el-descriptions-item :label="t('settings.gitHash')">{{ gitCommit }}</el-descriptions-item>
          <el-descriptions-item :label="t('settings.projectUrl')">
            <a href="https://github.com/ray5378/MusicFlow" target="_blank" rel="noopener" class="gh-link">{{ t('settings.githubRepo') }} ↗</a>
          </el-descriptions-item>
        </el-descriptions>
      </el-card>

      <el-card class="mt-card">
        <h3>{{ t('settings.proxy') }}</h3>
        <div class="setting-item">
          <div class="setting-label">
            <div class="title">{{ t('settings.proxyEnable.title') }}</div>
            <div class="desc">{{ t('settings.proxyEnable.desc') }}</div>
          </div>
          <div class="setting-value"><el-switch v-model="proxyEnabled" /></div>
        </div>
        <div v-if="proxyEnabled" class="setting-item">
          <div class="setting-label"><div class="title">{{ t('settings.proxyUrl.title') }}</div><div class="desc">{{ t('settings.proxyUrl.desc') }}</div></div>
          <div class="setting-value proxy-actions">
            <el-input v-model="proxyUrl" :placeholder="t('settings.proxyPlaceholder')" class="proxy-input" clearable />
            <el-button :loading="proxyTesting" @click="testProxy">{{ t('settings.testProxy') }}</el-button>
            <el-button type="primary" :loading="proxySaving" @click="saveProxy">{{ t('common.save') }}</el-button>
          </div>
        </div>
      </el-card>

      <el-card class="mt-card">
        <h3>{{ t('settings.batchPace.title') }}</h3>
        <div class="setting-item">
          <div class="setting-label">
            <div class="title">{{ t('settings.batchPace.title') }}</div>
            <div class="desc">{{ t('settings.batchPace.desc') }}</div>
          </div>
          <div class="setting-value batch-pace-actions">
            <el-select :model-value="batchPace" style="width: 160px" @change="saveBatchPace">
              <el-option :label="t('settings.batchPace.slow')" value="slow" />
              <el-option :label="t('settings.batchPace.standard')" value="standard" />
              <el-option :label="t('settings.batchPace.full')" value="full" />
            </el-select>
            <span class="pace-hint">{{ batchPaceHint }}</span>
          </div>
        </div>
      </el-card>

      <el-card class="mt-card">
        <h3>{{ t('settings.scheduled') }}</h3>
        <div class="setting-item">
          <div class="setting-label">
            <div class="title">{{ t('settings.dailySync.title') }}</div>
            <div class="desc">{{ t('settings.dailySync.desc') }}</div>
          </div>
          <div class="setting-value"><el-switch v-model="dailyEnabled" @change="saveDailyConfig" /></div>
        </div>
        <div class="setting-item">
          <div class="setting-label">
            <div class="title">{{ t('settings.dailyTime.title') }}</div>
            <div class="desc">{{ t('settings.dailyTime.desc') }}</div>
          </div>
          <div class="setting-value">
            <el-time-picker
              v-model="dailyTime"
              format="HH:mm"
              value-format="HH:mm"
              :placeholder="t('settings.dailyTime.placeholder')"
              style="width: 140px"
              @change="saveDailyConfig"
            />
          </div>
        </div>
      </el-card>

      <el-card class="mt-card">
        <h3>{{ t('settings.memoryReclaim.title') }}</h3>
        <div class="setting-item">
          <div class="setting-label">
            <div class="title">{{ t('settings.memoryReclaim.autoTitle') }}</div>
            <div class="desc">{{ t('settings.memoryReclaim.autoDesc') }}</div>
          </div>
          <div class="setting-value">
            <el-switch v-model="memoryAutoReclaim" @change="saveMemorySettings" />
          </div>
        </div>
        <div class="setting-item">
          <div class="setting-label">
            <div class="title">{{ t('settings.memoryReclaim.idleTitle') }}</div>
            <div class="desc">{{ t('settings.memoryReclaim.idleDesc') }}</div>
          </div>
          <div class="setting-value memory-actions">
            <el-input-number v-model="memoryIdleMinutes" :min="1" :max="60" size="small" @change="saveMemorySettings" />
            <span class="pace-hint">{{ t('settings.memoryReclaim.idleUnit') }}</span>
            <el-button type="primary" :loading="reclaiming" @click="reclaimNow">{{ t('settings.memoryReclaim.reclaimNow') }}</el-button>
          </div>
        </div>
      </el-card>
    </template>

    <!-- ===== 通用 ===== -->
    <el-card class="mt-card">
      <h3>{{ t('settings.general') }}</h3>
      <div class="setting-item">
        <div class="setting-label"><div class="title">{{ t('settings.clearCache.title') }}</div><div class="desc">{{ t('settings.clearCache.desc') }}</div></div>
        <div class="setting-value"><el-button @click="clearCache">{{ t('settings.clearCache.title') }}</el-button></div>
      </div>
      <div class="setting-item">
        <div class="setting-label"><div class="title">{{ t('settings.about.title') }}</div><div class="desc">{{ t('settings.about.desc') }}</div></div>
        <div class="setting-value">
          <a href="https://github.com/ray5378/MusicFlow" target="_blank" rel="noopener" class="gh-link">{{ t('settings.githubRepo') }} ↗</a>
        </div>
      </div>
    </el-card>

  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { ElMessage } from "element-plus";
import api from "@/api";
import { useAuthStore } from "@/stores/auth";
import { useLocaleStore } from "@/stores/locale";
import type { AppLocale } from "@/locales";

const { t } = useI18n();
const authStore = useAuthStore();
const localeStore = useLocaleStore();

function onLangChange(lang: AppLocale) {
  localeStore.setLang(lang);
}

// ---------- 版本 / 哈希（前后端 lockstep 绑定发布，仅展示后端版本） ----------
const serverVersion = ref("—");
const gitCommit = ref("—");
async function loadVersion() {
  try {
    const res = await api.get("/ping");
    const v = res.data?.version;
    serverVersion.value = v ? (v === "dev" ? "dev" : `v${v}`) : t("common.unknown");
    gitCommit.value = res.data?.commit || t("common.unknown");
  } catch {
    serverVersion.value = t("common.unknown");
    gitCommit.value = t("common.unknown");
  }
}

// ---------- 网络代理 ----------
const proxyEnabled = ref(false);
const proxyUrl = ref("");
const proxySaving = ref(false);
const proxyTesting = ref(false);

async function loadProxy() {
  try {
    const res = await api.get("/rest/api/v1/proxy");
    proxyEnabled.value = !!res.data.enabled;
    proxyUrl.value = res.data.url || "";
  } catch { /* 静默 */ }
}

async function saveProxy() {
  proxySaving.value = true;
  try {
    await api.put("/rest/api/v1/proxy", { enabled: proxyEnabled.value, url: proxyUrl.value });
    ElMessage.success(t("settings.saved"));
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || t("settings.saveFailed"));
  } finally {
    proxySaving.value = false;
  }
}

// 测试连接：先保存当前输入（让后端用最新配置测），再验证代理通道能否出网。
async function testProxy() {
  proxyTesting.value = true;
  try {
    await api.put("/rest/api/v1/proxy", { enabled: proxyEnabled.value, url: proxyUrl.value });
    const res = await api.post("/rest/api/v1/proxy/test", {});
    if (res.data?.success) ElMessage.success(res.data?.message || t("settings.proxyOk"));
    else ElMessage.error(res.data?.message || res.data?.error || t("settings.proxyBad"));
  } catch (e: any) {
    ElMessage.error(e.response?.data?.message || e.response?.data?.error || t("settings.testFailed"));
  } finally {
    proxyTesting.value = false;
  }
}

// ---------- 后台任务限速档位 ----------
const batchPace = ref<"slow" | "standard" | "full">("standard");
const batchPaceHint = ref("");
const PACE_HINT_KEYS: Record<string, string> = {
  slow: "settings.batchPace.hintSlow",
  standard: "settings.batchPace.hintStandard",
  full: "settings.batchPace.hintFull",
};

async function loadBatchPace() {
  try {
    const res = await api.get("/rest/api/v1/batch-pace");
    const p = res.data?.pace;
    if (p === "slow" || p === "standard" || p === "full") {
      batchPace.value = p;
      batchPaceHint.value = t(PACE_HINT_KEYS[p]);
    }
  } catch { /* 静默 */ }
}

async function saveBatchPace(pace: string) {
  try {
    const res = await api.put("/rest/api/v1/batch-pace", { pace });
    if (res.data?.success) {
      batchPaceHint.value = PACE_HINT_KEYS[pace] ? t(PACE_HINT_KEYS[pace]) : "";
      ElMessage.success(t("settings.batchPace.saved"));
    } else {
      ElMessage.error(res.data?.error || t("settings.saveFailed"));
    }
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || t("settings.saveFailed"));
  }
}

// ---------- 定时任务(每日同步时刻,HH:MM 可配) ----------
const dailyEnabled = ref(true);
const dailyTime = ref("03:00");
let dailySaving = false; // 去抖:enabled/time 连续改动只发一次

async function loadDailyConfig() {
  try {
    const res = await api.get("/rest/api/v1/daily-recommend");
    dailyEnabled.value = !!res.data?.enabled;
    if (typeof res.data?.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(res.data.time)) {
      dailyTime.value = res.data.time;
    }
  } catch { /* 静默 */ }
}

async function saveDailyConfig() {
  if (dailySaving) return;
  dailySaving = true;
  try {
    await api.put("/rest/api/v1/daily-recommend/config", {
      enabled: dailyEnabled.value,
      time: dailyTime.value || "03:00",
    });
    ElMessage.success(t("settings.dailyTime.saved"));
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || t("settings.saveFailed"));
  } finally {
    setTimeout(() => { dailySaving = false; }, 300);
  }
}

// ---------- 空闲内存自动回收 ----------
const memoryAutoReclaim = ref(true);
const memoryIdleMinutes = ref(5);
const reclaiming = ref(false);

async function loadMemorySettings() {
  try {
    const res = await api.get("/rest/api/v1/admin/memory-settings");
    memoryAutoReclaim.value = !!res.data?.enabled;
    if (Number.isFinite(res.data?.idleMinutes)) memoryIdleMinutes.value = res.data.idleMinutes;
  } catch { /* 静默 */ }
}
async function saveMemorySettings() {
  try {
    await api.put("/rest/api/v1/admin/memory-settings", {
      enabled: memoryAutoReclaim.value,
      idleMinutes: memoryIdleMinutes.value,
    });
    ElMessage.success(t("settings.memoryReclaim.saved"));
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || t("settings.saveFailed"));
  }
}
async function reclaimNow() {
  reclaiming.value = true;
  try {
    const res = await api.post("/rest/api/v1/admin/memory/reclaim", {});
    const r = res.data || {};
    const n = (r.caches || []).length;
    const parts = [r.gc ? "reclaimedGc" : "", r.checkpoint ? "reclaimedWal" : ""].filter(Boolean);
    let key = "settings.memoryReclaim.reclaimedFull";
    if (parts.length === 0) key = "settings.memoryReclaim.reclaimed";
    else if (parts.length === 1) key = `settings.memoryReclaim.${parts[0]}`;
    ElMessage.success(t(key, { count: n }));
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || t("settings.memoryReclaim.reclaimFailed"));
  } finally {
    reclaiming.value = false;
  }
}

// ---------- 外观 / 通用 ----------
const reduceMotion = ref(window.matchMedia('(prefers-reduced-motion: reduce)').matches);

function toggleMotion(v: string | number | boolean) {
  const on = Boolean(v);
  document.documentElement.style.setProperty('prefers-reduced-motion', on ? 'reduce' : 'no-preference');
  if (on) document.documentElement.classList.add('reduce-motion');
  else document.documentElement.classList.remove('reduce-motion');
  ElMessage.success(on ? t('settings.reduceMotion.on') : t('settings.reduceMotion.off'));
}

function clearCache() {
  localStorage.clear();
  ElMessage.success(t('settings.clearCache.done'));
  setTimeout(() => location.reload(), 800);
}

onMounted(() => { loadVersion(); loadProxy(); loadBatchPace(); loadMemorySettings(); loadDailyConfig(); });
</script>

<style lang="scss" scoped>
.settings-page { padding: 24px 32px 130px; max-width: 900px; margin: 0 auto; }
.page-header { margin-bottom: 24px; h2 { font-size: 28px; font-weight: 700; margin: 0; } }
.mt-card { margin-top: 18px; }
:deep(.el-card) { background: rgba(255,255,255,0.04) !important; border: 1px solid rgba(255,255,255,0.08) !important; border-radius: var(--fnos-radius-lg) !important; }
:deep(.el-descriptions__body) { background: transparent !important; }
:deep(.el-descriptions__label) { background: rgba(255,255,255,0.04) !important; color: var(--fnos-text-secondary) !important; }
:deep(.el-descriptions__content) { background: transparent !important; color: var(--fnos-text-primary) !important; }
h3 { font-size: 15px; font-weight: 600; margin: 0 0 2px; color: var(--fnos-text-primary); }
.setting-item { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; padding: 14px 0; border-bottom: 1px solid rgba(255,255,255,0.06);
  &:last-child { border-bottom: none; }
  .setting-label { .title { font-weight: 600; color: var(--fnos-text-primary); } .desc { font-size: 12px; color: var(--fnos-text-tertiary); margin-top: 4px; } }
  .setting-value { flex-shrink: 0; }
}
.gh-link { color: var(--el-color-primary); text-decoration: none; &:hover { text-decoration: underline; } }
.proxy-actions { display: flex; gap: 8px; align-items: center; }
.proxy-input { width: 300px; }
.batch-pace-actions { display: flex; gap: 10px; align-items: center; }
.memory-actions { display: flex; gap: 10px; align-items: center; }
.pace-hint { font-size: 12px; color: var(--fnos-text-tertiary); }

@media (max-width: 768px) {
  .settings-page { padding: 20px 16px; }
  .page-header h2 { font-size: 24px; }
  .setting-item { flex-direction: column; gap: 10px; }
  .proxy-input { width: 100%; }
  .proxy-actions { flex-wrap: wrap; }
}
</style>