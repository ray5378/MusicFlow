// peers 域路由层契约测试 —— src/routes/api/peers.ts(35 条路由)。
//
// 手法与 dlna/sendspin/playlists 三个契约测试一致:以真实 shared.ts 为底,只把
// 「服务层入口 + 管理器单例」换成可断言的假体(见 `_peersFakes.ts`)。
// 这样「服务层抛错 → 路由 catch → 500」这条分支才可达 —— 真实环境里要它发生
// 得让真设备掉线、真 ffmpeg 失败。
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/routes/api/shared.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { overrides } = await import("./_sharedFakes.js");
  const { peersFakes } = await import("./_peersFakes.js");
  // 顺序要紧:peersFakes 在 overrides 之后,覆盖掉通用假体里的管理器。
  return { ...actual, ...overrides, ...peersFakes };
});

import { PlaybackState } from "../../src/routes/api/shared.js";
import { registerPeers } from "../../src/routes/api/peers.js";
import {
  eventManager, fns, gm, pm, queueController, queueManager, resetPeersFakes,
} from "./_peersFakes.js";

type Any = any;

let currentUser: Any = { id: "u1", username: "ray", isAdmin: false };

const app = new Hono();
app.use("*", async (c: Any, next: Any) => {
  c.set("user", currentUser);
  await next();
});
registerPeers(app as Any);

const get = (p: string) => app.request("http://x" + p);
const send = (method: string, p: string, body?: Any) =>
  app.request("http://x" + p, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const post = (p: string, body?: Any) => send("POST", p, body);
const del = (p: string, body?: Any) => send("DELETE", p, body);
const json = async (r: Response) => (await r.json()) as Any;

beforeEach(() => {
  resetPeersFakes();
  currentUser = { id: "u1", username: "ray", isAdmin: false };
});

// ==================== GET /v1/peers ====================

describe("GET /v1/peers", () => {
  it("距上次发现超时 → 后台补扫一轮(fire-and-forget,不阻塞响应)", async () => {
    fns.shouldRefreshDevices.mockReturnValue(true);
    const r = await get("/v1/peers");
    expect(r.status).toBe(200);
    expect(fns.refreshDevices).toHaveBeenCalledTimes(1);
  });

  it("未超时不补扫", async () => {
    fns.shouldRefreshDevices.mockReturnValue(false);
    await get("/v1/peers");
    expect(fns.refreshDevices).not.toHaveBeenCalled();
  });

  it("补扫失败被吞掉(列表照常返回,不 500)", async () => {
    fns.shouldRefreshDevices.mockReturnValue(true);
    fns.refreshDevices.mockRejectedValue(new Error("SSDP 绑定失败"));
    const r = await get("/v1/peers");
    expect(r.status).toBe(200);
    expect((await json(r)).peers).toEqual([]);
  });

  it("includeHidden=1 透传给装饰器(管理页要看到被隐藏的行)", async () => {
    await get("/v1/peers?includeHidden=1");
    expect(fns.decoratePeersForClient).toHaveBeenCalledWith(expect.anything(), "u1", false, null, true);
    fns.decoratePeersForClient.mockClear();
    await get("/v1/peers");
    expect(fns.decoratePeersForClient).toHaveBeenCalledWith(expect.anything(), "u1", false, null, false);
  });

  it("管理员身份一并透传", async () => {
    currentUser = { id: "adm", username: "a", isAdmin: true };
    await get("/v1/peers");
    expect(fns.decoratePeersForClient).toHaveBeenCalledWith(expect.anything(), "adm", true, null, false);
  });
});

// ==================== 权限中间件 ====================

describe("权限中间件(/v1/peers/:peerId/* 与 /v1/peers/:peerId)", () => {
  it("无控制权 → 403,且不进入处理器", async () => {
    fns.canControlPeer.mockReturnValue(false);
    const r = await post("/v1/peers/dlna:dev1/pause");
    expect(r.status).toBe(403);
    expect((await json(r)).code).toBe("FORBIDDEN");
    expect(fns.pauseDevice).not.toHaveBeenCalled();
  });

  it("保留段 register 直接放行(不判权) —— 否则普通账号的本机播放器永远注册不上", async () => {
    fns.canControlPeer.mockReturnValue(false);
    const r = await post("/v1/peers/register", {});
    expect(r.status).toBe(200);
    expect(fns.canControlPeer).not.toHaveBeenCalled();
  });

  it("两层中间件的覆盖面不同:通配层拦所有子路径,精确层只拦 GET", async () => {
    fns.canControlPeer.mockReturnValue(false);
    // 精确层 /v1/peers/:peerId → GET 详情被判权
    expect((await get("/v1/peers/dlna:dev1")).status).toBe(403);
    // 通配层 /v1/peers/:peerId/* → 子路径一律判权(含 heartbeat;源码注释里的
    // 「register/heartbeat 走各自校验」只对精确层成立,register 靠保留段豁免)
    expect((await post("/v1/peers/local:u1/heartbeat")).status).toBe(403);
    expect(fns.canControlPeer).toHaveBeenCalled();
  });

  it("放行后子路径正常进入处理器(对照组,证明 403 来自判权而非路由缺失)", async () => {
    fns.canControlPeer.mockReturnValue(true);
    expect((await post("/v1/peers/local:u1/heartbeat")).status).toBe(200);
  });
});

// ==================== POST /v1/peers/register ====================

describe("POST /v1/peers/register", () => {
  it("缺 name → 回落用户名;peerId 打码(实例键被哈希)、self 恒 true", async () => {
    pm.registerLocal.mockReturnValue({ peerId: "local:u1:inst" });
    const b = await json(await post("/v1/peers/register", {}));
    expect(pm.registerLocal).toHaveBeenCalledWith("u1", "ray", null, undefined, undefined);
    // 出口一律打码:实例键不回显原文(反查走 resolveMaskedLocalPeerId)
    expect(b.peer.peerId.startsWith("local:u1:")).toBe(true);
    expect(b.peer.peerId).not.toContain("inst");
    expect(b.peer.self).toBe(true);
  });

  it("body.clientId 优先于头部上报;platform/model 去空白限长", async () => {
    const b = await json(await post("/v1/peers/register", {
      name: "  我的电脑  ", clientId: "cid-1",
      platform: "  windows  ", model: "  PC-1  ",
    }));
    expect(b.peer.self).toBe(true);
    expect(pm.registerLocal).toHaveBeenCalledWith("u1", "  我的电脑  ", "cid-1", "windows", "PC-1");
  });

  it("非法 clientId(含空白/超长)被丢弃 → null,由 decode 层兜底", async () => {
    await post("/v1/peers/register", { clientId: "  bad id!!  " });
    expect(pm.registerLocal.mock.calls[0][2]).toBeNull();
  });

  it("空字符串 name 不算合法 → 回落用户名", async () => {
    await post("/v1/peers/register", { name: "" });
    expect(pm.registerLocal.mock.calls[0][1]).toBe("ray");
  });

  it("body 非法 JSON → 按空对象处理,不 500", async () => {
    const r = await app.request("http://x/v1/peers/register", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{not json",
    });
    expect(r.status).toBe(200);
    expect(pm.registerLocal.mock.calls[0][1]).toBe("ray");
  });
});

// ==================== heartbeat / offline ====================

describe("heartbeat / offline", () => {
  it("heartbeat 回传 success=管理器结果", async () => {
    pm.heartbeat.mockReturnValueOnce(true);
    expect((await json(await post("/v1/peers/local:u1/heartbeat"))).success).toBe(true);
    pm.heartbeat.mockReturnValueOnce(false);
    expect((await json(await post("/v1/peers/local:u1/heartbeat"))).success).toBe(false);
  });

  it("offline:非本机实例键(旧格式 local:<uid>)→ 400 not-local-instance", async () => {
    fns.userIdOfLocalPeer.mockReturnValueOnce(null);
    const r = await post("/v1/peers/local:u1/offline");
    expect(r.status).toBe(400);
    expect((await json(r)).reason).toBe("not-local-instance");
  });

  it("offline:还有别的活连接 → 不标离线(关一个标签页 ≠ 端下线)", async () => {
    fns.countLiveConnections.mockReturnValueOnce(2);
    const b = await json(await post("/v1/peers/local:u1:inst/offline"));
    expect(b).toEqual({ ok: true, offline: false, reason: "other-connections-alive", live: 2 });
    expect(pm.markLocalOfflineByClient).not.toHaveBeenCalled();
  });

  it("offline:最后一条连接 → 标离线,且不动队列", async () => {
    fns.countLiveConnections.mockReturnValueOnce(1);
    const b = await json(await post("/v1/peers/local:u1:inst/offline"));
    expect(b).toEqual({ ok: true, offline: true, live: 1 });
    expect(pm.markLocalOfflineByClient).toHaveBeenCalledWith("u1", "c1");
    expect(pm.localClear).not.toHaveBeenCalled();
  });
});

// ==================== POST /v1/peers/:peerId/local-status ====================

describe("POST /v1/peers/:peerId/local-status", () => {
  it("peerId 解析失败(管理器不认)→ 400", async () => {
    pm.reportLocalStatus.mockReturnValueOnce(null);
    const r = await post("/v1/peers/local:u1/local-status", { state: "playing" });
    expect(r.status).toBe(400);
    expect((await json(r)).code).toBe("INVALID_PARAM");
  });

  it("state 大小写归一;未知取值 → undefined(而不是原样透传)", async () => {
    await post("/v1/peers/local:u1/local-status", { state: "playing" });
    expect(pm.reportLocalStatus.mock.calls[0][1].state).toBe("PLAYING");
    await post("/v1/peers/local:u1/local-status", { state: "paused_playback" });
    expect(pm.reportLocalStatus.mock.calls[1][1].state).toBe("PAUSED_PLAYBACK");
    await post("/v1/peers/local:u1/local-status", { state: "buffering" });
    expect(pm.reportLocalStatus.mock.calls[2][1].state).toBeUndefined();
    await post("/v1/peers/local:u1/local-status", { state: 123 });
    expect(pm.reportLocalStatus.mock.calls[3][1].state).toBeUndefined();
  });

  it("数值字段做有限性过滤:NaN / 字符串 → undefined(字段级合并沿用旧值)", async () => {
    await post("/v1/peers/local:u1/local-status", {
      state: "stopped", position: "5", duration: Number.NaN, volume: 30, songId: "",
    });
    const patch = pm.reportLocalStatus.mock.calls[0][1];
    expect(patch).toEqual({ state: "STOPPED", position: undefined, duration: undefined, volume: 30, songId: undefined });
  });

  it("songId 非空字符串才收下", async () => {
    await post("/v1/peers/local:u1/local-status", { songId: "s-9" });
    expect(pm.reportLocalStatus.mock.calls[0][1].songId).toBe("s-9");
  });

  it("成功回传 reportedAt", async () => {
    pm.reportLocalStatus.mockReturnValueOnce({ reportedAt: 12345 });
    expect(await json(await post("/v1/peers/local:u1/local-status", {}))).toEqual({ success: true, reportedAt: 12345 });
  });

  it("body 非法 JSON → 按空对象处理", async () => {
    const r = await app.request("http://x/v1/peers/local:u1/local-status", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{{{",
    });
    expect(r.status).toBe(200);
  });
});

// ==================== GET /v1/peers/:peerId/queue ====================

describe("GET /v1/peers/:peerId/queue", () => {
  it("无快照 → 400", async () => {
    pm.getQueueSnapshot.mockReturnValueOnce(null);
    expect((await get("/v1/peers/local:u1/queue")).status).toBe(400);
  });

  it("四种 kind 各取各的 currentMedia:dlna / airplay / sendspin / local(无)", async () => {
    pm.getQueueSnapshot.mockReturnValue({ items: [], currentIndex: 0 });

    fns.getCurrentMedia.mockReturnValueOnce({ songId: "s-dlna" });
    expect((await json(await get("/v1/peers/dlna:dev1/queue"))).currentMedia).toEqual({ songId: "s-dlna" });
    expect(fns.getCurrentMedia).toHaveBeenCalledWith("dev1");

    fns.getAirPlayPeerStatus.mockReturnValueOnce({ media: { songId: "s-ap" } });
    expect((await json(await get("/v1/peers/airplay:ap1/queue"))).currentMedia).toEqual({ songId: "s-ap" });

    fns.getSendspinFront.mockReturnValueOnce({ currentMedia: () => ({ songId: "s-ss" }) });
    expect((await json(await get("/v1/peers/sendspin:sc1/queue"))).currentMedia).toEqual({ songId: "s-ss" });

    expect((await json(await get("/v1/peers/local:u1/queue"))).currentMedia).toBeUndefined();
    expect((await json(await get("/v1/peers/group:g1/queue"))).currentMedia).toBeUndefined();
  });

  it("非数组 items 兜底为空数组;total 为完整长度", async () => {
    pm.getQueueSnapshot.mockReturnValue({ items: null, currentIndex: 0 });
    const b = await json(await get("/v1/peers/local:u1/queue"));
    expect(b.items).toEqual([]);
    expect(b.total).toBe(0);
  });

  it("分页:size>0 才切片;size=0 返回全量(向后兼容);offset 负值夹到 0", async () => {
    const items = [1, 2, 3, 4, 5];
    pm.getQueueSnapshot.mockReturnValue({ items, currentIndex: 2 });

    expect((await json(await get("/v1/peers/local:u1/queue"))).items).toEqual(items);
    expect((await json(await get("/v1/peers/local:u1/queue?size=2"))).items).toEqual([1, 2]);
    expect((await json(await get("/v1/peers/local:u1/queue?offset=2&size=2"))).items).toEqual([3, 4]);
    expect((await json(await get("/v1/peers/local:u1/queue?offset=-5&size=2"))).items).toEqual([1, 2]);
    expect((await json(await get("/v1/peers/local:u1/queue?offset=abc&size=abc"))).items).toEqual(items);
    // currentIndex 恒为绝对下标(分页不影响)
    expect((await json(await get("/v1/peers/local:u1/queue?offset=2&size=2"))).currentIndex).toBe(2);
  });
});

// ==================== POST /v1/peers/:peerId/queue/play ====================

describe("POST /v1/peers/:peerId/queue/play", () => {
  it("items 非数组 → 400", async () => {
    const r = await post("/v1/peers/local:u1/queue/play", { items: "nope" });
    expect(r.status).toBe(400);
    expect((await json(r)).code).toBe("INVALID_PARAM");
  });

  it("peerId 形态非法(裸 id)→ 400", async () => {
    expect((await post("/v1/peers/bare-id/queue/play", { items: [] })).status).toBe(400);
  });

  it("cast 端:先脱离活跃组,再 playFrom;带 position 时起播后 seek 落位", async () => {
    queueManager.playFrom.mockResolvedValueOnce(3);
    fns.seekPeerToSeconds.mockResolvedValueOnce(true);
    const b = await json(await post("/v1/peers/dlna:dev1/queue/play", { items: [{ songId: "s1" }], startIndex: 3, position: 12.5 }));
    expect(fns.detachFromActiveGroups).toHaveBeenCalled();
    expect(queueManager.playFrom).toHaveBeenCalledWith("dev1", [{ songId: "s1" }], 3, "http://127.0.0.1:46400");
    expect(fns.seekPeerToSeconds).toHaveBeenCalledWith("dlna:dev1", 12.5);
    expect(b).toEqual({ success: true, position: 12.5 });
  });

  it("cast 端:seek 落位失败 → position=null(不谎报成功落位)", async () => {
    fns.seekPeerToSeconds.mockResolvedValueOnce(false);
    const b = await json(await post("/v1/peers/group:g1/queue/play", { items: [], position: 9 }));
    expect(b.position).toBeNull();
  });

  it("cast 端:负 position 夹到 0;非有限数视为未传", async () => {
    await post("/v1/peers/dlna:dev1/queue/play", { items: [], position: -3 });
    expect(fns.seekPeerToSeconds.mock.calls[0][1]).toBe(0);
    fns.seekPeerToSeconds.mockClear();
    await post("/v1/peers/dlna:dev1/queue/play", { items: [], position: "abc" });
    expect(fns.seekPeerToSeconds).not.toHaveBeenCalled();
  });

  it("cast 端:起播抛错 → 500(走统一内部错误契约)", async () => {
    queueManager.playFrom.mockRejectedValueOnce(new Error("SOAP 拒连"));
    const r = await post("/v1/peers/dlna:dev1/queue/play", { items: [] });
    expect(r.status).toBe(500);
  });

  it("local 端:起点随起播交出(不经 seek),响应回显 position", async () => {
    const b = await json(await post("/v1/peers/local:u1/queue/play", { items: [{ songId: "s1" }], startIndex: 1, position: 7 }));
    expect(pm.localPlayFrom).toHaveBeenCalledWith("local:u1", "u1", [{ songId: "s1" }], 1, 7);
    expect(b).toEqual({ success: true, position: 7 });
    expect(fns.seekPeerToSeconds).not.toHaveBeenCalled();
  });

  it("startIndex 非数值 → 0;缺 position → null", async () => {
    const b = await json(await post("/v1/peers/local:u1/queue/play", { items: [] }));
    expect(pm.localPlayFrom.mock.calls[0][3]).toBe(0);
    expect(b.position).toBeNull();
  });
});

// ==================== POST /v1/peers/:peerId/queue/transfer-from ====================

describe("POST /v1/peers/:peerId/queue/transfer-from", () => {
  it("from 缺失/空白/非字符串 → 400", async () => {
    for (const body of [{}, { from: "" }, { from: "   " }, { from: 42 }]) {
      expect((await post("/v1/peers/local:u1/queue/transfer-from", body)).status).toBe(400);
    }
  });

  it("from === to(自我覆盖)→ 400", async () => {
    const r = await post("/v1/peers/dlna:dev1/queue/transfer-from", { from: "dlna:dev1" });
    expect(r.status).toBe(400);
  });

  it("源端不存在 → 400(不能把幻影队列当真)", async () => {
    pm.getQueueSnapshot.mockReturnValueOnce(null);
    expect((await post("/v1/peers/dlna:dev1/queue/transfer-from", { from: "dlna:ghost" })).status).toBe(400);
  });

  it("local 源端看 PeerManager 是否持有该实例(快照为空不算不存在)", async () => {
    pm.getQueueSnapshot.mockReturnValueOnce({ items: [] });
    pm.get.mockReturnValueOnce(null);
    expect((await post("/v1/peers/dlna:dev1/queue/transfer-from", { from: "local:u2" })).status).toBe(400);

    pm.getQueueSnapshot.mockReturnValueOnce({ items: [] });
    pm.get.mockReturnValueOnce({ peerId: "local:u2" });
    const b = await json(await post("/v1/peers/dlna:dev1/queue/transfer-from", { from: "local:u2" }));
    expect(b).toEqual({ success: true, transferred: 0 });
  });

  it("源端队列为空 → 200 transferred:0(不算错误)", async () => {
    pm.getQueueSnapshot.mockReturnValueOnce({ items: [], currentIndex: 0 });
    const b = await json(await post("/v1/peers/dlna:dev1/queue/transfer-from", { from: "dlna:src" }));
    expect(b).toEqual({ success: true, transferred: 0 });
  });

  it("cast 目标:sendspin 移交成立时按泵位置落位(不 seek)", async () => {
    pm.getQueueSnapshot.mockReturnValueOnce({ items: [{ songId: "sg" }], currentIndex: 0, playMode: "order" });
    fns.tryArmSendspinBorrow.mockResolvedValueOnce({ armed: true, songId: "sg", positionSeconds: 42 });
    fns.borrowLandingConfirmed.mockResolvedValueOnce(true);
    queueManager.playFrom.mockResolvedValueOnce(0);
    const b = await json(await post("/v1/peers/sendspin:sc1/queue/transfer-from", { from: "sendspin:sc2" }));
    expect(fns.tryArmSendspinBorrow).toHaveBeenCalledWith("sendspin:sc2", "sendspin:sc1", null);
    expect(fns.seekPeerToSeconds).not.toHaveBeenCalled();
    expect(b).toEqual({ success: true, transferred: 1, startIndex: 0, position: 42 });
    expect(queueManager.setPlayMode).toHaveBeenCalledWith("sc1", "order");
  });

  it("cast 目标:移交不成立 → 走常规对齐(读源端实时进度再 seek)", async () => {
    pm.getQueueSnapshot.mockReturnValueOnce({ items: [{ songId: "a" }, { songId: "b" }], currentIndex: 1 });
    fns.tryArmSendspinBorrow.mockResolvedValueOnce({ armed: true, songId: "a", positionSeconds: 5 });
    fns.readPeerPositionSeconds.mockResolvedValueOnce(33.5);
    fns.seekPeerToSeconds.mockResolvedValueOnce(true);
    const b = await json(await post("/v1/peers/dlna:dev1/queue/transfer-from", { from: "dlna:src" }));
    expect(b.startIndex).toBe(1);
    expect(b.position).toBe(33.5);
    expect(fns.seekPeerToSeconds).toHaveBeenCalledWith("dlna:dev1", 33.5);
  });

  it("cast 目标:调用方显式给 position 时优先于服务端读数", async () => {
    pm.getQueueSnapshot.mockReturnValueOnce({ items: [{ songId: "a" }], currentIndex: 0 });
    fns.seekPeerToSeconds.mockResolvedValueOnce(true);
    const b = await json(await post("/v1/peers/dlna:dev1/queue/transfer-from", { from: "dlna:src", position: 12 }));
    expect(fns.readPeerPositionSeconds).not.toHaveBeenCalled();
    expect(b.position).toBe(12);
  });

  it("cast 目标:position 为 0 → 不 seek(0 秒无需落位),position 为 null", async () => {
    pm.getQueueSnapshot.mockReturnValueOnce({ items: [{ songId: "a" }], currentIndex: 0 });
    fns.readPeerPositionSeconds.mockResolvedValueOnce(0);
    const b = await json(await post("/v1/peers/dlna:dev1/queue/transfer-from", { from: "dlna:src" }));
    expect(fns.seekPeerToSeconds).not.toHaveBeenCalled();
    expect(b.position).toBeNull();
  });

  it("local 目标:起点随起播交出,不 seek", async () => {
    pm.getQueueSnapshot.mockReturnValueOnce({ items: [{ songId: "a" }], currentIndex: 0, playMode: "shuffle" });
    fns.readPeerPositionSeconds.mockResolvedValueOnce(8);
    const b = await json(await post("/v1/peers/local:u1/queue/transfer-from", { from: "dlna:src" }));
    expect(pm.localPlayFrom).toHaveBeenCalledWith("local:u1", "u1", [{ songId: "a" }], 0, 8);
    expect(fns.seekPeerToSeconds).not.toHaveBeenCalled();
    expect(b.position).toBe(8);
    expect(pm.localSetPlayMode).toHaveBeenCalledWith("local:u1", "shuffle");
  });

  it("local 目标:进度为 0 → 不带起点(at=undefined)", async () => {
    pm.getQueueSnapshot.mockReturnValueOnce({ items: [{ songId: "a" }], currentIndex: 0 });
    fns.readPeerPositionSeconds.mockResolvedValueOnce(0);
    const b = await json(await post("/v1/peers/local:u1/queue/transfer-from", { from: "dlna:src" }));
    expect(pm.localPlayFrom.mock.calls[0][4]).toBeUndefined();
    expect(b.position).toBeNull();
  });

  it("currentIndex 越界/非数值 → 起点回落 0", async () => {
    for (const ci of [99, -1, "x", undefined]) {
      resetPeersFakes();
      pm.getQueueSnapshot.mockReturnValueOnce({ items: [{ songId: "a" }], currentIndex: ci });
      pm.localPlayFrom.mockClear();
      await post("/v1/peers/local:u1/queue/transfer-from", { from: "dlna:src" });
      expect(pm.localPlayFrom.mock.calls[0][3]).toBe(0);
    }
  });

  it("cast 目标起播抛错 → 500", async () => {
    pm.getQueueSnapshot.mockReturnValueOnce({ items: [{ songId: "a" }], currentIndex: 0 });
    queueManager.playFrom.mockRejectedValueOnce(new Error("投递失败"));
    expect((await post("/v1/peers/dlna:dev1/queue/transfer-from", { from: "dlna:src" })).status).toBe(500);
  });

  it("播放模式非法值不下发;下发抛错不影响流转结果(best-effort)", async () => {
    pm.getQueueSnapshot.mockReturnValueOnce({ items: [{ songId: "a" }], currentIndex: 0, playMode: "bogus" });
    await post("/v1/peers/dlna:dev1/queue/transfer-from", { from: "dlna:src" });
    expect(queueManager.setPlayMode).not.toHaveBeenCalled();

    resetPeersFakes();
    pm.getQueueSnapshot.mockReturnValueOnce({ items: [{ songId: "a" }], currentIndex: 0, playMode: "one" });
    queueManager.setPlayMode.mockImplementationOnce(() => { throw new Error("模式失败"); });
    const r = await post("/v1/peers/dlna:dev1/queue/transfer-from", { from: "dlna:src" });
    expect(r.status).toBe(200);
    expect((await json(r)).transferred).toBe(1);
  });
});

// ==================== 队列增删改 j/ 跳播 / 清空 / 停用 ====================

describe("队列变更端点", () => {
  it("jump:index 非整数 → 400;cast 走 jumpTo;local 走 localSetIndex", async () => {
    expect((await post("/v1/peers/dlna:dev1/queue/jump", { index: 1.5 })).status).toBe(400);
    expect((await post("/v1/peers/dlna:dev1/queue/jump", {})).status).toBe(400);
    await post("/v1/peers/dlna:dev1/queue/jump", { index: 2 });
    expect(queueManager.jumpTo).toHaveBeenCalledWith("dev1", 2, "http://127.0.0.1:46400");
    resetPeersFakes();
    await post("/v1/peers/local:u1/queue/jump", { index: 2 });
    expect(pm.localSetIndex).toHaveBeenCalledWith("local:u1", 2);
    expect(queueManager.jumpTo).not.toHaveBeenCalled();
  });

  it("jump:cast 抛错 → 500", async () => {
    queueManager.jumpTo.mockRejectedValueOnce(new Error("索引越界"));
    expect((await post("/v1/peers/dlna:dev1/queue/jump", { index: 9 })).status).toBe(500);
  });

  it("enqueue:items 非数组 → 400;cast/local 分流", async () => {
    expect((await post("/v1/peers/dlna:dev1/queue/enqueue", { items: {} })).status).toBe(400);
    await post("/v1/peers/dlna:dev1/queue/enqueue", { items: [{ songId: "a" }] });
    expect(queueManager.enqueue).toHaveBeenCalledWith("dev1", [{ songId: "a" }], "http://127.0.0.1:46400");
    resetPeersFakes();
    await post("/v1/peers/local:u1/queue/enqueue", { items: [{ songId: "a" }] });
    expect(pm.localEnqueue).toHaveBeenCalledWith("local:u1", "u1", [{ songId: "a" }]);
  });

  it("enqueue:cast 抛错 → 500", async () => {
    queueManager.enqueue.mockRejectedValueOnce(new Error("追加失败"));
    expect((await post("/v1/peers/dlna:dev1/queue/enqueue", { items: [] })).status).toBe(500);
  });

  it("DELETE queue:cast 清队列控制器,local 清本机队列", async () => {
    await del("/v1/peers/dlna:dev1/queue");
    expect(queueManager.clear).toHaveBeenCalledWith("dev1");
    resetPeersFakes();
    await del("/v1/peers/local:u1/queue");
    expect(pm.localClear).toHaveBeenCalledWith("local:u1");
    expect(queueManager.clear).not.toHaveBeenCalled();
  });

  it("DELETE queue/:index:非数字索引 → 400;cast/local 分流", async () => {
    expect((await del("/v1/peers/dlna:dev1/queue/abc")).status).toBe(400);
    await del("/v1/peers/dlna:dev1/queue/3");
    expect(queueManager.removeAt).toHaveBeenCalledWith("dev1", 3, "http://127.0.0.1:46400");
    resetPeersFakes();
    await del("/v1/peers/local:u1/queue/3");
    expect(pm.localRemoveAt).toHaveBeenCalledWith("local:u1", 3);
  });

  it("deactivate:仅 cast 端真正停用;local 静默成功", async () => {
    await post("/v1/peers/group:g1/queue/deactivate");
    expect(queueManager.deactivate).toHaveBeenCalledWith("g1");
    resetPeersFakes();
    const r = await post("/v1/peers/local:u1/queue/deactivate");
    expect(r.status).toBe(200);
    expect(queueManager.deactivate).not.toHaveBeenCalled();
  });

  it("reorder:from/to 必须整数 → 否则 400;cast/local 分流", async () => {
    for (const b of [{}, { from: 1 }, { from: 1, to: 1.5 }, { from: "1", to: 2 }]) {
      expect((await post("/v1/peers/dlna:dev1/queue/reorder", b)).status).toBe(400);
    }
    await post("/v1/peers/dlna:dev1/queue/reorder", { from: 1, to: 3 });
    expect(queueManager.reorder).toHaveBeenCalledWith("dev1", 1, 3);
    resetPeersFakes();
    await post("/v1/peers/local:u1/queue/reorder", { from: 1, to: 3 });
    expect(pm.localReorder).toHaveBeenCalledWith("local:u1", 1, 3);
  });

  it("play-mode:非法模式 → 400;cast/local 分流", async () => {
    expect((await post("/v1/peers/dlna:dev1/play-mode", { mode: "random" })).status).toBe(400);
    await post("/v1/peers/dlna:dev1/play-mode", { mode: "shuffle" });
    expect(queueManager.setPlayMode).toHaveBeenCalledWith("dev1", "shuffle");
    resetPeersFakes();
    await post("/v1/peers/local:u1/play-mode", { mode: "one" });
    expect(pm.localSetPlayMode).toHaveBeenCalledWith("local:u1", "one");
  });

  it("queue/index:index 非数值 → 400;非 local → 400(只有本机实例接受上报)", async () => {
    expect((await post("/v1/peers/local:u1/queue/index", { index: "1" })).status).toBe(400);
    expect((await post("/v1/peers/dlna:dev1/queue/index", { index: 1 })).status).toBe(400);
    await post("/v1/peers/local:u1/queue/index", { index: 1 });
    expect(pm.localSetIndex).toHaveBeenCalledWith("local:u1", 1);
  });
});

// ==================== 洗牌序列 ====================

describe("队列洗牌序列", () => {
  it("GET shuffle:非 local 或解析失败 → 400;无快照 → 400;成功回轻量形状", async () => {
    expect((await get("/v1/peers/dlna:dev1/queue/shuffle")).status).toBe(400);
    expect((await get("/v1/peers/bare/queue/shuffle")).status).toBe(400);
    pm.getQueueSnapshot.mockReturnValueOnce(null);
    expect((await get("/v1/peers/local:u1/queue/shuffle")).status).toBe(400);
    pm.getQueueSnapshot.mockReturnValue({ items: [1], currentIndex: 0 });
    fns.localShuffleInfo.mockReturnValueOnce({ epoch: 3, order: [2, 0, 1], pos: 0, len: 3 });
    const b = await json(await get("/v1/peers/local:u1/queue/shuffle"));
    expect(b).toEqual({ epoch: 3, order: [2, 0, 1], pos: 0, len: 3 });
  });

  it("POST reshuffle:非 local → 400;管理器返回 null → 400;成功回新序列", async () => {
    expect((await post("/v1/peers/dlna:dev1/queue/reshuffle")).status).toBe(400);
    pm.reshuffleLocal.mockReturnValueOnce(null);
    expect((await post("/v1/peers/local:u1/queue/reshuffle")).status).toBe(400);
    pm.reshuffleLocal.mockReturnValueOnce({});
    expect((await post("/v1/peers/local:u1/queue/reshuffle")).status).toBe(200);
    expect(pm.reshuffleLocal).toHaveBeenCalledWith("local:u1");
  });
});

// ==================== 定时暂停(sleep timer) ====================

describe("定时暂停", () => {
  it("非 cast 端 → 400 castPeerOnly(本机/客户端本地倒计时,服务端不接管)", async () => {
    expect((await post("/v1/peers/local:u1/sleep-timer", { durationSeconds: 60 })).status).toBe(400);
    expect((await get("/v1/peers/local:u1/sleep-timer")).status).toBe(400);
    expect((await post("/v1/peers/bare/sleep-timer", { durationSeconds: 60 })).status).toBe(400);
  });

  it("时长非法(<=0 / 非有限)→ 400;成功回 remainingMs", async () => {
    for (const b of [{}, { durationSeconds: 0 }, { durationSeconds: -5 }, { durationSeconds: "x" }, { durationSeconds: Number.POSITIVE_INFINITY }]) {
      expect((await post("/v1/peers/dlna:dev1/sleep-timer", b)).status).toBe(400);
    }
    queueManager.sleepTimerRemaining.mockReturnValueOnce(59_000);
    const b = await json(await post("/v1/peers/dlna:dev1/sleep-timer", { durationSeconds: 60 }));
    expect(queueManager.setSleepTimer).toHaveBeenCalledWith("dev1", 60_000);
    expect(b).toEqual({ success: true, remainingMs: 59_000 });
  });

  it("GET:未设置 → active:false;已设置 → active:true + remainingMs", async () => {
    queueManager.sleepTimerRemaining.mockReturnValueOnce(null);
    expect(await json(await get("/v1/peers/dlna:dev1/sleep-timer"))).toEqual({ active: false });
    queueManager.sleepTimerRemaining.mockReturnValueOnce(1_500);
    expect(await json(await get("/v1/peers/dlna:dev1/sleep-timer"))).toEqual({ active: true, remainingMs: 1_500 });
  });

  it("DELETE:cast 端清除;非 cast 静默成功(幂等)", async () => {
    await del("/v1/peers/dlna:dev1/sleep-timer");
    expect(queueManager.clearSleepTimer).toHaveBeenCalledWith("dev1");
    resetPeersFakes();
    const r = await del("/v1/peers/local:u1/sleep-timer");
    expect(r.status).toBe(200);
    expect(queueManager.clearSleepTimer).not.toHaveBeenCalled();
  });
});

// ==================== 传输控制 play / pause / stop ====================

describe("传输控制 play / pause / stop", () => {
  it("四种 kind 各自的链路被调到", async () => {
    // dlna:resumePlayback + playDevice
    await post("/v1/peers/dlna:dev1/play");
    expect(queueController.resumePlayback).toHaveBeenCalledWith("dev1");
    expect(fns.playDevice).toHaveBeenCalledWith("dev1");
    resetPeersFakes();
    // group / airplay / sendspin:transport("play")
    for (const p of ["group:g1", "airplay:ap1", "sendspin:sc1"]) {
      resetPeersFakes();
      expect((await post(`/v1/peers/${p}/play`)).status).toBe(200);
      expect(queueController.transport).toHaveBeenCalledWith(p.split(":")[1], "play");
    }
    // local:定向下发
    resetPeersFakes();
    await post("/v1/peers/local:u1/play");
    expect(fns.dispatchPeerCommand).toHaveBeenCalledWith("local:u1", "play");
  });

  it("peerId 形态非法 → 400", async () => {
    for (const path of ["/v1/peers/bare/play", "/v1/peers/bare/pause", "/v1/peers/bare/stop"]) {
      expect((await post(path)).status).toBe(400);
    }
  });

  it("设备/传输抛错 → 500(不把上游异常当成功)", async () => {
    fns.playDevice.mockRejectedValueOnce(new Error("DLNA 无响应"));
    expect((await post("/v1/peers/dlna:dev1/play")).status).toBe(500);
    resetPeersFakes();
    queueController.transport.mockRejectedValueOnce(new Error("组扇出失败"));
    expect((await post("/v1/peers/group:g1/play")).status).toBe(500);
    resetPeersFakes();
    fns.pauseDevice.mockRejectedValueOnce(new Error("暂停失败"));
    expect((await post("/v1/peers/dlna:dev1/pause")).status).toBe(500);
    resetPeersFakes();
    queueController.transport.mockRejectedValueOnce(new Error("停止失败"));
    expect((await post("/v1/peers/airplay:ap1/stop")).status).toBe(500);
    resetPeersFakes();
    fns.stopDevice.mockRejectedValueOnce(new Error("停止失败"));
    expect((await post("/v1/peers/dlna:dev1/stop")).status).toBe(500);
  });

  it("pause/stop 的 local 分支走定向下发(含 delivered 反馈)", async () => {
    fns.dispatchPeerCommand.mockReturnValueOnce({ success: true, delivered: false });
    const b = await json(await post("/v1/peers/local:u1/pause"));
    expect(b.delivered).toBe(false);
    await post("/v1/peers/local:u1/stop");
    expect(fns.dispatchPeerCommand).toHaveBeenCalledWith("local:u1", "stop");
  });

  it("stop 会先停队列控制器,再停设备(dlna)", async () => {
    await post("/v1/peers/dlna:dev1/stop");
    expect(queueController.stopPlayback).toHaveBeenCalledWith("dev1");
    expect(fns.stopDevice).toHaveBeenCalledWith("dev1");
  });
});

// ==================== next / prev ====================

describe("next / prev", () => {
  it("cast 端:脱离组 + 切换 + 打日志;local:定向下发", async () => {
    await post("/v1/peers/dlna:dev1/next");
    expect(fns.detachFromActiveGroups).toHaveBeenCalled();
    expect(queueManager.next).toHaveBeenCalledWith("dev1", "http://127.0.0.1:46400");
    resetPeersFakes();
    await post("/v1/peers/group:g1/prev");
    expect(queueManager.prev).toHaveBeenCalledWith("g1", "http://127.0.0.1:46400");
    resetPeersFakes();
    await post("/v1/peers/local:u1/next");
    expect(fns.dispatchPeerCommand).toHaveBeenCalledWith("local:u1", "next");
    resetPeersFakes();
    await post("/v1/peers/local:u1/prev");
    expect(fns.dispatchPeerCommand).toHaveBeenCalledWith("local:u1", "prev");
  });

  it("切歌抛错 → 500;peerId 非法 → 400", async () => {
    queueManager.next.mockRejectedValueOnce(new Error("切歌失败"));
    expect((await post("/v1/peers/dlna:dev1/next")).status).toBe(500);
    queueManager.prev.mockRejectedValueOnce(new Error("切歌失败"));
    expect((await post("/v1/peers/dlna:dev1/prev")).status).toBe(500);
    expect((await post("/v1/peers/bare/next")).status).toBe(400);
    expect((await post("/v1/peers/bare/prev")).status).toBe(400);
  });
});

// ==================== POST /v1/peers/:peerId/seek ====================

describe("POST /v1/peers/:peerId/seek", () => {
  it("缺 seconds/position 或非有限数 → 400", async () => {
    for (const b of [{}, { seconds: "3" }, { seconds: Number.NaN }, { position: Number.POSITIVE_INFINITY }]) {
      expect((await post("/v1/peers/dlna:dev1/seek", b)).status).toBe(400);
    }
    expect((await json(await post("/v1/peers/dlna:dev1/seek", {}))).code).toBe("INVALID_PARAM");
  });

  it("seconds 优先于 position", async () => {
    await post("/v1/peers/dlna:dev1/seek", { seconds: 30, position: 99 });
    expect(fns.seekDevice).toHaveBeenCalledWith("dev1", 30);
  });

  it("非整秒被按最小粒度对齐(精度守卫),并对所有来源生效", async () => {
    await post("/v1/peers/dlna:dev1/seek", { seconds: 12.7 });
    expect(fns.seekDevice.mock.calls[0][1] % 1).toBe(0);
  });

  it("走统一冷静期打标(覆盖 DLNA 不经 transport 的直连路径)", async () => {
    await post("/v1/peers/dlna:dev1/seek", { seconds: 5 });
    expect(fns.markSeekIssued).toHaveBeenCalledWith("dev1");
  });

  it("group / airplay / sendspin 走 transport('seek')", async () => {
    for (const p of ["group:g1", "airplay:ap1", "sendspin:sc1"]) {
      resetPeersFakes();
      await post(`/v1/peers/${p}/seek`, { seconds: 20 });
      expect(queueController.transport).toHaveBeenCalledWith(p.split(":")[1], "seek", 20);
    }
  });

  it("local:定向下发并原样回传 delivered(前端据此给「离线」反馈)", async () => {
    fns.dispatchPeerCommand.mockReturnValueOnce({ success: true, delivered: true });
    const b = await json(await post("/v1/peers/local:u1/seek", { seconds: 7 }));
    expect(fns.dispatchPeerCommand).toHaveBeenCalledWith("local:u1", "seek", { seconds: 7 });
    expect(b.delivered).toBe(true);
  });

  it("seek 失败 → 500;peerId 非法 → 400", async () => {
    fns.seekDevice.mockRejectedValueOnce(new Error("SOAP seek 被拒"));
    expect((await post("/v1/peers/dlna:dev1/seek", { seconds: 3 })).status).toBe(500);
    queueController.transport.mockRejectedValueOnce(new Error("seek 失败"));
    expect((await post("/v1/peers/group:g1/seek", { seconds: 3 })).status).toBe(500);
    expect((await post("/v1/peers/bare/seek", { seconds: 3 })).status).toBe(400);
  });
});

// ==================== POST /v1/peers/:peerId/volume ====================

describe("POST /v1/peers/:peerId/volume", () => {
  it("volume 非数值 → 400(五种 kind 一致)", async () => {
    for (const p of ["dlna:dev1", "group:g1", "airplay:ap1", "sendspin:sc1", "local:u1"]) {
      expect((await post(`/v1/peers/${p}/volume`, { volume: "50" })).status).toBe(400);
    }
  });

  it("dlna 走 setDeviceVolume;airplay 走 transport", async () => {
    await post("/v1/peers/dlna:dev1/volume", { volume: 42 });
    expect(fns.setDeviceVolume).toHaveBeenCalledWith("dev1", 42);
    resetPeersFakes();
    await post("/v1/peers/airplay:ap1/volume", { volume: 42 });
    expect(queueController.transport).toHaveBeenCalledWith("ap1", "volume", 42);
  });

  it("group:先落库再扇出(成员全离线也要保住用户调节结果)", async () => {
    await post("/v1/peers/group:g1/volume", { volume: 42 });
    expect(gm.setVolume).toHaveBeenCalledWith("g1", 42);
    expect(queueController.transport).toHaveBeenCalledWith("g1", "volume", 42);
  });

  it("sendspin:写成功后广播回显(以本次写入值为准)", async () => {
    queueController.transport.mockRejectedValueOnce(new Error("扇出失败"));
    expect((await post("/v1/peers/sendspin:sc1/volume", { volume: 42 })).status).toBe(500);
    resetPeersFakes();
    await post("/v1/peers/sendspin:sc1/volume", { volume: 42 });
    expect(fns.broadcastSendspinVolume).toHaveBeenCalledWith("sendspin:sc1", { volume: 42 });
  });

  it("local 定向下发;peerId 非法 → 400", async () => {
    await post("/v1/peers/local:u1/volume", { volume: 42 });
    expect(fns.dispatchPeerCommand).toHaveBeenCalledWith("local:u1", "volume", { volume: 42 });
    expect((await post("/v1/peers/bare/volume", { volume: 1 })).status).toBe(400);
  });

  it("dlna 上游抛错 → 500", async () => {
    fns.setDeviceVolume.mockRejectedValueOnce(new Error("音量失败"));
    expect((await post("/v1/peers/dlna:dev1/volume", { volume: 42 })).status).toBe(500);
  });
});

// ==================== POST /v1/peers/:peerId/announce ====================

describe("播报 announce", () => {
  it("缺 url → 400", async () => {
    expect((await post("/v1/peers/dlna:dev1/announce", {})).status).toBe(400);
    expect((await post("/v1/peers/dlna:dev1/announce", { url: 123 })).status).toBe(400);
  });

  it("默认非阻塞:立刻 202,不等播报跑完", async () => {
    const r = await post("/v1/peers/dlna:dev1/announce", { url: "http://tts/1.mp3", volume: 30 });
    expect(r.status).toBe(202);
    expect(await json(r)).toEqual({ success: true, accepted: true });
    expect(fns.announceOnPeer).toHaveBeenCalledWith({ peerId: "dlna:dev1", url: "http://tts/1.mp3", volume: 30 });
  });

  it("已在播报 → 409(不叠加)", async () => {
    fns.isAnnouncing.mockReturnValueOnce(true);
    const r = await post("/v1/peers/dlna:dev1/announce", { url: "http://tts/1.mp3" });
    expect(r.status).toBe(409);
    expect((await json(r)).code).toBe("CONFLICT");
  });

  it("blocking=true:等全程结束并回传结果", async () => {
    fns.announceOnPeer.mockResolvedValueOnce({ announced: true });
    const r = await post("/v1/peers/dlna:dev1/announce", { url: "http://tts/1.mp3", blocking: true });
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({ success: true, announced: true });
  });

  it("blocking=true 且播报失败 → 500;非阻塞失败只记日志(已 202,无法再改响应)", async () => {
    fns.announceOnPeer.mockRejectedValueOnce(new Error("TTS 拉流失败"));
    expect((await post("/v1/peers/dlna:dev1/announce", { url: "u", blocking: true })).status).toBe(500);

    resetPeersFakes();
    fns.announceOnPeer.mockRejectedValueOnce(new Error("TTS 拉流失败"));
    expect((await post("/v1/peers/dlna:dev1/announce", { url: "u" })).status).toBe(202);
  });

  it("volume 非数值 → 视为未传", async () => {
    await post("/v1/peers/dlna:dev1/announce", { url: "u", volume: "30" });
    expect(fns.announceOnPeer).toHaveBeenCalledWith({ peerId: "dlna:dev1", url: "u", volume: undefined });
  });
});

// ==================== POST /v1/peers/:peerId/mute ====================

describe("静音 mute", () => {
  it("muted 非布尔 → 400", async () => {
    expect((await post("/v1/peers/dlna:dev1/mute", { muted: "true" })).status).toBe(400);
    expect((await post("/v1/peers/dlna:dev1/mute", {})).status).toBe(400);
  });

  it("dlna / airplay / sendspin 各走自己的渲染器", async () => {
    await post("/v1/peers/dlna:dev1/mute", { muted: true });
    expect(fns.setDeviceMute).toHaveBeenCalledWith("dev1", true);
    resetPeersFakes();
    await post("/v1/peers/airplay:ap1/mute", { muted: true });
    expect(fns.setAirPlayMuted).toHaveBeenCalledWith("ap1", true);
    resetPeersFakes();
    await post("/v1/peers/sendspin:sc1/mute", { muted: true });
    expect(fns.setSendspinMemberMuted).toHaveBeenCalledWith("sc1", true);
  });

  it("组静音:无成员 → 400", async () => {
    gm.get.mockReturnValueOnce({ memberIds: [] });
    const r = await post("/v1/peers/group:g1/mute", { muted: true });
    expect(r.status).toBe(400);
    expect((await json(r)).code).toBe("INVALID_PARAM");
  });

  it("组静音:全员失败 → 502(带上游原因)", async () => {
    gm.get.mockReturnValueOnce({ memberIds: ["dlna:d1", "sendspin:s1"] });
    fns.setDeviceMute.mockRejectedValueOnce(new Error("设备不支持静音"));
    fns.setSendspinMemberMuted.mockRejectedValueOnce(new Error("sendspin 静音失败"));
    const r = await post("/v1/peers/group:g1/mute", { muted: true });
    expect(r.status).toBe(502);
    expect((await json(r)).error).toContain("设备不支持静音");
  });

  it("组静音:部分成功 → 个别成员失败不连累其余(applied/total)", async () => {
    gm.get.mockReturnValueOnce({ memberIds: ["dlna:d1", "sendspin:s1"] });
    fns.setSendspinMemberMuted.mockRejectedValueOnce(new Error("该成员离线"));
    const b = await json(await post("/v1/peers/group:g1/mute", { muted: false }));
    expect(b).toEqual({ success: true, applied: 1, total: 2 });
  });

  it("组静音:成员按 kind 分流(dlna 走 RenderingControl,sendspin 走双置位)", async () => {
    gm.get.mockReturnValueOnce({ memberIds: ["dlna:d1", "sendspin:s1"] });
    await post("/v1/peers/group:g1/mute", { muted: true });
    expect(fns.setDeviceMute).toHaveBeenCalledWith("d1", true);
    expect(fns.setSendspinMemberMuted).toHaveBeenCalledWith("s1", true);
  });

  it("上游抛错 → 500", async () => {
    fns.setDeviceMute.mockRejectedValueOnce(new Error("静音失败"));
    expect((await post("/v1/peers/dlna:dev1/mute", { muted: true })).status).toBe(500);
    fns.setAirPlayMuted.mockRejectedValueOnce(new Error("静音失败"));
    expect((await post("/v1/peers/airplay:ap1/mute", { muted: true })).status).toBe(500);
    fns.setSendspinMemberMuted.mockRejectedValueOnce(new Error("静音失败"));
    expect((await post("/v1/peers/sendspin:sc1/mute", { muted: true })).status).toBe(500);
  });
});

// ==================== POST /v1/peers/:peerId/reset ====================

describe("POST /v1/peers/:peerId/reset", () => {
  it("cast 端:停止 + 清队列(dlna 走 stopDevice,其余走 transport)", async () => {
    await post("/v1/peers/dlna:dev1/reset");
    expect(queueController.stopPlayback).toHaveBeenCalledWith("dev1");
    expect(fns.stopDevice).toHaveBeenCalledWith("dev1");
    expect(queueController.clear).toHaveBeenCalledWith("dev1");
    resetPeersFakes();
    await post("/v1/peers/sendspin:sc1/reset");
    expect(queueController.transport).toHaveBeenCalledWith("sc1", "stop");
    expect(queueController.clear).toHaveBeenCalledWith("sc1");
  });

  it("local 端:清队列元数据 + 丢弃状态上报(否则 /status 仍叠加旧 state)", async () => {
    await post("/v1/peers/local:u1/reset");
    expect(pm.localClear).toHaveBeenCalledWith("local:u1");
    expect(pm.clearLocalStatusReport).toHaveBeenCalledWith("local:u1");
  });

  it("停止阶段抛错 → 500(不留下半清状态)", async () => {
    fns.stopDevice.mockRejectedValueOnce(new Error("停止失败"));
    expect((await post("/v1/peers/dlna:dev1/reset")).status).toBe(500);
    expect(queueController.clear).not.toHaveBeenCalled();
  });

  it("peerId 非法 → 400", async () => {
    expect((await post("/v1/peers/bare/reset")).status).toBe(400);
  });
});

// ==================== GET /v1/peers/:peerId ====================

describe("GET /v1/peers/:peerId", () => {
  it("未注册 → 400;已注册 → 带 queue 快照", async () => {
    pm.get.mockReturnValueOnce(null);
    expect((await get("/v1/peers/dlna:dev1")).status).toBe(400);
    pm.get.mockReturnValueOnce({ peerId: "dlna:dev1", name: "主卧" });
    pm.getQueueSnapshot.mockReturnValueOnce({ items: [1] });
    const b = await json(await get("/v1/peers/dlna:dev1"));
    expect(b.peer.name).toBe("主卧");
    expect(b.peer.queue).toEqual({ items: [1] });
  });
});

// ==================== GET /v1/peers/:peerId/status ====================

describe("GET /v1/peers/:peerId/status", () => {
  it("peerId 非法 → 400", async () => {
    expect((await get("/v1/peers/bare/status")).status).toBe(400);
  });

  it("dlna:无 GENA 事件时原样返回 SOAP 值", async () => {
    fns.getDeviceStatus.mockResolvedValueOnce({ state: "PLAYING", position: 12, duration: 200, volume: 30, muted: false });
    eventManager.getEventState.mockReturnValueOnce(null);
    const b = await json(await get("/v1/peers/dlna:dev1/status"));
    expect(b).toEqual({ state: "PLAYING", position: 12, duration: 200, volume: 30, muted: false });
  });

  it("dlna:GENA 事件覆盖 state/volume/muted/updatedAt,但绝不覆盖 position/duration", async () => {
    fns.getDeviceStatus.mockResolvedValueOnce({ state: "STOPPED", position: 40, duration: 200, volume: 10, muted: false, updatedAt: 1 });
    eventManager.getEventState.mockReturnValueOnce({ state: "PLAYING", position: 3, volume: 55, muted: true, updatedAt: 1_700 });
    const b = await json(await get("/v1/peers/dlna:dev1/status"));
    expect(b.state).toBe("PLAYING");
    expect(b.volume).toBe(55);
    expect(b.muted).toBe(true);
    expect(b.updatedAt).toBe(1_700);
    // 关键:SOAP 的实时 position 不被 GENA 旧采样打回
    expect(b.position).toBe(40);
    expect(b.duration).toBe(200);
  });

  it("dlna:GENA 事件字段缺失/零值时保持 SOAP 值", async () => {
    fns.getDeviceStatus.mockResolvedValueOnce({ state: "PLAYING", position: 1, duration: 2, volume: 10, muted: false, updatedAt: 5 });
    eventManager.getEventState.mockReturnValueOnce({ volume: "loud", muted: "yes", updatedAt: 0 });
    const b = await json(await get("/v1/peers/dlna:dev1/status"));
    expect(b.volume).toBe(10);
    expect(b.muted).toBe(false);
    expect(b.updatedAt).toBe(5);
  });

  it("dlna:上游抛错 → 500", async () => {
    fns.getDeviceStatus.mockRejectedValueOnce(new Error("SOAP 超时"));
    expect((await get("/v1/peers/dlna:dev1/status")).status).toBe(500);
  });

  it("group:事件源取组长设备;抛错 → 500", async () => {
    fns.getGroupStatus.mockResolvedValueOnce({ state: "PLAYING", position: 3, duration: 9, volume: 20, muted: false });
    fns.getGroupLeaderDeviceId.mockReturnValueOnce("leader1");
    eventManager.getEventState.mockReturnValueOnce({ state: "PAUSED_PLAYBACK", volume: 21 });
    const b = await json(await get("/v1/peers/group:g1/status"));
    expect(fns.getGroupLeaderDeviceId).toHaveBeenCalledWith("g1");
    expect(eventManager.getEventState).toHaveBeenCalledWith("leader1");
    expect(b.state).toBe("PAUSED_PLAYBACK");
    expect(b.volume).toBe(21);

    fns.getGroupStatus.mockRejectedValueOnce(new Error("组状态失败"));
    expect((await get("/v1/peers/group:g1/status")).status).toBe(500);
  });

  it("airplay:直接回传 peer 状态", async () => {
    fns.getAirPlayPeerStatus.mockReturnValueOnce({ state: "PLAYING", media: { songId: "s" } });
    expect(await json(await get("/v1/peers/airplay:ap1/status"))).toEqual({ state: "PLAYING", media: { songId: "s" } });
  });

  it("sendspin:PlayerState → 对外 state 四态映射", async () => {
    fns.getSendspinDeviceVolume.mockReturnValue({ volume: 66, muted: true });
    fns.getSendspinFront.mockReturnValue({ currentMedia: () => ({ songId: "ss" }) });
    const cases: Array<[Any, string]> = [
      [PlaybackState.PLAYING, "PLAYING"],
      [PlaybackState.PAUSED, "PAUSED_PLAYBACK"],
      [PlaybackState.BUFFERING, "BUFFERING"],
      [PlaybackState.IDLE, "STOPPED"],
    ];
    for (const [inner, expected] of cases) {
      queueController.getPlayerState.mockResolvedValueOnce({ playbackState: inner, position: 1, duration: 2, updatedAt: 3 });
      const b = await json(await get("/v1/peers/sendspin:sc1/status"));
      expect(b.state).toBe(expected);
      expect(b.volume).toBe(66);
      expect(b.muted).toBe(true);
      expect(b.media).toEqual({ songId: "ss" });
    }
  });

  it("sendspin:控制器没有该端的状态 → 404", async () => {
    queueController.getPlayerState.mockResolvedValueOnce(null);
    const r = await get("/v1/peers/sendspin:sc1/status");
    expect(r.status).toBe(404);
    expect((await json(r)).code).toBe("NOT_FOUND");
  });

  it("sendspin:取状态抛错 → 500", async () => {
    queueController.getPlayerState.mockRejectedValueOnce(new Error("推流引擎未起"));
    expect((await get("/v1/peers/sendspin:sc1/status")).status).toBe(500);
  });

  it("local:无快照 → {};有快照无上报 → 只得队列;有上报 → 叠加传输态", async () => {
    pm.getQueueSnapshot.mockReturnValueOnce(null);
    expect(await json(await get("/v1/peers/local:u1/status"))).toEqual({});

    pm.getQueueSnapshot.mockReturnValueOnce({ items: [1], currentIndex: 0, updatedAt: 99 });
    pm.getLocalStatusReport.mockReturnValueOnce(null);
    expect(await json(await get("/v1/peers/local:u1/status"))).toEqual({ items: [1], currentIndex: 0, updatedAt: 99 });

    pm.getQueueSnapshot.mockReturnValueOnce({ items: [1], currentIndex: 0, updatedAt: 99 });
    pm.getLocalStatusReport.mockReturnValueOnce({ state: "PLAYING", position: 5, duration: 60, volume: 20, songId: "s1", reportedAt: 7 });
    const b = await json(await get("/v1/peers/local:u1/status"));
    expect(b.state).toBe("PLAYING");
    expect(b.position).toBe(5);
    expect(b.volume).toBe(20);
    expect(b.media).toEqual({ songId: "s1" });
    // updatedAt 必须是队列行的值(客户端用它做恢复新鲜度竞速)
    expect(b.updatedAt).toBe(99);
  });

  it("local:上报无 volume / 无 songId 时对应字段整体缺席(而非 null)", async () => {
    pm.getQueueSnapshot.mockReturnValueOnce({ items: [], currentIndex: 0 });
    pm.getLocalStatusReport.mockReturnValueOnce({ state: "STOPPED", position: 0, duration: 0, reportedAt: 1 });
    const b = await json(await get("/v1/peers/local:u1/status"));
    expect("volume" in b).toBe(false);
    expect("media" in b).toBe(false);
  });
});

// ==================== 三端分支补齐(group / airplay / sendspin 的 pause / stop / volume) ====================

describe("group / airplay / sendspin 的 pause / stop / volume 分支", () => {
  const CAST = ["group:g1", "airplay:ap1", "sendspin:sc1"];

  it("pause:三端各走 transport('pause')并成功", async () => {
    for (const p of CAST) {
      resetPeersFakes();
      expect((await post(`/v1/peers/${p}/pause`)).status).toBe(200);
      expect(queueController.transport).toHaveBeenCalledWith(p.split(":")[1], "pause");
    }
  });

  it("pause:三端 transport 抛错各自 → 500", async () => {
    for (const p of CAST) {
      resetPeersFakes();
      queueController.transport.mockRejectedValueOnce(new Error("暂停失败"));
      expect((await post(`/v1/peers/${p}/pause`)).status).toBe(500);
    }
  });

  it("play:airplay / sendspin transport 抛错 → 500", async () => {
    for (const p of ["airplay:ap1", "sendspin:sc1"]) {
      resetPeersFakes();
      queueController.transport.mockRejectedValueOnce(new Error("起播失败"));
      expect((await post(`/v1/peers/${p}/play`)).status).toBe(500);
    }
  });

  it("stop:三端各走「先停队列控制器,再 transport('stop')」", async () => {
    for (const p of CAST) {
      resetPeersFakes();
      expect((await post(`/v1/peers/${p}/stop`)).status).toBe(200);
      expect(queueController.stopPlayback).toHaveBeenCalledWith(p.split(":")[1]);
      expect(queueController.transport).toHaveBeenCalledWith(p.split(":")[1], "stop");
    }
  });

  it("stop:三端 transport 抛错各自 → 500", async () => {
    for (const p of CAST) {
      resetPeersFakes();
      queueController.transport.mockRejectedValueOnce(new Error("停止失败"));
      expect((await post(`/v1/peers/${p}/stop`)).status).toBe(500);
    }
  });

  it("volume:group 扇出抛错 → 500(库值已落,不回滚)", async () => {
    queueController.transport.mockRejectedValueOnce(new Error("扇出失败"));
    expect((await post("/v1/peers/group:g1/volume", { volume: 10 })).status).toBe(500);
    expect(gm.setVolume).toHaveBeenCalledWith("g1", 10);
  });

  it("volume:airplay 扇出抛错 → 500", async () => {
    queueController.transport.mockRejectedValueOnce(new Error("音量失败"));
    expect((await post("/v1/peers/airplay:ap1/volume", { volume: 10 })).status).toBe(500);
  });

  it("GET queue:peerId 无法解析(裸 id)→ currentMedia 为 undefined 而非 500", async () => {
    pm.getQueueSnapshot.mockReturnValueOnce({ items: [1], currentIndex: 0 });
    const b = await json(await get("/v1/peers/bare/queue"));
    expect(b.items).toEqual([1]);
    expect(b.currentMedia).toBeUndefined();
  });
});
