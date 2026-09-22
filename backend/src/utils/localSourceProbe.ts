// ==================== local/WebDAV 源可用性探测(多源组跨源回退) ====================
// 服务端统一承担「首选 Local,失败回退平台」:stream/play 拿到组内任意 id,
// 先经 preferLocal 优选 local 主源,再探测主源可用性,不可用则切组内 web 源。
// 本地文件用零成本 existsSync;WebDAV 每次流播一次 HEAD(失败记忆 5 分钟,
// 避免文件缺失期间每次流播都重复探测)。
//
// 成功记忆(F 项):WebDAV 探测成功同样记 5 分钟 —— 「这个文件刚探测过、可播」
// 的结论在 seek/起播之间反复被用到,却每次都重探(240 实测单次 1.0~2.9s)。
// 只缓存 webdav 分支:本地 l: 走 existsSync 零成本,缓存它零收益,反而会引入
// 「文件已删却仍返回死行」的风险。
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
/** 成功记忆与失败记忆取同量级:两者对称,不会出现「5 分钟内判死」与「每次重探」的错位。 */
const WEBDAV_OK_TTL = LOCAL_FAIL_TTL;
/** 缓存条目上限(防无界增长):超出先清过期,再丢最旧的(插入序)。 */
const CACHE_MAX = 512;

function pruneCache(m: Map<string, number>): void {
  if (m.size <= CACHE_MAX) return;
  const now = Date.now();
  for (const [k, t] of m) if (now - t >= LOCAL_FAIL_TTL) m.delete(k);
  while (m.size > CACHE_MAX) {
    const oldest = m.keys().next();
    if (oldest.done) break;
    m.delete(oldest.value);
  }
}

// songId -> 探测成功时间戳(仅 webdav 分支写入;本地分支零成本,不参与)
const webdavOkCache = new Map<string, number>();

/**
 * 主动逐出某首歌的 WebDAV 可播成功记忆。
 * 出流失败(404 / 上游 5xx)时调用 —— 成功记忆只是「曾经探测通过」,
 * 真出流失败说明这个结论已失效,继续缓存会让后续请求一直走这条死路。
 */
export function evictProbeOk(songId: string): void {
  webdavOkCache.delete(songId);
}

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

/** 探测 local/WebDAV 歌曲源是否可播(带失败记忆 + WebDAV 成功记忆)。 */
export function probeLocalSourceOk(song: { id: string; path?: string | null }): Promise<boolean> {
  const cached = localFailCache.get(song.id);
  if (cached && Date.now() - cached < LOCAL_FAIL_TTL) return Promise.resolve(false);
  // 成功记忆命中:零往返返回。只有 webdav 分支写过它,本地分支永远不会命中。
  const okAt = webdavOkCache.get(song.id);
  if (okAt && Date.now() - okAt < WEBDAV_OK_TTL) return Promise.resolve(true);
  try {
    const parsed = parseSongPath(song.path || "");
    if (!parsed) return Promise.resolve(true); // 路径解析不出按可用处理,避免误回退
    if (parsed.type === "w") {
      return (async () => {
        const source = db.select().from(mediaSources).where(eq(mediaSources.id, parsed.sourceId)).get();
        if (!source) {
          webdavOkCache.delete(song.id);
          localFailCache.set(song.id, Date.now());
          return false;
        }
        const config = JSON.parse(source.config || "{}");
        const url = getWebDAVUrl(config, parsed.filePath);
        const headers: Record<string, string> = {};
        if (config.username && config.password) {
          headers["Authorization"] = "Basic " + Buffer.from(`${config.username}:${config.password}`).toString("base64");
        }
        const ok = await probeWebDAV(fetch, url, headers);
        if (!ok) {
          webdavOkCache.delete(song.id);
          localFailCache.set(song.id, Date.now());
          pruneCache(localFailCache);
          return false;
        }
        webdavOkCache.set(song.id, Date.now());
        pruneCache(webdavOkCache);
        return true;
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
