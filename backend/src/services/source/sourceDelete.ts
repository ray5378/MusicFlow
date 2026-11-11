// ==================== 音源异步删除(独立子进程 + 断点续删) ====================
//
// 为什么不是同步 DELETE:一个 SMB 源动辄两万多首,同步删除会把 HTTP 请求挂几十秒;
// 旧实现还会把整张 songs 表读进 JS 堆(17 万行),160MB 堆直接 OOM。
//
// 为什么不是主进程异步循环:better-sqlite3 是同步的,每批 400 行的删除事务会按住
// 事件循环,前端在删除期间请求全部排队(2026-11 用户实测「卡住」)。现在删除内核
// 跑在**独立子进程**(sourceDeleteWorker.js),跑完即退出;主进程只负责:
//   1. 落任务行(source_delete_jobs → 前端轮询进度);
//   2. spawn/记录子进程,退出时清掉句柄并关闭该源持有的 SMB 连接;
//   3. 进程重启后 boot 调 resumePendingSourceDeletes() 把没跑完的任务重新拉起。
//
// 子进程会周期性检查父进程是否还活着:主进程重启时旧子进程会在一个批次内自行退出
// (退出码 3),新起的子进程接着删 —— 查询天然幂等,不会重复删或漏删。
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sqlite } from "../../db/index.js";
import { createLogger } from "../../utils/logger.js";
import { closeSmbSource } from "./smbClient.js";
import {
  countSourceSongs,
  markDeleteJobFailed,
  runSourceDelete,
  upsertDeleteJob,
} from "./sourceDeleteCore.js";

const log = createLogger("SRC-DEL");

/** 正在跑的任务(防重复 spawn:轮询/重复点击/重启恢复都可能命中同一条)。 */
const running = new Set<string>();
/** 子进程句柄(进程重启/退出时用来清理,避免僵尸引用)。 */
const children = new Map<string, ChildProcess>();

export interface DeleteJob {
  source_id: string;
  total: number;
  removed: number;
  status: "running" | "failed";
  error: string | null;
  updated_at: number;
}

/** 该源名下歌曲数(区间走 path 索引,不做全表扫)。 */
export function countSourceSongsFast(id: string): number {
  return countSourceSongs(sqlite, id);
}

/**
 * 启动删除(立即返回,后台跑)。重复调用只会返回当前进度,不会开第二个 worker。
 */
export function startSourceDelete(id: string): { total: number; removed: number } {
  const existing = sqlite
    .prepare("SELECT total, removed FROM source_delete_jobs WHERE source_id = ? AND status = 'running'")
    .get(id) as any;
  if (existing) {
    launch(id);
    return { total: Number(existing.total || 0), removed: Number(existing.removed || 0) };
  }
  const total = countSourceSongsFast(id);
  upsertDeleteJob(sqlite, id, total);
  launch(id);
  return { total, removed: 0 };
}

/** 拉起删除执行体:正常走子进程;VITEST 下退化为进程内核(测试没有 dist 产物)。 */
function launch(id: string): void {
  if (process.env.VITEST) {
    if (running.has(id)) return;
    running.add(id);
    void (async () => {
      try {
        await runSourceDelete(sqlite, id);
        const { finalizeSourceDelete } = await import("./sourceDeleteCore.js");
        finalizeSourceDelete(sqlite, id);
        closeSmbSource(id);
        log.info("音源删除完成(测试模式)", { sourceId: id });
      } catch (e: any) {
        markDeleteJobFailed(sqlite, id, e);
        log.error("音源删除失败(测试模式)", { sourceId: id, err: String(e?.message || e) });
      } finally {
        running.delete(id);
      }
    })();
    return;
  }
  if (children.has(id)) return;

  const workerPath = fileURLToPath(new URL("./sourceDeleteWorker.js", import.meta.url));
  const child = spawn(process.execPath, [workerPath, id, String(process.pid)], { stdio: "ignore" });
  children.set(id, child);
  // 主进程不需要等子进程:unref 让容器停机不被它拖住;子进程自己盯父进程存活。
  child.unref();
  child.on("error", (e) => {
    children.delete(id);
    markDeleteJobFailed(sqlite, id, e);
    log.error("删除子进程启动失败", { sourceId: id, err: e.message });
  });
  child.on("exit", (code) => {
    children.delete(id);
    if (code === 0) {
      closeSmbSource(id);
      log.info("音源删除完成", { sourceId: id });
    } else if (code === 1) {
      log.error("删除子进程失败,进度已保留可重试", { sourceId: id });
    } else if (code === 3) {
      log.warn("删除子进程因父进程退出而中止,待启动后续删", { sourceId: id });
    }
  });
}

/** boot 恢复:进程重启前没删完的任务继续删(查询天然幂等)。 */
export function resumePendingSourceDeletes(): number {
  let rows: any[] = [];
  try {
    rows = sqlite.prepare("SELECT source_id FROM source_delete_jobs WHERE status = 'running'").all() as any[];
  } catch {
    return 0;
  }
  for (const r of rows) launch(String(r.source_id));
  return rows.length;
}

/** 进度快照(供 /delete-status):只回正在跑或失败的,失败的可重试。 */
export function listSourceDeleteJobs(): Record<string, Omit<DeleteJob, "source_id">> {
  const rows = sqlite.prepare("SELECT * FROM source_delete_jobs").all() as DeleteJob[];
  const out: Record<string, Omit<DeleteJob, "source_id">> = {};
  for (const r of rows) {
    out[r.source_id] = {
      total: Number(r.total || 0),
      removed: Number(r.removed || 0),
      status: r.status,
      error: r.error,
      updated_at: Number(r.updated_at || 0),
    };
  }
  return out;
}
