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
            <el-option :label="t('language.zh-CN')" value="zh-CN" />
            <el-option :label="t('language.en-US')" value="en-US" />
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

      <!-- ===== 音频管道（P5-1 开关 + P5-2 DLNA 单独回退）=====
           与「音色」不同：这是**服务端全局**播放行为（所有账号、所有设备一致），故仅管理员可见。
           语义照 D9：关掉任一开关只等于「该链路滤镜链为空」，播放仍走管道 —— 不恢复「原样直出」。 -->
      <el-card class="mt-card">
        <h3>{{ t('settings.pipeline.title') }}</h3>
        <div class="dsp-desc">{{ t('settings.pipeline.desc') }}</div>

        <div class="setting-item">
          <div class="setting-label">
            <div class="title">{{ t('settings.pipeline.master') }}</div>
            <div class="desc">{{ t('settings.pipeline.masterDesc') }}</div>
          </div>
          <div class="setting-value"><el-switch v-model="pipelineSwitches.enabled" @change="savePipeline" /></div>
        </div>

        <div class="setting-item">
          <div class="setting-label"><div class="title">{{ t('settings.pipeline.channels') }}</div></div>
          <div class="setting-value pipe-channels">
            <label v-for="ch in PIPELINE_CHANNEL_KEYS" :key="ch" class="pipe-ch">
              <el-switch v-model="pipelineSwitches.channels[ch]" size="small" :disabled="!pipelineSwitches.enabled" @change="savePipeline" />
              <span>{{ t(`settings.pipeline.channel${PIPELINE_CHANNEL_LABEL[ch]}`) }}</span>
            </label>
          </div>
        </div>

        <div class="setting-item">
          <div class="setting-label">
            <div class="title">{{ t('settings.pipeline.flow') }}</div>
            <div class="desc">{{ t('settings.pipeline.flowDesc') }}</div>
          </div>
          <div class="setting-value"><el-switch v-model="flowForm.enabled" :disabled="!pipelineSwitches.enabled" @change="savePipeline" /></div>
        </div>

        <div class="setting-item">
          <div class="setting-label"><div class="title">{{ t('settings.pipeline.crossfade') }}</div></div>
          <div class="setting-value pipe-row">
            <span class="dsp-mini">{{ t('settings.pipeline.mode') }}</span>
            <el-select v-model="flowForm.mode" size="small" style="width: 170px" :disabled="!pipelineSwitches.enabled" @change="savePipeline">
              <el-option :label="t('settings.pipeline.modeDisabled')" value="disabled" />
              <el-option :label="t('settings.pipeline.modeStandard')" value="standard" />
            </el-select>
            <span class="dsp-mini">{{ t('settings.pipeline.duration') }}</span>
            <el-input-number v-model="flowForm.durationSec" :min="3" :max="30" :step="1" size="small" controls-position="right" style="width: 110px" :disabled="!pipelineSwitches.enabled || flowForm.mode !== 'standard'" @change="savePipeline" />
            <span class="dsp-mini">{{ t('settings.pipeline.seconds') }}</span>
          </div>
        </div>

        <div class="setting-item pipe-block">
          <div class="setting-label">
            <div class="title">{{ t('settings.pipeline.deviceFallback') }}</div>
            <div class="desc">{{ t('settings.pipeline.deviceFallbackDesc') }}</div>
          </div>
          <div class="setting-value pipe-channels pipe-devices">
            <div v-if="pipelineDevices.length === 0" class="dsp-mini">{{ t('settings.pipeline.noDevices') }}</div>
            <label v-for="d in pipelineDevices" :key="d.deviceId" class="pipe-ch">
              <el-switch v-model="d.fallback" size="small" @change="saveDeviceFallback(d)" />
              <span>{{ d.name }}</span>
            </label>
          </div>
        </div>

        <div class="setting-item">
          <div class="setting-label">
            <div class="title">{{ t('settings.pipeline.measure') }}</div>
            <div class="desc">{{ t('settings.pipeline.measureDesc') }}</div>
          </div>
          <div class="setting-value pipe-row">
            <el-switch v-model="measureEnabled" size="small" @change="saveMeasureEnabled" />
            <span class="dsp-mini">{{ measureStatusText }}</span>
            <el-button size="small" :disabled="!measureEnabled" :loading="measureRunning" @click="runMeasure">{{ t('settings.pipeline.measureRun') }}</el-button>
          </div>
        </div>
      </el-card>
    </template>

    <!-- ===== 音色（每台设备，P4-3）=====
         与「响度归一化」职责不同：② 段管「每首歌一样响」，这里管「按口味调音色」。
         音色是设备属性（书架箱/耳机各自的补偿曲线），故按 peerId 存、不跟账号走。
         全部留 0 = 不做任何处理（服务端零滤镜、零开销）。 -->
    <el-card class="mt-card">
      <h3>{{ t('settings.dsp.title') }}</h3>
      <div class="dsp-desc">{{ t('settings.dsp.desc') }}</div>
      <div class="setting-item">
        <div class="setting-label">
          <div class="title">{{ t('settings.dsp.device') }}</div>
          <div v-if="dspDevices.length === 0" class="desc">{{ t('settings.dsp.noDevice') }}</div>
        </div>
        <div class="setting-value">
          <el-select v-model="dspPeerId" style="width: 240px" :placeholder="t('settings.dsp.devicePlaceholder')" @change="loadDsp">
            <el-option v-for="d in dspDevices" :key="d.peerId" :label="d.label" :value="d.peerId" />
          </el-select>
        </div>
      </div>

      <template v-if="dspPeerId">
        <div class="setting-item">
          <div class="setting-label">
            <div class="title">{{ t('settings.dsp.preamp') }}</div>
            <div class="desc">{{ t('settings.dsp.preampDesc') }}</div>
          </div>
          <div class="setting-value">
            <el-input-number v-model="dspForm.preampDb" :min="-30" :max="30" :step="0.5" :precision="1" size="small" controls-position="right" style="width: 120px" />
          </div>
        </div>

        <div class="setting-item">
          <div class="setting-label"><div class="title">{{ t('settings.dsp.tone') }}</div></div>
          <div class="setting-value dsp-row">
            <span class="dsp-mini">{{ t('settings.dsp.toneBass') }}</span>
            <el-input-number v-model="dspForm.bassDb" :min="-12" :max="12" :step="1" size="small" controls-position="right" style="width: 110px" />
            <span class="dsp-mini">{{ t('settings.dsp.toneMid') }}</span>
            <el-input-number v-model="dspForm.midDb" :min="-12" :max="12" :step="1" size="small" controls-position="right" style="width: 110px" />
            <span class="dsp-mini">{{ t('settings.dsp.toneTreble') }}</span>
            <el-input-number v-model="dspForm.trebleDb" :min="-12" :max="12" :step="1" size="small" controls-position="right" style="width: 110px" />
          </div>
        </div>

        <div class="setting-item">
          <div class="setting-label">
            <div class="title">{{ t('settings.dsp.balance') }}</div>
            <div class="desc">{{ t('settings.dsp.balanceDesc') }}</div>
          </div>
          <div class="setting-value dsp-row">
            <span class="dsp-mini">{{ t('settings.dsp.balanceLeft') }}</span>
            <el-slider v-model="dspForm.balance" :min="-100" :max="100" :step="5" style="width: 220px" />
            <span class="dsp-mini">{{ t('settings.dsp.balanceRight') }}</span>
          </div>
        </div>

        <div class="setting-item">
          <div class="setting-label"><div class="title">{{ t('settings.dsp.gain') }}</div><div class="desc">{{ t('settings.dsp.gainDesc') }}</div></div>
          <div class="setting-value">
            <el-input-number v-model="dspForm.gainDb" :min="-30" :max="30" :step="0.5" :precision="1" size="small" controls-position="right" style="width: 120px" />
          </div>
        </div>

        <div class="setting-item dsp-eq-block">
          <div class="setting-label">
            <div class="title">{{ t('settings.dsp.eq') }}</div>
            <div class="desc">{{ dspForm.bands.length === 0 ? t('settings.dsp.eqEmpty') : t('settings.dsp.eqDesc') }}</div>
          </div>
          <div class="setting-value dsp-eq">
            <div v-for="(b, i) in dspForm.bands" :key="i" class="dsp-eq-row">
              <el-select v-model="b.type" size="small" style="width: 110px">
                <el-option v-for="tp in DSP_EQ_TYPES" :key="tp.value" :label="t(`settings.dsp.type${tp.label}`)" :value="tp.value" />
              </el-select>
              <el-input-number v-model="b.frequency" :min="20" :max="20000" :step="10" size="small" controls-position="right" style="width: 120px" />
              <el-input-number v-model="b.gainDb" :min="-24" :max="24" :step="0.5" :precision="1" size="small" controls-position="right" style="width: 110px" />
              <el-input-number v-model="b.q" :min="0.1" :max="20" :step="0.1" :precision="1" size="small" controls-position="right" style="width: 100px" />
              <el-select v-model="b.channel" size="small" style="width: 92px">
                <el-option :label="t('settings.dsp.eqAll')" value="all" />
                <el-option label="FL" value="FL" />
                <el-option label="FR" value="FR" />
              </el-select>
              <el-button link type="danger" size="small" @click="dspForm.bands.splice(i, 1)">{{ t('settings.dsp.eqRemove') }}</el-button>
            </div>
            <el-button size="small" @click="addDspBand">{{ t('settings.dsp.eqAdd') }}</el-button>
          </div>
        </div>

        <div class="dsp-foot">
          <span class="dsp-mini">{{ dspDeviceLabel }}</span>
          <el-button :loading="dspSaving" @click="clearDsp">{{ t('settings.dsp.clear') }}</el-button>
          <el-button type="primary" :loading="dspSaving" @click="saveDsp">{{ t('settings.dsp.save') }}</el-button>
        </div>
      </template>
    </el-card>

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
import { ref, reactive, computed, onMounted, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import { ElMessage } from "element-plus";
import api from "@/api";
import { useAuthStore } from "@/stores/auth";
import { useLocaleStore } from "@/stores/locale";
import { usePlayerStore } from "@/stores/player";
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

// ---------- 音色：per-player DSP（③ 段，P4-3）----------
// 服务端按 peerId 存（音色是设备属性，不跟账号走），出流时插在响度之后、限制器之前。
// 这里只做「读—改—写」：**归一化的真相在服务端**（normalizeDspConfig），
// 所以保存后一律用响应里的 config 回写表单 —— 用户看到的就是真正生效的值。
const playerStore = usePlayerStore();
const dspPeerId = ref("");
const dspSaving = ref(false);
const dspForm = reactive({
  preampDb: 0,
  bassDb: 0,
  midDb: 0,
  trebleDb: 0,
  balance: 0,
  gainDb: 0,
  bands: [] as Array<{ type: string; frequency: number; gainDb: number; q: number; channel: string }>,
});

const DSP_EQ_TYPES = [
  { value: "peak", label: "Peak" },
  { value: "low_shelf", label: "LowShelf" },
  { value: "high_shelf", label: "HighShelf" },
  { value: "high_pass", label: "HighPass" },
  { value: "low_pass", label: "LowPass" },
  { value: "notch", label: "Notch" },
];

/** 可选设备列表（来自播放器 store：REST /v1/peers + WS 心跳共同维护）。 */
const dspDevices = computed(() =>
  (playerStore.peers as any[])
    .filter((p) => typeof p?.peerId === "string" && p.peerId)
    .map((p) => ({ peerId: p.peerId as string, label: playerStore.getPeerName(p.peerId) || p.name || p.peerId })),
);
const dspDeviceLabel = computed(() => dspDevices.value.find((d) => d.peerId === dspPeerId.value)?.label || "");

function dspUrl(): string {
  return `/rest/api/v1/player-prefs/dsp/${encodeURIComponent(dspPeerId.value)}`;
}

function applyDspConfig(cfg: any): void {
  dspForm.preampDb = Number(cfg?.preampDb) || 0;
  dspForm.bassDb = Number(cfg?.tone?.bassDb) || 0;
  dspForm.midDb = Number(cfg?.tone?.midDb) || 0;
  dspForm.trebleDb = Number(cfg?.tone?.trebleDb) || 0;
  dspForm.balance = Number(cfg?.balance) || 0;
  dspForm.gainDb = Number(cfg?.gainDb) || 0;
  dspForm.bands = (Array.isArray(cfg?.parametricEq?.bands) ? cfg.parametricEq.bands : []).map((b: any) => ({
    type: String(b?.type || "peak"),
    frequency: Number(b?.frequency) || 1000,
    gainDb: Number(b?.gainDb) || 0,
    q: Number(b?.q) || 1,
    channel: b?.channel === "FL" || b?.channel === "FR" ? b.channel : "all",
  }));
}

/** 切换设备：先把表单清回"无处理"，再拉该设备的配置（避免把上一台的残留带过去）。 */
async function loadDsp(): Promise<void> {
  applyDspConfig(null);
  if (!dspPeerId.value) return;
  try {
    const res = await api.get(dspUrl());
    applyDspConfig(res.data?.config);
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || t("settings.dsp.loadFailed"));
  }
}

function addDspBand(): void {
  dspForm.bands.push({ type: "peak", frequency: 1000, gainDb: 0, q: 1, channel: "all" });
}

// 直接把表单原文发给服务端归一化（0 / 空段由服务端丢弃），再用返回值回写 —— 单一真相源。
function dspPayload(): Record<string, unknown> {
  return {
    preampDb: dspForm.preampDb,
    tone: { bassDb: dspForm.bassDb, midDb: dspForm.midDb, trebleDb: dspForm.trebleDb },
    balance: dspForm.balance,
    gainDb: dspForm.gainDb,
    parametricEq: {
      bands: dspForm.bands.map((b) => ({
        type: b.type,
        frequency: b.frequency,
        gainDb: b.gainDb,
        q: b.q,
        ...(b.channel !== "all" ? { channel: b.channel } : {}),
      })),
    },
  };
}

async function saveDsp(): Promise<void> {
  if (!dspPeerId.value) return;
  dspSaving.value = true;
  try {
    const res = await api.put(dspUrl(), dspPayload());
    applyDspConfig(res.data?.config);
    ElMessage.success(t("settings.dsp.saved"));
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || t("settings.dsp.saveFailed"));
  } finally {
    dspSaving.value = false;
  }
}

async function clearDsp(): Promise<void> {
  if (!dspPeerId.value) return;
  dspSaving.value = true;
  try {
    // 空配置 → 服务端归一化为 null 并**删行**（库里不留"等于没配置"的行）。
    const res = await api.put(dspUrl(), {});
    applyDspConfig(res.data?.config);
    ElMessage.success(t("settings.dsp.cleared"));
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || t("settings.dsp.saveFailed"));
  } finally {
    dspSaving.value = false;
  }
}

// ---------- 音频管道开关 + DLNA 单设备回退（P5-1 / P5-2）----------
// 服务端**全局**播放行为（所有账号、所有设备一致），端点均 admin ⇒ 面板只挂在管理员区块。
// 语义照 D9：关掉 = 滤镜链为空（仍走管道），不是恢复直出。
// 与「音色」面板同一套做法：保存后用响应回写，**归一化的真相源在服务端**。
const pipelineSwitches = reactive<{ enabled: boolean; channels: Record<string, boolean> }>({
  enabled: true,
  channels: { http: true, dlna: true, sendspin: true, airplay: true },
});
// flow.enabled 是「允许拼连续流」（P3 的读取口），mode/durationSec 才是真正生效的交叉淡入。
const flowForm = reactive<{ enabled: boolean; mode: "disabled" | "standard"; durationSec: number }>({
  enabled: true,
  mode: "disabled",
  durationSec: 8,
});
const pipelineDevices = ref<Array<{ deviceId: string; name: string; fallback: boolean }>>([]);
// 面板是一串独立开关，连点时逐条 PUT 会让「后发的响应」被「先发的响应」回写覆盖（回滚错觉）。
// 照本仓既有做法（`setVolume` / `dailySaving`）做 250ms trailing 去抖，合并成一次提交。
let pipelineTimer: ReturnType<typeof setTimeout> | null = null;

const PIPELINE_CHANNEL_KEYS = ["http", "dlna", "sendspin", "airplay"] as const;
// i18n 后缀 → 键名 `settings.pipeline.channel${suffix}`（首字母大写，与既有键命名一致）。
const PIPELINE_CHANNEL_LABEL: Record<string, string> = {
  http: "Http",
  dlna: "Dlna",
  sendspin: "Sendspin",
  airplay: "Airplay",
};

/** 用服务端返回值回写面板。`devices` 缺席时保持原样（PUT 响应不返回设备表）。 */
function applyPipelineSettings(res: any): void {
  const sw = res?.switches;
  if (sw) {
    pipelineSwitches.enabled = sw.enabled !== false;
    for (const ch of PIPELINE_CHANNEL_KEYS) {
      pipelineSwitches.channels[ch] = sw.channels?.[ch] !== false;
    }
  }
  const fl = res?.flow;
  if (fl) {
    flowForm.enabled = fl.enabled !== false;
    flowForm.mode = fl.mode === "standard" ? "standard" : "disabled";
    const dur = Number(fl.durationSec);
    flowForm.durationSec = Number.isFinite(dur) && dur > 0 ? dur : 8;
  }
  if (Array.isArray(res?.devices)) {
    pipelineDevices.value = res.devices
      .map((d: any) => ({
        deviceId: String(d?.deviceId || ""),
        name: String(d?.name || d?.deviceId || ""),
        fallback: d?.fallback === true,
      }))
      .filter((d: { deviceId: string }) => !!d.deviceId);
  }
}

async function loadPipeline(): Promise<void> {
  try {
    const res = await api.get("/rest/api/v1/pipeline/switches");
    applyPipelineSettings(res.data);
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || t("settings.pipeline.loadFailed"));
  }
}

async function savePipeline(): Promise<void> {
  if (pipelineTimer) clearTimeout(pipelineTimer);
  pipelineTimer = setTimeout(() => { void commitPipeline(); }, 250);
}

async function commitPipeline(): Promise<void> {
  pipelineTimer = null;
  try {
    const res = await api.put("/rest/api/v1/pipeline/switches", {
      switches: { enabled: pipelineSwitches.enabled, channels: { ...pipelineSwitches.channels } },
      flow: { enabled: flowForm.enabled, mode: flowForm.mode, durationSec: flowForm.durationSec },
    });
    applyPipelineSettings(res.data);
    ElMessage.success(t("settings.pipeline.saved"));
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || t("settings.pipeline.saveFailed"));
  }
}

/** 单设备回退：失败时把开关拨回去，避免界面显示的与库里存的不一致。 */
async function saveDeviceFallback(d: { deviceId: string; name: string; fallback: boolean }): Promise<void> {
  try {
    const res = await api.put(`/rest/api/v1/pipeline/dlna/${encodeURIComponent(d.deviceId)}`, { fallback: d.fallback });
    d.fallback = res.data?.fallback === true;
    ElMessage.success(t("settings.pipeline.saved"));
  } catch (e: any) {
    d.fallback = !d.fallback;
    ElMessage.error(e.response?.data?.error || t("settings.pipeline.saveFailed"));
  }
}

// ---------- 离线预测量（P5-3，可选优化层，默认关）----------
// 服务端异步跑（一批可能几十首），所以这里只发「开始」+ 轮询进度 ——
// 同步等结果会撞上 api 的 15s 超时（axios timeout）。
const measureEnabled = ref(false);
const measureRunning = ref(false);
const measureCounts = reactive({ total: 0, measured: 0, pending: 0 });
const measureProgress = reactive({ done: 0, total: 0 });
let measurePoll: ReturnType<typeof setInterval> | null = null;

const measureStatusText = computed(() =>
  measureRunning.value
    ? t("settings.pipeline.measureRunning", { done: measureProgress.done, total: measureProgress.total })
    : t("settings.pipeline.measureStatus", { done: measureCounts.measured, total: measureCounts.total }),
);

function stopMeasurePoll(): void {
  if (!measurePoll) return;
  clearInterval(measurePoll);
  measurePoll = null;
}

function startMeasurePoll(): void {
  if (measurePoll) return;
  measurePoll = setInterval(() => { void loadMeasure(); }, 1000);
}

function applyMeasureState(s: any): void {
  if (!s || typeof s !== "object") return;
  measureEnabled.value = s.enabled === true;
  measureRunning.value = s.running === true;
  if (Number.isFinite(s.total)) measureCounts.total = Number(s.total);
  if (Number.isFinite(s.measured)) measureCounts.measured = Number(s.measured);
  if (Number.isFinite(s.pending)) measureCounts.pending = Number(s.pending);
  if (s.progress && typeof s.progress === "object") {
    measureProgress.done = Number(s.progress.done) || 0;
    measureProgress.total = Number(s.progress.total) || 0;
  }
  // 服务端还在跑就保持轮询，跑完自动停（不用用户手动刷新）
  if (measureRunning.value) startMeasurePoll();
  else stopMeasurePoll();
}

async function loadMeasure(): Promise<void> {
  try {
    const res = await api.get("/rest/api/v1/pipeline/measure");
    applyMeasureState(res.data);
  } catch { /* 静默：轮询期间失败不刷屏，面板其余部分已单独报错 */ }
}

async function saveMeasureEnabled(): Promise<void> {
  try {
    const res = await api.put("/rest/api/v1/pipeline/measure", { enabled: measureEnabled.value });
    applyMeasureState(res.data);
    ElMessage.success(t("settings.pipeline.saved"));
  } catch (e: any) {
    measureEnabled.value = !measureEnabled.value; // 失败回拨，别让界面与库里不一致
    ElMessage.error(e.response?.data?.error || t("settings.pipeline.saveFailed"));
  }
}

async function runMeasure(): Promise<void> {
  try {
    const res = await api.post("/rest/api/v1/pipeline/measure/run", {});
    applyMeasureState(res.data);
    if (res.data?.started) ElMessage.success(t("settings.pipeline.measureStarted"));
    else if (res.data?.reason === "busy") ElMessage.warning(t("settings.pipeline.measureBusy"));
    else if (res.data?.reason === "disabled") ElMessage.warning(t("settings.pipeline.measureDisabled"));
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || t("settings.pipeline.saveFailed"));
  }
}

onMounted(() => {
  loadVersion(); loadProxy(); loadBatchPace(); loadMemorySettings(); loadDailyConfig();
  if (authStore.isAdmin) { loadPipeline(); loadMeasure(); }
});
onUnmounted(stopMeasurePoll);
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
// 音色面板（P4-3）
.dsp-desc { font-size: 12px; color: var(--fnos-text-tertiary); margin: 6px 0 4px; line-height: 1.6; }
.dsp-mini { font-size: 12px; color: var(--fnos-text-tertiary); white-space: nowrap; }
.dsp-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsp-eq-block { flex-direction: column; }
.dsp-eq { display: flex; flex-direction: column; gap: 8px; align-items: flex-end; width: 100%; }
.dsp-eq-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.dsp-foot { display: flex; align-items: center; justify-content: flex-end; gap: 12px; padding-top: 14px; }
// 音频管道面板（P5-1 / P5-2）
.pipe-channels { display: flex; align-items: center; gap: 6px 16px; flex-wrap: wrap; justify-content: flex-end; }
.pipe-ch { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--fnos-text-secondary); white-space: nowrap; }
.pipe-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pipe-block { flex-direction: column; }
.pipe-devices { width: 100%; justify-content: flex-end; }

@media (max-width: 768px) {
  .settings-page { padding: 20px 16px; }
  .page-header h2 { font-size: 24px; }
  .setting-item { flex-direction: column; gap: 10px; }
  .proxy-input { width: 100%; }
  .proxy-actions { flex-wrap: wrap; }
  .dsp-eq { align-items: stretch; }
  .dsp-eq-row { justify-content: flex-start; }
  .pipe-channels { justify-content: flex-start; }
}
</style>