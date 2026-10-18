import type { Directive, DirectiveBinding } from "vue";

type CoverUrl = string;

interface LazyState {
  url: CoverUrl;
  loaded: boolean;
  observer: IntersectionObserver | null;
}

const KEY = "__mfLazyCover";

// 已纳入观察的元素集合:unmounted 时移除(避免强引用阻碍回收)。
const observed = new Set<Element>();

function start(el: HTMLImageElement, st: LazyState) {
  if (typeof IntersectionObserver === "undefined") {
    // 兜底:无 IntersectionObserver(旧浏览器/非窗口环境)时立即赋值,退化为普通加载。
    if (st.url) el.src = st.url;
    st.loaded = true;
    return;
  }
  st.observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        // 靠近视口时才真正设置 src 触发请求,随后停止观察该元素。
        if (!st.loaded) {
          st.loaded = true;
          if (st.url) el.src = st.url;
        }
        st.observer?.disconnect();
        st.observer = null;
      }
    },
    // rootMargin 200px:提前约一屏开始加载,快速滚动也不易出现空白;
    // threshold 0:与视口任意相交即触发。
    // 不用原生 loading="lazy":桌面快网下其阈值过大,会把视口附近的整屏图片一次性预取,
    // 首页实测仍会一次发出约 130 张封面请求,起不到收敛作用;故自建观察精确控制发请求时机。
    { rootMargin: "200px", threshold: 0 },
  );
  st.observer.observe(el);
  observed.add(el);
}

/**
 * v-lazy-cover="url"
 *
 * 封面图精细化懒加载:只有当 <img> 距视口 200px 以内时才把 src 设为指令值,
 * 未靠近前**不设置 src**,浏览器因此不会提前发起任何图片请求。
 */
export const lazyCover: Directive<HTMLImageElement, CoverUrl> = {
  mounted(el: HTMLImageElement, binding: DirectiveBinding<CoverUrl>) {
    const st: LazyState = { url: String(binding.value || ""), loaded: false, observer: null };
    (el as any)[KEY] = st;
    start(el, st);
  },
  updated(el: HTMLImageElement, binding: DirectiveBinding<CoverUrl>) {
    const st = (el as any)[KEY] as LazyState | undefined;
    if (!st) return;
    const url = String(binding.value || "");
    if (st.url === url) return;
    st.url = url;
    // 指令值更新:若已加载过(观察器已断开)则重新走一遍(换图);
    // 尚未靠近视口则无需动作 —— 观察回调会用最新的 st.url 赋值。
    if (st.loaded) {
      st.loaded = false;
      start(el, st);
    }
  },
  unmounted(el: HTMLImageElement) {
    const st = (el as any)[KEY] as LazyState | undefined;
    st?.observer?.disconnect();
    delete (el as any)[KEY];
    observed.delete(el);
  },
};

export default lazyCover;
