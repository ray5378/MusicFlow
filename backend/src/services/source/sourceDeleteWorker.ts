// ==================== 音源删除子进程 ====================
//
// 由 sourceDelete.ts 拉起,把自己负责的那个源删干净后**立即退出**(不常驻)。
// 用法: node dist/services/source/sourceDeleteWorker.js <sourceId> [parentPid]
// 退出码:
//   0 完成(源行与任务行都已删除)
//   1 失败(错误已写进 source_delete_jobs.error,前端可重试)
//   2 参数缺失
//   3 父进程已退出(任务保持 running,下次启动 resumePendingSourceDeletes 续删)
import { sqlite } from "../../db/index.js";
import { finalizeSourceDelete, markDeleteJobFailed, runSourceDelete } from "./sourceDeleteCore.js";

const id = process.argv[2];
const parentPid = Number(process.argv[3] || 0);

function parentAlive(): boolean {
  if (!parentPid) return true;
  try {
    process.kill(parentPid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  if (!id) process.exit(2);
  try {
    await runSourceDelete(sqlite, id, { shouldStop: () => !parentAlive() });
    // 主进程没了就先不删源行:重启后 resume 会接着把这个任务做完。
    if (!parentAlive()) process.exit(3);
    finalizeSourceDelete(sqlite, id);
    process.exit(0);
  } catch (e) {
    markDeleteJobFailed(sqlite, id, e);
    process.exit(1);
  }
}

void main();
