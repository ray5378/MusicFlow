// ==================== S1「下一首预解码」Web 开关(音频页)====================
//
// **为什么不是 settings 表**:S1 的判定跑在 sendspin **子进程**(streamEngine 的
// maybeStartNextPrefetch),主进程的 settings 缓存/内存态它一概看不见;而 plugins
// 表是主/子进程各自直读 sqlite(WAL 多进程安全,与 readSendspinPluginConfig 同口径)。
// 所以开关值落在 sendspin-renderer 插件配置的 `next_track_prefetch` 键:
// 主进程在音频页改完 → 子进程下一次换歌立刻读到,无需重启、不打断当前播放。
//
// 缺省**开**:只在显式写过 `next_track_prefetch: false` 时才关(从未配置过 = 开)。
// 容器环境变量 `MF_BRIDGE_NEXT_TRACK_PREFETCH` 仍作排障总闸,在 streamEngine 里
// 优先于本值(0/false/off 关,1/true/on 开)。
import { sqlite } from "../../db/index.js";

const PLUGIN_SELECT =
  "SELECT config FROM plugins WHERE id = 'sendspin-renderer' OR name = 'sendspin-renderer'";

/** 读 Web 开关(缺省 true;显式 false 才关)。读不到(无插件行/JSON 坏)也按 true。 */
export function readBridgePrefetchConfig(): boolean {
  try {
    const row = sqlite.prepare(PLUGIN_SELECT).get() as any;
    const cfg = row?.config ? JSON.parse(row.config) : {};
    return cfg?.next_track_prefetch !== false;
  } catch {
    return true;
  }
}
