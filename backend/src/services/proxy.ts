// ==================== 网络代理（插件外呼 + 市场拉取） ====================
//
// 系统设置里的「网络代理」配置（格式 http://ip:port、https://ip:port 或
// socks5://ip:port 等）：
//   - 作用于**插件市场拉取**（registry.json / plugin.json / 安装包 tar.gz）与
//     **插件沙箱 host.http 外呼**（内置 + 外置插件的第三方 API 请求），让
//     GitHub / musicbrainz.org 等在容器直连不可达的环境下也能访问；
//   - 实现：undici `ProxyAgent`(HTTP/HTTPS 代理) 或 `Socks5ProxyAgent`(SOCKS5 代理)
//     按代理地址做模块级缓存，以 per-request `dispatcher` 注入（不调用
//     setGlobalDispatcher），因此**不影响其它后端网络**（DLNA 轮询、封面/歌词下载、
//     Web 端请求等仍直连）；
//   - 设置改动即时生效（每次调用读 settings，5s TTL 缓存；代理地址变化时
//     下次调用自动新建 agent）。
// 注意:必须显式从 undici 导入 fetch,与 ProxyAgent/Socks5ProxyAgent 保持同一实例。
// Node 全局 fetch 是另一份内置 undici,把本包的 dispatcher 传给它会报
// "invalid onRequestStart method"(dispatcher 符号不匹配)。
import { ProxyAgent, Socks5ProxyAgent, fetch } from "undici";
import { getSetting, getSettingBool } from "./settings.js";

const PROXY_ENABLED_KEY = "proxy_enabled";
const PROXY_URL_KEY = "proxy_url";

/** 当前生效的代理配置。url 已规整；enabled 表示开关打开且地址合法。 */
export function getProxyConfig(): { enabled: boolean; url: string } {
  const enabled = getSettingBool(PROXY_ENABLED_KEY, false);
  const url = normalizeProxyUrl(getSetting(PROXY_URL_KEY, ""));
  return { enabled: enabled && !!url, url };
}

/** 校验并规整代理地址：接受 http(s):// 与 socks[45]?://（host:port 必填）。
 *  非法 / 空 返回 ""（视为未配置 → 直连）。 */
export function normalizeProxyUrl(raw: string): string {
  const u = String(raw || "").trim();
  if (!u) return "";
  if (!/^(https?|socks[45]?):\/\//i.test(u)) return "";
  try {
    const parsed = new URL(u);
    if (!parsed.hostname || !parsed.port) return "";
    return u.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

// ProxyAgent / Socks5ProxyAgent 带连接池，长存复用；key 为规整后的代理地址，
// 设置变更后自然重建。两类 agent 都实现 undici Dispatcher 接口。
const agents = new Map<string, ProxyAgent | Socks5ProxyAgent>();
// FIFO 上限:代理地址变更频繁时防止 agent/连接池无界累积(每个 agent 含 keep-alive 连接)。
const PROXY_AGENT_MAX = 32;

/** 按代理地址返回对应的 dispatcher：http(s) → ProxyAgent，socks → Socks5ProxyAgent。 */
function getProxyDispatcher(url: string): ProxyAgent | Socks5ProxyAgent {
  let a = agents.get(url);
  if (!a) {
    const scheme = new URL(url).protocol.replace(":", "").toLowerCase();
    a = /^socks[45]?$/.test(scheme) ? new Socks5ProxyAgent(url) : new ProxyAgent(url);
    agents.set(url, a);
    if (agents.size > PROXY_AGENT_MAX) {
      const oldest = agents.keys().next().value;
      if (oldest !== undefined && oldest !== url) {
        const old = agents.get(oldest)!;
        (old as any).close?.().catch?.(() => {}); // 关闭连接池,防 socket 泄漏
        agents.delete(oldest);
      }
    }
  }
  return a;
}

/** 代理请求扩展参数：`proxy` 覆盖系统设置（true=强制走代理 / false=强制直连 /
 *  缺省=跟随系统开关）。供插件 host.http 按插件配置逐请求控制。 */
export type ProxyFetchInit = RequestInit & { proxy?: boolean };

/** 按代理配置发起 fetch：启用代理 → undici 的 fetch + 同实例 dispatcher（dispatcher
 *  必须与 fetch 来自同一份 undici，否则报 invalid onRequestStart method）；否则走
 *  全局 fetch（保持可被测试桩替换、且与其它后端代码一致）。
 *  `init.proxy` 可覆盖系统开关：false 强制直连；true 强制走代理（系统未配置代理
 *  地址时降级直连）。用于插件市场拉取与插件沙箱 host.http 外呼。 */
export async function proxyFetch(url: string, init?: ProxyFetchInit): Promise<Response> {
  const { enabled, url: proxyUrl } = getProxyConfig();
  const override = init?.proxy;
  const useProxy =
    override === undefined
      ? enabled && !!proxyUrl
      : override === true
        ? !!proxyUrl
        : false;
  const { proxy: _proxy, ...rest } = init || {};
  if (useProxy) {
    // 必须与 ProxyAgent/Socks5ProxyAgent 同一 undici 实例（即本模块导入的 fetch）。
    return (fetch as any)(url, { ...rest, dispatcher: getProxyDispatcher(proxyUrl) });
  }
  return (globalThis.fetch as any)(url, rest);
}

// ==================== 代理连通性测试 ====================
// 设计目标：验证「代理通道本身是否可用」，而不是「能否访问某一个写死的网站」。
//   - 先探测核心用途目标（GitHub 插件源 registry.json）；
//   - 若不通，再探测中性可达站点，以区分「代理服务器坏/不可达」与
//     「仅 GitHub 被代理分流规则挡掉」两种不同情况；
//   - 只要能经代理访问到任意外网（得到 HTTP 响应），即视为代理通道正常 → success。

const PROXY_TEST_URL =
  "https://raw.githubusercontent.com/ray5378/MusicFlow-plugins/master/registry.json";
// 中性连通性探测候选（任一可达即可证明代理出网正常）。
const NEUTRAL_PROBES = ["https://example.com/", "https://www.gstatic.com/generate_204"];

// 探测目标（默认生产值）。测试可临时重定向到本地服务，使「完整链路模拟」离线可复现。
let _proxyTestUrl = PROXY_TEST_URL;
let _neutralProbes = NEUTRAL_PROBES;
/** 仅测试用：重定向探测目标，不影响生产默认行为。 */
export function __setProxyTestTargets(github: string, neutral: string[] = NEUTRAL_PROBES): void {
  _proxyTestUrl = github;
  _neutralProbes = neutral;
}

export interface ProxyProbe {
  url: string;
  status?: number;
  ok?: boolean;
  error?: string;
}

export interface ProxyTestResult {
  /** 代理通道是否可用（能经代理访问外网）。 */
  success: boolean;
  /** 中文摘要，前端直接展示。 */
  message: string;
  /** 插件源(GitHub)是否可达；null=未启用/未配置。 */
  githubReachable: boolean | null;
  /** 逐探测点明细。 */
  probes: ProxyProbe[];
}

async function probeOnce(
  dispatcher: ProxyAgent | Socks5ProxyAgent,
  url: string,
  timeoutMs = 10_000
): Promise<ProxyProbe> {
  try {
    const r = await (fetch as any)(url, { dispatcher, signal: AbortSignal.timeout(timeoutMs) });
    return { url, status: r.status, ok: r.ok };
  } catch (e: any) {
    return { url, error: String(e?.cause?.message || e?.message || e) };
  }
}

/** 测试当前代理配置能否出网。返回结构化结果，供路由与前端展示。 */
export async function testProxyConnection(): Promise<ProxyTestResult> {
  const { enabled, url } = getProxyConfig();
  if (!enabled || !url) {
    return {
      success: false,
      message: "代理未启用或地址未配置（请先在上方开启并填写正确的 http(s):// 或 socks5:// 地址）",
      githubReachable: null,
      probes: [],
    };
  }

  const dispatcher = getProxyDispatcher(url);

  // 1) 核心用途探测：插件源（GitHub raw registry）
  const github = await probeOnce(dispatcher, _proxyTestUrl);

  // 2) 中性连通性探测：仅当 GitHub 不通时，用于判断是「代理坏」还是「仅 GitHub 被挡」
  let neutral: ProxyProbe | undefined;
  if (github.status === undefined) {
    for (const u of _neutralProbes) {
      const p = await probeOnce(dispatcher, u);
      neutral = p;
      if (p.status !== undefined) break;
    }
  }

  const githubReached = github.status !== undefined;
  const neutralReached = !!neutral && neutral.status !== undefined;
  const tunnelWorks = githubReached || neutralReached;
  const githubReachable = githubReached ? !!github.ok : null;

  let message: string;
  if (github.ok) {
    message = `代理可用，插件源可访问（GitHub 返回 HTTP ${github.status}）`;
  } else if (githubReached) {
    message = `代理通道正常，但 GitHub 插件源返回 HTTP ${github.status}（registry 地址可能已变更）`;
  } else if (neutralReached) {
    message =
      "代理通道正常，但无法访问 GitHub 插件源（请检查代理分流规则是否放行 github.com / raw.githubusercontent.com）";
  } else {
    message = `代理服务器连接失败：${github.error || neutral?.error || "未知错误"}`;
  }

  const probes = neutral ? [github, neutral] : [github];
  return { success: tunnelWorks, message, githubReachable, probes };
}
