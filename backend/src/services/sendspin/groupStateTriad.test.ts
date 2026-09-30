// P0 门禁:组状态必须是 MA `PlaybackStateType` 三态(stopped / paused / playing)。
//
// 为什么必须钉死:组状态是设备区分「服务端暂停 / 断网 / 播完」的**唯一依据**。
// 此前三者一律表现为 stopped —— 设备无法区分暂停与断流,真机表现为
//「暂停后恢复播放从头开始」。三态是 P1 续播修复能生效的前提(设备要能
// 认出 paused 才保留解码上下文与进度)。
//
// 契约(对齐 MA):
//   - 无曲目               → stopped
//   - 有曲目,推流挂起      → paused
//   - 有曲目,推流进行中    → playing
//
// 测试路径 = 生产路径:连真 WS 服务握手,取真实 SendspinConnection,
// 直接调它的 sendGroupUpdate(),在客户端侧断言收到的 playback_state。
// 不启动 pump(不需要真音频),只验状态判定。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import WebSocket from "ws";
import { setSendspinIdentityDir, startSendspinService, stopSendspinService, getSendspinServer } from "./index.js";

const PORT = 18967;
const URL = `ws://127.0.0.1:${PORT}/sendspin`;

function connectHello(clientId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const timer = setTimeout(() => { try { ws.terminate(); } catch { /* noop */ } reject(new Error("no server/hello")); }, 5000);
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
    ws.on("open", () => ws.send(JSON.stringify({
      type: "client/hello",
      payload: { client_id: clientId, name: clientId, version: 1, supported_roles: ["player@v1"] },
    })));
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      try {
        if (JSON.parse(data.toString("utf8"))?.type === "server/hello") { clearTimeout(timer); resolve(ws); }
      } catch { /* ignore */ }
    });
  });
}

async function waitFor(fn: () => boolean, ms = 8000, what = ""): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - t0 > ms) throw new Error(`waitFor timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("sendspin 组状态三态(P0:stopped / paused / playing)", () => {
  let tmpDir: string;
  let ws: WebSocket;
  let conn: any;
  let texts: any[];
  /** 同步捕获 sendJson 的 (type, payload) —— WS 是异步的,断言不能靠等消息。 */
  let captured: Array<[string, any]> = [];

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sendspin-triad-"));
    setSendspinIdentityDir(tmpDir);
    await startSendspinService(PORT);
    ws = await connectHello("TRIAD-1");
    texts = [];
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      try { texts.push(JSON.parse(data.toString("utf8"))); } catch { /* ignore */ }
    });
    const srv = getSendspinServer() as any;
    await waitFor(() => [...srv.clients.values()].some((c: any) => c.clientId === "TRIAD-1"), 8000, "client registered");
    conn = [...srv.clients.values()].find((c: any) => c.clientId === "TRIAD-1");
    expect(conn).toBeTruthy();
    // hook 在实例上:sendGroupUpdate 内部走 this.sendJson(...),替换实例属性即可捕获,
    // 且仍调原方法(行为不变,若真发送抛错也能暴露)。
    const origSendJson = conn.sendJson.bind(conn);
    conn.sendJson = (t: string, p?: any) => { captured.push([t, p]); return origSendJson(t, p); };
  }, 30_000);

  afterAll(async () => {
    try { ws?.close(); } catch { /* noop */ }
    await stopSendspinService();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** 取最近一条 group/update 的 playback_state。 */
  function lastState(): string | undefined {
    for (let i = captured.length - 1; i >= 0; i--) {
      if (captured[i][0] === "group/update") return captured[i][1]?.playback_state;
    }
    return undefined;
  }

  it("无曲目 → stopped", () => {
    const srv = getSendspinServer() as any;
    const g = srv.group("TRIAD-1");
    conn.group = g;
    g.current = null;
    g.paused = false;
    captured.length = 0;
    conn.sendGroupUpdate();
    expect(lastState()).toBe("stopped");
  });

  it("未入组(group=null)→ stopped:给客户端稳定的默认组身份", () => {
    conn.group = null;
    captured.length = 0;
    conn.sendGroupUpdate();
    expect(lastState()).toBe("stopped");
  });

  it("有曲目 + 推流挂起 → paused(设备据此保留解码上下文与进度)", () => {
    const srv = getSendspinServer() as any;
    const g = srv.group("TRIAD-1");
    conn.group = g;
    g.current = { songId: "s1", title: "T", durationMs: 100000 } as any;
    g.paused = true;
    captured.length = 0;
    conn.sendGroupUpdate();
    expect(lastState()).toBe("paused");
  });

  it("有曲目 + 推流进行中 → playing", () => {
    const srv = getSendspinServer() as any;
    const g = srv.group("TRIAD-1");
    conn.group = g;
    g.current = { songId: "s1", title: "T", durationMs: 100000 } as any;
    g.paused = false;
    captured.length = 0;
    conn.sendGroupUpdate();
    expect(lastState()).toBe("playing");
  });

  it("group/update 必带 group_id/group_name(设备按组身份归位)", () => {
    const srv = getSendspinServer() as any;
    const g = srv.group("TRIAD-1");
    conn.group = g;
    g.current = { songId: "s1", title: "T", durationMs: 100000 } as any;
    g.paused = false;
    captured.length = 0;
    conn.sendGroupUpdate();
    const upd = [...captured].reverse().find((x) => x[0] === "group/update");
    expect(upd?.[1]?.group_id).toBeTruthy();
    expect(upd?.[1]?.group_name).toBeTruthy();
  });
});
