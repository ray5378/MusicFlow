// 播放器 Webhook 契约测试:渠道 token 生命周期 + device 参数解析。
// token 是免鉴权端点的唯一凭据(停用必须立即失效);device 解析错一个字符就会
// 把控制指令投到错的音箱,故「多个匹配必须报错而不是随便选一个」是硬契约。
// MUST be the first import: re-exports the isolated DATA_DIR env for this file.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { db } from "../../src/db/index.js";
import { users, userFavoriteSongs } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({
  devices: [] as Array<{ id: string; name: string; available: boolean }>,
  airplay: [] as Array<{ id: string; name: string }>,
  groups: [] as Array<{ id: string; name: string }>,
}));

vi.mock("../../src/services/dlna/control.js", () => ({
  getCachedDevices: () => h.devices,
  getDeviceStatus: async () => ({ volume: 42 }),
}));
vi.mock("../../src/services/airplay/control.js", () => ({
  listAirPlayDevices: () => h.airplay,
}));
vi.mock("../../src/services/group/index.js", () => ({
  getGroupManager: () => ({ list: () => h.groups }),
}));

import {
  listPlayerWebhookTokens,
  createPlayerWebhookToken,
  deletePlayerWebhookToken,
  setPlayerWebhookTokenEnabled,
  validatePlayerWebhookToken,
  getPlayerWebhookTokenById,
  resolvePlayerWebhookOwnerName,
  resolvePlayerDevicePeers,
} from "../../src/services/player/playerWebhook.js";

let adminId = "";

beforeAll(() => {
  const admin = db.select().from(users).get();
  adminId = admin?.id ?? "";
  h.devices = [
    { id: "d-living", name: "客厅音箱", available: true },
    { id: "d-bed", name: "卧室音箱", available: false },
  ];
  h.airplay = [{ id: "a-1", name: "客厅 AirPlay" }];
  h.groups = [{ id: "g-1", name: "全屋" }];
});

afterAll(() => {
  db.delete(userFavoriteSongs).where(eq(userFavoriteSongs.userId, adminId)).run();
});

describe("渠道 token 生命周期", () => {
  it("创建后可在列表里看到,且默认启用", () => {
    const token = createPlayerWebhookToken(adminId, "HA 自动化");
    const row = listPlayerWebhookTokens().find((t) => t.token === token);
    expect(row).toBeDefined();
    expect(row!.enabled).toBe(true);
    expect(row!.ownerUserId).toBe(adminId);
    expect(row!.name).toBe("HA 自动化");
  });

  it("校验:启用中返回归属用户;停用后立即失效", () => {
    const token = createPlayerWebhookToken(adminId, "临时");
    expect(validatePlayerWebhookToken(token)).toEqual({ ownerUserId: adminId });

    const id = listPlayerWebhookTokens().find((t) => t.token === token)!.id;
    expect(setPlayerWebhookTokenEnabled(id, false)).toBe(true);
    expect(validatePlayerWebhookToken(token)).toBeUndefined();

    expect(setPlayerWebhookTokenEnabled(id, true)).toBe(true);
    expect(validatePlayerWebhookToken(token)).toEqual({ ownerUserId: adminId });
  });

  it("未知 token / 空 token 一律校验失败", () => {
    expect(validatePlayerWebhookToken("no-such-token")).toBeUndefined();
    expect(validatePlayerWebhookToken("")).toBeUndefined();
  });

  it("按 id 取值:id 为空返回 undefined;删除返回 true,重复删除返回 false", () => {
    const token = createPlayerWebhookToken(adminId, "待删");
    const id = listPlayerWebhookTokens().find((t) => t.token === token)!.id;

    expect(getPlayerWebhookTokenById("")).toBeUndefined();
    expect(getPlayerWebhookTokenById(id)?.token).toBe(token);

    expect(deletePlayerWebhookToken(id)).toBe(true);
    expect(deletePlayerWebhookToken(id)).toBe(false);
    expect(getPlayerWebhookTokenById(id)).toBeUndefined();
  });

  it("归属用户名:有用户返回用户名,空 id 返回空串", () => {
    const admin = db.select().from(users).where(eq(users.id, adminId)).get();
    expect(resolvePlayerWebhookOwnerName(adminId)).toBe(admin?.username ?? "");
    expect(resolvePlayerWebhookOwnerName("")).toBe("");
  });
});

describe("resolvePlayerDevicePeers: device 参数解析", () => {
  it("缺 device → 明确报错", () => {
    expect(() => resolvePlayerDevicePeers("")).toThrow(/缺少 device/);
    expect(() => resolvePlayerDevicePeers("   ")).toThrow(/缺少 device/);
  });

  it("精确 peerId(dlna:/group:/airplay:)原样返回", () => {
    expect(resolvePlayerDevicePeers("dlna:d-living")).toEqual(["dlna:d-living"]);
    expect(resolvePlayerDevicePeers("group:g-1")).toEqual(["group:g-1"]);
    expect(resolvePlayerDevicePeers("airplay:a-1")).toEqual(["airplay:a-1"]);
  });

  it("all → 全部在线 DLNA + 全部群组(离线设备不参与)", () => {
    const out = resolvePlayerDevicePeers("all");
    expect(out).toContain("dlna:d-living");
    expect(out).toContain("group:g-1");
    expect(out).not.toContain("dlna:d-bed");
  });

  it("all 且一个可用播放器都没有 → 报错而不是返回空数组", () => {
    const savedDev = h.devices;
    const savedGroups = h.groups;
    h.devices = [];
    h.groups = [];
    try {
      expect(() => resolvePlayerDevicePeers("all")).toThrow(/没有可用的播放器/);
    } finally {
      h.devices = savedDev;
      h.groups = savedGroups;
    }
  });

  it("名字模糊匹配(大小写不敏感)唯一命中 → 返回该 peerId", () => {
    expect(resolvePlayerDevicePeers("卧室")).toEqual(["dlna:d-bed"]);
    expect(resolvePlayerDevicePeers("全屋")).toEqual(["group:g-1"]);
  });

  it("模糊匹配到多个 → 必须报错(禁止随便挑一个投播)", () => {
    expect(() => resolvePlayerDevicePeers("客厅")).toThrow(/匹配到多个播放器/);
  });

  it("一个都匹配不到 → 报错", () => {
    expect(() => resolvePlayerDevicePeers("书房")).toThrow(/找不到播放器/);
  });
});
