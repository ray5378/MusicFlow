// ==================== 消息路由 + client/ 处理器注册 ====================
//
// server 侧每个激活 role 向 router 注册 `family` 对应类型(见 plan T10 Step 1 表)。
// `handleMessage(router, type, payload, ctx)` 派发;`ctx` 提供 server/group/session 句柄。
// 纯路由逻辑可单测;具体语义在 server.ts 注入的 action 里实现。

export type MessageActions = Record<
  string,
  (payload: any, ctx: any) => void | Promise<void>
>;

export function familyForType(type: string): string {
  return type.split("/")[0];
}

export function registerMessage(
  router: MessageActions,
  family: string,
  type: string,
  action: (payload: any, ctx: any) => void | Promise<void>,
): void {
  router[`${family}.${type}`] = action;
}

export class MessageRouter {
  private table = new Map<string, (payload: any, ctx: any) => void | Promise<void>>();
  private ctx: any;

  constructor(ctx: any = null) {
    this.ctx = ctx;
  }

  register(family: string, type: string, action: (payload: any, ctx: any) => void | Promise<void>): void {
    this.table.set(`${family}/${type}`, action);
  }

  async handle(type: string, payload: any): Promise<boolean> {
    const fn = this.table.get(type);
    if (!fn) return false;
    await fn(payload, this.ctx);
    return true;
  }

  get handlers(): number {
    return this.table.size;
  }
}