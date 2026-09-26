// ==================== mDNS 广播生命周期 ====================
// bonjour-service 需要真实 UDP 5353 端口,测试里整体 mock,只验证本模块的
// 发布/撤销/共享实例/异常兜底逻辑。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../../plugins/_env.js";

import { describe, it, expect, beforeEach, vi } from "vitest";

const M = vi.hoisted(() => ({
  published: [] as any[],
  instances: 0,
  destroyed: 0,
  stopped: [] as any[],
  publishThrows: false as boolean,
}));

vi.mock("bonjour-service", () => ({
  Bonjour: class {
    constructor() {
      M.instances++;
    }
    publish(opts: any) {
      if (M.publishThrows) throw new Error("publish failed");
      const svc = { opts, stop: () => M.stopped.push(opts), __svc: true };
      M.published.push(opts);
      return svc;
    }
    destroy() {
      M.destroyed++;
    }
  },
}));

import {
  getSharedBonjour,
  startMdnsBroadcast,
  stopMdnsBroadcast,
  publishExtraService,
  unpublishExtraService,
} from "../../../src/services/discovery/mdns.js";

beforeEach(() => {
  // 先复位模块内单例(它会 stop 上一次测试残留的服务),再清零计数,
  // 否则残留的 stop 会被算进本次用例的断言里。
  stopMdnsBroadcast();
  M.published = [];
  M.instances = 0;
  M.destroyed = 0;
  M.stopped = [];
  M.publishThrows = false;
});

describe("mDNS 广播", () => {
  it("startMdnsBroadcast 发布 _musicflow._tcp 并携带 version/uuid", () => {
    startMdnsBroadcast(46400);
    expect(M.published.length).toBe(1);
    const opts = M.published[0];
    expect(opts.type).toBe("musicflow");
    expect(opts.protocol).toBe("tcp");
    expect(opts.port).toBe(46400);
    expect(typeof opts.txt.version).toBe("string");
    // uuid 必须是稳定的 36 位 UUID(HA 用 unique_id 去重)
    expect(opts.txt.uuid).toMatch(/^[0-9a-f-]{36}$/i);
    expect(opts.name.startsWith("MusicFlow-")).toBe(true);
  });

  it("重复 start 不重复发布,也不新建 Bonjour 实例", () => {
    startMdnsBroadcast(46400);
    const before = M.instances;
    startMdnsBroadcast(46400);
    expect(M.published.length).toBe(1);
    expect(M.instances).toBe(before);
  });

  it("publish 抛错被捕获(不冒泡,服务继续可用)", () => {
    M.publishThrows = true;
    expect(() => startMdnsBroadcast(46400)).not.toThrow();
  });

  it("stopMdnsBroadcast 停掉主服务并销毁实例", () => {
    startMdnsBroadcast(46400);
    stopMdnsBroadcast();
    expect(M.stopped.length).toBe(1);
    expect(M.destroyed).toBe(1);
    // 停完可以重新起
    startMdnsBroadcast(46400);
    expect(M.published.length).toBe(2);
  });

  it("getSharedBonjour 复用同一实例(避免多实例抢 5353)", () => {
    const a = getSharedBonjour();
    const b = getSharedBonjour();
    expect(a).toBe(b);
    expect(M.instances).toBe(1);
  });
});

describe("额外 mDNS 服务(插件用)", () => {
  it("publishExtraService 用共享实例发布,参数原样下传", () => {
    publishExtraService("sendspin", { name: "SP-1", type: "sendspin", port: 8927, txt: { id: "x" } });
    expect(M.published.length).toBe(1);
    expect(M.published[0]).toMatchObject({ name: "SP-1", type: "sendspin", port: 8927, txt: { id: "x" } });
  });

  it("同一 key 重复 publish → 先撤旧的(不泄漏)", () => {
    publishExtraService("k", { name: "A", type: "t", port: 1 });
    publishExtraService("k", { name: "B", type: "t", port: 2 });
    expect(M.published.length).toBe(2);
    expect(M.stopped.length).toBe(1);
    expect(M.stopped[0].name).toBe("A");
  });

  it("unpublishExtraService 撤销并允许再次发布", () => {
    publishExtraService("k2", { name: "A", type: "t", port: 1 });
    unpublishExtraService("k2");
    expect(M.stopped.length).toBe(1);
    publishExtraService("k2", { name: "A2", type: "t", port: 1 });
    expect(M.published.length).toBe(2);
  });

  it("unpublish 不存在的 key 是安全的", () => {
    expect(() => unpublishExtraService("no-such")).not.toThrow();
  });

  it("publishExtraService 在无主广播时也能工作(自建共享实例)", () => {
    publishExtraService("solo", { name: "S", type: "t", port: 9 });
    expect(M.instances).toBe(1);
    expect(M.published.length).toBe(1);
  });

  it("stopMdnsBroadcast 会连带撤销所有额外服务", () => {
    publishExtraService("a1", { name: "A1", type: "t", port: 1 });
    publishExtraService("a2", { name: "A2", type: "t", port: 2 });
    stopMdnsBroadcast();
    expect(M.stopped.length).toBe(2);
    expect(M.destroyed).toBe(1);
  });
});
