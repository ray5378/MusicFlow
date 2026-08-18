// P0-A 半自动错误码迁移:把 api/index.ts + auth/index.ts 的
// `c.json({ success: false, error: X })` 迁移为 `c.json(apiError(CODE, X))`。
// 用法: node scripts/migrate-errorcode.mjs [--apply]
// 默认 dry-run 打印映射表;加 --apply 才写文件。
// 关键词 → BusinessErrorCode 映射(基于错误文案):
//   不存在/未找到 → NOT_FOUND; 无权/权限 → FORBIDDEN;
//   正在进行/已在/重复/未启用 → CONFLICT; 缺少/无效/必须/不能/非法/不支持 → INVALID_PARAM;
//   失败/连接/不可用/无法 → UPSTREAM_ERROR; 默认 → INTERNAL
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const files = ["routes/api/index.ts", "routes/auth/index.ts"];

const CODE = {
  notFound: /不存在|未找到|尚无任务记录/,
  forbidden: /无权|权限|未登录/,
  conflict: /正在进行|已在|重复|未启用|已禁用|正在扫描|正在运行|刚导入过|无需/,
  invalid: /缺少|无效|必须|不能为空|非法|不支持|不是|请输入|请选择/,
  upstream: /失败|连接|不可用|无法|超时/,
};

function inferCode(msg) {
  if (CODE.notFound.test(msg)) return "NOT_FOUND";
  if (CODE.forbidden.test(msg)) return "FORBIDDEN";
  if (CODE.conflict.test(msg)) return "CONFLICT";
  if (CODE.invalid.test(msg)) return "INVALID_PARAM";
  if (CODE.upstream.test(msg)) return "UPSTREAM_ERROR";
  return "INTERNAL";
}

// 匹配 c.json({ success: false, error: X }) 与 c.json({ success: false, error: X }, status)
const RE = /c\.json\(\{ success: false, error: ([^}]*?) \}(, \d+)?\)/g;

let apply = process.argv.includes("--apply");
let total = 0;
for (const f of files) {
  const p = path.join(root, f);
  const src = fs.readFileSync(p, "utf8");
  const out = [];
  let m;
  let last = 0;
  while ((m = RE.exec(src)) !== null) {
    const msgExpr = m[1].trim();
    // 取文案关键词(字符串字面量/模板串直接取,表达式取兜底字面量)
    const lit = (msgExpr.match(/["'`]([^"'`]*)["'`]/) || [])[1] || msgExpr;
    const code = inferCode(lit);
    total++;
    out.push(`  L${String(src.slice(0, m.index).split("\n").length).padStart(4)} [${code}] ${lit.slice(0, 60)}`);
    last = m.index + m[0].length;
    if (last > m.index) { /* noop */ }
  }
  if (out.length) {
    console.log(`\n===== ${f} (${out.length} 处) =====`);
    console.log(out.join("\n"));
  }
  if (apply) {
    const replaced = src.replace(RE, (match, msgExpr, status) => {
      const lit = (msgExpr.match(/["'`]([^"'`]*)["'`]/) || [])[1] || msgExpr;
      const code = inferCode(lit);
      return `c.json(apiError(BusinessErrorCode.${code}, ${msgExpr.trim()})${status || ""})`;
    });
    fs.writeFileSync(p, replaced);
  }
}
console.log(`\n总计 ${total} 处匹配。${apply ? "已应用" : "(dry-run,加 --apply 应用)"}`);
