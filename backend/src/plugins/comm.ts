import { createLogger } from "../utils/logger.js";
// ==================== Inter-plugin communication ====================
//
// A tiny pub/sub bus that lets plugins talk to each other without importing
// one another — mirroring songloft's `comm` namespace. A plugin with the
// `inter-plugin` permission may `.send(id, msg)` to another plugin or
// `.broadcast(msg)`; listeners register with `.on(handler)`.
//
// This is an in-process event bus (we have no cross-VM messaging), but the API
// shape intentionally matches songloft so external JS plugins feel at home.

const log = createLogger("comm");
export type CommHandler = (message: any) => void | Promise<void>;

interface CommTarget {
  id: string;
  permissions: string[];
  on(handler: CommHandler): void;
  off(handler: CommHandler): void;
  send(targetId: string, message: any): void;
  broadcast(message: any): void;
}

const listeners = new Map<string, Set<CommHandler>>();

function ensure(id: string): Set<CommHandler> {
  let s = listeners.get(id);
  if (!s) { s = new Set(); listeners.set(id, s); }
  return s;
}

function createComm(pluginId: string, permissions: string[]): CommTarget {
  const allowed = permissions.includes("inter-plugin") || permissions.includes("*");
  const fail = (what: string) => {
    throw new Error(`插件 ${pluginId} 缺少 inter-plugin 权限,无法${what}`);
  };
  return {
    id: pluginId,
    permissions,
    on(handler: CommHandler) {
      ensure(pluginId).add(handler);
    },
    off(handler: CommHandler) {
      listeners.get(pluginId)?.delete(handler);
    },
    send(targetId: string, message: any) {
      if (!allowed) return fail("向其他插件发消息");
      for (const h of ensure(targetId)) {
        try { h(message); } catch (e: any) { log.error(`handler error in ${targetId}`, { err: e?.message || e }); }
      }
    },
    broadcast(message: any) {
      if (!allowed) return fail("广播消息");
      for (const [id, set] of listeners) {
        if (id === pluginId) continue;
        for (const h of set) {
          try { h(message); } catch (e: any) { log.error(`handler error in ${id}`, { err: e?.message || e }); }
        }
      }
    },
  };
}

/** Remove every listener (used on host shutdown / plugin reload). */
export function resetComm(): void {
  listeners.clear();
}

export { createComm };
export type { CommTarget };
