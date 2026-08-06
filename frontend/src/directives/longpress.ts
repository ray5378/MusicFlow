import type { Directive, DirectiveBinding } from "vue";
import { lpBegin, lpMove, lpEnd } from "@/composables/useItemActions";

type LpCallback = (target?: EventTarget | null) => void;

interface LpState {
  cb: LpCallback;
  onStart: (e: TouchEvent) => void;
  onMove: () => void;
  onEnd: () => void;
}

const KEY = "__mfLongpress";

/**
 * v-longpress="() => openActionSheet(...)"
 * 也可接收触摸目标：v-longpress="(t) => onLongPress(t)"（列表容器上按行分发用）
 * 移动端长按 ~460ms 触发回调；手指移动即取消。
 * 会顺带屏蔽系统的长按菜单 / 文本选择，避免和自定义面板冲突。
 */
export const longpress: Directive<HTMLElement, LpCallback> = {
  mounted(el: HTMLElement, binding: DirectiveBinding<LpCallback>) {
    const st: LpState = {
      cb: binding.value,
      onStart: (e: TouchEvent) => {
        const target = e.target;
        lpBegin(() => st.cb?.(target));
      },
      onMove: () => lpMove(),
      onEnd: () => lpEnd(),
    };
    (el as any)[KEY] = st;

    el.style.setProperty("-webkit-touch-callout", "none");
    el.addEventListener("touchstart", st.onStart, { passive: true });
    el.addEventListener("touchmove", st.onMove, { passive: true });
    el.addEventListener("touchend", st.onEnd);
    el.addEventListener("touchcancel", st.onEnd);
    el.addEventListener("scroll", st.onMove, { passive: true });
  },
  updated(el: HTMLElement, binding: DirectiveBinding<LpCallback>) {
    const st = (el as any)[KEY] as LpState | undefined;
    if (st) st.cb = binding.value;
  },
  unmounted(el: HTMLElement) {
    const st = (el as any)[KEY] as LpState | undefined;
    if (!st) return;
    el.removeEventListener("touchstart", st.onStart);
    el.removeEventListener("touchmove", st.onMove);
    el.removeEventListener("touchend", st.onEnd);
    el.removeEventListener("touchcancel", st.onEnd);
    el.removeEventListener("scroll", st.onMove);
    delete (el as any)[KEY];
  },
};

export default longpress;
