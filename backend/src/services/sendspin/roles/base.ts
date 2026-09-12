// ==================== Sendspin Role base ====================
//
// 每个 role 工厂 `(client) => role`。client 是 server 侧的 SendspinConnection,
// role 通过它下行数据。角色只持有 roleId 与 activate/deactivate 生命周期;
// 具体消息的语义在角色实现里,消息收发在 server.ts / stream.ts 编排。

export interface SendspinRole {
  roleId: string;
  onActivate(): void;
  onDeactivate(): void;
}

export abstract class BaseRole implements SendspinRole {
  constructor(
    public readonly roleId: string,
    protected readonly client: any,
  ) {}

  onActivate(): void {
    /* no-op 子类可覆写 */
  }
  onDeactivate(): void {
    /* no-op 子类可覆写 */
  }
}

/** 便捷:向客户端发送加密 JSON 消息(经 transport)。 */
export function sendJson(client: any, type: string, payload?: Record<string, any>): void {
  client?.sendJson(type, payload);
}

/** 便捷:向客户端发送加密二进制帧(已含 bin id 的类型字节由调用方打包)。 */
export function sendBinary(client: any, body: Uint8Array): void {
  client?.sendBinary(body);
}