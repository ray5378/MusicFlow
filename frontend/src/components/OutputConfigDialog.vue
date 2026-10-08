<template>
  <el-dialog
    :model-value="modelValue"
    :title="title"
    width="460px"
    :append-to-body="true"
    @update:model-value="(v: any) => emit('update:modelValue', !!v)"
    @open="load"
  >
    <div v-loading="loading" class="oc-body">
      <p v-if="isGroup" class="oc-tip">{{ t("settings.bits.groupTip") }}</p>

      <div class="oc-row">
        <div class="oc-label">
          <div class="oc-title">{{ t("settings.rate.title") }}</div>
        </div>
        <el-select v-model="rate" style="width: 200px" :disabled="saving || peerIds.length === 0">
          <el-option :label="t('settings.rate.auto', { rate: autoRate })" value="auto" />
          <el-option v-for="r in options" :key="r" :label="`${r} Hz`" :value="r" />
        </el-select>
      </div>
      <div class="oc-row">
        <div class="oc-label">
          <div class="oc-title">{{ t("settings.bits.title") }}</div>
        </div>
        <el-select v-model="bits" style="width: 200px" :disabled="saving || peerIds.length === 0">
          <el-option :label="t('settings.bits.auto')" value="auto" />
          <el-option v-for="b in bitsOptions" :key="b" :label="`${b} bit`" :value="b" />
        </el-select>
      </div>

      <div class="oc-desc">{{ t("settings.rate.desc") }}</div>
      <div class="oc-desc">{{ t("settings.bits.desc") }}</div>

      <div class="oc-effective">
        <span class="oc-effective-label">{{ t("settings.bits.state") }}</span>
        <span class="oc-effective-value">
          {{ effectiveRate }} Hz
          <span class="oc-dot">·</span>
          {{ effectiveBits === null ? t("settings.bits.autoState") : `${effectiveBits} bit` }}
        </span>
      </div>
    </div>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">{{ t("common.cancel") }}</el-button>
      <el-button type="primary" :loading="saving" :disabled="peerIds.length === 0" @click="save">
        {{ t("groups.outputSave") }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
// ==================== 音频输出配置弹窗（batch49）====================
// 「播放器」页的统一入口：采样率 + 位深**同一个弹窗**、都手动配。
// 与「音频」页「音色」卡片里的采样率下拉同源（同一后端表 / 同一套路由）。
//
// 语义（与 services/playerRate.ts 严格对齐）：
//   - 采样率三来源：**手动 > 设备 hello 自动宣告 > 缺省 48000**；
//   - 位深：手动 16/24，**自动 = 跟随源位深**（16 源出 16 / 24 源出 24）；
//   - 群组：采样率/位深都取**成员最低**（组内必须同格式）；
//   - 只有 `dlna:` / `sendspin:` 参与（AirPlay 锁 44100/16bit、本机客户端不参与）。
//
// **群组 = 整组一键设置**（用户拍板）：保存时把这一组值写给组内**每一台**设备，
// 组内必然同格式，不会出现「组设置看着改了、实际被成员的低档压住」的心智错位。
// 具体实现 = 把 `peerIds`（设备行 1 个、群组卡片 N 个）逐个 PUT 一遍。
//
// 配置一次拿全（`GET /v1/player-prefs/rate` 返回 options/defaultRate/bitsOptions/
// 已有配置），N 台设备**只发一个请求**。写失败不吞：气泡报错 + 弹窗不关。
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { ElMessage } from "element-plus";
import api from "@/api";
import { apiErrorText } from "@/utils/apiError";

interface RateCfg {
  manualRate: number | null;
  probedRate: number | null;
  manualBits: number | null;
}
const EMPTY_CFG: RateCfg = { manualRate: null, probedRate: null, manualBits: null };

const props = defineProps<{
  modelValue: boolean;
  /** 目标 peerId 列表：设备行传 1 个；群组卡片传全组成员。 */
  peerIds: string[];
  title: string;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", v: boolean): void;
  (e: "saved"): void;
}>();

const { t } = useI18n();
const loading = ref(false);
const saving = ref(false);
const options = ref<number[]>([48000, 88200, 96000, 176400, 192000]);
const bitsOptions = ref<number[]>([16, 24]);
const defaultRate = ref(48000);
const configs = ref<Record<string, RateCfg>>({});
const rate = ref<string | number>("auto");
const bits = ref<string | number>("auto");

/** 群组（多设备）= 走「整组一键设置」的提示与语义。 */
const isGroup = computed(() => props.peerIds.length > 1);

function cfgOf(peerId: string): RateCfg {
  return configs.value?.[peerId] ?? EMPTY_CFG;
}

/** 组/设备内采样率手动档一致才回显该档；不一致或都没设 → 「自动」。 */
const uniformManualRate = computed<number | null>(() => {
  let v: number | null = null;
  for (const pid of props.peerIds) {
    const m = cfgOf(pid).manualRate;
    if (m === null) return null;
    if (v === null) v = m;
    else if (v !== m) return null;
  }
  return v;
});
const uniformManualBits = computed<number | null>(() => {
  let v: number | null = null;
  for (const pid of props.peerIds) {
    const m = cfgOf(pid).manualBits;
    if (m === null) return null;
    if (v === null) v = m;
    else if (v !== m) return null;
  }
  return v;
});

/** 「自动」档实际会落到多少 Hz（设备 = 上报/缺省；组 = 成员取最低）。 */
const autoRate = computed(() => {
  let min = 0;
  for (const pid of props.peerIds) {
    const r = cfgOf(pid).probedRate ?? defaultRate.value;
    if (min === 0 || r < min) min = r;
  }
  return min || defaultRate.value;
});

/** 当前**真正生效**的采样率（手动优先，组取最低）——与后端裁决同口径。 */
const effectiveRate = computed(() => {
  let min = 0;
  for (const pid of props.peerIds) {
    const c = cfgOf(pid);
    const r = c.manualRate ?? c.probedRate ?? defaultRate.value;
    if (min === 0 || r < min) min = r;
  }
  return min || defaultRate.value;
});

/** 当前真正生效的位深；null = 自动（跟随源位深）。组取成员最低、跳过自动档。 */
const effectiveBits = computed<number | null>(() => {
  let min = 0;
  for (const pid of props.peerIds) {
    const b = cfgOf(pid).manualBits;
    if (b !== null && (min === 0 || b < min)) min = b;
  }
  return min || null;
});

async function load(): Promise<void> {
  if (props.peerIds.length === 0) return;
  loading.value = true;
  try {
    const res = await api.get("/rest/api/v1/player-prefs/rate");
    if (Array.isArray(res.data?.options) && res.data.options.length > 0) options.value = res.data.options;
    if (Array.isArray(res.data?.bitsOptions) && res.data.bitsOptions.length > 0) bitsOptions.value = res.data.bitsOptions;
    if (Number(res.data?.defaultRate) > 0) defaultRate.value = Number(res.data.defaultRate);
    configs.value = res.data?.configs && typeof res.data.configs === "object" ? res.data.configs : {};
    rate.value = uniformManualRate.value ?? "auto";
    bits.value = uniformManualBits.value ?? "auto";
  } catch (e: any) {
    ElMessage.error(apiErrorText(e, t("settings.rate.saveFailed")));
  } finally {
    loading.value = false;
  }
}

async function save(): Promise<void> {
  saving.value = true;
  try {
    const body = {
      rate: rate.value === "auto" ? null : Number(rate.value),
      bits: bits.value === "auto" ? null : Number(bits.value),
    };
    // 群组 = 写在每一台上（整组一键设置）。
    await Promise.all(
      props.peerIds.map((pid) =>
        api.put(`/rest/api/v1/player-prefs/rate/${encodeURIComponent(pid)}`, body),
      ),
    );
    ElMessage.success(t("settings.rate.saved"));
    emit("saved");
    emit("update:modelValue", false);
  } catch (e: any) {
    ElMessage.error(apiErrorText(e, t("settings.rate.saveFailed")));
  } finally {
    saving.value = false;
  }
}
</script>

<style lang="scss" scoped>
.oc-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.oc-tip {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--fnos-text-tertiary);
  background: rgba(255, 255, 255, 0.04);
  border-left: 3px solid var(--fnos-orange);
  border-radius: 6px;
  padding: 8px 12px;
}
.oc-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.oc-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--fnos-text-primary);
}
.oc-desc {
  font-size: 12px;
  line-height: 1.6;
  color: var(--fnos-text-tertiary);
}
.oc-effective {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  padding-top: 4px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}
.oc-effective-label {
  color: var(--fnos-text-tertiary);
}
.oc-effective-value {
  color: var(--fnos-orange);
  font-weight: 500;
}
.oc-dot {
  margin: 0 4px;
  color: var(--fnos-text-tertiary);
}
</style>
