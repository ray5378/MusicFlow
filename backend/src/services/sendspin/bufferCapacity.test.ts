// B 类回归守卫(2026-09-29 SENDSPIN 死代码清理)。
//
// 事故:client/state 曾把字节字段 buffer_capacity 误当成毫秒存进 bufferCapacityMs,
// 产生误导性日志(`buffer_capacity=0ms`)与死字段。修复:删除 bufferCapacityMs,
// client/hello 的 buffer_capacity 严格按字节解析为 bufferCapacityBytes(对照
// aiosendspin BufferTracker(capacity_bytes))。本文件守卫「单位是字节,不是毫秒」。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import WebSocket from "ws";
import {
  setSendspinIdentityDir, startSendspinService, stopSendspinService, getSendspinServer,
} from "./index.js";
import { parseHelloBufferCapacity } from "./server.js";
import type { SendspinConnection } from "./server.js";

const PORT = 18942;
const URL = `ws://127.0.0.1:${PORT}/sendspin`;
const BC_ID = "BC:GUARD:AA:BB:CC";

describe("parseHelloBufferCapacity(纯函数):单位是字节", () => {
  it("player@v1_support.buffer_capacity 按字节解析(真机 ESPHome 4.8MB)", () => {
    expect(parseHelloBufferCapacity({ "player@v1_support": { buffer_capacity: 4800000 } })).toBe(4800000);
  });
  it("兼容顶层 buffer_capacity(legacy 键名)", () => {
    expect(parseHelloBufferCapacity({ buffer_capacity: 1600000 })).toBe(1600000);
  });
  it("兼容 player_support(非 v1 键名)", () => {
    expect(parseHelloBufferCapacity({ player_support: { buffer_capacity: 2000000 } })).toBe(2000000);
  });
  it("缺失/非法 → 0(不钳制)", () => {
    expect(parseHelloBufferCapacity({})).toBe(0);
    expect(parseHelloBufferCapacity({ "player@v1_support": {} })).toBe(0);
    expect(parseHelloBufferCapacity({ buffer_capacity: -5 })).toBe(0);
    expect(parseHelloBufferCapacity(null as any)).toBe(0);
  });
  it("守卫:绝不把字节当作毫秒(返回值须等于原始字节,而非 /1000 之类)", () => {
    const raw = 4800000;
    expect(parseHelloBufferCapacity({ buffer_capacity: raw })).toBe(raw);
  });
});

describe("端到端:client/hello buffer_capacity 落到 bufferCapacityBytes(字节),无 bufferCapacityMs", () => {
  let tmpDir: string;
  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-bc-"));
    setSendspinIdentityDir(tmpDir);
    await startSendspinService(PORT);
  });
  afterAll(async () => {
    await stopSendspinService();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("hello 带 buffer_capacity=4800000 → conn.bufferCapacityBytes=4800000 且无 bufferCapacityMs 死字段", async () => {
    const ws = new WebSocket(URL);
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error("open timeout")), 5000);
      ws.on("open", () => { clearTimeout(t); res(); });
      ws.on("error", rej);
    });
    ws.send(JSON.stringify({
      type: "client/hello",
      payload: {
        client_id: BC_ID, name: "bc", version: 1, supported_roles: ["player@v1"],
        "player@v1_support": { buffer_capacity: 4800000, supported_formats: ["flac"] },
      },
    }));
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error("hello timeout")), 5000);
      ws.on("message", (d, bin) => {
        if (bin) return;
        try { const m = JSON.parse((d as Buffer).toString()); if (m?.type === "server/hello") { clearTimeout(t); res(); } } catch { /* ignore */ }
      });
    });
    const srv = getSendspinServer()!;
    // 等解析完成(bufferCapacityBytes 写入)。
    for (let i = 0; i < 120; i++) {
      const c = srv.clients.get(BC_ID) as (SendspinConnection & { bufferCapacityBytes?: number; bufferCapacityMs?: number }) | undefined;
      if (c && c.bufferCapacityBytes === 4800000) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const conn = srv.clients.get(BC_ID) as (SendspinConnection & { bufferCapacityBytes?: number; bufferCapacityMs?: number }) | undefined;
    expect(conn).toBeDefined();
    expect(conn!.bufferCapacityBytes).toBe(4800000);
    expect((conn as any).bufferCapacityMs).toBeUndefined(); // 死字段已删
    ws.terminate();
  });
});
