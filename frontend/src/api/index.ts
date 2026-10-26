import axios from "axios";
import { useAuthStore } from "@/stores/auth";
import router from "@/router";
import { gt, i18n } from "@/locales";
import { getClientId } from "@/utils/clientId";

// ---- 超时 + GET 自动重试(2026-11-05 首屏「卡 15 秒」的两个病根) ----
// ① 超时 15000ms 与真实耗时严重不匹配:实测 /v1/groups 3.3ms、/v1/airplay/devices 2.4ms
//    (生产环境)。15s 的超时只在「反代掐掉空闲的 keep-alive 连接、复用旧连接的首个
//    请求被静默丢弃」时才起作用:那个请求永远等不到响应,于是整整白等 15 秒。
// ② 只调超时不够 —— 那种请求注定失败,用户还是得手动刷新。所以对 **GET** 增设
//    「无响应类网络错误自动重试 1 次」:重试会新建连接,几乎立刻成功。
//    4xx/5xx 是服务端明确答复(权限/参数/不存在),重试无意义,直接交给调用方。
const API_TIMEOUT_MS = 6000;

const api = axios.create({ baseURL: "", timeout: API_TIMEOUT_MS });

/** 值得重试的失败:连接层没拿到任何 HTTP 响应。
 *  - ECONNABORTED / ETIMEDOUT:axios 超时;
 *  - ERR_NETWORK / ECONNRESET / EPIPE:socket 被重置/半开(反代掐 keep-alive 的典型表现);
 *  - message 兜底:部分运行时(浏览器 fetch/XHR 适配器、Node 侧)不带 code。 */
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNABORTED",
  "ETIMEDOUT",
  "ERR_NETWORK",
  "ECONNRESET",
  "EPIPE",
  "ESOCKETTIMEDOUT",
]);

function isRetryableNetworkError(error: any): boolean {
  // 服务端已答复(含 401/403/404/5xx)→ 不重试。
  if (error?.response) return false;
  const code = String(error?.code || "");
  if (RETRYABLE_NETWORK_CODES.has(code)) return true;
  const msg = String(error?.message || "");
  return /timeout of \d+ms exceeded|network error|socket hang up|aborted/i.test(msg);
}

api.interceptors.request.use((config) => {
  const authStore = useAuthStore();
  if (authStore.token) {
    config.headers.Authorization = `Bearer ${authStore.token}`;
  }
  // 随请求携带界面语言,后端据此渲染错误文案(默认 zh-CN)。
  config.headers["x-mf-lang"] = String(i18n.global.locale.value || "zh-CN");
  // 本播放端的临时端 ID:服务端用它把同账号多个播放端的队列隔离开
  // (只在服务端内部使用,响应里不会回显 —— 见 backend utils/peerId.ts)。
  config.headers["x-mf-client-id"] = getClientId();
  return config;
});

/** 打一条调试日志(重试路径必须留痕,否则「为什么这次没卡」无从排查)。
 *  用 debug 级别:正常路径不刷控制台,排障时把它打开即可看到 url + 耗时。
 *  文案用英文 —— 纯开发日志,不进界面,走 i18n 只会给文案表添噪音。 */
function debugRetry(message: string): void {
  // eslint-disable-next-line no-console
  console.debug(`[api] ${message}`);
}

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const config: any = error?.config;
    const method = String(config?.method || "").toLowerCase();
    // GET 幂等 ⇒ 可安全重放;写操作(POST/PUT/DELETE)一律不自动重试,
    // 否则超时重试可能造成重复创建/重复投屏。
    if (config && method === "get" && !config.__mfRetried && isRetryableNetworkError(error)) {
      config.__mfRetried = true;
      const url = String(config.url || "");
      const startedAt = Date.now();
      debugRetry(`GET ${url} got no response (${String(error?.code || error?.message || "unknown")}) - retrying once`);
      try {
        const res = await api.request(config);
        debugRetry(`GET ${url} retried OK in ${Date.now() - startedAt}ms`);
        return res;
      } catch (retryError: any) {
        debugRetry(
          `GET ${url} retry failed after ${Date.now() - startedAt}ms `
            + `(${String(retryError?.code || retryError?.message || "unknown")})`,
        );
        return Promise.reject(retryError);
      }
    }
    if (error.response?.status === 401) {
      const authStore = useAuthStore();
      authStore.logout();
      router.push("/login");
    }
    return Promise.reject(error);
  }
);

/** 把接口报错格式化为可行动的中文文案:
 *  - 沙箱限制错误(后端透传 sandboxCode/hint)→「[错误码] 说明 + 修复提示」;
 *  - axios 自身超时(如 "timeout of 6000ms exceeded")→ 中文超时说明;
 *  - 其余回退到服务端 error 字段或 fallback。 */
export function formatApiError(e: any, fallback = gt("common.operationFailed")): string {
  const data = e?.response?.data;
  if (data?.error) {
    if (data.sandboxCode) {
      return `[${data.sandboxCode}] ${String(data.error)}${data.hint ? ". " + String(data.hint) : ""}`;
    }
    return String(data.error);
  }
  const msg = typeof e?.message === "string" ? e.message : "";
  if (/timeout of \d+ms exceeded/i.test(msg)) {
    return gt("api.timeout");
  }
  return msg || fallback;
}

export default api;
