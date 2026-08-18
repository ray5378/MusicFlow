// P0-B 批量日志迁移:把各文件的 console.error 迁移为 createLogger 的 log.error。
// 规则:
//   - 提取消息头部 [TAG] 作为 logger 前缀(无 TAG 用文件名大写),消息体去掉 [TAG] 与尾冒号
//   - `console.error(msg, err)` → `log.error(msg, { err })` ; `console.error(msg)` → `log.error(msg)`
//   - 文件自动注入 import + `const log = createLogger("TAG")`(若尚未存在)
// 用法: node scripts/migrate-logger.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".ts") && fs.readFileSync(p, "utf8").includes("console.error(")) files.push(p);
  }
})(root);

const RE = /console\.error\((\s*)(`[^`]*`|"[^"]*"|'[^']*')(\s*,\s*([^;]+?))?\s*\);/g;

let total = 0;
for (const p of files) {
  const rel = path.relative(root, p).replace(/\\/g, "/");
  let src = fs.readFileSync(p, "utf8");
  let tag = null;
  const replaced = src.replace(RE, (m, ws, q, argPart, errExpr) => {
    total++;
    const inner = q.slice(1, -1);
    const tagM = inner.match(/^\[([A-Za-z0-9-]+)\]\s*/);
    if (tagM) tag = tagM[1];
    const msg = inner.replace(/^\[([A-Za-z0-9-]+)\]\s*/, "").replace(/:\s*$/, "").trim();
    const err = errExpr ? errExpr.trim() : null;
    return `log.error(${q[0]}${msg}${q[0]}${err ? `, { err: ${err} }` : ""});`;
  });
  if (replaced === src) continue;
  tag = tag || path.basename(p, ".ts").toUpperCase();
  // 注入 import + 实例
  let out = replaced;
  if (!/createLogger/.test(out)) {
    const depth = rel.split("/").length - 1;
    const importLine = `import { createLogger } from "${"../".repeat(depth)}utils/logger.js";`;
    const lastImport = [...out.matchAll(/^import .*$/gm)].pop();
    if (lastImport) {
      const idx = lastImport.index + lastImport[0].length;
      out = out.slice(0, idx) + "\n" + importLine + out.slice(idx);
    } else {
      out = importLine + "\n" + out;
    }
    out = out.replace(/\n(export (const|function|class|async function|interface|type|enum)\b)/m, `\nconst log = createLogger("${tag}");\n$1`);
  }
  fs.writeFileSync(p, out);
  console.log(`  ${rel} (tag=${tag})`);
}
console.log(`\n迁移 ${total} 处 console.error,涉及文件数=${files.length}。`);
