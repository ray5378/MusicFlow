// MusicFetch 下载器：只用 Node 内置模块实现的流式 HTTP(S) 下载。
//
// 为什么不用第三方：外置插件跑在沙箱里做不了二进制 IO，下载必须在主仓内完成；
// 主仓不允许为这个功能新增 npm 依赖（离线/内网部署场景），故全部基于
// node:http / node:https / node:fs / node:crypto / node:net / node:dns 实现。
//
// 能力：SSRF 防护（逐跳校验）、手动跟随重定向、断点续传、停摆/总超时、限速、
// 边写边算 sha256、体积上限、可取消。
//
// 约定：destPath 由调用方给定（通常是 .part 临时路径）；出错时**不删除**已写内容，
// 清理交回调用方（.part 往往要保留给下一次断点续传用）。
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import dns from "node:dns";
import net from "node:net";
import { once } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { FetchErrorCode } from "../services/fetch/types.js";

/** 默认总超时（ms）。 */
const DEFAULT_TIMEOUT_MS = 120000;
/** 默认停摆超时（ms）：超过这么久没收到新字节即失败。 */
const DEFAULT_STALL_TIMEOUT_MS = 20000;
/** 默认最大重定向跳数。 */
const DEFAULT_MAX_REDIRECTS = 3;
/** 默认 UA：部分源站对空 UA 直接 403。 */
const DEFAULT_UA = "MusicFlow/MusicFetch (+https://github.com/musicflow)";

/** 下载失败：携带可直接展示给用户的错误码。 */
export class DownloadError extends Error {
  code: FetchErrorCode;
  httpStatus?: number;
  bytes?: number;

  constructor(code: FetchErrorCode, message: string, extra?: { httpStatus?: number; bytes?: number }) {
    super(message);
    this.name = "DownloadError";
    this.code = code;
    if (extra?.httpStatus !== undefined) this.httpStatus = extra.httpStatus;
    if (extra?.bytes !== undefined) this.bytes = extra.bytes;
  }
}

/** 下载入参。 */
export interface DownloadOptions {
  url: string;
  /** 写入目标（调用方保证是 .part 路径） */
  destPath: string;
  headers?: Record<string, string>;
  /** 总超时，默认 120000 */
  timeoutMs?: number;
  /** 无新字节即失败，默认 20000 */
  stallTimeoutMs?: number;
  /** 超过即 TOO_LARGE */
  maxBytes?: number;
  /** 0/未给 = 不限速 */
  rateLimitKBps?: number;
  /** 默认 true */
  resume?: boolean;
  /** 默认 3 */
  maxRedirects?: number;
  userAgent?: string;
  /** 默认 true */
  ssrfGuard?: boolean;
  /** 空数组/未给 = 不限 */
  hostAllowlist?: string[];
  /**
   * 可信内网主机（管理员显式授权，如自建 go-music-dl）：命中即放行，不做内网段拦截。
   * 支持「主机名 / `*.子域` / IPv4 CIDR（如 `192.168.10.0/24`，整段内网一次性授权）」。
   */
  trustedHosts?: string[];
  signal?: AbortSignal;
}

/** 下载结果。 */
export interface DownloadResult {
  bytes: number;
  httpStatus: number;
  mime?: string;
  sha256: string;
  rangeSupported: boolean;
  finalUrl: string;
  partial: boolean;
}

/** 内部：一次「收流写盘」的入参。 */
interface PumpArgs {
  res: IncomingMessage;
  req: ClientRequest;
  ws: fs.WriteStream;
  /** 续传时已存在的字节数（计入最终 bytes） */
  startBytes: number;
  maxBytes?: number;
  deadlineMs: number;
  stallTimeoutMs: number;
  rateLimitKBps?: number;
  signal?: AbortSignal;
}

interface PumpOutcome {
  bytes: number;
  sha256: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 大小写不敏感取 header。 */
function findHeader(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) return headers[k];
  }
  return undefined;
}

/** 大小写不敏感删 header（跨主机跳转时剥离凭据用）。 */
function deleteHeader(headers: Record<string, string>, name: string): void {
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) delete headers[k];
  }
}

/** IPv4 是否命中私有/回环/链路本地/CGNAT/未指定等应拦截网段。 */
function isBlockedV4(ip: string): boolean {
  const p = ip.split(".").map((x) => Number.parseInt(x, 10));
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 私网
  if (a === 127) return true; // 回环
  if (a === 169 && b === 254) return true; // 链路本地（含云元数据 169.254.169.254）
  if (a === 172 && b >= 16 && b <= 31) return true; // 私网
  if (a === 192 && b === 168) return true; // 私网
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  return false;
}

/**
 * IP 是否应被拦截。IPv6 的 '::ffff:' 映射需先解出内嵌 IPv4 再判（否则绕过）。
 * 无法识别的地址形态 → 保守拦截。
 */
export function isBlockedIp(ip: string): boolean {
  const s = String(ip ?? "").trim().toLowerCase();
  if (net.isIPv4(s)) return isBlockedV4(s);
  if (net.isIPv6(s)) {
    if (s === "::" || s === "::1") return true; // 未指定 / 回环
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
    if (mapped) return isBlockedV4(mapped[1]);
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(s)) return true; // 十六进制形式的 IPv4 映射
    if (s.startsWith("fc") || s.startsWith("fd")) return true; // ULA fc00::/7
    if (/^fe[89ab]/.test(s)) return true; // 链路本地 fe80::/10
    return false;
  }
  return true;
}

/** IPv4 → 32 位无符号整数；非法返回 null。 */
function ipv4ToInt(ip: string): number | null {
  if (!net.isIPv4(ip)) return null;
  const p = ip.split(".").map((x) => Number.parseInt(x, 10));
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

/** 解析 IPv4 CIDR（`192.168.10.0/24`）→ { base, mask }；非法返回 null。 */
function parseCidr(raw: string): { base: number; mask: number } | null {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(String(raw ?? "").trim());
  if (!m) return null;
  const base = ipv4ToInt(m[1]);
  const bits = Number.parseInt(m[2], 10);
  if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: (base & mask) >>> 0, mask };
}

/** ip 是否落在 cidrs 中任意一段之内（IPv4）。 */
function ipInAnyCidr(ip: string, cidrs: string[]): boolean {
  const v = ipv4ToInt(ip);
  if (v === null) return false;
  for (const raw of cidrs) {
    const c = parseCidr(raw);
    if (c && ((v & c.mask) >>> 0) === c.base) return true;
  }
  return false;
}

/** 从白名单里挑出 CIDR 形式的条目（其余是主机名 / 通配域名）。 */
function cidrEntries(list: string[]): string[] {
  return list.filter((x) => String(x ?? "").includes("/"));
}

/**
 * hostname 是否命中白名单。支持三种写法：
 *   - 精确主机名：`nas.local`
 *   - 通配子域：`*.example.com`
 *   - **IPv4 CIDR**：`192.168.10.0/24`（整段内网一次性授权，2026-10-11）
 *
 * CIDR 在**此处**只能命中「主机名本身就是 IP」的情况；主机名要先解析才能比对时，
 * 由调用方在 DNS 解析后用 `ipInAnyCidr` 再判一次（见 assertUrlAllowed）。
 */
function matchHostAllowlist(hostname: string, allowlist: string[]): boolean {
  const h = hostname.toLowerCase();
  for (const raw of allowlist) {
    const p = String(raw ?? "").trim().toLowerCase();
    if (!p) continue;
    if (p.includes("/")) {
      if (ipInAnyCidr(h, [p])) return true; // h 必须是字面 IP 才可能命中
      continue;
    }
    if (p.startsWith("*.")) {
      const suffix = p.slice(2);
      if (h === suffix || h.endsWith(`.${suffix}`)) return true;
    } else if (h === p) {
      return true;
    }
  }
  return false;
}

/** 解析出 hostname 的全部候选 IP（DNS rebinding 防护：逐个判定）。 */
function dnsLookupAll(hostname: string): Promise<dns.LookupAddress[]> {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses);
    });
  });
}

/** 解析 URL；非法 URL 直接抛错。 */
function parseUrl(raw: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw new DownloadError("FETCH_FAILED", `非法 URL: ${raw}`);
  }
}

/**
 * 单跳安全校验：协议 → host 白名单 → 解析出的每一个 IP。
 *
 * 与 utils/ssrf.ts 的既有策略保持一致：**命中白名单即放行**（白名单是管理员的显式
 * 授权，可能就是内网镜像站），未命中白名单时再做私有网段拦截。
 */
async function assertUrlAllowed(
  url: URL,
  ssrfGuard: boolean,
  hostAllowlist?: string[],
  trustedHosts?: string[],
): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new DownloadError("SSRF_BLOCKED", `不支持的协议 ${url.protocol}`);
  }
  // new URL("http://[::1]/").hostname === "[::1]"
  const hostname = url.hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (!hostname) throw new DownloadError("SSRF_BLOCKED", "URL 缺少主机名");

  // 可信内网主机（管理员显式授权的自建信源，如 go-music-dl）：命中即放行，
  // 不做白名单/内网段拦截；其余主机照常走既有守卫。
  const trusted = trustedHosts ?? [];
  if (trusted.length > 0 && matchHostAllowlist(hostname, trusted)) return;

  const allowlist = hostAllowlist ?? [];
  if (allowlist.length > 0) {
    if (!matchHostAllowlist(hostname, allowlist)) {
      throw new DownloadError("SSRF_BLOCKED", `主机 ${hostname} 不在允许列表内`);
    }
    return;
  }
  if (!ssrfGuard) return;

  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) {
      throw new DownloadError("SSRF_BLOCKED", `目标地址 ${hostname} 属于内网/保留网段`);
    }
    return;
  }
  let addresses: dns.LookupAddress[];
  try {
    addresses = await dnsLookupAll(hostname);
  } catch (e) {
    throw new DownloadError("SSRF_BLOCKED", `主机 ${hostname} 解析失败: ${(e as Error).message}`);
  }
  if (addresses.length === 0) {
    throw new DownloadError("SSRF_BLOCKED", `主机 ${hostname} 解析结果为空`);
  }
  // 可信 CIDR 的二次判定：主机名（如 `nas.local`）解析到可信网段内 → 一并放行。
  // （字面 IP 的情形在前面 matchHostAllowlist 已经放行了。）
  const trustedCidrs = cidrEntries(trusted);
  if (trustedCidrs.length > 0 && addresses.some((a) => ipInAnyCidr(a.address, trustedCidrs))) {
    return;
  }
  for (const a of addresses) {
    if (isBlockedIp(a.address)) {
      throw new DownloadError("SSRF_BLOCKED", `主机 ${hostname} 解析到内网/保留地址 ${a.address}`);
    }
  }
}

/** 跨主机跳转时剥离 Authorization（不能把凭据带给下一跳）。 */
function stripCrossHostAuth(headers: Record<string, string>, prevHost: string, nextHost: string): void {
  if (prevHost.toLowerCase() === nextHost.toLowerCase()) return;
  deleteHeader(headers, "authorization");
}

/** 已存在的 .part 大小（用于断点续传）。 */
function existingFileSize(destPath: string): number {
  try {
    const st = fs.statSync(destPath);
    return st.isFile() ? st.size : 0;
  } catch {
    return 0;
  }
}

/** 丢弃响应体（错误路径下让 socket 干净结束）。 */
function drain(res: IncomingMessage): void {
  try {
    res.resume();
  } catch {
    /* noop */
  }
}

/** 发起请求并等响应头。 */
function awaitResponse(req: ClientRequest, deadlineMs: number, signal?: AbortSignal): Promise<IncomingMessage> {
  return new Promise<IncomingMessage>((resolve, reject) => {
    let onAbort: (() => void) | undefined;
    let timer: NodeJS.Timeout | undefined;
    let settled = false;

    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      if (onAbort && signal) signal.removeEventListener("abort", onAbort);
    };
    const fail = (err: DownloadError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        req.destroy();
      } catch {
        /* noop */
      }
      reject(err);
    };

    // 监听器先挂:无论后续哪条失败路径 destroy 了 req,都保证 'error' 有接收方,
    // 不会退化成未处理的 error 事件。
    req.once("response", (res) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(res);
    });
    req.once("error", (err: Error) => fail(new DownloadError("FETCH_FAILED", `请求失败: ${err.message}`)));

    if (signal) {
      if (signal.aborted) {
        settled = true;
        try {
          req.destroy();
        } catch {
          /* noop */
        }
        reject(new DownloadError("FETCH_FAILED", "下载已被取消"));
        return;
      }
      onAbort = (): void => fail(new DownloadError("FETCH_FAILED", "下载已被取消"));
      signal.addEventListener("abort", onAbort);
    }

    timer = setTimeout(() => fail(new DownloadError("TIMEOUT", "等待响应超时")), Math.max(0, deadlineMs - Date.now()));
    req.end();
  });
}

/** 流式收流写盘：限速 / 停摆 / 总超时 / 体积上限 / sha256 / 可取消。 */
function pumpToFile(args: PumpArgs): Promise<PumpOutcome> {
  return new Promise<PumpOutcome>((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    let received = 0;
    let settled = false;
    let stallTimer: NodeJS.Timeout | undefined;
    let totalTimer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;

    const cleanup = (): void => {
      if (stallTimer) clearTimeout(stallTimer);
      if (totalTimer) clearTimeout(totalTimer);
      if (onAbort && args.signal) args.signal.removeEventListener("abort", onAbort);
    };
    const fail = (err: DownloadError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        args.req.destroy();
      } catch {
        /* noop */
      }
      try {
        args.res.destroy();
      } catch {
        /* noop */
      }
      try {
        args.ws.destroy();
      } catch {
        /* noop */
      }
      reject(err);
    };
    const armStall = (): void => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(
        () => fail(new DownloadError("STALL", `超过 ${args.stallTimeoutMs}ms 未收到新数据`)),
        args.stallTimeoutMs,
      );
    };

    // 写盘错误（最常见是磁盘写满 ENOSPC）统一转成可展示的错误码。
    args.ws.on("error", (e: Error) => {
      const code = (e as NodeJS.ErrnoException).code;
      fail(
        new DownloadError(
          code === "ENOSPC" ? "DISK_FULL" : "FETCH_FAILED",
          `写入 ${args.ws.path ?? ""} 失败: ${e.message}`,
        ),
      );
    });

    totalTimer = setTimeout(
      () => fail(new DownloadError("TIMEOUT", "下载总时长超过上限")),
      Math.max(0, args.deadlineMs - Date.now()),
    );
    armStall();

    if (args.signal) {
      if (args.signal.aborted) {
        fail(new DownloadError("FETCH_FAILED", "下载已被取消"));
        return;
      }
      onAbort = (): void => fail(new DownloadError("FETCH_FAILED", "下载已被取消"));
      args.signal.addEventListener("abort", onAbort);
    }

    void (async () => {
      try {
        const startedAt = Date.now();
        const bytesPerMs =
          args.rateLimitKBps && args.rateLimitKBps > 0 ? (args.rateLimitKBps * 1024) / 1000 : 0;

        for await (const chunk of args.res) {
          const buf: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
          armStall();
          received += buf.length;
          if (args.maxBytes !== undefined && args.startBytes + received > args.maxBytes) {
            fail(
              new DownloadError("TOO_LARGE", `下载体积超过上限 ${args.maxBytes} 字节`, {
                bytes: args.startBytes + received,
              }),
            );
            return;
          }
          hash.update(buf);
          if (!args.ws.write(buf)) await once(args.ws, "drain");
          if (bytesPerMs > 0) {
            // 令牌桶：已收字节换算「应耗时」，与真实耗时之差即为需要 sleep 的时间。
            const expected = received / bytesPerMs;
            const wait = expected - (Date.now() - startedAt);
            if (wait > 1) await sleep(Math.min(wait, 5000));
          }
        }

        const finished = new Promise<void>((res, rej) => {
          args.ws.once("error", (e: Error) => rej(e));
          args.ws.once("close", () => res());
        });
        args.ws.end();
        await finished;

        if (settled) return;
        settled = true;
        cleanup();
        resolve({ bytes: args.startBytes + received, sha256: hash.digest("hex") });
      } catch (e) {
        fail(
          e instanceof DownloadError
            ? e
            : new DownloadError("FETCH_FAILED", `传输/写入失败: ${(e as Error).message}`),
        );
      }
    })();
  });
}

/**
 * 流式下载到文件。
 *
 * @throws {DownloadError} 详见 FetchErrorCode；网络层异常统一包成 FETCH_FAILED 并保留原始 message。
 */
export async function downloadToFile(opts: DownloadOptions): Promise<DownloadResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const stallTimeoutMs = opts.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const ssrfGuard = opts.ssrfGuard !== false;
  const resume = opts.resume !== false;
  const deadlineMs = Date.now() + timeoutMs;
  const destPath = opts.destPath;

  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (!findHeader(headers, "user-agent")) headers["user-agent"] = opts.userAgent ?? DEFAULT_UA;

  let currentUrl = parseUrl(opts.url);
  let prevHost = currentUrl.host;

  for (let hop = 0; ; hop++) {
    await assertUrlAllowed(currentUrl, ssrfGuard, opts.hostAllowlist, opts.trustedHosts);
    stripCrossHostAuth(headers, prevHost, currentUrl.host);

    // 断点续传只在首跳发起（跳走之后 Range 语义已不属于原资源）
    const existingBytes = hop === 0 && resume ? existingFileSize(destPath) : 0;
    const reqHeaders: Record<string, string> = { ...headers };
    if (existingBytes > 0) reqHeaders["range"] = `bytes=${existingBytes}-`;

    const mod = currentUrl.protocol === "https:" ? https : http;
    const req = mod.request(currentUrl, { method: "GET", headers: reqHeaders });
    const res = await awaitResponse(req, deadlineMs, opts.signal);
    const status = res.statusCode ?? 0;
    const location = typeof res.headers.location === "string" ? res.headers.location : undefined;

    // 手动跟随重定向（不引入 follow-redirects）
    if (status >= 300 && status < 400 && location) {
      drain(res);
      if (hop >= maxRedirects) {
        throw new DownloadError("FETCH_FAILED", `重定向次数超过上限 ${maxRedirects}`);
      }
      prevHost = currentUrl.host;
      currentUrl = new URL(location, currentUrl);
      continue;
    }

    if (status === 403) {
      drain(res);
      throw new DownloadError("HTTP_403", "源站返回 403（多为防盗链/签名过期）", { httpStatus: status });
    }
    if (status >= 400 && status < 500) {
      drain(res);
      // 细分「资源本身不存在」的三个码：它们是永久失效判定（attempts.ts
      // PERMANENT_FAILURE_CODES）的唯一 HTTP 依据。其余 4xx 可恢复 —— 401 是插件
      // 凭据过期、408 是请求超时、429 是限流、416 是 Range 不满足，重试/换链就能成，
      // 一律留在 HTTP_4XX 兜底，**不进永久失效计数**（否则会误删歌）。
      const code: FetchErrorCode =
        status === 404
          ? "HTTP_404"
          : status === 410
            ? "HTTP_410"
            : status === 451
              ? "HTTP_451"
              : "HTTP_4XX";
      throw new DownloadError(code, `源站返回 ${status}`, { httpStatus: status });
    }
    if (status >= 500) {
      drain(res);
      throw new DownloadError("HTTP_5XX", `源站返回 ${status}`, { httpStatus: status });
    }
    if (status !== 200 && status !== 206) {
      drain(res);
      throw new DownloadError("FETCH_FAILED", `源站返回未预期的状态码 ${status}`, { httpStatus: status });
    }

    const rangeSupported = String(res.headers["accept-ranges"] ?? "").toLowerCase() === "bytes";
    const partial = status === 206;
    const ws = fs.createWriteStream(destPath, { flags: partial ? "a" : "w" });
    let outcome: PumpOutcome;
    try {
      outcome = await pumpToFile({
        res,
        req,
        ws,
        startBytes: partial ? existingBytes : 0,
        maxBytes: opts.maxBytes,
        deadlineMs,
        stallTimeoutMs,
        rateLimitKBps: opts.rateLimitKBps,
        signal: opts.signal,
      });
    } catch (e) {
      drain(res);
      throw e;
    }

    const mime = typeof res.headers["content-type"] === "string" ? res.headers["content-type"] : undefined;
    const result: DownloadResult = {
      bytes: outcome.bytes,
      httpStatus: status,
      mime,
      sha256: outcome.sha256,
      rangeSupported,
      finalUrl: currentUrl.toString(),
      partial,
    };
    return result;
  }
}

/** 直链体积预探入参。 */
export interface ProbeSizeOptions {
  url: string;
  headers?: Record<string, string>;
  /** 默认 8000 */
  timeoutMs?: number;
  /** 默认 3 */
  maxRedirects?: number;
  userAgent?: string;
  ssrfGuard?: boolean;
  hostAllowlist?: string[];
  trustedHosts?: string[];
  signal?: AbortSignal;
}

/**
 * 直链体积预探（PATCH15）：不消费 body，只取全量体积。
 * 先 HEAD（多数静态/CDN 直链支持，content-length 直读）；HEAD 被拒（403/405 等）
 * 或拿不到体积时回退 GET Range bytes=0-0（206 的 content-range 给全量；服务器忽略
 * Range 回 200 时用 content-length，读完头立即断开不下载 body）。
 * 任何失败都返回 null —— 预探只是优化，绝不让主流程失败。
 */
export async function probeRemoteSize(opts: ProbeSizeOptions): Promise<number | null> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const deadlineMs = Date.now() + timeoutMs;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const ssrfGuard = opts.ssrfGuard !== false;

  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (!findHeader(headers, "user-agent")) headers["user-agent"] = opts.userAgent ?? DEFAULT_UA;

  /** 手动跟随重定向发起一次请求；失败抛 DownloadError。 */
  const requestOnce = async (method: string): Promise<IncomingMessage> => {
    let currentUrl = parseUrl(opts.url);
    for (let hop = 0; ; hop++) {
      await assertUrlAllowed(currentUrl, ssrfGuard, opts.hostAllowlist, opts.trustedHosts);
      const mod = currentUrl.protocol === "https:" ? https : http;
      const req = mod.request(currentUrl, { method, headers });
      const res = await awaitResponse(req, deadlineMs, opts.signal);
      const status = res.statusCode ?? 0;
      const location = typeof res.headers.location === "string" ? res.headers.location : undefined;
      if (status >= 300 && status < 400 && location) {
        drain(res);
        if (hop >= maxRedirects) throw new DownloadError("FETCH_FAILED", "重定向次数超过上限");
        currentUrl = new URL(location, currentUrl);
        continue;
      }
      return res;
    }
  };

  const sizeOf = (res: IncomingMessage): number | null => {
    const cr = String(res.headers["content-range"] ?? "");
    const m = /\/(\d+)\s*$/.exec(cr);
    if (m) return Number(m[1]);
    const cl = Number(res.headers["content-length"] ?? "");
    return Number.isFinite(cl) && cl > 0 ? cl : null;
  };

  try {
    const res = await requestOnce("HEAD");
    const status = res.statusCode ?? 0;
    const size = status === 200 || status === 206 ? sizeOf(res) : null;
    drain(res);
    if (size) return size;
  } catch {
    // HEAD 被拒/网络异常：走 GET Range 兜底
  }
  try {
    const res = await requestOnce("GET");
    const status = res.statusCode ?? 0;
    const size = status === 200 || status === 206 ? sizeOf(res) : null;
    if (status === 206) drain(res); // 1 字节 body，排干即可
    else {
      try {
        res.destroy(); // 200 全量 body：读完头立即断开，绝不下载
      } catch {
        /* 断开失败无所谓 */
      }
    }
    return size;
  } catch {
    return null;
  }
}
