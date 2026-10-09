<template>
  <!-- 通用扫码弹窗(T05 R24):由插件配置页 type:"action" 字段触发。
       零 QR/编码逻辑:后端归一化出 imageDataUrl 后这里 <img> 直显;
       守卫 backend/scripts/check-frontend-no-qr.mjs 强制前端无任何编码代码。
       v4.3.2:① params prop(manifest action 字段 args)随 start/poll/cancel 全程
       透传——两平台独立绑定入口靠它区分,后端原样转发;② 绑定状态回显行(插件
       startBind 下发 boundAccount/authValid,检测不阻塞出码);③ 800 成功显示
       登录账号昵称约 2s 再自动关弹窗。 -->
  <el-dialog
    :model-value="modelValue"
    :title="title || t('admin.plugins.qrLoginTitle')"
    width="380px"
    :append-to-body="true"
    @update:model-value="(v: any) => onVisibleChange(!!v)"
  >
    <!-- 平台下拉(多平台插件):切换即取消当前会话并按新平台重新出码;选项由
         status 结果 platforms 下发(插件中文名 label),核心不写死任何平台。 -->
    <div v-if="platformOptions.length > 1" class="qr-platform-row">
      <el-select v-model="selectedPlatform" size="small" style="width: 220px" @change="onPlatformChange">
        <el-option v-for="o in platformOptions" :key="o.value" :label="o.label" :value="o.value" />
      </el-select>
    </div>
    <div v-loading="loading" class="qr-body">
      <!-- 绑定状态回显:打开弹窗时插件对存量凭据做了轻量探测(不阻塞出码)。
           authValid=false 明确提示重新绑定;true 提示当前凭据仍有效。 -->
      <div v-if="boundAccount" class="qr-status" :class="{ 'qr-status-invalid': authValid === false }">
        {{ t('admin.plugins.qrBoundAccount', { name: boundAccount.nickname || '-' }) }}
        <!-- authValid=null(探测网络失败,不给判定)→ 只显示账号名不显示有效性 -->
        <template v-if="authValid !== null">· {{ authValid === false ? t('admin.plugins.qrAuthInvalid') : t('admin.plugins.qrAuthValid') }}</template>
      </div>
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
        <div v-if="success" class="qr-success-view">
          <span class="qr-success-text">{{ successText }}</span>
        </div>
        <div v-else-if="expired" class="qr-expired">
          <span>{{ t('admin.plugins.qrExpired') }}</span>
          <el-button type="primary" size="small" :loading="loading" @click="start">
            {{ t('admin.plugins.qrRefresh') }}
          </el-button>
        </div>
        <div v-else class="qr-waiting">{{ t('admin.plugins.qrWaiting') }}</div>
        <!-- pollBind 上报的错误(如上游风控文案):直显插件本地化消息,不打断轮询 -->
        <div v-if="pollErrorMsg && !success && !expired" class="qr-poll-error">{{ pollErrorMsg }}</div>
      </template>
    </div>
    <template #footer>
      <el-button @click="onVisibleChange(false)">{{ t("common.cancel") }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
// 行为契约(R24-AC, v4.3.2 增补):
//   - 打开 → POST /v1/plugins/:id/action { method, params }(method = 字段 action
//     指定的插件方法;params = 字段 args + 会话键,如 {platform:"qq"} —— 分平台
//     绑定入口的区分参数,后端原样透传给插件方法)→ payload 直显;
//   - 按 **响应下发的 pollIntervalMs** 轮询 pollBind(不写死间隔,QQ 必须 <15s 由
//     插件下发;缺省兜底 2s);801 待扫继续 / 802 过期 → 停轮询显示刷新 / 800 成功
//     → Toast(含昵称) + emit success + 停留 ~2s 展示登录账号后自动关弹窗;
//   - 关闭弹窗(R24-AC④)→ 立即停轮询 + 发 cancelBind 清理会话(成功关闭同样清理);
//   - 轮询单次失败容忍(网络抖动),不中断循环;插件上报 state:"error" 时直显其
//     message(风控文案等)但继续轮询;并发 poll 迟到响应(成功后清理会话的 802)
//     不覆盖成功态(v4.3.2 真机修复);
//   - 绑定状态行:payload.boundAccount(昵称/头像)+ payload.authValid(true 有效 /
//     false 失效)由插件探测下发,前端只直显,不做任何判断逻辑。
import { ref, computed, watch, onUnmounted } from "vue";
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
  /** 附加参数(manifest action 字段 args,如 {platform:"netease"}):
   *  与 sessionKey 合并后随 start/poll/cancel 全程透传给插件方法。 */
  params?: Record<string, unknown> | null;
  /** 平台选项(多平台插件):由配置页 status 结果 platforms 下发({value,label});
   *  >1 项时弹窗顶部渲染下拉,切换即按新平台重新出码。 */
  platforms?: Array<{ value: string; label: string }> | null;
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
const successText = ref("");
/** 最近一次 pollBind 上报的 error message(轮询持续,不中断;成功/过期即清)。 */
const pollErrorMsg = ref("");

/** 绑定状态回显(插件 startBind 下发;未下发/未绑定为 null → 不渲染状态行)。 */
const boundAccount = computed<any>(() => {
  const v = payload.value?.boundAccount;
  return v && typeof v === "object" ? v : null;
});
const authValid = computed<boolean | null>(() => {
  const v = payload.value?.authValid;
  return typeof v === "boolean" ? v : null;
});

/** 平台下拉:选项由父层传(status 结果下发);当前值缺省取 params.platform。 */
const platformOptions = computed(() => (props.platforms || []).filter((o) => o && o.value && o.label));
const selectedPlatform = ref<string>("");

let pollTimer: ReturnType<typeof setInterval> | null = null;
let successTimer: ReturnType<typeof setTimeout> | null = null;
let pollIntervalMs = 2000; // 插件未下发时的兜底;正常路径以响应 pollIntervalMs 为准
let sessionKey: string | null = null;
let cancelled = false;

/** 合并附加参数(args)与本调用键:args 在前、调用键在后(后者不可被覆盖)。 */
function actionParams(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(props.params || {}), ...extra };
  if (selectedPlatform.value) merged.platform = selectedPlatform.value;
  return merged;
}

function stopPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function stopSuccessTimer(): void {
  if (successTimer !== null) {
    clearTimeout(successTimer);
    successTimer = null;
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
  stopSuccessTimer();
  loading.value = true;
  expired.value = false;
  success.value = false;
  successText.value = "";
  pollErrorMsg.value = "";
  payload.value = null;
  sessionKey = null;
  try {
    const data = await callAction(props.method, actionParams());
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
    const data = await callAction("pollBind", actionParams({ sessionKey }));
    result = data?.result ?? {};
  } catch {
    return; // 单次轮询失败容忍,下个周期再试
  }
  // 竞态守卫:轮询间隔短于上游响应时多个 poll 并发在途;成功路径会删除会话,
  // 迟到的并发 poll 拿到 802「会话不存在」,若不拦会把已显示的成功态覆盖成
  // 过期态(真机实测:酷狗凭据已落库但弹窗无成功反应)。
  if (success.value || expired.value || sessionKey === null) return;
  if (result?.state === "error") pollErrorMsg.value = String(result?.message || "");
  const code = result?.code;
  if (code === 800) {
    success.value = true;
    const nickname = result?.account?.nickname;
    successText.value = nickname
      ? t("admin.plugins.qrSuccessAs", { name: String(nickname) })
      : t("admin.plugins.qrSuccess");
    stopPolling();
    ElMessage.success(successText.value);
    emit("success");
    // 展示登录账号 ~2s 后自动关弹窗(关弹窗仍会 cancelBind 清理会话)。
    stopSuccessTimer();
    successTimer = setTimeout(() => {
      successTimer = null;
      onVisibleChange(false);
    }, 2000);
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
    await callAction("cancelBind", actionParams({ sessionKey }));
  } catch {
    // 清理失败静默:会话由插件 ttlSec 自行过期
  }
}

/** 下拉切平台:取消旧会话 → 按新平台重新出码(cancel 后重置 cancelled,
 *  保证弹窗关闭时新会话仍能被正确清理)。 */
async function onPlatformChange(): Promise<void> {
  if (!props.modelValue) return;
  await cancel();
  cancelled = false;
  await start();
}

function onVisibleChange(v: boolean): void {
  if (!v) {
    stopPolling();
    stopSuccessTimer();
    void cancel(); // R24-AC④:关闭弹窗立即 cancelBind
  }
  emit("update:modelValue", v);
}

watch(
  () => props.modelValue,
  (v) => {
    if (v) {
      cancelled = false;
      selectedPlatform.value = String(props.params?.platform || platformOptions.value[0]?.value || "");
      void start();
    } else {
      stopPolling();
      stopSuccessTimer();
      void cancel();
    }
  },
);

onUnmounted(() => {
  stopPolling();
  stopSuccessTimer();
  void cancel();
});
</script>

<style scoped>
.qr-body { display: flex; flex-direction: column; align-items: center; gap: 12px; min-height: 200px; justify-content: center; }
.qr-poll-error { color: var(--el-color-danger); font-size: 12px; line-height: 1.5; text-align: center; white-space: pre-wrap; word-break: break-all; margin-top: -4px; }
.qr-img { width: 240px; height: 240px; object-fit: contain; }
.qr-waiting { color: var(--el-text-color-secondary, #909399); font-size: 13px; }
.qr-expired { display: flex; flex-direction: column; align-items: center; gap: 8px; color: var(--el-color-warning, #e6a23c); font-size: 13px; }
.qr-fallback { display: flex; flex-direction: column; align-items: center; gap: 8px; max-width: 100%; }
.qr-link-text { word-break: break-all; color: var(--el-text-color-secondary, #909399); font-size: 12px; max-width: 300px; }
.qr-platform-row { display: flex; justify-content: center; }
.qr-status { font-size: 13px; color: var(--el-color-success, #67c23a); text-align: center; max-width: 320px; }
.qr-status-invalid { color: var(--el-color-error, #f56c6c); }
.qr-success-view { display: flex; flex-direction: column; align-items: center; gap: 4px; color: var(--el-color-success, #67c23a); font-size: 14px; }
.qr-success-text { font-weight: 600; }
</style>
