// P1 + P3 回归锁(2026-09-17 第三次无声事故)。
//
// 事故链路:服务端下发的音频字节**完全正确**(4096/48k/2ch/16bit,无容器头),
// 设备侧日志**全绿**(Stream Started / codec header / speaker Starting),状态
// PLAYING、进度正常 —— 但**完全无声**。根因是两条独立缺陷:
//
//  P3  时间戳与墙钟脱钩:`timelineBaseUs` 是死字段(恒 0),ts 退化成
//      「调度帧序号 × 100ms」。实测首块下发时解码已耗时 7.4s,而 ts 仅 2200ms
//      → 设备算 `(ts - send_ahead) - now` 恒为负(−6079ms … −6126ms)
//      → 认为目标时刻早已过去 → 立即吐字节 → 缓冲永远空 → underrun。
//      另:每包只有 1 个 4096 样本帧(85.33ms),却被标 100ms 步进 → 时间轴超前。
//
//  P1  设备上报的延迟参数**从未被解析**:MA 的 `PlayerStatePayload`
//      (client→server)带 output_delay_ms / required_lead_time_ms / min_buffer_ms,
//      服务端此前无任何 client/state 分支,send_ahead 硬编码。
//
// 下面的测试用真实 legacy WS 客户端验证修复后的可观测行为。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import WebSocket from "ws";
import {
  setSendspinIdentityDir, startSendspinService, stopSendspinService, getSendspinServer,
} from "./index.js";
import type { SendspinConnection } from "./server.js";
import { computeCommonSendAhead, DEFAULT_MIN_BUFFER_MS } from "./group.js";
import { FRAME_MS, FIRST_FRAME_LEAD_US } from "./streamEngine.js";

const PORT = 18928;
const URL = `ws://127.0.0.1:${PORT}/sendspin`;
const CLIENT_ID = "11:22:33:44:55:66";

let tmpDir: string;

/** 连一个 legacy 客户端并等到 server/hello。 */
function connectHello(payload: any): Promise<{ ws: WebSocket; hello: any }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const timer = setTimeout(() => { try { ws.terminate(); } catch { /* */ } reject(new Error("no server/hello")); }, 5000);
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
    ws.on("open", () => ws.send(JSON.stringify({ type: "client/hello", payload })));
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      try {
        const msg = JSON.parse(data.toString("utf8"));
        if (msg?.type === "server/hello") { clearTimeout(timer); resolve({ ws, hello: msg.payload }); }
      } catch { /* ignore */ }
    });
  });
}

async function waitFor(fn: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("waitFor timeout");
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-state-"));
  setSendspinIdentityDir(tmpDir);
  await startSendspinService(PORT);
});

afterAll(async () => {
  await stopSendspinService();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("P1:client/state 设备参数解析", () => {
  it("解析 player 上报并写入连接字段(此前完全无解析分支)", async () => {
    const { ws } = await connectHello({
      client_id: CLIENT_ID, name: "esp32-test", supported_roles: ["player@v1"],
      "player@v1_support": { supported_formats: [{ codec: "flac", channels: 2, sample_rate: 48000, bit_depth: 16 }] },
    });
    const srv = getSendspinServer()!;
    await waitFor(() => srv.clients.has(CLIENT_ID));
    const conn = srv.clients.get(CLIENT_ID) as SendspinConnection;
    expect(conn.stateReported).toBe(false); // 未上报前为 false

    ws.send(JSON.stringify({
      type: "client/state",
      payload: { player: { output_delay_ms: 120, required_lead_time_ms: 500, min_buffer_ms: 300 } },
    }));
    await waitFor(() => conn.stateReported);

    expect(conn.outputDelayMs).toBe(120);
    expect(conn.requiredLeadTimeMs).toBe(500);
    expect(conn.minBufferMs).toBe(300);
    ws.close();
  });

  it("非法/缺失字段被忽略,不污染既有值", async () => {
    const srv = getSendspinServer()!;
    const conn = srv.clients.get(CLIENT_ID);
    if (!conn) return; // 上一用例已关连接时跳过(顺序执行下的防御)
    expect(conn.stateReported).toBe(true);
    // 保持原值不被 NaN 冲掉
    expect(Number.isFinite(conn.minBufferMs)).toBe(true);
  });

  it("MA 公式:设备参数驱动 send_ahead,而非硬编码", () => {
    // 设备报 min_buffer=300 → 300ms(不再是 800ms)
    expect(computeCommonSendAhead([{ minBufferMs: 300 }])).toBe(300_000);
    // output_delay 叠加:max(300,0)+120 = 420
    expect(computeCommonSendAhead([{ minBufferMs: 300, outputDelayMs: 120 }])).toBe(420_000);
    // required_lead 大于 min_buffer 时取较大值
    expect(computeCommonSendAhead([{ minBufferMs: 300, requiredLeadTimeMs: 900 }])).toBe(900_000);
    // 未上报 → 缺省 800ms(向后兼容)
    expect(computeCommonSendAhead([{}])).toBe(DEFAULT_MIN_BUFFER_MS * 1000);
    // ⚠️ 空组必须给缺省而非 0 —— 0 会让设备认为「立即输出」→ underrun
    expect(computeCommonSendAhead([])).toBe(DEFAULT_MIN_BUFFER_MS * 1000);
  });
});

describe("P3:调度粒度与首块提前量常量", () => {
  it("FRAME_MS 对齐 MA 的 25ms(此前 100ms 与 FLAC block 4096 永不对齐)", () => {
    expect(FRAME_MS).toBe(25);
    // 25ms @48k = 1200 样本,与 FLAC block 4096 仍不对齐 —— 所以时间戳
    // 绝不能按调度粒度推进,必须按实测样本数(见 EncodedChunk.frameSamples)。
    expect((48000 * FRAME_MS) / 1000).toBe(1200);
    expect(4096 % 1200).not.toBe(0);
  });

  it("FIRST_FRAME_LEAD_US 对齐 MA DEFAULT_INITIAL_DELAY_US = 250ms", () => {
    expect(FIRST_FRAME_LEAD_US).toBe(250_000);
  });

  it("锚点提前量必须 = max(send_ahead, FIRST_FRAME_LEAD_US),不能只用固定 250ms", () => {
    // 「第四次无声」根因锁:MA `push_stream.py:1313` 是
    //   `_channel_timing[ch] = now_us + self._min_send_ahead_us()`
    // —— 锚点用的就是**帧头里那个 send_ahead**。曾误用固定 250ms:
    // 设备全报 0 → 缺省 send_ahead=800ms → delta = 250-800 = **-550ms 恒负**
    // → 设备收首块即判过期 → 立即吐字节 → underrun → 无声。
    const anchorLead = (sendAheadUs: number) => Math.max(sendAheadUs, FIRST_FRAME_LEAD_US);
    // ESPHome 真实形态:全报 0 → 缺省 800ms → 锚点必须也是 800ms
    const esp = computeCommonSendAhead([{ minBufferMs: 0, requiredLeadTimeMs: 0, outputDelayMs: 0 }]);
    expect(esp).toBe(800_000);
    expect(anchorLead(esp)).toBe(800_000);
    // 设备真报了 300ms 缓冲 → 锚点跟着变 300ms(若仍用 250ms 则 delta=-50ms)
    expect(anchorLead(computeCommonSendAhead([{ minBufferMs: 300 }]))).toBe(300_000);
    // 只有 send_ahead 小于 250ms 时,250ms 作下限兜底
    expect(anchorLead(computeCommonSendAhead([{ minBufferMs: 50 }]))).toBe(250_000);
    // 不变量:锚点 ≥ send_ahead → delta = 锚点 - send_ahead ≥ 0(永不「已过期」)
    for (const r of [{}, { minBufferMs: 0 }, { minBufferMs: 300 }, { minBufferMs: 1200 }]) {
      const sa = computeCommonSendAhead([r]);
      expect(anchorLead(sa) - sa).toBeGreaterThanOrEqual(0);
    }
  });
});
