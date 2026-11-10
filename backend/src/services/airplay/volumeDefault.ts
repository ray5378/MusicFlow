// ==================== AirPlay 音量缺省值(无 DB 依赖) ====================
//
// 为什么单独成文件:该值同时被
//   - 主进程的 deviceState(会 import db/index,读写 airplay_device_state);
//   - **子进程**的 bridgeSession(绝不能 import db —— 那条链会在 import 时就
//     `new Database(...)`,让子进程多开一条 671MB 库的连接)。
// 共用一个常量,避免两处各写一份 80 而悄悄漂移。
export const DEFAULT_AIRPLAY_VOLUME = 80;
