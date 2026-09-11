// ==================== 组内跨源优选(播放优选插件) ====================
// 「播放优选(首选 Local)」插件的两个方向:
//   1. web → local/webdav 优选:web 行出流时,若同曲多源组内有本地/WebDAV 核心
//      曲库源,优先用本地源(无损优先)。
//   2. local/webdav → web 回退:本地源不可用(文件缺失/WebDAV 探测失败)时,
//      回退组内 web 源,保证组内永远有可播源。
//
// 两个方向都必须**先检测候选源是否真的有效**再切换 —— 直接切到失效的本地源
// 会让原本能播的歌播不出来。local 用零成本 existsSync,WebDAV 用 HEAD(+GET
// Range 兜底),失败记忆 5 分钟(见 utils/localSourceProbe.ts)。
//
// /rest/stream、/rest/dlna/stream/:token 与流可播性探测(ensurePlayableStream)
// 共用这一份解析,保证「探测结论」与「实际出流」始终一致 —— 否则出流会换源
// 的歌会被探测判成无可用音源,客户端照着判定就白跳一首。
import { db } from "../../db/index.js";
import { songs } from "../../db/schema.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import { probeLocalSourceOk } from "../../utils/localSourceProbe.js";
import {
  playPreferenceActive,
  preferLocalEnabled,
  fallbackToWebEnabled,
} from "../plugin/core/playPreference.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("Source");

type SongRow = typeof songs.$inferSelect;

/**
 * 解析实际出流应使用的行。返回的可能是同一行(无需换源),也可能是组内兄弟行。
 * 插件总开关关闭时原样返回 —— 「插件关闭 = 按原源播放」。
 */
export async function resolvePreferredSong(song: SongRow): Promise<SongRow> {
  // 方向 1:web → 组内 local/webdav 优选(local 优先,然后 webdav)。
  if (
    (song.type || "local") === "web" &&
    song.groupId &&
    playPreferenceActive() &&
    preferLocalEnabled()
  ) {
    try {
      const alts = db
        .select()
        .from(songs)
        .where(
          and(eq(songs.groupId, song.groupId), inArray(songs.type, ["local", "webdav"])),
        )
        .orderBy(sql`CASE ${songs.type} WHEN 'local' THEN 0 ELSE 1 END`)
        .all();
      for (const alt of alts) {
        // 必须先验证候选源真实有效:本地文件不存在 / WebDAV 不可达时继续试下一个。
        if (!(await probeLocalSourceOk(alt))) {
          log.info("播放优选:候选源不可用,继续下一个", {
            webId: song.id,
            altId: alt.id,
            type: alt.type,
          });
          continue;
        }
        log.info("播放优选:web 歌曲切换到核心曲库源", {
          webId: song.id,
          localId: alt.id,
          type: alt.type,
        });
        return alt;
      }
    } catch (e) {
      log.warn("播放优选查询失败,按原源播放", {
        id: song.id,
        err: (e as Error)?.message || e,
      });
    }
  }

  // 方向 2:local/webdav → 组内 web 回退(首选 Local,失败回退平台)。
  if (
    (song.type || "local") !== "web" &&
    song.groupId &&
    playPreferenceActive() &&
    fallbackToWebEnabled()
  ) {
    if (!(await probeLocalSourceOk(song))) {
      try {
        const alt = db
          .select()
          .from(songs)
          .where(and(eq(songs.groupId, song.groupId), eq(songs.type, "web")))
          .orderBy(songs.createdAt)
          .limit(1)
          .get();
        if (alt) {
          log.info("流回退:核心曲库源不可用,切组内 web 源", {
            localId: song.id,
            webId: alt.id,
            title: alt.title || "",
          });
          return alt;
        }
      } catch (e) {
        log.warn("流回退查询失败,按原源播放", {
          id: song.id,
          err: (e as Error)?.message || e,
        });
      }
    }
  }
  return song;
}
