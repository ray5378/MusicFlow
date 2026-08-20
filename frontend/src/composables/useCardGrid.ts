// 卡片网格窗口化加载:基于 useInfiniteList 的按需分块 fetch + 稀疏缓存 + 越界剪枝,
// 并针对「CSS Grid 响应式铺满」的整页卡片列表做视口可见区窗口化渲染。
// 与行式列表(SongTable)同构,供歌单/专辑/艺术家网格共用:
// - 网格采用 auto-fill/minmax,列数随容器宽度变化,用 minTileWidth+gap 反推 cols;
// - 按固定「行高 = 卡宽 × 纵横比 + 下方信息条高」估算行高,由 scrollTop 求出可见行区间,
//   换算成全局卡片下标范围交给 onWindow 按块预取 + 剪枝;
// - 模板只渲染 [start,end) 区间内的卡片,区间外的整行置 undefined 释放对象,
//   滚动浏览过的卡片不累积,内存恒定 = 窗口 ± 余量。
import { ref, onBeforeUnmount } from "vue";
import { useInfiniteList, type RangeFetcher, type UseInfiniteListOptions } from "./useInfiniteList";

export interface CardGridOptions extends UseInfiniteListOptions {
  /** 网格最小卡片宽(与 CSS minmax 一致),用于由容器宽反推列数 */
  minTileWidth?: number;
  /** 网格 gap(与 CSS 一致) */
  gap?: number;
  /** 封面纵横比(width:height),用于由卡宽估算行高 */
  coverRatio?: number;
  /** 封面下方信息条高度(px) */
  rowFooter?: number;
  /** 固定行高覆盖(px):适用于卡片高度不随卡宽线性变化的布局(如圆形头像+文字) */
  rowHeight?: number;
  /** 视口上下额外缓冲的「可见行外的渲染行数」 */
  bufferRows?: number;
}

export function useCardGrid<T = any>(fetcher: RangeFetcher<T>, options: CardGridOptions = {}) {
  const chunk = options.chunk ?? 200;
  const inf = useInfiniteList<T>(fetcher, options);
  const minTileWidth = options.minTileWidth ?? 200;
  const gap = options.gap ?? 18;
  const coverRatio = options.coverRatio ?? 1;
  const rowFooter = options.rowFooter ?? 64;
  const fixedRowHeight = options.rowHeight;
  const bufferRows = options.bufferRows ?? 1;

  /** 网格容器(native) */
  const gridEl = ref<HTMLElement | null>(null);
  const cols = ref(1); // 当前列数
  const startIndex = ref(0); // 首个可见卡片(全局下标)
  const endIndex = ref(0);

  /** 由容器宽度按 minmax 公式反推列数 + 每格卡宽 + 行高。 */
  function computeLayout() {
    const el = gridEl.value;
    if (!el) return;
    const w = el.clientWidth;
    if (w <= 0) return;
    const c = Math.max(1, Math.floor((w + gap) / (minTileWidth + gap)));
    cols.value = c;
  }
  function tileWidth(): number {
    const el = gridEl.value;
    const w = el?.clientWidth ?? 0;
    if (w <= 0) return minTileWidth;
    return (w - (cols.value - 1) * gap) / cols.value;
  }
  function rowHeight(): number {
    return fixedRowHeight ?? (tileWidth() / coverRatio + rowFooter);
  }

  /** 计算可见卡片区间并交给底层按块预取 + 剪枝。 */
  function recomputeWindow() {
    computeLayout();
    const el = gridEl.value;
    if (!el) return;
    const total = inf.total.value;
    if (total <= 0 || !inf.list.value.length) return;
    const rh = rowHeight();
    const root = findScrollRoot(el);
    const isWin = root === window;
    const st = isWin ? window.scrollY : (root as HTMLElement).scrollTop;
    const vh = isWin ? window.innerHeight : (root as HTMLElement).clientHeight;
    // 网格相对滚动容器内容坐标系顶部的偏移。
    const elRect = el.getBoundingClientRect();
    const rootTop = isWin ? 0 : (root as HTMLElement).getBoundingClientRect().top;
    const topInRoot = elRect.top - rootTop + st;
    const c = cols.value;
    const firstRow = Math.max(0, Math.floor((st - topInRoot) / rh) - bufferRows);
    const lastRow = Math.min(
      Math.ceil(total / c),
      Math.ceil((st + vh - topInRoot) / rh) + bufferRows
    );
    startIndex.value = firstRow * c;
    endIndex.value = Math.max(startIndex.value, Math.min(total, lastRow * c));
    inf.onWindow(startIndex.value, endIndex.value);
  }
  function findScrollRoot(el: HTMLElement): HTMLElement | Window {
    let node = el.parentElement ?? null;
    while (node) {
      const oy = getComputedStyle(node).overflowY;
      if (oy === "auto" || oy === "scroll") return node;
      node = node.parentElement;
    }
    return window;
  }

  let bound = false;
  let scrollFn: (() => void) | null = null;
  let resizeFn: (() => void) | null = null;
  let root: HTMLElement | Window = window;
  const raf = { id: 0 };
  function schedule() {
    if (raf.id) return;
    raf.id = requestAnimationFrame(() => {
      raf.id = 0;
      recomputeWindow();
    });
  }
  function bind() {
    if (bound) return;
    bound = true;
    root = findScrollRoot(gridEl.value!);
    scrollFn = schedule;
    resizeFn = schedule;
    root.addEventListener("scroll", scrollFn, { passive: true });
    window.addEventListener("resize", resizeFn);
    schedule();
  }
  function unbind() {
    if (!bound) return;
    if (scrollFn) root.removeEventListener("scroll", scrollFn);
    if (resizeFn) window.removeEventListener("resize", resizeFn);
    if (raf.id) cancelAnimationFrame(raf.id);
    bound = false;
    scrollFn = null;
    resizeFn = null;
  }
  onBeforeUnmount(unbind);

  return {
    list: inf.list,
    loading: inf.loading,
    error: inf.error,
    total: inf.total,
    init: inf.init,
    reload: inf.init,
    onWindow: inf.onWindow,
    gridEl,
    cols,
    startIndex,
    endIndex,
    bindGrid: () => {
      // DOM 挂载后先布局再绑定滚动;列表长度/总数到达后重算一次窗口。
      if (!gridEl.value) return; // 网格被 v-if 收起(如远程模式)时等待重新挂载
      if (!bound) bind();
      schedule();
    },
    recomputeGrid: schedule,
  };
}

export type { RangeFetcher };