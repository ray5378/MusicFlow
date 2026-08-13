// ==================== 网络代理（插件拉取链路专用） ====================
//
// 系统设置里的「网络代理」配置（格式 http://ip:port 或 https://ip:port）：
//   - 仅作用于**插件市场拉取**（registry.json / plugin.json / 安装包 tar.gz），
//     让 GitHub 等源在不可直连的环境下也能安装插件；
//   - 实现：undici `ProxyAgent` 按代理地址做模块级缓存，以 per-request
//     `dispatcher` 注入（不调用 setGlobalDispatcher），因此**不影响其它后端
//     网络**（DLNA 轮询、封面/歌词下载、插件沙箱 host.http 等仍直连）；
//   - 设置改动即时生效（每次调用读 settings，5s TTL 缓存；代理地址变化时
//     下次调用自动新建 agent）。
import { ProxyAgent } from "undici";
import { getSetting, getSettingBool } from "./settings.js";

const PROXY_ENABLED_KEY = "proxy_enabled";
const PROXY_URL_KEY = "proxy_url";

/** 当前生效的代理配置。url 已规整；enabled 表示开关打开且地址合法。 */
export function getProxyConfig(): { enabled: boolean; url: string } {
  const enabled = getSettingBool(PROXY_ENABLED_KEY, false);
  const url = normalizeProxyUrl(getSetting(PROXY_URL_KEY, ""));
  return { enabled: enabled && !!url, url };
}

/** 校验并规整代理地址：仅接受 http://host:port 或 https://host:port。
 *  非法 / 空 返回 ""（视为未配置 → 直连）。 */
export function normalizeProxyUrl(raw: string): string {
  const u = String(raw || "").trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) return "";
  try {
    const parsed = new URL(u);
    if (!parsed.hostname || !parsed.port) return "";
    return u.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

// ProxyAgent 带连接池，长存复用；key 为规整后的代理地址，设置变更后自然重建。
const agents = new Map<string, ProxyAgent>();

function getProxyAgent(url: string): ProxyAgent {
  let a = agents.get(url);
  if (!a) {
    a = new ProxyAgent(url);
    agents.set(url, a);
  }
  return a;
}

/** 按代理配置发起 fetch：启用代理 → undici dispatcher；否则原生 fetch。
 *  用于插件市场拉取，避免在直连可用的场景引入代理开销。 */
export async function proxyFetch(url: string, init?: RequestInit): Promise<Response> {
  const { enabled, url: proxyUrl } = getProxyConfig();
  if (enabled && proxyUrl) {
    // RequestInit 不含 undici 扩展字段，类型上需要放行。
    return (fetch as any)(url, { ...init, dispatcher: getProxyAgent(proxyUrl) });
  }
  return fetch(url, init);
}
