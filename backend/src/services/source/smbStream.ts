// ==================== SMB → 回环 HTTP 的 token 通道 ====================
//
// SMB 不能直接喂给 ffmpeg，所以在服务端开一个只认 token 的回环地址：
//   ffmpeg → http://127.0.0.1:<port>/rest/smbstream/<token> → SMB 文件流
//
// 这样下游(预取、DLNA Range 代理、seek)与 WebDAV 完全同构，不需要任何
// "这是 SMB" 的特殊分支；token 只在本机回环消费，和 membuf / dlna raw 的
// 信任模型一致(靠签名 + 过期时间)。
//
// ⚠️ token 必须**跨进程**有效：sendspin 推流/预热跑在 fork 出来的子进程里，
// 子进程 mint 的回环 URL 是主进程的 HTTP 路由在收请求。旧实现用进程内 Map 存
// token，子进程签发的 token 主进程查不到 → /rest/smbstream 一律 403，群组
// (混合 AirPlay+Sendspin)播 SMB 音频完全无声。现在改为**无状态签名 token**：
// 源 id / 文件路径 / 过期时间编码进 token，用 DATA_DIR 下持久化的密钥签名，
// 任何进程都能验签并自行从 DB 取 SMB 配置。
import { createHmac, timingSafeEqual } from "node:crypto";
import { getJwtSecret } from "../../utils/env.js";
import { loopbackBase } from "../dlna/control.js";
import { loadSmbConfig, normalizeSmbPath, type SmbConfig } from "./smbClient.js";

export interface SmbStreamEntry {
  sourceId: string;
  config: SmbConfig;
  filePath: string;
  expiresAt: number;
}

/** 6 小时足够覆盖一次播放(含暂停/拖进度)，又不会让 token 永久有效。 */
const TTL_MS = 6 * 60 * 60 * 1000;

/** 签名密钥：环境变量优先；否则复用 DATA_DIR 下的持久化密钥(主进程与 fork 子进程共享)。 */
function signKey(): Buffer {
  const explicit = process.env.MUSICFLOW_SMBSTREAM_SECRET;
  if (explicit) return Buffer.from(explicit, "utf8");
  return Buffer.from(getJwtSecret(), "utf8");
}

function sign(payload: string): string {
  return createHmac("sha256", signKey()).update(payload).digest("base64url");
}

/** 注册一次可回环读取的 SMB 文件，返回 ffmpeg 可直接打开的 URL。 */
export function mintSmbStreamUrl(sourceId: string, _config: SmbConfig, filePath: string): string {
  const body = JSON.stringify({
    s: sourceId,
    p: normalizeSmbPath(filePath),
    e: Date.now() + TTL_MS,
  });
  const payload = Buffer.from(body, "utf8").toString("base64url");
  return `${loopbackBase()}/rest/smbstream/${payload}.${sign(payload)}`;
}

/** 路由侧兑换 token；签名不符/过期/源不存在返回 null。 */
export function resolveSmbStream(token: string): SmbStreamEntry | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = Buffer.from(token.slice(dot + 1), "utf8");
  const expected = Buffer.from(sign(payload), "utf8");
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;

  let body: any;
  try {
    body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const sourceId = String(body?.s || "");
  const filePath = String(body?.p || "");
  const expiresAt = Number(body?.e || 0);
  if (!sourceId || !filePath || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;

  // 配置由接收请求的进程自行从 DB 读取，token 里不夹带密码。
  const config = loadSmbConfig(sourceId);
  if (!config) return null;
  return { sourceId, config, filePath: normalizeSmbPath(filePath), expiresAt };
}

/** 测试用：旧实现清空内存注册表；无状态 token 下无可清理状态。 */
export function resetSmbStreamsForTest(): void {
  /* no-op */
}
