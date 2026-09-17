// Sendspin 服务端 mDNS 广播(_sendspin-server._tcp),供客户端发现。
//
// 边界:一切 sendspin 认知(服务类型/端口/txt path)归本包;发布动作走共享
// discovery/mdns 的通用 publishExtraService(它不懂业务,只管发布)。
// 见 spec Client Initiated Connections:port 为 server WS 监听端口(推荐 38927),
// txt 必须带 path(推荐 /sendspin)。
import { publishExtraService, unpublishExtraService } from "../discovery/mdns.js";

const BROADCAST_KEY = "sendspin-server";

export function advertiseSendspinServer(port: number, serverName: string): void {
  try {
    publishExtraService(BROADCAST_KEY, {
      name: serverName || "MusicFlow Sendspin",
      type: "sendspin-server",
      port,
      txt: { path: "/sendspin" },
    });
  } catch { /* 广播失败不影响服务 */ }
}

export function unadvertiseSendspinServer(): void {
  try {
    unpublishExtraService(BROADCAST_KEY);
  } catch { /* 忽略 */ }
}
