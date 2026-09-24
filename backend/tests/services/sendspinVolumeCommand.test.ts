// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { initDatabase, sqlite } from "../../src/db/index.js";
import {
  setSendspinIdentityDir,
  startSendspinService,
  stopSendspinService,
  getSendspinServer,
} from "../../src/services/sendspin/index.js";
import { SendspinGroup, parseHelloSupportedCommands } from "../../src/services/sendspin/server.js";
import { setVolumeCore, setMutedCore } from "../../src/services/sendspin/playerCore.js";

// ==================== 音量/静音改走设备命令(P4 音量实时生效) ====================
//
// 背景:改动前 `appliedGain = conn.volume × group.volume / 100` 被 `scalePcm` **烘进
// 编码后的 PCM**,设备缓冲深度 30s ⇒ 用户拖完音量要等旧增益那段播完才听见变化。
// MA 的做法是:音量**绝不进采样**,走 `server/command` 的 `player.command="volume"`
// 下发,设备在**自己的输出级**实时施加 —— 与缓冲深度无关。
//
// 本文件锁三件事:
//   ① `client/hello` 的 `supported_commands` 解析(含真机帧形与键名兼容);
//   ② 施加位置的分派:宣告了 volume+mute → 编码增益恒 unity + 下发命令;
//      未宣告 → 完全回退旧行为(编码增益 = 乘积,一条命令都不发);
//   ③ 真机链路:legacy 明文连接上确实能收到 `server/command` 帧。

const PORT = 18935;
const URL = `ws://127.0.0.1:${PORT}/sendspin`;
const CAP_CID = "VOLCMD-CAP"; // 宣告了 supported_commands
const PLAIN_CID = "VOLCMD-PLAIN"; // 未宣告(老固件)

/** 収齐下行 TEXT 帧(控制面走明文 JSON;音频是 BINARY,两者互不干扰)。 */
class Wire {
  frames: Array<{ type?: string; payload?: any }> = [];
  constructor(ws: WebSocket) {
    ws.on("message", (data: any, isBinary: boolean) => {
      if (isBinary) return;
      try {
        this.frames.push(JSON.parse(data.toString("utf8")));
      } catch { /* 非 JSON 明文帧忽略 */ }
    });
  }
  /** 该连接收到的全部 player 命令。 */
  playerCommands(): any[] {
    return this.frames
      .filter((f) => f?.type === "server/command")
      .map((f) => f.payload?.player)
      .filter(Boolean);
  }
  volumeCommands(): number[] {
    return this.playerCommands().filter((p) => p.command === "volume").map((p) => p.volume);
  }
  muteCommands(): boolean[] {
    return this.playerCommands().filter((p) => p.command === "mute").map((p) => p.mute);
  }
}

async function waitFor(fn: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - t0 > ms) throw new Error(`waitFor timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** 拨入一个 legacy 明文客户端(与 ESPHome/sendspin-cpp 同路径:无 Noise)。
 *  `supportedCommands` 给定时按真机帧形放进 `player@v1_support`。 */
async function connect(cid: string, supportedCommands?: string[]): Promise<Wire> {
  const ws = new WebSocket(URL);
  const wire = new Wire(ws);
  (globalThis as any).__volWs ??= [];
  (globalThis as any).__volWs.push(ws);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no server/hello")), 5000);
    ws.on("open", () =>
      ws.send(
        JSON.stringify({
          type: "client/hello",
          payload: {
            client_id: cid,
            name: "vol-test",
            version: 1,
            supported_roles: ["player@v1"],
            ...(supportedCommands
              ? { "player@v1_support": { supported_formats: [], supported_commands: supportedCommands } }
              : {}),
          },
        }),
      ),
    );
    ws.on("message", (data: any, isBinary: boolean) => {
      if (isBinary) return;
      try {
        if (JSON.parse(data.toString("utf8"))?.type === "server/hello") {
          clearTimeout(timer);
          resolve();
        }
      } catch { /* ignore */ }
    });
    ws.on("error", reject);
  });
  return wire;
}

describe("sendspin 音量走设备命令(server/command)", () => {
  let tmpDir: string;
  let capWire: Wire;
  let plainWire: Wire;

  beforeAll(async () => {
    if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
    initDatabase();
    // ⚠️ 必须关掉 mDNS 自动发现:否则单测会真的去 dial 局域网里的音箱
    // (`sendspin-discover` 发现即拨 <ip>:8928)。本地开发机上跑测试不该碰真设备。
    // 写法与 pluginConfig.test.ts 一致(插件配置就是 plugins 表的一行 config JSON)。
    sqlite
      .prepare(
        "INSERT INTO plugins (id, name, config) VALUES ('sendspin-renderer', 'sendspin-renderer', ?) ON CONFLICT(id) DO UPDATE SET config = excluded.config",
      )
      .run(JSON.stringify({ auto_discover: false }));
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sendspin-volcmd-"));
    setSendspinIdentityDir(tmpDir);
    await startSendspinService(PORT);
    capWire = await connect(CAP_CID, ["volume", "mute"]);
    plainWire = await connect(PLAIN_CID);
    const srv = getSendspinServer()!;
    await waitFor(() => !!srv.clients.get(CAP_CID) && !!srv.clients.get(PLAIN_CID), 5000, "两台 legacy conn");
  }, 60000);

  afterAll(async () => {
    for (const ws of ((globalThis as any).__volWs as WebSocket[]) ?? []) {
      try { ws.terminate(); } catch { /* ignore */ }
    }
    await stopSendspinService();
    sqlite.prepare("DELETE FROM plugins WHERE id = 'sendspin-renderer'").run();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("hello 解析:真机帧形 / legacy 键名 / 顶层键 / 非法值过滤", () => {
    // 真机实发(ESPHome 2026.9.0):`player@v1_support.supported_commands`
    expect(parseHelloSupportedCommands({ "player@v1_support": { supported_commands: ["volume", "mute"] } })).toEqual(["volume", "mute"]);
    // 非 v1 legacy 键名
    expect(parseHelloSupportedCommands({ player_support: { supported_commands: ["mute"] } })).toEqual(["mute"]);
    // 顶层键
    expect(parseHelloSupportedCommands({ supported_commands: ["volume"] })).toEqual(["volume"]);
    // 大小写/空白归一化 + 去重 + 未知命令丢弃(spec 只允许 volume/mute)
    expect(parseHelloSupportedCommands({ supported_commands: [" Volume ", "VOLUME", "pause", 7, "mute"] })).toEqual(["volume", "mute"]);
    // 取不到 / 非法 → [] (= 未宣告能力 ⇒ 不下发任何设备命令)
    expect(parseHelloSupportedCommands({})).toEqual([]);
    expect(parseHelloSupportedCommands(undefined)).toEqual([]);
    expect(parseHelloSupportedCommands({ supported_commands: "volume" })).toEqual([]);
  });

  it("宣告 volume+mute → 编码增益恒 unity(音量不进 PCM)", () => {
    const g = new SendspinGroup("g-unity", {} as any);
    g.volume = 40;
    const sent: any[] = [];
    const c: any = {
      clientId: "c1", codec: "flac", volume: 100, muted: false,
      supportsCommand: (cmd: string) => cmd === "volume" || cmd === "mute",
      sendPlayerCommand: (cmd: any) => { sent.push(cmd); return true; },
    };
    // 关键:不再 40,而是 100 —— 音量由设备输出级施加(这就是"实时生效"的根)
    expect(g.appliedGain(c)).toBe(100);
    // 下发给设备的音量才是组音量(设备音量 = conn.trim × 组音量)
    expect(g.deviceVolume(c)).toBe(40);
    expect(g.syncVolumeTo(c)).toBe(true);
    expect(sent).toEqual([
      { command: "volume", volume: 40 },
      { command: "mute", mute: false },
    ]);
  });

  it("未宣告命令 → 完全回退编码增益,一条命令都不发", () => {
    const g = new SendspinGroup("g-legacy", {} as any);
    g.volume = 40;
    const sent: any[] = [];
    const c: any = {
      clientId: "c2", codec: "flac", volume: 100, muted: false,
      supportsCommand: () => false,
      sendPlayerCommand: (cmd: any) => { sent.push(cmd); return true; },
    };
    expect(g.appliedGain(c)).toBe(40); // 旧行为:乘积
    expect(g.syncVolumeTo(c)).toBe(false);
    expect(sent).toEqual([]);
  });

  it("只宣告 volume 不宣告 mute → 回退编码增益", () => {
    // 只宣告 volume 时静音无法可靠表达,而那正是要避开的一类"看起来生效、实际打架"。
    const g = new SendspinGroup("g-half", {} as any);
    g.volume = 30;
    const c: any = {
      clientId: "c3", codec: "flac", volume: 100, muted: false,
      supportsCommand: (cmd: string) => cmd === "volume",
      sendPlayerCommand: () => true,
    };
    expect(g.offloadsVolume(c)).toBe(false);
    expect(g.appliedGain(c)).toBe(30);
  });

  it("入组即对齐:成员一进组就拿到组音量", () => {
    const g = new SendspinGroup("g-join", {} as any);
    g.volume = 55;
    const sent: any[] = [];
    const c: any = {
      clientId: "c4", codec: "flac", volume: 100, muted: false,
      supportsCommand: () => true,
      sendPlayerCommand: (cmd: any) => { sent.push(cmd); return true; },
    };
    g.add(c);
    expect(sent).toEqual([
      { command: "volume", volume: 55 },
      { command: "mute", mute: false },
    ]);
  });

  it("组静音只改 mute,音量值原样保留(两把独立旋钮)", () => {
    const g = new SendspinGroup("g-mute", {} as any);
    g.volume = 70;
    g.muted = true;
    const sent: any[] = [];
    const c: any = {
      clientId: "c5", codec: "flac", volume: 100, muted: false,
      supportsCommand: () => true,
      sendPlayerCommand: (cmd: any) => { sent.push(cmd); return true; },
    };
    g.syncVolumeTo(c);
    expect(sent).toEqual([
      { command: "volume", volume: 70 },
      { command: "mute", mute: true },
    ]);
  });

  it("真机链路:改音量 → 设备收到 server/command 且编码增益保持 unity", async () => {
    const srv = getSendspinServer()!;
    const conn = srv.clients.get(CAP_CID)!;
    // ⚠️ vitest 配了 `sequence.shuffle`,文件内用例顺序随机 ⇒ 每个用例必须**自建基线**,
    // 不能依赖上一个用例留下的组音量/静音(否则偶发、换台机器就翻)。
    // ⚠️ 顺序必须是「先清空帧 → 再造基线 → 等基线到齐 → 再清空」:先清再等会漏掉
    // 在途帧(它们会在清空之后才落地,污染下一次观测窗口)。实测踩过。
    capWire.frames.length = 0;
    setMutedCore(srv, CAP_CID, false);
    setVolumeCore(srv, CAP_CID, 50);
    await waitFor(
      () => capWire.volumeCommands().includes(50) && capWire.muteCommands().includes(false),
      3000,
      "基线 volume=50 / 未静音",
    );
    capWire.frames.length = 0; // 只观察本次

    setVolumeCore(srv, CAP_CID, 37);

    await waitFor(() => capWire.volumeCommands().includes(37), 3000, "server/command volume=37");
    // volume 先、mute 后(先给音量再解静音,设备解静音时不会闪一下旧音量)
    expect(capWire.playerCommands()).toEqual([
      { command: "volume", volume: 37 },
      { command: "mute", mute: false },
    ]);
    // 音量没有烘进 PCM:编码增益恒 unity ⇒ 30s 缓冲里不会留着旧增益
    expect(srv.group(CAP_CID).appliedGain(conn)).toBe(100);
    expect(srv.group(CAP_CID).deviceVolume(conn)).toBe(37);
  });

  it("真机链路:静音/取消静音走独立命令,音量值不被改写", async () => {
    const srv = getSendspinServer()!;
    const conn = srv.clients.get(CAP_CID)!;
    capWire.frames.length = 0;
    setMutedCore(srv, CAP_CID, false);
    setVolumeCore(srv, CAP_CID, 37);
    await waitFor(
      () => capWire.volumeCommands().includes(37) && capWire.muteCommands().includes(false),
      3000,
      "基线 volume=37 / 未静音",
    );
    capWire.frames.length = 0;

    setMutedCore(srv, CAP_CID, true);
    await waitFor(() => capWire.muteCommands().includes(true), 3000, "mute=true");
    // 音量仍是 37 —— 静音是独立的第二把旋钮,不是把音量拧到 0
    expect(capWire.playerCommands()).toEqual([
      { command: "volume", volume: 37 },
      { command: "mute", mute: true },
    ]);
    expect(srv.group(CAP_CID).deviceVolume(conn)).toBe(37);

    capWire.frames.length = 0;
    setMutedCore(srv, CAP_CID, false);
    await waitFor(() => capWire.muteCommands().includes(false), 3000, "mute=false");
    expect(capWire.playerCommands()).toEqual([
      { command: "volume", volume: 37 },
      { command: "mute", mute: false },
    ]);
  });

  it("真机链路:未宣告能力的设备一条命令都收不到(老固件行为不变)", async () => {
    const srv = getSendspinServer()!;
    plainWire.frames.length = 0;

    setVolumeCore(srv, PLAIN_CID, 21);
    setMutedCore(srv, PLAIN_CID, true);
    await new Promise((r) => setTimeout(r, 300));

    expect(plainWire.frames.filter((f) => f?.type === "server/command")).toEqual([]);
    // 老路径照旧:静音 → 增益 0;未静音 → 乘积
    const conn = srv.clients.get(PLAIN_CID)!;
    expect(srv.group(PLAIN_CID).appliedGain(conn)).toBe(0);
    setMutedCore(srv, PLAIN_CID, false);
    expect(srv.group(PLAIN_CID).appliedGain(conn)).toBe(21);
  });
});
