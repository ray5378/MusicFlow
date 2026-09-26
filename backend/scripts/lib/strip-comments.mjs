// 守卫脚本共用的「剥注释」实现（字符串感知）。
//
// 为什么需要它（2026-09-27 缺陷沉淀）：
//   原先各守卫都自带朴素实现，用一条「块注释正则 + 整行注释正则」剥注释。
//   该正则**不认识字符串字面量**。路由里存在通配路由字符串，例如
//   `app.use("/v1/peers/:peerId/*", ...)`，其中的斜杠星号会被当成块注释起点，
//   向后贪婪吞到最近的闭合标记。单文件时顺序常常凑巧没事；但路由按业务域拆分后，
//   守卫改为拼接 `backend/src/routes/api/` 全目录，`airplay.ts` 排在 `peers.ts` 之前
//   → `peers.ts` 的 `/v1/peers` 路由被整段吞掉 → check-dlna-realtime.mjs 假红。
//
// 本实现按字符扫描：
//   · 跳过 ' " ` 三种字符串字面量（含反斜杠转义）——这是修掉上面那个坑的关键；
//   · 斜杠星号开头的块注释，剥离到最近的闭合标记；
//   · 双斜杠行注释，剥离到行尾；但**前一字符是反斜杠或冒号**时不算注释，
//     避免误伤正则字面量里的转义斜杠与字符串外的 URL。
//
// 不解析正则字面量与模板插值 —— 对静态守卫足够，且不会再被字符串里的通配符带偏。
export function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  let quote = "";
  while (i < n) {
    const c = src[i];
    const c2 = i + 1 < n ? src[i + 1] : "";
    if (quote) {
      out += c;
      if (c === "\\") {
        if (c2) out += c2;
        i += 2;
        continue;
      }
      if (c === quote) quote = "";
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && c2 === "/") {
      const prev = i > 0 ? src[i - 1] : "";
      if (prev !== "\\" && prev !== ":") {
        while (i < n && src[i] !== "\n") i += 1;
        continue;
      }
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && c2 === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

export default stripComments;
