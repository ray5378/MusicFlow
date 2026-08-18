// 主项目遗留清理:console.log/console.warn 单参数 → log.info/log.warn。
// 规则:
//   - 仅转换「引号/模板串后直接 )」的严格单参数调用(多参数/宿主 log 转发自动排除)
//   - 消息保留原样(含 [TAG],避免多 TAG 文件丢标签;logger 前缀用文件首个 TAG 或文件名)
//   - 排除: sandbox.ts / sandboxWorker.ts(worker 原生 ESM 加载,禁新增 import)、utils/logger.ts
// 用法: node scripts/migrate-info.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const EXCLUDE = new Set(["plugins/sandbox.ts", "plugins/sandboxWorker.ts", "utils/logger.ts"]);

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".ts")) {
      const rel = path.relative(root, p).replace(/\\/g, "/");
      if (!EXCLUDE.has(rel) && /console\.(log|warn)\(/.test(fs.readFileSync(p, "utf8"))) files.push(p);
    }
  }
})(root);

// 严格单参数: console.log(`...`|"..."|'...');  或 console.warn(...);
const RE = /console\.(log|warn)\((\s*)(`[^`]*`|"[^"]*"|'[^']*')(\s*)\);/g;

let total = 0;
for (const p of files) {
  const rel = path.relative(root, p).replace(/\\/g, "/");
  let src = fs.readFileSync(p, "utf8");
  let tag = null;
  const replaced = src.replace(RE, (m, kind, ws, q, ws2) => {
    total++;
    const inner = q.slice(1, -1);
    const tagM = inner.match(/^\[([A-Za-z0-9-]+)\]\s*/);
    if (tagM) tag = tagM[1];
    const method = kind === "warn" ? "warn" : "info";
    return `log.${method}(${q});`;
  });
  if (replaced === src) continue;
  tag = tag || path.basename(p, ".ts").toUpperCase();
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
console.log(`\n转换 ${total} 处 console.log/warn → log.info/warn,涉及 ${files.length} 文件。`);
