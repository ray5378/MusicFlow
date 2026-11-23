// ==================== 播放器隔离总开关 ====================
//
// 为什么要文件开关：AF_PLAYER_ISOLATION 是进程启动期环境变量，改它必须重建容器
// （丢掉挂载/端口/重启策略）。改造验证期需要频繁 A/B，所以额外支持「标志文件」：
//   开机启用：docker exec musicflow touch /app/backend/data/player-isolation.on
//   关闭    ：docker exec musicflow rm -f  /app/backend/data/player-isolation.on
// 之后 restart 容器即可（文件在持久化卷上，重建容器也仍然生效）。
import fs from "node:fs";

const DEFAULT_FLAG = "/app/backend/data/player-isolation.on";

export function playerIsolationEnabled(): boolean {
  if (process.env.MF_PLAYER_ISOLATION === "1") return true;
  if (process.env.MF_PLAYER_ISOLATION === "0") return false;
  const file = process.env.MF_ISOLATION_FLAG_FILE || DEFAULT_FLAG;
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}
