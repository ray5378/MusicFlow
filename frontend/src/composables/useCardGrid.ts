// 卡片网格窗口化加载:基于 useInfiniteList 的按需分块 fetch + 稀疏缓存 + 越界剪枝,
// 并针对「整页铺满」的卡片列表做视口可见区窗口化渲染。供歌单/专辑/艺术家网格共用。
//
// 与行式列表(SongTable)不同,卡片网格不能把「滚动高度」交给浏览器的 auto 布局,
// 否则会出现这两个 bug:
//  1) 桌面端乱跳:只渲染可见窗口时,容器高度 ≈ 一屏,前后滚动卸载/挂载让 scrollHeight
//     反复变化,滚动条与内容抖动;
//  2) 手机端无法下拉:容器高度只有一屏,页面几乎没有可滚动高度,懒加载永远无法触发。
//
// 因此这里采用「固定高度 spacer + 绝对定位虚拟卡片」:
//  - 容器显式 height = ⌈total/cols⌉ × rowHeight,滚动范围恒定(不抖动);
//  - 每张卡(含未加载占位)按全局下标绝对定位在 top=row×rowHeight / left=col×(w+gap);
//  - 列数 cols 跟随移动端断点(≤768px 固定 2 列,与匹配的移动 CSS 一致),桌面由
//    minTileWidth 反推;
//  - 用 ResizeObserver 监听容器宽度,容器变化(含首挂载)时重算布局与可见窗口。
import { ref, computed, onBeforeUnmount, type CSSProperties } from "vue";
import { useInfiniteList, type RangeFetcher, type UseInfiniteListOptions } from "./useInfiniteList";
import { useIsMobile } from "./useIsMobile";

export interface CardGridOptions extends UseInfiniteListOptions {
  /** 网格最小卡片宽(桌面由容器宽反推列数;移动端固定 2 列) */
  minTileWidth?: number;
  /** 卡片间距(px,与移动 CSS 的 gap 一致) */
  gap?: number;
  /** 封面纵横比(width:height),用于由卡宽估算行高(行高 = 卡宽/纵横比 + 信息条高) */
  coverRatio?: number;
  /** 封面下方信息条高度(px,并入行高估算) */
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
  const isMobile = useIsMobile();

  /** 网格容器(native):固定高度 spacer,虚拟卡片绝对定位其内 */
  const gridEl = ref<HTMLElement | null>(null);
  const cols = ref(1); // 当前列数
  const tileW = ref(minTileWidth); // 每格卡宽(px,由容器宽与列数反算)
  const rowH = ref(fixedRowHeight ?? (minTileWidth / coverRatio + rowFooter)); // 每行高/每卡高(px)
  const startIndex = ref(0); // 首个可见卡片(全局下标)
  const endIndex = ref(0);

  /** 由容器宽度反推列数 + 每格卡宽 + 行高。移动端固定 2 列(与移动 CSS 一致)。 */
  function computeLayout() {
    const el = gridEl.value;
    if (!el) return;
    const w = el.clientWidth;
    if (w <= 0) return;
    const c = isMobile.value ? 2 : Math.max(1, Math.floor((w + gap) / (minTileWidth + gap)));
    cols.value = c;
    const tw = (w - (c - 1) * gap) / c;
    tileW.value = tw;
    rowH.value = fixedRowHeight ?? (tw / coverRatio + rowFooter);
  }

  /** 容器固定高度(px):滚动范围恒定 → 桌面不抖动、手机可下拉 */
  const frameHeight = computed(() => {
    const total = inf.total.value;
    if (!total || total <= 0) return "0px";
    return Math.ceil(total / Math.max(1, cols.value)) * rowH.value + "px";
  });

  /** 某张卡(或占位)的绝对定位样式:top=row×rowH,left=col×(w+gap) */
  function cardStyle(idx: number): CSSProperties {
    const c = Math.max(1, cols.value);
    const row = Math.floor(idx / c);
    const col = idx % c;
    const tw = tileW.value;
    const rh = rowH.value;
    return {
      position: "absolute",
      top: row * rh + "px",
      left: col * (tw + gap) + "px",
      width: tw + "px",
      height: rh + "px",
    };
  }

  /** 计算可见卡片区间并交给底层按块预取 + 剪枝。 */
  function recomputeWindow() {
    computeLayout();
    const el = gridEl.value;
    if (!el) return;
    const total = inf.total.value;
    if (total <= 0 || !inf.list.value.length) return;
    const c = cols.value;
    const rh = rowH.value;
    const root = findScrollRoot(el);
    const isWin = root === window;
    const st = isWin ? window.scrollY : (root as HTMLElement).scrollTop;
    const vh = isWin ? window.innerHeight : (root as HTMLElement).clientHeight;
    // 网格相对滚动容器内容坐标系顶部的偏移;容器高度固定,该偏移恒定。
    const elRect = el.getBoundingClientRect();
    const rootTop = isWin ? 0 : (root as HTMLElement).getBoundingClientRect().top;
    const topInRoot = elRect.top - rootTop + st;
    const firstRow = Math.max(0, Math.floor((st - topInRoot) / rh) - bufferRows);
    const lastRow = Math.min(Math.ceil(total / c), Math.ceil((st + vh - topInRoot) / rh) + bufferRows);
    startIndex.value = Math.max(0, firstRow * c);
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
  let ro: ResizeObserver | null = null;
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
    // 容器宽度变化(含首挂载)时重算列数/行高并重算窗口。
    ro = new ResizeObserver(() => schedule());
    if (gridEl.value) ro.observe(gridEl.value);
    schedule();
  }
  function unbind() {
    if (!bound) return;
    if (scrollFn) root.removeEventListener("scroll", scrollFn);
    if (resizeFn) window.removeEventListener("resize", resizeFn);
    if (ro) { ro.disconnect(); ro = null; }
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
    frameHeight,
    cardStyle,
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