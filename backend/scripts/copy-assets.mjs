// 把非 TS 的运行期资源拷进 dist(目前只有 SMB 桥接脚本)。
// tsc 只处理 .ts，桥接脚本是 Python，必须由构建显式带过去，
// 否则 dist/services/source/smbClient.js 会找不到同目录的 smbBridge.py。
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const from = resolve(root, "src/services/source/smbBridge.py");
const to = resolve(root, "dist/services/source/smbBridge.py");

mkdirSync(dirname(to), { recursive: true });
copyFileSync(from, to);
console.log("[copy-assets] smbBridge.py -> dist/services/source/");
