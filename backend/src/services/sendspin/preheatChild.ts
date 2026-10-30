// ==================== 子进程侧:曲末预热(主进程下推) ====================
//
// 为什么要有这个文件(2026-10-30 240 真机取证):
//   主进程的 drainPreheat 在曲末前 9s 就把「下一首能不能播」算完了
//   (`曲末预热 resolve=cached ms=1~6`),但泵(`streamEngine.defaultSource`)跑在
//   supervisor fork 的**子进程**里。子进程的 playableCache / fallbackCache 是
//   module-local Map,看不到主进程的结论 ⇒ 泵每次起播都要在本进程里重新做一遍
//   `resolvePlayableRow`(实测 38 次全部 ensure-ok ms=2900~3930,命中 fresh-cache 0 次)。
//   这 3s 落在「曲末排空窗口(实测 9760~9786ms)」里,一旦超窗就是可闻静音。
//
//   与 ipcProtocol 里 `songUnplayable`(子→主,负缓存回传)是同一类跨进程缓存断层的
//   **反方向**。2026-10-28 那次事故("子进程已判死,主进程仍读 unknown 又播一遍假歌")
//   已经证明:module-local 缓存差异必须显式打通,不能指望"另一侧反正会自己算一遍"。
//
// 只做 resolve(可播结论 + 换源链),**不建流、不取字节**:
//   整曲字节由主进程 prefetchCache 预取,泵的 ffmpeg 从回环 `/rest/stream` 拉 ——
//   那条链路本来就能命中(实测 0.17s)。在这里重复预取只会白占内存与带宽。
//
// 红线:本模块**永不抛、永不阻塞**。预热失败只是回到"起播时再算一遍"的旧行为,
// 绝不允许影响播放主链路。
import { createLogger } from "../../utils/logger.js";
import { hasActivePump } from "./streamEngine.js";

const log = createLogger("Sendspin-preheatChild");

/** 已预热过的歌曲(幂等)。有上限:长会话里逐首累积,满了整批清掉重新来。 */
const warmed = new Set<string>();
const WARMED_MAX = 512;

/**
 * 门控:本进程里有没有「用过 sendspin 的组」。
 *
 * 纯 DLNA / 直连 AirPlay 播放时,主进程同样会在曲末前 9s 触发预热钩子;此时为它去
 * 探一遍源纯属浪费(每首一次 3s 的对外探测,会占上游配额,还可能踩平台限流)。
 * 判据用泵注册表:泵按组常驻创建、`stopGroupPump` 时才删 —— 有条目 = 这个组确实
 * 归 sendspin 在推。组刚建、泵还没建的那一瞬会被挡掉,但那也正是"还没起播"的时候。
 */
function pumpsInUse(): boolean {
  try {
    return hasActivePump();
  } catch {
    // 运行时装配未完成:保守地**不预热**(宁可慢,不要白探)。
    return false;
  }
}

/**
 * 在本(子)进程内预热一首歌的可播结论。同步返回,实际探测在后台跑。
 *
 * @param songId 曲目 id(主进程已 stripPlayerPrefix 过的裸 songId)
 */
export function warmSongInChild(songId: string): void {
  const id = typeof songId === "string" ? songId.trim() : "";
  if (!id) return;
  if (warmed.has(id)) return; // 幂等:同一首只探一次(命中不打日志)
  if (!pumpsInUse()) {
    log.debug(`子进程预热跳过 song=${id}(本进程没有在用 sendspin 的组)`);
    return;
  }
  if (warmed.size >= WARMED_MAX) warmed.clear();
  warmed.add(id);
  const t0 = Date.now();
  void (async () => {
    try {
      const { resolvePlayableRow } = await import("../source/resolveAudio.js");
      const r = await resolvePlayableRow(id);
      // 成功路径成功 = 本进程的 playableCache 已被 ensurePlayableStream 写热,
      // 泵起播时 resolvePlayableRow 会直接走 fresh-cache。
      log.info(
        `子进程预热 ev=child-preheat song=${id} ok=${r.row ? 1 : 0}` +
          ` reason=${r.reason} ms=${Date.now() - t0}`,
      );
    } catch (e: any) {
      log.debug(`子进程预热异常(已忽略) song=${id}: ${String(e?.message || e).slice(0, 160)}`);
    }
  })();
}

/** 测试用:清空幂等标记。 */
export function resetPreheatChildStateForTest(): void {
  warmed.clear();
}
