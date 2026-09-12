// ==================== Sendspin 运行时持有器(leaf,零重依赖) ====================
//
// 仅持有一个 SendspinServer 实例引用,供 protocolPlayer / control 在运行时取用。
// 放在独立 leaf 模块(npm 重依赖:不 import player/index、不 import server)——避免
// 形成 QueueController → sendspin/protocolPlayer → sendspin/index → player/index → QueueController
// 的模块初始化环(会导致 "Cannot access 'registered' before initialization")。
import type { SendspinServer } from "./server.js";

let server: SendspinServer | null = null;

export function getServer(): SendspinServer | null {
  return server;
}

export function setServer(srv: SendspinServer | null): void {
  server = srv;
}