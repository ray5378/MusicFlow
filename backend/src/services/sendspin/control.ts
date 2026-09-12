// ==================== Sendspin 对外控制面(占位) ====================
//
// renderer 薄壳(Task 6)依赖的控制入口。真实实现随后续任务补齐:
//  - listSendspinPlayers()   -> Task 10 角色注册表 / server 会话列表
//  - castSendspin()          -> Task 8/9 推流 + ProtocolPlayer
//  - controlSendspin()       -> Task 11/12 组命令 / seek / volume

import type { RendererDevice } from "../../plugins/types.js";

/** 枚举当前已连接的 Sendspin 客户端,渲染为可投屏的"播放器"设备。 */
export async function listSendspinPlayers(): Promise<RendererDevice[]> {
  return [];
}

/** 将 songId 投放到指定 Sendspin 客户端(组)播放。 */
export async function castSendspin(_deviceId: string, _songId: string): Promise<{ mediaUri: string }> {
  throw new Error("Sendspin 播放尚未实现(Sendspin 通过协议客户端主动发起,通常无需显式投屏)");
}

/** 对 Sendspin 客户端(组)下发控制指令。 */
export async function controlSendspin(
  _deviceId: string,
  action: string,
  _payload?: unknown,
): Promise<unknown> {
  throw new Error(`Sendspin 控制尚未实现(动作: ${action})`);
}