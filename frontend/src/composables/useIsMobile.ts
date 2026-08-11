import { ref, readonly } from "vue";

const MQ = "(max-width: 768px)";
const state = ref(typeof window !== "undefined" ? window.matchMedia(MQ).matches : false);

if (typeof window !== "undefined") {
  const mql = window.matchMedia(MQ);
  const onChange = (e: MediaQueryListEvent | MediaQueryList) => {
    state.value = "matches" in e ? e.matches : false;
  };
  if (mql.addEventListener) mql.addEventListener("change", onChange as any);
  else mql.addListener(onChange as any); // Safari < 14
}

/** 全局共享的移动端断点状态（≤768px） */
export function useIsMobile() {
  return readonly(state);
}
