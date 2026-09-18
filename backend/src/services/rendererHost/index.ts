// ==================== 常驻渲染器子进程宿主:公共入口 ====================
//
// 供各渲染器业务(sendspin / airplay / 未来的 airplay2、cast、roon …)复用的通用层:
//   - RendererHostSupervisor : 主进程侧宿主(fork / 握手 / 看门狗 / 退避重启 / rpc / 镜像);
//   - ChildRpcHost           : 子进程侧控制器(RPC 分发 / 快照节流 / 心跳 / 生命周期);
//   - ipcProtocol            : 通用信封类型与常量(req/res/heartbeat/ready/state/stop);
//   - resolveChildEntry      : 子进程入口路径解析(prod 用 .js,dev 用 .ts);
//   - isRendererForkMode     : 三态模式判定(child / in-proc / fork),只有默认值不同;
//   - createFrontAccessor    : 主进程侧外观工厂(fork→代理,in-proc→真实实例);
//   - childBootstrap         : 子进程启动骨架(致命异常兜底 / 数据层 / 消息循环)。
//
// 新接一个渲染器业务的完整清单(照 sendspin 抄即可):
//   1. `<biz>/ipcProtocol.ts`  : 定义业务载荷(快照 / 就绪信息 / 事件 / 附加消息),
//                                用 HostToChild / ChildToHost 组合成两侧联合类型;
//   2. `<biz>/childMain.ts`    : 继承 ChildRpcHost,提供 buildState + dispatch + onStop;
//   3. `<biz>/child.ts`        : 用 childBootstrap 的骨架起 runtime,mainReady 后进消息循环;
//   4. `<biz>/supervisor.ts`   : 实例化 RendererHostSupervisor(applyReady/applyState/onEvent);
//   5. `<biz>/proxy.ts`        : 写外观接口 + 镜像代理,并用 AssertImplements 守住真实实例;
//   6. `<biz>/mode.ts`         : 一行 isRendererForkMode({...})。
export * from "./ipcProtocol.js";
export * from "./supervisor.js";
export * from "./childHost.js";
export * from "./paths.js";
export * from "./mode.js";
export * from "./front.js";
export * from "./childBootstrap.js";
