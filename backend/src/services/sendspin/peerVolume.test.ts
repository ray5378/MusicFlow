// 音量回显取值:实时优先、离线回退持久库值;并验证它确实落在唯一出口
// decoratePeersForClient(/v1/peers 与 WS peer_snapshot 共用)上。
//
// 本文件不启 sendspin 服务 —— getServer() 为 null 且 supervisor 未运行,即"离线"分支,
// 正好覆盖「服务/组缺席 → 回退库值」这条关键路径(在线分支由实时组音量覆盖,另由集成路径验证)。
import { describe, it, expect, beforeEach } from "vitest";
import { sqlite } from "../../db/index.js";
import { saveDeviceVolumeState, deleteDeviceVolumeState } from "./deviceState.js";
import { getSendspinDeviceVolume, attachSendspinPeerVolumes } from "./peerVolume.js";
import { decoratePeersForClient } from "../access.js";

describe("sendspin 音量回显(离线回退库值 + 唯一出口补齐)", () => {
  const CID = "peer-vol-test-1";
  beforeEach(() => {
    sqlite.prepare("DELETE FROM sendspin_device_state WHERE client_id = ?").run(CID);
    deleteDeviceVolumeState(CID);
  });

  it("无库行 → 缺省 100/false,online=false", () => {
    expect(getSendspinDeviceVolume(CID)).toEqual({ volume: 100, muted: false, online: false });
  });

  it("有库行 → 回显持久值(服务不在跑时的离线回退)", () => {
    saveDeviceVolumeState(CID, { volume: 33, muted: true });
    expect(getSendspinDeviceVolume(CID)).toEqual({ volume: 33, muted: true, online: false });
  });

  it("空 clientId → 缺省 100/false", () => {
    expect(getSendspinDeviceVolume("")).toEqual({ volume: 100, muted: false, online: false });
  });

  it("attachSendspinPeerVolumes:只补 sendspin 行,其它 kind 原样不动", () => {
    saveDeviceVolumeState(CID, { volume: 66, muted: false });
    const peers = [
      { peerId: "dlna:d1", kind: "dlna", name: "dev" },
      { peerId: `sendspin:${CID}`, kind: "sendspin", name: "spk" },
      { peerId: "group:g1", kind: "group", name: "grp" },
    ];
    const out = attachSendspinPeerVolumes(peers);
    expect(out[0]).not.toHaveProperty("volume");
    expect(out[1]).toMatchObject({ peerId: `sendspin:${CID}`, volume: 66, muted: false });
    expect(out[2]).not.toHaveProperty("volume");
  });

  it("唯一出口 decoratePeersForClient 上 sendspin 行带出 volume/muted(管理员视角)", () => {
    saveDeviceVolumeState(CID, { volume: 24, muted: true });
    const rows = decoratePeersForClient(
      [
        { peerId: "dlna:d1", kind: "dlna", name: "dev" },
        { peerId: `sendspin:${CID}`, kind: "sendspin", name: "spk" },
      ],
      "admin-user",
      true,
      null,
    );
    const sp = rows.find((r) => r.peerId === `sendspin:${CID}`);
    expect(sp).toMatchObject({ volume: 24, muted: true });
    const dl = rows.find((r) => r.peerId === "dlna:d1");
    expect(dl).not.toHaveProperty("volume");
  });
});
