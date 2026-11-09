// 视口感知的封面图地址。
//
// 网格卡片在手机端只渲染约 120-140px，但过去统一请求 size=300 的图，
// 低端机要解码/驻留一张更大的位图，滚动时浪费 CPU 与内存。
// 这里按视口返回更小尺寸：移动端取 min(fallback, 150)，桌面端保持原值。
// 视觉上网格卡片几乎无差（150px 已超出其显示尺寸），但解码更轻。
// 详情页大图（hero）仍走原 size，因为那是单张大图、质量优先。

export function coverUrl(id: string | undefined, fallback = 300): string {
  if (!id) return "";
  const size =
    typeof window !== "undefined" && window.innerWidth <= 768
      ? Math.min(fallback, 150)
      : fallback;
  const q = `/rest/getCoverArt?id=${id}&size=${size}`;
  // 封面 <img> 无法携带请求头。2026-11-09 起登录会把 JWT 同步到 mf_token cookie
  // (见 stores/auth.ts),由浏览器自动随图片请求携带 —— URL 因此不含 token,
  // 保持稳定,浏览器缓存可跨会话复用。
  // cookie 不可用(被浏览器禁用/同步未完成)时回退到旧的 ?token= 形式,保证不破图。
  const hasCookie =
    typeof document !== "undefined" && /(?:^|;\s*)mf_token=/.test(document.cookie);
  if (hasCookie) return q;
  const token = typeof window !== "undefined" ? localStorage.getItem("token") || "" : "";
  return token ? `${q}&token=${encodeURIComponent(token)}` : q;
}
