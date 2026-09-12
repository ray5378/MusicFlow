// Sendspin 接入统一 QueueController 的服务器权威集成测试。
//
// 对照 DLNA/AirPlay 的 registerDlnaDevice/registerAirPlayDevice 模式,验证:
//   - registerSendspinDevice 把客户端注册为 UniversalPlayer(带 Sendspin ProtocolPlayer)
//   - playMedia 设定组当前曲、pollState 反映 PLAYING + duration
//   - setVolume/seek/stop 映射到组状态
//   - unregisterSendspinDevices 注销全部 sendspin 播放器与队列
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { QueueController } from "../../src/services/player/QueueController.js";
import { setSendspinIdentityDir, startSendspinService, stopSendspinService, getSendspinServer } from "../../src/services/sendspin/index.js";
import { createSendspinProtocolPlayer } from "../../src/services/sendspin/protocolPlayer.js";
import { PlaybackState } from "../../src/services/player/types.js";

describe("Sendspin 服务器权威集成", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sendspin-int-"));
    setSendspinIdentityDir(tmpDir);
    await startSendspinService();
  });

  afterAll(async () => {
    await stopSendspinService();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("registerSendspinDevice 注册可播的服务器权威播放器", () => {
    const qc = new QueueController();
    qc.registerSendspinDevice("c1", "room-xbox");
    const up = qc["players"].get("c1") as any;
    expect(up).toBeTruthy();
    expect(up.playerId).toBe("sendspin:c1");
    expect(up.getProtocol()).toBeTruthy();
    expect(qc["players"].has("c1")).toBe(true);
    // 幂等:重复注册不产生第二个 player。
    qc.registerSendspinDevice("c1", "room-xbox");
    expect(qc["players"].size).toBe(1);
  });

  it("playMedia → pollState 反映 PLAYING 与 duration;setVolume/seek/stop 生效", async () => {
    expect(getSendspinServer()).toBeTruthy();
    const p = createSendspinProtocolPlayer("c1");
    const item = { songId: "s1", title: "Test", artist: "A", mime: "audio/opus", duration: 180 };
    const { mediaUri } = await p.playMedia(item, "http://192.168.1.5:46400");
    expect(mediaUri).toContain("/rest/dlna/stream/"); // token 流地址(占位上报)

    let st = await p.pollState();
    expect(st.playbackState).toBe(PlaybackState.PLAYING);
    expect(st.duration).toBe(180);

    await p.setVolume(60);
    const srv = getSendspinServer()!;
    expect(srv.group("c1").volume).toBe(60);

    await p.seek(42);
    expect(srv.group("c1").positionMs).toBe(42_000);
    expect((await p.pollState()).position).toBe(42);

    await p.stop();
    expect((await p.pollState()).playbackState).toBe(PlaybackState.IDLE);
  });

  it("unregisterSendspinDevices 注销全部 sendspin 播放器", () => {
    const qc = new QueueController();
    qc.registerSendspinDevice("c1", "a");
    qc.registerSendspinDevice("c2", "b");
    expect(qc["players"].size).toBe(2);
    qc.unregisterSendspinDevices();
    expect(qc["players"].size).toBe(0);
    // 非 sendspin(如 dlna)不被误伤。
    qc.registerSendspinDevice("c1", "a");
    qc["players"].set("d1", { playerId: "dlna:d1" } as any);
    qc.unregisterSendspinDevices();
    expect(qc["players"].has("d1")).toBe(true);
    expect(qc["players"].has("c1")).toBe(false);
  });
});