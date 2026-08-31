// SSRF 防护工具:校验「后端代理抓取」的 URL 是否允许请求。
//
// 背景:getCoverArt 会把前端传回的完整 http(s) URL 当作远程封面直链代理取图
// (客户端 cover_art_image.dart 将 trusted-url: 包装的 URL 原样传给服务端)。
// 若不设防,登录用户可让服务端访问内网服务(云元数据 169.254.169.254、内网
// 管理后台、其它容器的地址等),形成 SSRF。
//
// 策略(默认从严,可配置放行):
//   - 仅允许 http/https scheme;
//   - 域名解析成 IP 后,回环/私网/链路本地/组播/保留地址一律拦截;
//   - DNS rebinding:以「解析结果 IP」而非「域名文本」判定(域名可指向任意 IP);
//   - 解析失败视为不可信,保守拦截;
//   - 放行通道:COVER_PROXY_ALLOW_HOSTS(逗号分隔的精确 hostname 白名单)或
//     COVER_PROXY_ALLOW_PRIVATE=1(整体放行内网,部署在纯内网环境时使用)。
import { lookup } from "node:dns/promises";
import net from "node:net";

/** IP 是否属于回环/私网/链路本地/组播/保留地址(应拦截)。 */
export function isBlockedIp(ip: string): boolean {
  const v4 = net.isIPv4(ip);
  if (v4) {
    const p = ip.split(".").map(Number);
    const [a, b] = p;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 私网
    if (a === 127) return true; // 回环
    if (a === 169 && b === 254) return true; // 链路本地(含云元数据)
    if (a === 172 && b >= 16 && b <= 31) return true; // 私网
    if (a === 192 && b === 168) return true; // 私网
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    if (a === 198 && (b === 18 || b === 19)) return true; // 基准测试 198.18/15
    if (a === 198 && b === 51 && p[2] === 100) return true; // 文档 198.51.100.0/24
    if (a === 203 && b === 0 && p[2] === 113) return true; // 文档 203.0.113.0/24
    if (a >= 224) return true; // 组播/保留
    return false;
  }
  if (net.isIPv6(ip)) {
    const h = ip.toLowerCase();
    if (h === "::" || h === "::1") return true; // 未指定/回环
    if (h.startsWith("::ffff:")) return isBlockedIp(h.slice("::ffff:".length)); // IPv4 映射
    if (h.startsWith("fc") || h.startsWith("fd")) return true; // ULA
    if (/^fe[89ab]/.test(h)) return true; // 链路本地 fe80::/10
    if (h.startsWith("64:ff9b:")) return true; // NAT64
    if (h.startsWith("2001:db8:")) return true; // 文档
    return false;
  }
  // 无法识别的地址形态 → 保守拦截
  return true;
}

/** hostname 是否命中精确白名单(COVER_PROXY_ALLOW_HOSTS,逗号分隔,大小写不敏感)。 */
export function isAllowedCoverProxyHost(hostname: string): boolean {
  const allow = (process.env.COVER_PROXY_ALLOW_HOSTS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (allow.length === 0) return false;
  return allow.includes(hostname.toLowerCase());
}

/**
 * 判定一个待代理抓取的封面 URL 是否应被拦截。
 * @returns true = 拦截(不得发起请求);false = 放行。
 */
export async function isBlockedCoverProxyUrl(rawUrl: string): Promise<boolean> {
  if (process.env.COVER_PROXY_ALLOW_PRIVATE === "1") return false;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return true; // 非法 URL → 拦截
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return true;

  // 去掉 IPv6 字面量包裹的方括号:new URL("http://[::1]/").hostname === "[::1]"
  let hostname = url.hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (!hostname) return true;
  if (isAllowedCoverProxyHost(hostname)) return false;

  // 端口不做限制:拦截面是「私网/回环/保留 IP」而非端口,公网任意端口的正常
  // 封面直链不受影响(那不属于 SSRF)。
  try {
    // 以解析后的 IP 判定(DNS rebinding 防护);解析失败 → 拦截。
    const { address } = await lookup(hostname, { verbatim: false });
    return isBlockedIp(address);
  } catch {
    return true;
  }
}
