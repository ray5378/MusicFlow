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
import {
  chmodSync,
  chownSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
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
/** 生成带修复指引的统一错误（所有写权限失败一个口径）。 */
function writableError(dir: string, err: unknown): Error {
  const code = String((err as any)?.code ?? err);
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  const gid = typeof process.getgid === "function" ? process.getgid() : uid;
  log.error("写目录预检失败", { dir, code, uid });
  return new Error(
    `目录不可写: ${dir} (code=${code}, 进程 uid=${uid})。` +
      `请在部署侧执行: chown -R ${uid}:${gid} '${dir}' 然后重启服务`,
  );
}

/**
 * 自适应修复（PATCH14）：写探针失败后按能力自动修，能修的当场修好，修不了返回 false。
 *   - root 进程：直接 chown 目录到当前用户（挂载属主配错的最常见场景）；
 *   - 目录属主就是当前用户：chmod 补上属主写位（属主被剥权的场景）；
 *   - 其他（他人目录 + 非 root）：文件系统层面无能为力 → false，走统一错误。
 */
function tryHealWritable(dir: string): boolean {
  try {
    const st = statSync(dir);
    const uid = typeof process.getuid === "function" ? process.getuid() : -1;
    const gid = typeof process.getgid === "function" ? process.getgid() : uid;
    if (uid < 0) return false;
    if (uid === 0) {
      chownSync(dir, uid, gid);
      return true;
    }
    if (st.uid === uid) {
      chmodSync(dir, st.mode | 0o200);
      return true;
    }
  } catch {
    /* 修复失败按不可修处理 */
  }
  return false;
}

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
    // 自适应修复：能修的当场修（属主缺写位 / root 进程），修不了才抛统一错误。
    const healed = tryHealWritable(dir);
    if (!healed) throw writableError(dir, err);
    try {
      writeFileSync(probe, "ok");
      unlinkSync(probe);
    } catch (err2: any) {
      throw writableError(dir, err2);
    }
    log.info("写目录自适应修复成功（chmod/chown）", { dir });
  }
  verified.add(dir);
}

/**
 * 非抛出版探针：目录当前进程用户可写（含自适应修复成功）→ true。
 * 用于「能不能往这里写」的决策点（如洗版原地替换前探原文件目录），失败不打日志。
 */
export function canWriteDir(dir: string): boolean {
  if (!dir || !String(dir).trim()) return false;
  try {
    ensureWritableDir(dir);
    return true;
  } catch {
    return false;
  }
}
