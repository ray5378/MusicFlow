// ==================== 写目录可用性预检（挂载权限通用防线） ====================
//
// 背景（2026-10-10 240 生产实测）：downloadRoot / cacheRoot 是宿主挂载目录，属主
// 配错（node:1001 + mode 705）时后端进程（musicflow, uid 100）落在 other=r-x ——
// 无写权限。症状极具迷惑性：候选源全部正常命中、质量门禁正常工作，但每个真正开始
// 下载的项都在 mkdir 缓存目录时 EACCES，整任务颗粒无收。
//
// 通用机制：对配置里所有「写根目录」做 mkdir + 探针文件 写入预检：
//   - 可写 → 记忆通过（进程生命周期内同一路径只探一次，可传 fresh 强制重探）；
//   - 不可写 → 抛出带修复指引的明确错误。调用方（startFetchJob）据此把整个任务
//     快速失败，而不是跑到一半逐项报难懂的 EACCES。
// 后端进程通常非 root，无法自行 chown 自愈 → 修复动作在部署侧执行；错误信息里
// 直接给出可复制的 chown 命令。
import { mkdirSync, readdirSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import * as path from "node:path";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("fetch-writable");

/** 已通过预检的目录（进程内记忆）。 */
const verified = new Set<string>();

/** 测试辅助：清空「已验证」记忆，下次预检强制重新探针。 */
export function resetWritableVerify(): void {
  verified.clear();
}

/**
 * 清空缓存根目录**内容**（保留目录本身），返回删除条数。
 *
 * 为什么在启动时清：跑批循环是进程内的，重启后缓存目录里遗留的下载子目录 /
 * .part 半成品永远不会再被任何任务引用，留着只占空间（产品定调 2026-10-10）。
 *
 * 防御：cacheRoot 为空 / 是根路径 / 深度不足两段 / 与 downloadRoot 相同或互为
 * 祖先时，一律拒绝清理 —— 绝不碰成品目录与挂载点。
 */
export function cleanCacheRootContents(cacheRoot: string, downloadRoot: string): number {
  if (!cacheRoot || !String(cacheRoot).trim()) return 0;
  const cr = path.resolve(String(cacheRoot));
  const root = path.parse(cr).root;
  if (cr === root) return 0;
  const rel = cr.slice(root.length);
  if (rel.split(path.sep).filter(Boolean).length < 2) return 0; // 只清至少两段深的目录
  const dr = String(downloadRoot || "").trim() ? path.resolve(String(downloadRoot)) : "";
  if (dr && (cr === dr || cr.startsWith(dr + path.sep) || dr.startsWith(cr + path.sep))) {
    log.warn("cacheRoot 与 downloadRoot 相同/互为祖先，跳过启动清空", { cr, dr });
    return 0;
  }
  let n = 0;
  try {
    for (const e of readdirSync(cr)) {
      rmSync(path.join(cr, e), { recursive: true, force: true });
      n++;
    }
  } catch {
    /* 目录不存在等：视为无可清理 */
  }
  return n;
}

/**
 * 确保目录存在且当前进程用户可在其中创建文件；不可写时抛出带修复指引的错误。
 * 幂等：同一路径成功后本进程内不再重复探针（传 fresh: true 强制重探）。
 */
export function ensureWritableDir(dir: string, opts?: { fresh?: boolean }): void {
  if (!dir || !String(dir).trim()) {
    throw new Error("写目录为空，请检查 fetch 配置（downloadRoot/cacheRoot）");
  }
  if (!opts?.fresh && verified.has(dir)) return;
  mkdirSync(dir, { recursive: true });
  const probe = `${String(dir).replace(/[\\/]+$/, "")}/.mf_write_probe_${process.pid}`;
  try {
    writeFileSync(probe, "ok");
    unlinkSync(probe);
  } catch (err: any) {
    const code = String(err?.code ?? err);
    const uid = typeof process.getuid === "function" ? process.getuid() : -1;
    const gid = typeof process.getgid === "function" ? process.getgid() : uid;
    log.error("写目录预检失败", { dir, code, uid });
    throw new Error(
      `目录不可写: ${dir} (code=${code}, 进程 uid=${uid})。` +
        `请在部署侧执行: chown -R ${uid}:${gid} '${dir}' 然后重启服务`,
    );
  }
  verified.add(dir);
}
