// AirPlay (RAOP) 独立取流会话。
//
// 为什么要独立(「播放通道不能复用」):此前 AirPlay 与 DLNA、sendspin 三方共用
// `services/dlna/control.ts` 的 cast session 与 `/rest/dlna/stream/:token` 路由 ——
// 一条路由同时承担三种语义,带来三个结构性问题:
//   ① DLNA 音箱兼容头(contentFeatures / 12h 假 Content-Length / ICY)被强加给
//      AirPlay 解码器,语义上完全不属于它;
//   ② 滤镜通道键恒为 `dlna`,`pipeline.airplay` 开关形同虚设;
//   ③ 任一链改 URL 参数(如 `timeOffset`)会串到别的链。
// 现在 AirPlay 有自己的 token 命名空间与 `/rest/airplay/stream/:token` 路由,
// 出流核心仍与 DLNA 共用(见 routes/rest/castStream 的 serveCastStream),
// 只是参数不同 —— 不复制 100+ 行出流逻辑。
//
// ⚠️ 与 DLNA 的 raw_stream_tokens 同理,注册表必须落 SQLite:AirPlay 生产默认
// fork 模式,token 在主进程 mint、由子进程(经回环 URL)消费,内存 Map 跨进程
// 不可见(2026-09-19 事故的同一条教训)。
import { randomBytes } from "crypto";
import { sqlite } from "../../db/index.js";

const AIRPLAY_SESSION_TTL_MS = 30 * 60 * 1000;

/** 为一次 AirPlay 投屏登记取流凭证,返回 token 化的 URL。
 *
 * ⚠️ 同 (songId, deviceId) 的未过期会话**复用 token、仅续期** —— 对齐 MA 的
 * 「同一队列项流 URL 恒定」:若每次投流都 mint 新 token,同歌 seek 重建流后
 * 设备侧 mediaUri 变化会触发 PlaybackTracker 的「PLAYING 且 uri 变 = 换歌」
 * 误判 → 自动 advance 切下一首(与 DLNA createCastSession 同根因,见其注释)。
 */
export function createAirPlaySession(
  songId: string,
  deviceId: string,
  baseUrl: string,
): { token: string; streamUrl: string; expiresAt: number } {
  const token = randomBytes(16).toString("hex");
  const now = Date.now();
  const expiresAt = now + AIRPLAY_SESSION_TTL_MS;
  try {
    sqlite.prepare("DELETE FROM airplay_stream_tokens WHERE exp < ?").run(now);
    const existing = sqlite
      .prepare(
        "SELECT token FROM airplay_stream_tokens WHERE song_id = ? AND device_id = ? AND exp > ? ORDER BY exp DESC LIMIT 1",
      )
      .get(songId, deviceId, now) as { token: string } | undefined;
    if (existing) {
      sqlite.prepare("UPDATE airplay_stream_tokens SET exp = ? WHERE token = ?").run(expiresAt, existing.token);
      return { token: existing.token, streamUrl: `${baseUrl}/rest/airplay/stream/${existing.token}`, expiresAt };
    }
    sqlite
      .prepare("INSERT INTO airplay_stream_tokens (token, song_id, device_id, exp) VALUES (?, ?, ?, ?)")
      .run(token, songId, deviceId, expiresAt);
  } catch (e) {
    // 建表失败(极旧库)不应让投屏整体失败:回退到一次性内存 token,本次播放仍可用。
    for (const [k, v] of memoryTokens) {
      if (v.songId === songId && v.deviceId === deviceId && v.expiresAt > now) {
        v.expiresAt = expiresAt;
        return { token: k, streamUrl: `${baseUrl}/rest/airplay/stream/${k}`, expiresAt };
      }
    }
    memoryTokens.set(token, { songId, deviceId, expiresAt });
  }
  return { token, streamUrl: `${baseUrl}/rest/airplay/stream/${token}`, expiresAt };
}

/** 内存回退表(仅 DB 不可用时的降级路径)。 */
const memoryTokens = new Map<string, { songId: string; deviceId: string; expiresAt: number }>();

/** 解析 AirPlay 取流凭证。过期即删并返回 null。 */
export function resolveAirPlaySession(token: string): { songId: string; deviceId: string } | null {
  const mem = memoryTokens.get(token);
  if (mem) {
    if (mem.expiresAt < Date.now()) {
      memoryTokens.delete(token);
      return null;
    }
    return { songId: mem.songId, deviceId: mem.deviceId };
  }
  try {
    const row = sqlite
      .prepare("SELECT song_id, device_id, exp FROM airplay_stream_tokens WHERE token = ?")
      .get(token) as { song_id: string; device_id: string; exp: number } | undefined;
    if (!row) return null;
    if (row.exp < Date.now()) {
      sqlite.prepare("DELETE FROM airplay_stream_tokens WHERE token = ?").run(token);
      return null;
    }
    return { songId: row.song_id, deviceId: row.device_id };
  } catch {
    return null;
  }
}
