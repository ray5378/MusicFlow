// Sendspin 控制面(listSendspinPlayers)契约测试:
// 枚举出来的设备是「可投屏播放器」列表的唯一来源,available 必须如实反映客户端
// ready 状态 —— 卡在这里会表现为「列表里有一个点了没反应的假播放器」。
// MUST be the first import: re-exports the isolated DATA_DIR env for this file.
import "../plugins/_env.js";

import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({
  front: null as null | { clients: Map<string, { ready: boolean }> },
  started: 0,
}));

vi.mock("../../src/services/sendspin/index.js", () => ({
  getSendspinFront: () => h.front,
  startSendspinService: async () => {
    h.started += 1;
  },
}));

import { listSendspinPlayers } from "../../src/services/sendspin/control.js";

describe("listSendspinPlayers: 枚举已连接客户端", () => {
  it("服务未启动(getSendspinFront 为空)→ 空列表,不抛错", async () => {
    h.front = null;
    await expect(listSendspinPlayers()).resolves.toEqual([]);
  });

  it("按客户端 ID 逐个渲染为 sendspin 设备,available 取自 ready", async () => {
    h.front = {
      clients: new Map([
        ["phone-a", { ready: true }],
        ["desktop-b", { ready: false }],
      ]),
    };
    const out = await listSendspinPlayers();
    expect(out).toHaveLength(2);
    const byId = new Map(out.map((d) => [d.id, d]));
    expect(byId.get("phone-a")).toMatchObject({
      id: "phone-a",
      name: "phone-a",
      type: "sendspin",
      available: true,
      meta: { manufacturer: "Sendspin", model: "Sendspin client", hasVolumeControl: true },
    });
    expect(byId.get("desktop-b")?.available).toBe(false);
  });

  it("无客户端 → 空列表(不要把上次连接的残留渲染出来)", async () => {
    h.front = { clients: new Map() };
    await expect(listSendspinPlayers()).resolves.toEqual([]);
  });
});
