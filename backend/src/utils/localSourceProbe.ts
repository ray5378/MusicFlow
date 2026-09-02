// ==================== local/WebDAV 源可用性探测(多源组跨源回退) ====================
// 服务端统一承担「首选 Local,失败回退平台」:stream/play 拿到组内任意 id,
// 先经 preferLocal 优选 local 主源,再探测主源可用性,不可用则切组内 web 源。
// 本地文件用零成本 existsSync;WebDAV 每次流播一次 HEAD。失败记忆 5 分钟,
// 避免文件缺失期间每次流播都重复探测。
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
        try {
          const r = await fetch(url, { method: "HEAD", headers, signal: AbortSignal.timeout(8000) });
          if (r.status === 200 || r.status === 206) return true;
          localFailCache.set(song.id, Date.now());
          return false;
        } catch {
          localFailCache.set(song.id, Date.now());
          return false;
        }
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
