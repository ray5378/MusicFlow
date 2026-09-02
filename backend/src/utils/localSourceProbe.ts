// ==================== local/WebDAV 源可用性探测(多源组跨源回退) ====================
// 服务端统一承担「首选 Local,失败回退平台」:stream/play 拿到组内任意 id,
// 先经 preferLocal 优选 local 主源,再探测主源可用性,不可用则切组内 web 源。
// 本地文件用零成本 existsSync;WebDAV 每次流播一次 HEAD(失败记忆 5 分钟,
// 避免文件缺失期间每次流播都重复探测)。
import { db } from "../db/index.js";
import { mediaSources } from "../db/schema.js";
import { eq } from "drizzle-orm";

export function parseSongPath(p: string): { type: "w" | "l"; sourceId: string; filePath: string } | null {
  const colon1 = p.indexOf(":");
  if (colon1 < 0) return null;
  const prefix = p.slice(0, colon1);
  const rest = p.slice(colon1 + 1);
  const colon2 = rest.indexOf(":");
  if (colon2 < 0) return null;
  return { type: prefix as "w" | "l", sourceId: rest.slice(0, colon2), filePath: rest.slice(colon2 + 1) };
}

function getWebDAVUrl(sourceConfig: any, filePath: string): string {
  const origin = new URL(sourceConfig.url).origin;
  return origin + filePath;
}

const localFailCache = new Map<string, number>(); // songId -> 失败时间戳
const LOCAL_FAIL_TTL = 5 * 60 * 1000;

/**
 * WebDAV 文件可播性判定(纯函数,可注入 fetch 单测):
 * 先 HEAD——多数 WebDAV/静态服务器支持,成功即可用(快路径)。
 * HEAD 失败(403/405/501 等——对象存储网关常不认 HEAD 直链签名,如天翼云盘实测
 * HEAD 403 但 GET Range 206 可播)或网络异常时,改用 GET Range(bytes=0-0)兜底确认,
 * 避免误判「不可用」把无损源错误回退到平台源。只有 GET 也失败才算不可用。
 */
export async function probeWebDAV(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
): Promise<boolean> {
  try {
    const r = await fetchImpl(url, { method: "HEAD", headers, signal: AbortSignal.timeout(8000) });
    if (r.status === 200 || r.status === 206) return true;
  } catch {
    // HEAD 网络异常:继续 GET 兜底
  }
  try {
    const r = await fetchImpl(url, {
      method: "GET",
      headers: { ...headers, Range: "bytes=0-0" },
      signal: AbortSignal.timeout(8000),
    });
    return r.status === 200 || r.status === 206;
  } catch {
    return false;
  }
}

/** 探测 local/WebDAV 歌曲源是否可播(带失败记忆缓存)。 */
export function probeLocalSourceOk(song: { id: string; path?: string | null }): Promise<boolean> {
  const cached = localFailCache.get(song.id);
  if (cached && Date.now() - cached < LOCAL_FAIL_TTL) return Promise.resolve(false);
  try {
    const parsed = parseSongPath(song.path || "");
    if (!parsed) return Promise.resolve(true); // 路径解析不出按可用处理,避免误回退
    if (parsed.type === "w") {
      return (async () => {
        const source = db.select().from(mediaSources).where(eq(mediaSources.id, parsed.sourceId)).get();
        if (!source) { localFailCache.set(song.id, Date.now()); return false; }
        const config = JSON.parse(source.config || "{}");
        const url = getWebDAVUrl(config, parsed.filePath);
        const headers: Record<string, string> = {};
        if (config.username && config.password) {
          headers["Authorization"] = "Basic " + Buffer.from(`${config.username}:${config.password}`).toString("base64");
        }
        const ok = await probeWebDAV(fetch, url, headers);
        if (!ok) localFailCache.set(song.id, Date.now());
        return ok;
      })();
    }
    return import("fs").then((fs) => {
      if (fs.existsSync(parsed.filePath)) return true;
      localFailCache.set(song.id, Date.now());
      return false;
    }).catch(() => true);
  } catch {
    return Promise.resolve(true);
  }
}
