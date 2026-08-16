// Test-only helper:隔离 DATA_DIR 已由 tests/setup.ts 统一分配(每个测试文件
// 独立目录 + 全量 schema)。本模块保留 TMP_DATA_DIR(指向当前文件的隔离目录,
// 供写插件目录/封面等用)与 hasTar()。
import { execFileSync } from "child_process";

export const TMP_DATA_DIR = process.env.DATA_DIR!;

/** Whether the system `tar` binary exists (installPlugin relies on it). */
export function hasTar(): boolean {
  try {
    execFileSync("tar", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
