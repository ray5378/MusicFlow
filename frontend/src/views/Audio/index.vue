<template>
  <div class="audio-page">
    <div class="page-header"><h2>{{ t('layout.audio') }}</h2></div>

    <!-- ===== 音量归一化（② 段）=====
         服务端**全局**播放行为（所有账号、所有设备一致），故仅管理员可见。
         目标响度区间 [-30, -5] LUFS、缺省 -14，对齐 MA 的 `CONF_ENTRY_VOLUME_NORMALIZATION_TARGET`
         （`constants.py:459-468`，range=(-30,-5) / default=-14）；键名 `loudness.normalization`
         + `loudness.targetLufs` 落在服务端 settings 表。 -->
    <el-card v-if="authStore.isAdmin">
      <h3>{{ t('settings.normalization.title') }}</h3>
      <div class="card-desc">{{ t('settings.normalization.desc') }}</div>

      <div class="setting-item">
        <div class="setting-label">
          <div class="title">{{ t('settings.normalization.enable') }}</div>
          <div class="desc">{{ t('settings.normalization.enableDesc') }}</div>
        </div>
        <div class="setting-value">
          <el-switch v-model="normalization.enabled" @change="saveAudio" />
        </div>
      </div>

      <div class="setting-item">
        <div class="setting-label">
          <div class="title">{{ t('settings.normalization.target') }}</div>
          <div class="desc">{{ t('settings.normalization.targetDesc') }}</div>
        </div>
        <div class="setting-value lufs-row">
          <el-slider
            v-model="normalization.targetLufs"
            :min="TARGET_LUFS_MIN"
            :max="TARGET_LUFS_MAX"
            :step="1"
            show-stops
            :disabled="!normalization.enabled"
            style="width: 240px"
            @change="saveAudio"
          />
          <span class="lufs-value">{{ normalization.targetLufs }} LUFS</span>
        </div>
      </div>
    </el-card>

    <!-- ===== 音频管道（P5-1 开关 + P5-2 DLNA 单独回退 + P5-3 离线测量）=====
         与「音色」不同：这是**服务端全局**播放行为（所有账号、所有设备一致），故仅管理员可见。
         语义照 D9：关掉任一开关只等于「该链路滤镜链为空」，播放仍走管道 —— 不恢复「原样直出」。 -->
    <el-card v-if="authStore.isAdmin" class="mt-card">
      <h3>{{ t('settings.pipeline.title') }}</h3>
      <div class="card-desc">{{ t('settings.pipeline.desc') }}</div>

      <div class="setting-item">
        <div class="setting-label">
          <div class="title">{{ t('settings.pipeline.master') }}</div>
          <div class="desc">{{ t('settings.pipeline.masterDesc') }}</div>
        </div>
        <div class="setting-value"><el-switch v-model="pipelineSwitches.enabled" @change="saveAudio" /></div>
      </div>

      <div class="setting-item">
        <div class="setting-label"><div class="title">{{ t('settings.pipeline.channels') }}</div></div>
        <div class="setting-value pipe-channels">
          <label v-for="ch in PIPELINE_CHANNEL_KEYS" :key="ch" class="pipe-ch">
            <el-switch v-model="pipelineSwitches.channels[ch]" size="small" :disabled="!pipelineSwitches.enabled" @change="saveAudio" />
            <span>{{ t(`settings.pipeline.channel${PIPELINE_CHANNEL_LABEL[ch]}`) }}</span>
          </label>
        </div>
      </div>

      <div class="setting-item">
        <div class="setting-label">
          <div class="title">{{ t('settings.pipeline.flow') }}</div>
          <div class="desc">{{ t('settings.pipeline.flowDesc') }}</div>
        </div>
        <div class="setting-value"><el-switch v-model="flowForm.enabled" :disabled="!pipelineSwitches.enabled" @change="saveAudio" /></div>
      </div>

      <div class="setting-item">
        <div class="setting-label"><div class="title">{{ t('settings.pipeline.crossfade') }}</div></div>
        <div class="setting-value pipe-row">
          <span class="dsp-mini">{{ t('settings.pipeline.mode') }}</span>
          <el-select v-model="flowForm.mode" size="small" style="width: 170px" :disabled="!pipelineSwitches.enabled" @change="saveAudio">
            <el-option :label="t('settings.pipeline.modeDisabled')" value="disabled" />
            <el-option :label="t('settings.pipeline.modeStandard')" value="standard" />
          </el-select>
          <span class="dsp-mini">{{ t('settings.pipeline.duration') }}</span>
          <!-- 区间 1…15 秒（缺省 8）对齐 MA `CONF_ENTRY_CROSSFADE_DURATION` 的 range=(1,15)；
               服务端落库前同样夹一遍，两端口径必须一致。 -->
          <el-input-number v-model="flowForm.durationSec" :min="FADE_MIN_SEC" :max="FADE_MAX_SEC" :step="1" size="small" controls-position="right" style="width: 110px" :disabled="!pipelineSwitches.enabled || flowForm.mode !== 'standard'" @change="saveAudio" />
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

    <!-- ===== 音色（每台设备，P4-3）=====
         与「响度归一化」职责不同：② 段管「每首歌一样响」，这里管「按口味调音色」。
         音色是设备属性（书架箱/耳机各自的补偿曲线），故按 peerId 存、不跟账号走。
         全部留 0 = 不做任何处理（服务端零滤镜、零开销）。 -->
    <el-card class="mt-card">
      <h3>{{ t('settings.dsp.title') }}</h3>
      <div class="card-desc">{{ t('settings.dsp.desc') }}</div>
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
              <el-input-number v-model="b.q" :min="0.1" :max="20" :step="0.1" :precision="1" :disabled="!!b.slope" size="small" controls-position="right" style="width: 100px" />
              <!-- 陡度：只对高/低通有用。选「用 Q 值」(0) = 单节、由左边的 q 定；
                   选 12/24/48 = 按 MA 的级联 Butterworth 展开（order = slope/6 节，此时 q 被忽略）。 -->
              <el-select v-if="isPassBand(b.type)" v-model="b.slope" size="small" style="width: 118px">
                <el-option :label="t('settings.dsp.slopeQ')" :value="0" />
                <el-option v-for="s in PASS_SLOPE_OPTIONS" :key="s" :label="s + ' dB/oct'" :value="s" />
              </el-select>
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
  </div>
</template>

<script setup lang="ts">
// 独立的「音频」页（从「系统设置」整体搬迁而来，见 docs/audio-pipeline-progress.md §8）。
// 三块内容，各自的服务端真相源不同，别混：
//   ① 音量归一化（② 段）—— 服务端全局设置 `loudness.*`，admin；
//   ② 音频管道（滤镜链开关 / 交叉淡入 / DLNA 回退 / 离线测量）—— 服务端全局设置 `pipeline.*`
//      / `crossfade.*`，admin；
//   ③ 设备音色（③ 段 DSP）—— **按设备** 存，非 admin 也能配，服务端再收一层 `canControlPeer`。
// i18n 键沿用搬迁前的 `settings.*` 前缀（键名就是历史契约，改名等于把两份语言文件一起重排，
// 与"搬迁"这件事无关）；本页自己的标题用 `layout.audio`。
import { ref, reactive, computed, onMounted, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import { ElMessage } from "element-plus";
import api from "@/api";
import { useAuthStore } from "@/stores/auth";
import { usePlayerStore } from "@/stores/player";
import { apiErrorText } from "@/utils/apiError";

const { t } = useI18n();
const authStore = useAuthStore();
const playerStore = usePlayerStore();

/** 目标响度区间（与后端 `normalization.ts` 的常量、MA 的 ConfigEntry range 三者一致）。 */
const TARGET_LUFS_MIN = -30;
const TARGET_LUFS_MAX = -5;
/** 交叉淡入时长区间（与后端 `fades.ts` 的 FADE_MIN/MAX_SEC、MA range=(1,15) 三者一致）。 */
const FADE_MIN_SEC = 1;
const FADE_MAX_SEC = 15;

// ---------- ① 音量归一化（② 段）----------
// 服务端全局；开关与目标响度走同一个 PUT（与管道开关合并成一次提交，见 commitAudio）。
const normalization = reactive<{ enabled: boolean; targetLufs: number }>({
  enabled: true,
  targetLufs: -14,
});

// ---------- ② 音频管道开关 + 交叉淡入 + DLNA 单设备回退 ----------
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
let audioTimer: ReturnType<typeof setTimeout> | null = null;

const PIPELINE_CHANNEL_KEYS = ["http", "dlna", "sendspin", "airplay"] as const;
// i18n 后缀 → 键名 `settings.pipeline.channel${suffix}`（首字母大写，与既有键命名一致）。
const PIPELINE_CHANNEL_LABEL: Record<string, string> = {
  http: "Http",
  dlna: "Dlna",
  sendspin: "Sendspin",
  airplay: "Airplay",
};

/** 用服务端返回值回写面板。`devices` 缺席时保持原样（PUT 响应不返回设备表）。 */
function applyAudioSettings(res: any): void {
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
    // 服务端已夹到 [1, 15]，这里只兜「没给值」的情况。
    flowForm.durationSec = Number.isFinite(dur) && dur > 0 ? dur : 8;
  }
  const nm = res?.normalization;
  if (nm) {
    normalization.enabled = nm.enabled !== false;
    const tl = Number(nm.targetLufs);
    normalization.targetLufs = Number.isFinite(tl) ? tl : -14;
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

async function loadAudio(): Promise<void> {
  try {
    const res = await api.get("/rest/api/v1/pipeline/switches");
    applyAudioSettings(res.data);
  } catch (e: any) {
    ElMessage.error(apiErrorText(e, t("settings.pipeline.loadFailed")));
  }
}

function saveAudio(): void {
  if (audioTimer) clearTimeout(audioTimer);
  audioTimer = setTimeout(() => { void commitAudio(); }, 250);
}

async function commitAudio(): Promise<void> {
  audioTimer = null;
  try {
    const res = await api.put("/rest/api/v1/pipeline/switches", {
      switches: { enabled: pipelineSwitches.enabled, channels: { ...pipelineSwitches.channels } },
      flow: { enabled: flowForm.enabled, mode: flowForm.mode, durationSec: flowForm.durationSec },
      normalization: { enabled: normalization.enabled, targetLufs: normalization.targetLufs },
    });
    applyAudioSettings(res.data);
    ElMessage.success(t("settings.pipeline.saved"));
  } catch (e: any) {
    ElMessage.error(apiErrorText(e, t("settings.pipeline.saveFailed")));
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
    ElMessage.error(apiErrorText(e, t("settings.pipeline.saveFailed")));
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
    ElMessage.error(apiErrorText(e, t("settings.pipeline.saveFailed")));
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
    ElMessage.error(apiErrorText(e, t("settings.pipeline.saveFailed")));
  }
}

// ---------- ③ 音色：per-player DSP（P4-3）----------
// 服务端按 peerId 存（音色是设备属性，不跟账号走），出流时插在响度之后、限制器之前。
// 这里只做「读—改—写」：**归一化的真相在服务端**（normalizeDspConfig），
// 所以保存后一律用响应里的 config 回写表单 —— 用户看到的就是真正生效的值。
const dspPeerId = ref("");
const dspSaving = ref(false);
const dspForm = reactive({
  preampDb: 0,
  bassDb: 0,
  midDb: 0,
  trebleDb: 0,
  balance: 0,
  gainDb: 0,
  // slope 仅高/低通用（0 = 用 Q 值单节；12/24/48 = MA 级联 Butterworth 的 dB/oct 陡度）。
  bands: [] as Array<{ type: string; frequency: number; gainDb: number; q: number; slope: number; channel: string }>,
});

const DSP_EQ_TYPES = [
  { value: "peak", label: "Peak" },
  { value: "low_shelf", label: "LowShelf" },
  { value: "high_shelf", label: "HighShelf" },
  { value: "high_pass", label: "HighPass" },
  { value: "low_pass", label: "LowPass" },
  { value: "notch", label: "Notch" },
];

/** 高/低通的陡度档（dB/oct，与后端 `PASS_SLOPES` / MA `HighLowPassSlope` 一致）。 */
const PASS_SLOPE_OPTIONS = [12, 24, 48];

/** 陡度只对高/低通有意义（其余类型的 band 不给这个下拉）。 */
function isPassBand(type: string): boolean {
  return type === "high_pass" || type === "low_pass";
}

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
    slope: Number(b?.slope) || 0,
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
    ElMessage.error(apiErrorText(e, t("settings.dsp.loadFailed")));
  }
}

function addDspBand(): void {
  dspForm.bands.push({ type: "peak", frequency: 1000, gainDb: 0, q: 1, slope: 0, channel: "all" });
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
        // 陡度只在选了档位时发（0 = 用 Q 值单节，服务端按"无 slope"处理）。
        ...(b.slope ? { slope: b.slope } : {}),
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
    ElMessage.error(apiErrorText(e, t("settings.dsp.saveFailed")));
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
    ElMessage.error(apiErrorText(e, t("settings.dsp.saveFailed")));
  } finally {
    dspSaving.value = false;
  }
}

onMounted(() => {
  // 两个 admin 区块（归一化 / 管道）共用一个 GET；非管理员只看到「设备音色」。
  if (authStore.isAdmin) { loadAudio(); loadMeasure(); }
});
onUnmounted(stopMeasurePoll);
</script>

<style lang="scss" scoped>
.audio-page { padding: 24px 32px 130px; max-width: 900px; margin: 0 auto; }
.page-header { margin-bottom: 24px; h2 { font-size: 28px; font-weight: 700; margin: 0; } }
.mt-card { margin-top: 18px; }
:deep(.el-card) { background: rgba(255,255,255,0.04) !important; border: 1px solid rgba(255,255,255,0.08) !important; border-radius: var(--fnos-radius-lg) !important; }
h3 { font-size: 15px; font-weight: 600; margin: 0 0 2px; color: var(--fnos-text-primary); }
.setting-item { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; padding: 14px 0; border-bottom: 1px solid rgba(255,255,255,0.06);
  &:last-child { border-bottom: none; }
  .setting-label { .title { font-weight: 600; color: var(--fnos-text-primary); } .desc { font-size: 12px; color: var(--fnos-text-tertiary); margin-top: 4px; } }
  .setting-value { flex-shrink: 0; }
}
// 响度归一化（② 段）
.lufs-row { display: flex; align-items: center; gap: 12px; }
.lufs-value { font-size: 13px; color: var(--fnos-text-secondary); font-variant-numeric: tabular-nums; min-width: 78px; text-align: right; }
// 音色面板（P4-3）
.card-desc { font-size: 12px; color: var(--fnos-text-tertiary); margin: 6px 0 4px; line-height: 1.6; }
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
  .audio-page { padding: 20px 16px; }
  .page-header h2 { font-size: 24px; }
  .setting-item { flex-direction: column; gap: 10px; }
  .dsp-eq { align-items: stretch; }
  .dsp-eq-row { justify-content: flex-start; }
  .pipe-channels { justify-content: flex-start; }
  .lufs-row { width: 100%; justify-content: flex-start; }
}
</style>
