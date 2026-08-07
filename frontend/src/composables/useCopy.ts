import { ref, readonly } from "vue";
import { ElMessage } from "element-plus";

const copiedText = ref("");
let timer: ReturnType<typeof setTimeout> | null = null;

/** 复制文本到剪贴板(带非安全上下文的 execCommand fallback)。 */
export function useCopy() {
  async function copyText(text: string) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
  }

  const copy = async (text: string, label?: string) => {
    try {
      await copyText(text);
      if (label) ElMessage.success(`已复制 ${label}`);
    } catch {
      if (label) ElMessage.error("复制失败");
      return;
    }
    copiedText.value = text;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (copiedText.value === text) copiedText.value = "";
    }, 2000);
  };

  return { copy, copiedText: readonly(copiedText) };
}