// ==================== SMB → 回环 HTTP 的 token 通道 ====================
//
// SMB 不能直接喂给 ffmpeg，所以在服务端开一个只认 token 的回环地址：
//   ffmpeg → http://127.0.0.1:<port>/rest/smbstream/<token> → SMB 文件流
//
// 这样下游(预取、DLNA Range 代理、seek)与 WebDAV 完全同构，不需要任何
// "这是 SMB" 的特殊分支；token 只在本机回环消费，和 membuf / dlna raw 的
// 信任模型一致(无鉴权，靠随机串 + 过期时间)。
import { randomUUID } from "node:crypto";
import { loopbackBase } from "../dlna/control.js";
import { normalizeSmbPath, type SmbConfig } from "./smbClient.js";

export interface SmbStreamEntry {
  sourceId: string;
  config: SmbConfig;
  filePath: string;
  expiresAt: number;
}

/** 6 小时足够覆盖一次播放(含暂停/拖进度)，又不会让 token 永久有效。 */
const TTL_MS = 6 * 60 * 60 * 1000;
/** 上限防止被反复起播撑爆内存(每条只存路径与配置快照)。 */
const MAX_TOKENS = 1024;

const tokens = new Map<string, SmbStreamEntry>();

function prune(): void {
  const now = Date.now();
  for (const [k, v] of tokens) if (v.expiresAt <= now) tokens.delete(k);
  while (tokens.size >= MAX_TOKENS) {
    const oldest = tokens.keys().next();
    if (oldest.done) break;
    tokens.delete(oldest.value);
  }
}

/** 注册一次可回环读取的 SMB 文件，返回 ffmpeg 可直接打开的 URL。 */
export function mintSmbStreamUrl(sourceId: string, config: SmbConfig, filePath: string): string {
  prune();
  const token = randomUUID().replace(/-/g, "");
  tokens.set(token, {
    sourceId,
    config,
    filePath: normalizeSmbPath(filePath),
    expiresAt: Date.now() + TTL_MS,
  });
  return `${loopbackBase()}/rest/smbstream/${token}`;
}

/** 路由侧兑换 token；过期/未知返回 null。 */
export function resolveSmbStream(token: string): SmbStreamEntry | null {
  const hit = tokens.get(token);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    tokens.delete(token);
    return null;
  }
  return hit;
}

/** 测试用：清空注册表。 */
export function resetSmbStreamsForTest(): void {
  tokens.clear();
}
