<template>
  <!-- 通用扫码弹窗(T05 R24):由插件配置页 type:"action" 字段触发。
       零 QR/编码逻辑:后端归一化出 imageDataUrl 后这里 <img> 直显;
       守卫 backend/scripts/check-frontend-no-qr.mjs 强制前端无任何编码代码。 -->
  <el-dialog
    :model-value="modelValue"
    :title="title || t('admin.plugins.qrLoginTitle')"
    width="380px"
    :append-to-body="true"
    @update:model-value="(v: any) => onVisibleChange(!!v)"
  >
    <div v-loading="loading" class="qr-body">
      <template v-if="payload">
        <img v-if="payload.imageDataUrl" :src="payload.imageDataUrl" class="qr-img" alt="QR" />
        <!-- imageDataUrl:null 且 kind==="url" → 降级为可点击链接 + 文本 -->
        <div v-else-if="payload.kind === 'url'" class="qr-fallback">
          <a :href="String(payload.value)" target="_blank" rel="noopener noreferrer">
            {{ t('admin.plugins.qrOpenLink') }}
          </a>
          <div class="qr-link-text">{{ payload.value }}</div>
        </div>
        <!-- kind==="text"(或未知 kind)→ 纯文本展示 -->
        <div v-else class="qr-fallback">
          <div class="qr-link-text">{{ payload.value }}</div>
        </div>

        <!-- 802 过期 → 提示 + 刷新按钮(重新 startBind 拉新码) -->
        <div v-if="expired" class="qr-expired">
          <span>{{ t('admin.plugins.qrExpired') }}</span>
          <el-button type="primary" size="small" :loading="loading" @click="start">
            {{ t('admin.plugins.qrRefresh') }}
          </el-button>
        </div>
        <div v-else-if="!success" class="qr-waiting">{{ t('admin.plugins.qrWaiting') }}</div>
      </template>
    </div>
    <template #footer>
      <el-button @click="onVisibleChange(false)">{{ t("common.cancel") }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
// 行为契约(R24-AC):
//   - 打开 → POST /v1/plugins/:id/action { method }(method = 字段 action 指定的
//     插件方法,如 startBind)→ payload 直显;
//   - 按 **响应下发的 pollIntervalMs** 轮询 pollBind(不写死间隔,QQ 必须 <15s 由
//     插件下发;缺省兜底 2s);801 待扫继续 / 802 过期 → 停轮询显示刷新 / 800 成功
//     → Toast + emit success + 关弹窗;
//   - 关闭弹窗(R24-AC④)→ 立即停轮询 + 发 cancelBind 清理会话(成功关闭同样清理);
//   - 轮询单次失败容忍(网络抖动),不中断循环。
import { ref, watch, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import { ElMessage } from "element-plus";
import api, { formatApiError } from "@/api";

const props = defineProps<{
  modelValue: boolean;
  /** 插件 id(manifest.id) */
  pluginId: string;
  /** 触发的 action 方法名(字段 f.action,如 startBind) */
  method: string;
  /** 弹窗标题(字段 label,manifest/i18n 驱动);缺省用通用文案 */
  title?: string;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", v: boolean): void;
  /** 800 登录成功(父层刷新账号卡/列表) */
  (e: "success"): void;
}>();

const { t } = useI18n();
const loading = ref(false);
const payload = ref<any>(null);
const expired = ref(false);
const success = ref(false);

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollIntervalMs = 2000; // 插件未下发时的兜底;正常路径以响应 pollIntervalMs 为准
let sessionKey: string | null = null;
let cancelled = false;

function stopPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/** 调 action 端点(统一入口:method + params,错误统一弹 formatApiError)。 */
async function callAction(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const res = await api.post(`/rest/api/v1/plugins/${props.pluginId}/action`, { method, params });
  return res?.data ?? {};
}

/** 发码(打开/刷新):重新拿二维码 payload 并启动轮询。 */
async function start(): Promise<void> {
  stopPolling();
  loading.value = true;
  expired.value = false;
  success.value = false;
  payload.value = null;
  sessionKey = null;
  try {
    const data = await callAction(props.method);
    payload.value = data;
    sessionKey = typeof data?.sessionKey === "string" && data.sessionKey ? data.sessionKey : null;
    if (typeof data?.pollIntervalMs === "number" && data.pollIntervalMs > 0) pollIntervalMs = data.pollIntervalMs;
    pollTimer = setInterval(() => void poll(), pollIntervalMs);
  } catch (e) {
    ElMessage.error(formatApiError(e, t("admin.plugins.qrFailed")));
  } finally {
    loading.value = false;
  }
}

/** 轮询登录状态:801 待扫(继续)/ 802 过期(停轮询+刷新按钮)/ 800 成功(收尾)。 */
async function poll(): Promise<void> {
  if (!sessionKey || success.value || expired.value) return;
  let result: any = null;
  try {
    const data = await callAction("pollBind", { sessionKey });
    result = data?.result ?? {};
  } catch {
    return; // 单次轮询失败容忍,下个周期再试
  }
  const code = result?.code;
  if (code === 800) {
    success.value = true;
    stopPolling();
    ElMessage.success(t("admin.plugins.qrSuccess"));
    emit("success");
    onVisibleChange(false); // 关弹窗 → cancelBind 清理会话
  } else if (code === 802) {
    expired.value = true;
    stopPolling();
  }
  // 801(待扫)与其余中间态:继续轮询
}

/** 清理会话(发 cancelBind,幂等,只发一次)。 */
async function cancel(): Promise<void> {
  if (!sessionKey || cancelled) return;
  cancelled = true;
  try {
    await callAction("cancelBind", { sessionKey });
  } catch {
    // 清理失败静默:会话由插件 ttlSec 自行过期
  }
}

function onVisibleChange(v: boolean): void {
  if (!v) {
    stopPolling();
    void cancel(); // R24-AC④:关闭弹窗立即 cancelBind
  }
  emit("update:modelValue", v);
}

watch(
  () => props.modelValue,
  (v) => {
    if (v) {
      cancelled = false;
      void start();
    } else {
      stopPolling();
      void cancel();
    }
  },
);

onUnmounted(() => {
  stopPolling();
  void cancel();
});
</script>

<style scoped>
.qr-body { display: flex; flex-direction: column; align-items: center; gap: 12px; min-height: 200px; justify-content: center; }
.qr-img { width: 240px; height: 240px; object-fit: contain; }
.qr-waiting { color: var(--el-text-color-secondary, #909399); font-size: 13px; }
.qr-expired { display: flex; flex-direction: column; align-items: center; gap: 8px; color: var(--el-color-warning, #e6a23c); font-size: 13px; }
.qr-fallback { display: flex; flex-direction: column; align-items: center; gap: 8px; max-width: 100%; }
.qr-link-text { word-break: break-all; color: var(--el-text-color-secondary, #909399); font-size: 12px; max-width: 300px; }
</style>
