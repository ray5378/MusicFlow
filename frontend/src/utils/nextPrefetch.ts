// ==================== 下一首预取（本机 Web 客户端） ====================
//
// 背景：本机播放走 Howler（html5，单个 HTMLAudioElement），`ended` 之后才创建新的
// Howl 并请求 `/rest/stream`。外网播无损（单曲 30~80MB）要等「首包 + 整曲下载」才
// 开始响；服务端 prefetchCache/drainPreheat 只是把网络源整曲读进**服务端**内存，
// 不会提前把字节送到浏览器，本地无损更是直接读盘 —— 所以慢的是「客户端从 0 拉」。
//
// 做法：当前曲播放期间，把**下一首**的完整流用 fetch 拉成 Blob，切歌时用 blob URL
// 起播（瞬时开始，不再碰网络）。同一时间只预取 1 首、有体积上限、随时可取消；
// 任何失败都静默回退在线流，绝不阻塞切歌。
//
// 边界（勿破坏流转播放）：
//   - 只服务本机播放：投屏/流转开始、切到其它播放端时由 player 调 resetPrefetch()。
//   - 带 streamUrl 的远程歌不预取（其可用性由播放失败兜底）。
//   - 与 sendspin（raw 回环）、/rest/dlna|airplay 链路无任何交集。
//
// 开关：localStorage.mf.nextPrefetch = "0" 关闭；localStorage.mf.nextPrefetchMaxMB
// 可覆盖单曲体积上限（MB）。

/** 默认单曲上限：桌面 96MB、Safari/低内存设备 48MB（无损单曲通常 20~60MB）。 */
const DEFAULT_MAX_BYTES = 96 * 1024 * 1024;
const LOW_MEM_MAX_BYTES = 48 * 1024 * 1024;

interface InflightTask {
  songId: string;
  ctrl: AbortController;
  bytes: number;
}

interface ReadyBlob {
  songId: string;
  url: string;
  bytes: number;
}

let inflight: InflightTask | null = null;
let ready: ReadyBlob | null = null;

/** 开关：默认开，`mf.nextPrefetch = "0"` 可即时关闭（出问题不用发版）。 */
export function prefetchEnabled(): boolean {
  try {
    return localStorage.getItem("mf.nextPrefetch") !== "0";
  } catch {
    return true;
  }
}

/** 单曲体积上限（字节）：localStorage 覆盖 > 设备内存/浏览器判断 > 默认值。 */
function maxPrefetchBytes(): number {
  try {
    const mb = Number(localStorage.getItem("mf.nextPrefetchMaxMB") || 0);
    if (Number.isFinite(mb) && mb > 0) return Math.round(mb * 1024 * 1024);
  } catch {
    /* localStorage 不可用（隐私模式）→ 走默认 */
  }
  const nav = typeof navigator !== "undefined" ? (navigator as any) : null;
  const mem = Number(nav?.deviceMemory || 0);
  const ua = String(nav?.userAgent || "");
  const isSafari = /^((?!chrome|android|crios|fxios).)*safari/i.test(ua);
  if (isSafari || (mem > 0 && mem <= 4)) return LOW_MEM_MAX_BYTES;
  return DEFAULT_MAX_BYTES;
}

function revokeReady(): void {
  if (!ready) return;
  try {
    URL.revokeObjectURL(ready.url);
  } catch {
    /* ignore */
  }
  ready = null;
}

/** 中止进行中的预取、释放已备好的 blob（投屏/流转/清队列/登出时调用）。 */
export function resetPrefetch(): void {
  if (inflight) {
    try {
      inflight.ctrl.abort();
    } catch {
      /* ignore */
    }
    inflight = null;
  }
  revokeReady();
}

/** 预取下一首：url 由调用方用与播放完全一致的 getStreamUrl(song) 生成。 */
export function prefetchNext(songId: string, url: string): void {
  if (!prefetchEnabled()) return;
  if (!songId || !url) return;
  if (inflight?.songId === songId || ready?.songId === songId) return;
  // 同一时间只保留 1 份：换下一首时旧任务/旧 blob 一律作废。
  resetPrefetch();
  const item: InflightTask = { songId, ctrl: new AbortController(), bytes: 0 };
  inflight = item;
  void runPrefetch(item, url);
}

async function runPrefetch(item: InflightTask, url: string): Promise<void> {
  try {
    const res = await fetch(url, { signal: item.ctrl.signal, credentials: "same-origin" });
    if (!res.ok || !res.body) throw new Error(`prefetch http ${res.status}`);
    const reader = res.body.getReader();
    const chunks: BlobPart[] = [];
    const cap = maxPrefetchBytes();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (inflight !== item) {
        // 已被新的预取/取消取代：尽快结束这条连接，别把带宽留在这首上。
        void reader.cancel().catch(() => {});
        return;
      }
      item.bytes += value.byteLength;
      if (item.bytes > cap) throw new Error("prefetch over-cap");
      chunks.push(value);
    }
    if (item.ctrl.signal.aborted || inflight !== item) return;
    if (typeof URL.createObjectURL !== "function") return;
    const type = res.headers.get("content-type") || "application/octet-stream";
    ready = { songId: item.songId, url: URL.createObjectURL(new Blob(chunks, { type })), bytes: item.bytes };
    inflight = null;
  } catch {
    // 网络错误 / 超时 / 超上限 / 被取消 —— 一律静默，切歌时回退在线流。
    if (inflight === item) inflight = null;
  }
}

/** 切歌时取走已备好的 blob URL（取走即消费；调用方负责在 unload 后 revoke）。 */
export function takePrefetched(songId: string): string | null {
  if (!ready || ready.songId !== songId) return null;
  const url = ready.url;
  ready = null;
  return url;
}

/** 调试用状态快照（供控制台/测试观察，不参与播放逻辑）。 */
export function prefetchStatus(): { songId: string; bytes: number; ready: boolean; failed: boolean } {
  if (inflight) return { songId: inflight.songId, bytes: inflight.bytes, ready: false, failed: false };
  if (ready) return { songId: ready.songId, bytes: ready.bytes, ready: true, failed: false };
  return { songId: "", bytes: 0, ready: false, failed: true };
}
