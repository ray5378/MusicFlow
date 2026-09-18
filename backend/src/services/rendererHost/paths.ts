// ==================== 常驻渲染器子进程:路径解析 ====================
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/**
 * 解析「与调用方同目录」的子进程入口。
 *
 * 生产走编译产物(`dist/services/<biz>/child.js`),dev(tsx)下没有 .js,
 * 退回同目录的 `child.ts`(fork 会继承 tsx loader)。两种形态都不用手工配置。
 *
 * @param importMetaUrl 调用方模块的 `import.meta.url`(据此定位同目录)
 * @param entryFile 入口文件名,默认 `child.js`
 */
export function resolveChildEntry(importMetaUrl: string, entryFile = "child.js"): string {
  const here = path.dirname(fileURLToPath(importMetaUrl));
  const compiled = path.join(here, entryFile);
  if (fs.existsSync(compiled)) return compiled;
  return path.join(here, entryFile.replace(/\.js$/, ".ts"));
}
