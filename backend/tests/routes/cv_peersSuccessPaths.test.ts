// peers 域路由覆盖率补口:精确层 403 + 六个传输端点的「兜底成功返回」(cv_ 前缀)。
//
// 目标行(src/routes/api/peers.ts):
//   - 107:GET /v1/peers/:peerId 精确层中间件的 403 分支。既有契约测试的 GET 403
//     实际被**通配层**(/v1/peers/:peerId/*,行 97)拦截 —— 通配层对裸路径也生效,
//     故精确层要触达必须先让通配层放行(canControlPeer 首调 true)、再在精确层拒绝
//     (次调 false)。
//   - 609/633/673/726/738/839:play/pause/stop/next/prev/volume 六个 handler 末尾的
//     `return c.json({ success: true })`。真实 parsePeerId 只认 5 种 kind 且每种都有
//     分支,兜底行只在「解析结果不落任何分支」时可达 —— 这里把共享 mock 最外层的
//     parsePeerId 覆盖成返回未知 kind,驱动六个端点走到兜底返回。
// 手法与 peersRoutesContract.test.ts 完全一致:真实 shared.ts 为底,只换服务层入口
// 与管理器单例(_sharedFakes/_peersFakes)。
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const parsePeerIdMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/routes/api/shared.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { overrides } = await import("./_sharedFakes.js");
  const { peersFakes } = await import("./_peersFakes.js");
  // 顺序要紧:parsePeerId 放最后,压过 actual/通用假体里的同名导出。
  return { ...actual, ...overrides, ...peersFakes, parsePeerId: parsePeerIdMock };
});

import { registerPeers } from "../../src/routes/api/peers.js";
import { fns, resetPeersFakes } from "./_peersFakes.js";

type Any = any;

let currentUser: Any = { id: "u1", username: "ray", isAdmin: false };

const app = new Hono();
app.use("*", async (c: Any, next: Any) => {
  c.set("user", currentUser);
  await next();
});
registerPeers(app as Any);

const get = (p: string) => app.request("http://x" + p);
const post = (p: string) =>
  app.request("http://x" + p, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
const json = async (r: Response) => (await r.json()) as Any;

beforeEach(() => {
  resetPeersFakes();
  currentUser = { id: "u1", username: "ray", isAdmin: false };
  parsePeerIdMock.mockReset();
  parsePeerIdMock.mockReturnValue({ kind: "unknown", id: "x" });
});

// ==================== 精确层 403(行 107) ====================

describe("GET /v1/peers/:peerId 精确层 403", () => {
  it("通配层放行、精确层拒绝 → 403 FORBIDDEN(不被通配层的 403 掩盖)", async () => {
    fns.canControlPeer.mockReturnValueOnce(true).mockReturnValueOnce(false);
    const r = await get("/v1/peers/dlna:dev1");
    expect(r.status).toBe(403);
    expect((await json(r)).code).toBe("FORBIDDEN");
  });
});

// ==================== 六个端点的兜底成功返回(609/633/673/726/738/839) ====================

describe("play/pause/stop/next/prev/volume 的兜底成功返回", () => {
  it.each(["play", "pause", "stop", "next", "prev"])(
    "POST /v1/peers/:peerId/%s:kind 不落任何分支 → 兜底 { success: true }",
    async (action: string) => {
      const r = await post(`/v1/peers/dlna:dev1/${action}`);
      expect(r.status).toBe(200);
      expect(await json(r)).toEqual({ success: true });
      // 证明走的是兜底而不是任一 kind 分支:不得有任何设备/队列/定向下发副作用。
      expect(fns.playDevice).not.toHaveBeenCalled();
      expect(fns.pauseDevice).not.toHaveBeenCalled();
      expect(fns.stopDevice).not.toHaveBeenCalled();
      expect(fns.dispatchPeerCommand).not.toHaveBeenCalled();
    },
  );

  it("POST /v1/peers/:peerId/volume:kind 不落任何分支 → 兜底 { success: true }(连 body 都不读)", async () => {
    const r = await post("/v1/peers/dlna:dev1/volume");
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({ success: true });
    expect(fns.setDeviceVolume).not.toHaveBeenCalled();
    expect(fns.dispatchPeerCommand).not.toHaveBeenCalled();
  });
});
