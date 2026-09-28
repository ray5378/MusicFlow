// ESPHome 6053 桥接:事件镜像 / 写入 / 探针的覆盖补测。
//
// 用**假 EspHomeClient**(vi.mock 只换客户端类,entityId / MediaPlayerCommand 用真值),
// 不建立任何真连接 —— 覆盖 esphomeBridge.ts 中「事件到达后」的镜像与写入逻辑。
//
// 守住的硬契约(改坏在真机上直接表现为音量写不动 / 状态镜像是假的 / 探针误报成功):
//   1) deviceInfo / entities / media_player / lifecycle 四类事件必须真的把设备真值
//      镜像进快照(桥的**唯一**外部判据,不能靠服务端自证);
//   2) 写音量/静音只发 VOLUME/MUTE,且只对 media_player 实体发,绝不发播放类命令;
//   3) 保活目标上限 16,淘汰最久未 attach 的必须**断开其连接**(不白占设备 slot);
//   4) 探针(测试连接)成功 / 超时 / auth / network / unknown 五类结局各有明确 errorCode。
import "../plugins/_env.js";

import { describe, it, expect, beforeEach, vi } from "vitest";
import { MediaPlayerCommand } from "esphome-client";

// 假客户端:记录配置、事件处理器、command 调用;可控 connect 失败 / 构造抛错。
const h = vi.hoisted(() => {
  const instances: any[] = [];
  const ctl: {
    nextConnectRejects: null | (() => Promise<never>);
    nextConstructThrows: null | Error;
  } = { nextConnectRejects: null, nextConstructThrows: null };

  class FakeClient {
    config: any;
    handlers: Record<string, Function[]> = {};
    connectCalls = 0;
    disconnectCalls = 0;
    commands: Array<[any, any]> = [];
    commandThrows = false;
    constructor(cfg: any) {
      if (ctl.nextConstructThrows) {
        const e = ctl.nextConstructThrows;
        ctl.nextConstructThrows = null;
        throw e;
      }
      this.config = cfg;
      instances.push(this);
    }
    on(ev: string, fn: Function) {
      (this.handlers[ev] ||= []).push(fn);
      return this;
    }
    emit(ev: string, ...args: any[]) {
      for (const fn of this.handlers[ev] ?? []) fn(...args);
    }
    connect(): Promise<void> {
      this.connectCalls++;
      const r = ctl.nextConnectRejects;
      if (r) {
        ctl.nextConnectRejects = null;
        return r();
      }
      return Promise.resolve();
    }
    disconnect() {
      this.disconnectCalls++;
    }
    command(id: any, opts: any) {
      if (this.commandThrows) throw new Error("cmd boom");
      this.commands.push([id, opts]);
    }
  }
  return { instances, ctl, FakeClient };
});

vi.mock("esphome-client", async (orig) => {
  const actual: any = await (orig as any)();
  return { ...actual, EspHomeClient: h.FakeClient };
});

import {
  esphomeBridge,
  probeEsphome,
  ESPHOME_API_PORT,
} from "../../src/services/sendspin/esphomeBridge.js";

const H1 = "192.0.2.10";
const H2 = "192.0.2.11";
const KEY = "K".repeat(44);

/** 最近一次 spawn 出来的假客户端。 */
const lastCli = () => h.instances[h.instances.length - 1];

describe("esphomeBridge 事件镜像(假 client)", () => {
  beforeEach(() => {
    esphomeBridge.stop();
    h.instances.length = 0;
    h.ctl.nextConnectRejects = null;
    h.ctl.nextConstructThrows = null;
  });

  it("deviceInfo/entities/media_player 事件把设备真值镜像进快照", () => {
    esphomeBridge.syncDevice(H1, KEY);
    const cli = lastCli();
    // 连接参数:字段名必须是 psk(写成 encryptionKey 会静默降级为明文握手而失败)
    expect(cli.config.psk).toBe(KEY);
    expect(cli.config.port).toBe(ESPHOME_API_PORT);
    expect(cli.config.clientId).toBe("musicflow");

    cli.emit("deviceInfo", { name: "esp32-player", esphomeVersion: "2024.9" });
    cli.emit("entities", [
      { key: 1, name: "Speaker", objectId: "speaker_media_player", type: "media_player" },
      { key: 2, objectId: "temp", type: "sensor" },
      {}, // 无 key → 忽略,不得制造幽灵实体
    ]);
    cli.emit("media_player", { key: 1, entity: "Speaker", state: 2, volume: 0.5, muted: false });

    const d = esphomeBridge.snapshot()[0];
    expect(d.connected).toBe(true);
    expect(d.deviceName).toBe("esp32-player");
    expect(d.esphomeVersion).toBe("2024.9");
    expect(d.players).toHaveLength(2);
    // 有状态事件 → 真值
    const st = d.players.find((p) => p.key === "1")!;
    expect(st.stateName).toBe("PLAYING"); // api.proto:2 == PLAYING(真机实测)
    expect(st.volume).toBe(0.5);
    // 已发现但还没收到状态的实体也要露出来(前端能看到「有这个 entity」)
    const ph = d.players.find((p) => p.key === "2")!;
    expect(ph.stateName).toBe("NONE");
    expect(ph.updatedAt).toBe(0);
    expect(ph.name).toBe("temp"); // 无 name → 回落 objectId

    // 「设备真的在播」是外部判据:最近 30s 内上报过 PLAYING
    expect(esphomeBridge.isPlaying(H1)).toBe(true);
    expect(esphomeBridge.mirroredVolume(H1)).toEqual({ volume: 0.5, muted: false });
  });

  it("lifecycle disconnect 记 lastError;后续 connect 清空;非 PLAYING 不算在播", () => {
    esphomeBridge.syncDevice(H1, KEY);
    const cli = lastCli();
    cli.emit("entities", [{ key: 1, objectId: "mp", type: "media_player" }]);
    // 首次带 volume/muted;第二次不带 → 必须沿用上一帧(设备不是每次都回全字段)
    cli.emit("media_player", { key: 1, state: 1, volume: 0.7, muted: true });
    cli.emit("media_player", { key: 1, state: 1 });
    const p = esphomeBridge.snapshot()[0].players[0];
    expect(p.stateName).toBe("IDLE");
    expect(p.volume).toBe(0.7);
    expect(p.muted).toBe(true);

    // state != 2(PLAYING) → 不算在播;未知设备 → false
    expect(esphomeBridge.isPlaying(H1)).toBe(false);
    expect(esphomeBridge.isPlaying("10.0.0.1")).toBe(false);

    cli.emit("lifecycle", { kind: "disconnect", cause: { message: "socket closed" } });
    let d = esphomeBridge.snapshot()[0];
    expect(d.connected).toBe(false);
    expect(d.lastError).toBe("socket closed");

    // disconnect 无 cause/message → lastError 清空(不编造文案)
    cli.emit("lifecycle", { kind: "disconnect" });
    expect(esphomeBridge.snapshot()[0].lastError).toBe("");

    cli.emit("lifecycle", { kind: "connect" });
    d = esphomeBridge.snapshot()[0];
    expect(d.connected).toBe(true);
    expect(d.lastError).toBe("");
  });

  it("connect 失败不抛给调用方,只记 lastError(保活尽力而为,不拖垮启动)", async () => {
    h.ctl.nextConnectRejects = () => Promise.reject(new Error("ECONNREFUSED"));
    esphomeBridge.syncDevice(H1, KEY);
    await new Promise((r) => setTimeout(r, 0)); // 让 connect().catch 落地
    const d = esphomeBridge.snapshot()[0];
    expect(d.connected).toBe(false);
    expect(d.lastError).toBe("ECONNREFUSED");
  });

  it("保活目标上限 16:超出的按 attach 顺序淘汰最久未 attach 的,并断开其连接", () => {
    for (let i = 1; i <= 17; i++) esphomeBridge.syncDevice(`192.0.2.${i}`, KEY);
    const hosts = esphomeBridge.snapshot().map((x) => x.host);
    expect(hosts).toHaveLength(16);
    expect(hosts).not.toContain("192.0.2.1");
    expect(hosts).toContain("192.0.2.17");
    // 被淘汰那台的连接必须真的断开(否则设备侧 client slot 白占)
    expect(h.instances[0].disconnectCalls).toBe(1);
  });

  it("写音量/静音:只对 media_player 实体、只发 VOLUME/MUTE,音量钳到 0..1", () => {
    esphomeBridge.syncDevice(H1, KEY);
    const cli = lastCli();
    cli.emit("deviceInfo", { name: "d", esphomeVersion: "1" });
    cli.emit("entities", [
      { key: 1, objectId: "speaker_media_player", type: "media_player" },
      { key: 2, objectId: "temp", type: "sensor" }, // 非 media_player → 不收音量命令
      { key: 3, type: "media_player" }, // 无 objectId → 拼不出 EntityId
    ]);

    const v = esphomeBridge.setVolume(H1, 2); // 越界 → 钳到 1
    expect(v).toEqual({ ok: true, code: "ok", sent: 1 });
    expect(cli.commands[0][1]).toEqual({ volume: 1 });
    expect(String(cli.commands[0][0])).toContain("speaker_media_player");

    const m = esphomeBridge.setMuted(H1, true);
    expect(m).toEqual({ ok: true, code: "ok", sent: 1 });
    expect(cli.commands[1][1]).toEqual({ command: MediaPlayerCommand.MUTE });

    expect(esphomeBridge.setMuted(H1, false).sent).toBe(1);
    expect(cli.commands[2][1]).toEqual({ command: MediaPlayerCommand.UNMUTE });
    // 写的是**设备自身**音量,绝不该出现播放类命令
    expect(cli.commands.every(([, o]) => !("command" in o) || o.command === MediaPlayerCommand.MUTE || o.command === MediaPlayerCommand.UNMUTE)).toBe(true);
  });

  it("已连上但没有可写实体 → no-entity(不假装成功)", () => {
    esphomeBridge.syncDevice(H1, KEY);
    const cli = lastCli();
    cli.emit("deviceInfo", { name: "d", esphomeVersion: "1" });
    expect(esphomeBridge.setVolume(H1, 0.1)).toEqual({ ok: false, code: "no-entity", sent: 0 });
    expect(esphomeBridge.setMuted(H1, true)).toEqual({ ok: false, code: "no-entity", sent: 0 });
  });

  it("command 抛错 → send-failed(不静默假装已写)", () => {
    esphomeBridge.syncDevice(H1, KEY);
    const cli = lastCli();
    cli.emit("deviceInfo", { name: "d", esphomeVersion: "1" });
    cli.emit("entities", [{ key: 1, objectId: "mp", type: "media_player" }]);
    cli.commandThrows = true;
    expect(esphomeBridge.setVolume(H1, 0.5)).toEqual({ ok: false, code: "send-failed", sent: 0 });
    expect(esphomeBridge.setMuted(H1, true).code).toBe("send-failed");
  });

  it("mirroredVolume:有实体但没收到过状态 → null(不编造音量)", () => {
    esphomeBridge.syncDevice(H1, KEY);
    lastCli().emit("entities", [{ key: 1, objectId: "mp", type: "media_player" }]);
    expect(esphomeBridge.mirroredVolume(H1)).toBeNull();
  });

  it("syncDevice 清空密钥 → 断开该台;stop() 断开全部", () => {
    esphomeBridge.syncDevice(H1, KEY);
    esphomeBridge.syncDevice(H2, KEY);
    const [c1, c2] = h.instances;
    esphomeBridge.syncDevice(H1, "");
    expect(c1.disconnectCalls).toBe(1);
    expect(esphomeBridge.snapshot().map((x) => x.host)).toEqual([H2]);
    esphomeBridge.stop();
    expect(c2.disconnectCalls).toBe(1);
    expect(esphomeBridge.snapshot()).toEqual([]);
  });

  it("同凭据重复 sync 幂等:不重建连接", () => {
    esphomeBridge.syncDevice(H1, KEY, 6054);
    esphomeBridge.syncDevice(H1, KEY, 6054);
    expect(h.instances).toHaveLength(1);
  });

  it("同 host 改密钥/端口 → 重建连接(旧 client 必须断开)", () => {
    esphomeBridge.syncDevice(H1, KEY, ESPHOME_API_PORT);
    const old = lastCli();
    esphomeBridge.syncDevice(H1, "Z".repeat(44), ESPHOME_API_PORT);
    // 旧 client 握的是旧凭据,改了必须重来,否则连不上却显示「已配」
    expect(old.disconnectCalls).toBe(1);
    expect(h.instances).toHaveLength(2);
    expect(lastCli().config.psk).toBe("Z".repeat(44));
    expect(esphomeBridge.snapshot()).toHaveLength(1);
  });

  it("syncAll:列表内按各自凭据同步,列表外一律断开,空/缺 host 项忽略", () => {
    esphomeBridge.syncDevice(H2, KEY); // 先存在一台
    const stale = h.instances[0];
    esphomeBridge.syncAll([
      { host: H1, psk: KEY, port: 6054 },
      { host: "", psk: KEY }, // 缺 host → 忽略,不得凭空造目标
      { psk: KEY } as any,
    ]);
    const snap = esphomeBridge.snapshot();
    expect(snap.map((x) => x.host)).toEqual([H1]);
    expect(snap[0].port).toBe(6054);
    // 不在列表里的那台必须被断开(配置热更新后不该残留旧目标)
    expect(stale.disconnectCalls).toBe(1);
  });
});

describe("probeEsphome 一次性握手探针(假 client)", () => {
  beforeEach(() => {
    esphomeBridge.stop();
    h.instances.length = 0;
    h.ctl.nextConnectRejects = null;
    h.ctl.nextConstructThrows = null;
  });

  it("成功:deviceInfo 即判连上,并回带已收状态;用完即断不留残余 slot", async () => {
    const pending = probeEsphome(H1, KEY, ESPHOME_API_PORT, 5000);
    const cli = lastCli();
    // 探针是一次性的:关掉自动重连,失败就是失败
    expect(cli.config.clientId).toBe("musicflow-probe");
    expect(cli.config.reconnect).toBe(false);
    cli.emit("entities", [
      { key: 1, name: "Speaker", objectId: "sp", type: "media_player" },
      {}, // 无 key → 忽略
    ]);
    cli.emit("media_player", { key: 1, entity: "Speaker", state: 2, volume: 0.8, muted: false });
    cli.emit("media_player", { key: "" }); // 无 key → 忽略
    cli.emit("deviceInfo", { name: "probe-dev", esphomeVersion: "2024.9" });

    const r = await pending;
    expect(r).toMatchObject({
      host: H1,
      ok: true,
      deviceName: "probe-dev",
      esphomeVersion: "2024.9",
      error: "",
      errorCode: "none",
    });
    expect(r.players).toHaveLength(1);
    expect(r.players[0].stateName).toBe("PLAYING");
    expect(r.players[0].volume).toBe(0.8);
    expect(cli.disconnectCalls).toBe(1);
  }, 15_000);

  it("握手超时 → timeout(用户干等 10s 之外必须给明确码)", async () => {
    const r = await probeEsphome(H1, KEY, ESPHOME_API_PORT, 80);
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("timeout");
    expect(r.error).toBe("handshake timeout");
  });

  it("connect 失败按原因归类 auth / network / unknown", async () => {
    h.ctl.nextConnectRejects = () => Promise.reject(new Error("authentication failed"));
    expect((await probeEsphome(H1, KEY, ESPHOME_API_PORT, 2000)).errorCode).toBe("auth");
    // 注意:必须用**真的能命中** network 判据的错误串。产品判据是
    // `/timeout|econn|enotfound|unreach/i` —— 它匹配 ECONNREFUSED/ECONNRESET/ENOTFOUND,
    // 但**不匹配** Node 常见的 `ETIMEDOUT`("ETIME-DOUT" 不含 "timeout"),见缺陷报告。
    h.ctl.nextConnectRejects = () => Promise.reject(new Error("connect ECONNREFUSED"));
    expect((await probeEsphome(H1, KEY, ESPHOME_API_PORT, 2000)).errorCode).toBe("network");
    h.ctl.nextConnectRejects = () => Promise.reject(new Error("weird failure"));
    expect((await probeEsphome(H1, KEY, ESPHOME_API_PORT, 2000)).errorCode).toBe("unknown");
  });

  it("构造/内部异常 → unknown(早退,不泄漏)", async () => {
    h.ctl.nextConstructThrows = new Error("boom");
    const r = await probeEsphome(H1, KEY, ESPHOME_API_PORT, 2000);
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("unknown");
    expect(r.error).toBe("boom");
    expect(r.host).toBe(H1);
  });
});
