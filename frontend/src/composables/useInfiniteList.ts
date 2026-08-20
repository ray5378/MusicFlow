// 全库统一无限滚动:窗口化分块加载 + 稀疏缓存 + 窗口外剪枝。
// 与 HA 卡片(musicflow-remote-card)同构,供行式列表(SongTable)与卡片网格共用:
// - 服务端按 offset/size 分页,一次只拉一块(CHUNK),内存峰值恒定 = 窗口 ± 余量;
// - 以「全长稀疏数组」为共享缓存(songs.value globalIdx → item,未加载槽位为 undefined),
//   由渲染层(SongTable 虚拟滚动 / 网格 tile)只取视口窗口渲染,占位槽等待块到达后填充;
// - 随滚动按块预取(并发上限 concurrency),窗口移动超过 keepRows 后,把范围外的整块 slot
//   置为 undefined 释放歌曲对象,保证缓存不随浏览过的条目数增长;回退到保留区(±prefetch)
//   直接复用,避免抖拉。
import { ref } from "vue";

export interface RangeResult<T> {
  items: T[];
  /** 服务端总数;为负/缺省表示无分页信息(如远程整包返回) */
  total?: number;
}
export type RangeFetcher<T> = (offset: number, size: number) => Promise<RangeResult<T>>;

export interface UseInfiniteListOptions {
  /** 每块条数(服务端 offset/size 分页) */
  chunk?: number;
  /** 窗口外剪枝保留余量(行):回退时直接复用,避免抖拉;≥ chunk 效果更稳 */
  keepRows?: number;
  /** 窗口外再预取的额外块数(平滑快速滚动) */
  prefetchBlocks?: number;
  /** 同时在途的块请求上限 */
  concurrency?: number;
}

export function useInfiniteList<T = any>(fetcher: RangeFetcher<T>, options: UseInfiniteListOptions = {}) {
  const chunk = options.chunk ?? 200;
  const keepRows = options.keepRows ?? chunk;
  const prefetchBlocks = options.prefetchBlocks ?? 1;
  const concurrency = options.concurrency ?? 2;
  const margin = keepRows + prefetchBlocks * chunk;
  // 剪枝宽于预取:保留区 = 窗口 ± margin;窗口在 margin 内滚动复用,跳出后丢弃整块。
  const keepMargin = margin;

  /** 全长稀疏数组:globalIdx → item,未加载槽位为 undefined(渲染层据此显示占位)。 */
  const list = ref<T[]>([]);
  const loading = ref(false);
  const error = ref("");
  const total = ref(0);

  const loaded = new Set<number>(); // 已成功加载的块号
  const inflight = new Set<number>(); // 在途块号
  let seq = 0;
  let totalKnown = false;
  // 当前可视化窗口(行),块到达后据此继续补拉被并发限流压下的邻居块。
  let activeStart = 0;
  let activeEnd = 120;

  function writeChunk(ci: number, items: T[]) {
    const base = ci * chunk;
    // ref.value 在 Vue 里的元素类型是 UnwrapRefSimple<T>,与 T 不直接兼容;
    // 稀疏缓存只是「槽位写入」,用宽松类型避免无意义的协变报错。
    const arr = list.value as any[];
    const n = arr.length;
    for (let j = 0; j < items.length; j++) {
      const it = items[j];
      if (it == null) continue;
      const idx = base + j;
      if (idx < n) arr[idx] = it;
    }
  }

  // 扩容/触顶收缩到 total,保留已加载槽位的既有值(按 globalIdx 拷贝)。
  function resize(n: number) {
    const cur = list.value as any[];
    const fresh = new Array(n).fill(undefined) as any[];
    const ln = Math.min(cur.length, n);
    for (let i = 0; i < ln; i++) fresh[i] = cur[i];
    list.value = fresh as T[];
  }

  // 把某块全局槽位置为 undefined,释放歌曲对象(供 GC),不改变数组长度。
  function nullSlots(ci: number) {
    const arr = list.value as any[];
    const base = ci * chunk;
    const n = arr.length;
    for (let js = 0; js < chunk; js++) {
      const idx = base + js;
      if (idx >= n) break;
      arr[idx] = undefined;
    }
  }

  async function ensureChunkBase(ci: number) {
    const mySeq = seq;
    fetcher(ci * chunk, chunk)
      .then((r) => {
        if (mySeq !== seq) return; // 已被 reload/reset 作废
        inflight.delete(ci);
        const t = typeof r.total === "number" ? r.total : -1;
        if (t >= 0) {
          const wasKnown = totalKnown;
          if (!totalKnown || list.value.length !== t) resize(t);
          totalKnown = true;
          total.value = t;
          writeChunk(ci, r.items);
          if (!wasKnown) loading.value = false;
        } else {
          writeChunk(ci, r.items);
        }
        loaded.add(ci);
        scheduleNext();
      })
      .catch((e) => {
        if (mySeq !== seq) return;
        inflight.delete(ci);
        error.value = String((e && e.message) || e);
        if (!totalKnown) loading.value = false;
        scheduleNext();
      });
  }

  function ensureChunk(ci: number) {
    if (inflight.has(ci) || loaded.has(ci)) return;
    if (inflight.size >= concurrency) return; // 被并发限流,等块到达后由 scheduleNext 续拉
    inflight.add(ci);
    if (!totalKnown && !loading.value) loading.value = true;
    void ensureChunkBase(ci);
  }

  function scheduleNext() {
    onWindow(activeStart, activeEnd);
  }

  /** 渲染层滚动通知进入(global 行区间);同时负责预取与剪枝。 */
  function onWindow(startRow: number, endRow: number) {
    if (!totalKnown) return;
    activeStart = startRow;
    activeEnd = endRow;
    const first = Math.max(0, Math.floor((startRow - keepMargin) / chunk));
    const last = Math.floor((Math.min(total.value - 1, endRow + keepMargin)) / chunk);
    // 剪枝:窗口 ± keepMargin 外的旧块置 undefined 并移除「已加载」标记。
    if (loaded.size) {
      for (const ci of [...loaded]) {
        if (ci < first || ci > last) {
          nullSlots(ci);
          loaded.delete(ci);
        }
      }
    }
    // 预取范围内缺失的块。
    for (let ci = first; ci <= last; ci++) ensureChunk(ci);
  }

  function init(startRow = 0, endRow = 120) {
    seq++;
    totalKnown = false;
    total.value = 0;
    list.value = [];
    loaded.clear();
    inflight.clear();
    loading.value = true;
    error.value = "";
    activeStart = startRow;
    activeEnd = endRow;
    ensureChunk(Math.floor(startRow / chunk)); // 先取窗口所在块拿 total,再按窗口扩充
  }

  return { list, loading, error, total, init, reload: init, onWindow };
}