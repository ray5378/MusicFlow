import axios from "axios";
import { useAuthStore } from "@/stores/auth";
import router from "@/router";
import { gt, i18n } from "@/locales";

const api = axios.create({ baseURL: "", timeout: 15000 });

api.interceptors.request.use((config) => {
  const authStore = useAuthStore();
  if (authStore.token) {
    config.headers.Authorization = `Bearer ${authStore.token}`;
  }
  // 随请求携带界面语言,后端据此渲染错误文案(默认 zh-CN)。
  config.headers["x-mf-lang"] = String(i18n.global.locale.value || "zh-CN");
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
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
 *  - axios 自身超时(如 "timeout of 15000ms exceeded")→ 中文超时说明;
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
