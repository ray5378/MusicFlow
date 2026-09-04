import { ElMessage } from "element-plus";
import { gt } from "@/locales";

/**
 * 复制文本到剪贴板。
 * 优先用 Clipboard API（需要 HTTPS / 安全上下文）；
 * 在 HTTP、局域网 IP 等非安全上下文下自动回退到临时 textarea + execCommand，
 * 保证 Home Assistant 这类跑在内网 http 上的常驻客户端也能正常复制。
 * 失败时提示手动复制而不是直接静默失败。
 */
export async function copyText(text: string, successMsg = gt("clipboard.copied")): Promise<boolean> {
  if (text == null || text === "") {
    ElMessage.warning(gt("clipboard.empty"));
    return false;
  }

  // 1) 安全上下文下优先用 Clipboard API
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      ElMessage.success(successMsg);
      return true;
    } catch {
      // 落到兜底方案
    }
  }

  // 2) 兜底：临时 textarea + execCommand（主流浏览器在 http 下仍可用）
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.left = "-9999px";
    ta.style.opacity = "0";
    ta.setAttribute("readonly", "");
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    if (ok) {
      ElMessage.success(successMsg);
      return true;
    }
    throw new Error("execCommand returned false");
  } catch {
    ElMessage.warning(gt("clipboard.fallbackFailed"));
    return false;
  }
}
