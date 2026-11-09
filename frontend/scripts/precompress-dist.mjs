// 构建后对 dist 内文本资源做 Brotli 预压缩,生成同名 <file>.br。
// 后端 serveStatic({ precompressed: true }) 会按 Accept-Encoding 命中 .br/.gz,
// 无需运行时压缩。脚本可重复执行(覆盖已有 .br)。
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";

const DIST_DIR = fileURLToPath(new URL("../dist/", import.meta.url));

// 仅压文本类资源;图片/字体等二进制格式压缩收益低,跳过。
const TEXT_EXTENSIONS = new Set([".js", ".css", ".html", ".svg", ".json", ".map", ".txt"]);

async function walk(dir, files = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, files);
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      if (TEXT_EXTENSIONS.has(ext)) files.push(full);
    }
  }
  return files;
}

async function main() {
  try {
    await stat(DIST_DIR);
  } catch {
    console.error("[precompress] 未找到 dist 目录:", DIST_DIR);
    process.exitCode = 1;
    return;
  }

  const files = await walk(DIST_DIR);
  let count = 0;
  let rawTotal = 0;
  let brTotal = 0;

  for (const file of files) {
    const raw = await readFile(file);
    const compressed = brotliCompressSync(raw, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.length,
      },
    });
    await writeFile(`${file}.br`, compressed);
    count += 1;
    rawTotal += raw.length;
    brTotal += compressed.length;
  }

  const kb = (n) => (n / 1024).toFixed(1);
  console.log(
    `[precompress] 压缩 ${count} 个文件,原始 ${kb(rawTotal)} KB → br ${kb(brTotal)} KB`,
  );
}

main().catch((err) => {
  console.error("[precompress] 失败:", err);
  process.exitCode = 1;
});
