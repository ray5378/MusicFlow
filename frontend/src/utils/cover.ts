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
  // 封面 <img> 无法携带请求头,鉴权凭据走 URL ?token=(与 /rest/stream 一致)。
  // 后端 getCoverArt 按 OpenSubsonic 规范要求鉴权,不带 token 会 401。
  const token = typeof window !== "undefined" ? localStorage.getItem("token") || "" : "";
  const q = `/rest/getCoverArt?id=${id}&size=${size}`;
  return token ? `${q}&token=${encodeURIComponent(token)}` : q;
}
