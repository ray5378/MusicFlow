// ==================== AP2 首包延迟埋点（门控 / 零开销）验证 ====================
//
// 埋点只为定位「SETUP(stream) 响应 → 首包」抖动，绝不能反过来影响生产链路，故两条铁律：
//   ① 门控缺省关闭时：不起 observer、不写文件、不打时间、不产生任何 trace 输出；
//   ② 门控打开时：一条会话产出**一行** JSON，字段齐全、可机读。
//
// 门控在 ap2Trace 模块加载时读一次 ⇒ 开门控的用例必须 vi.resetModules() + 动态 import。
import "../plugins/_env.js";

import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSocket, type Socket as DgramSocket } from "node:dgram";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Ap2RtspClient } from "../../src/services/airplay/ap2/rtspClient.js";
import { bplistDecode, bplistEncode, type PlistValue } from "../../src/services/airplay/ap2/bplist.js";
import { AP2_TRACE_ON } from "../../src/services/airplay/ap2/ap2Trace.js";
import {
  AP2_REALTIME_STREAM_TYPE,
  Ap2StreamSession,
  type Ap2AudioSink,
  type Ap2PcmProvider,
} from "../../src/services/airplay/ap2/ap2Stream.js";

/** 一行 trace JSON 的全部字段（顺序无关，用于「字段齐全」断言）。 */
const TRACE_KEYS: readonly string[] = [
  "ev", "dev", "rate", "tWallMs", "totalUs", "dTimingUs", "dDgramImportUs", "dSocketUs",
  "dCallerSchedUs", "dFirstPullUs", "pullWaitMs", "loopDelayP50Us", "loopDelayP95Us", "loops",
];

/** 假控制面：按请求体里有没有 streams 区分 SETUP(session) / SETUP(stream)，eventPort=0。 */
function fakeClient(
  dataPort: number,
  decode: (b: Buffer) => PlistValue | null,
  encode: (v: PlistValue) => Buffer,
): Ap2RtspClient {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    request: async (opts: { body?: Buffer }): Promise<{
      status: number;
      statusText: string;
      headers: Map<string, string>;
      body: Buffer;
    }> => {
      const req = opts.body && opts.body.length ? decode(opts.body) : null;
      const isStream = !!req && typeof req === "object" && !Array.isArray(req)
        && !Buffer.isBuffer(req) && "streams" in (req as object);
      const body = isStream
        ? encode({
            streams: [{ controlPort: 1, dataPort, streamID: 7, type: AP2_REALTIME_STREAM_TYPE }],
          } as unknown as PlistValue)
        : encode({ eventPort: 0 } as unknown as PlistValue);
      return { status: 200, statusText: "OK", headers: new Map<string, string>(), body };
    },
    on: (ev: string, cb: (...args: unknown[]) => void): void => {
      const arr = listeners.get(ev) ?? [];
      arr.push(cb);
      listeners.set(ev, arr);
    },
    removeListener: (): void => undefined,
    destroy: (): void => undefined,
  } as unknown as Ap2RtspClient;
}

/** 计数型假出口（不发真 UDP）。 */
function countingSink(): Ap2AudioSink & { packets: number } {
  const s = {
    packets: 0,
    connect: async (): Promise<void> => undefined,
    send: (): void => {
      s.packets++;
    },
    destroy: (): void => undefined,
  };
  return s;
}

/** 给 n 块、每块 frames 帧的供给器（给完返回 null）。 */
function provider(chunks: number, frames: number): Ap2PcmProvider {
  let n = 0;
  return {
    pull: async (): Promise<Buffer | null> => (n++ >= chunks ? null : Buffer.alloc(frames * 4)),
  };
}

/** 从日志行里抠出 trace JSON（日志形如 `[airplay-ap2] INFO [airplay-ap2] trace {...}`）。 */
function parseTraceLine(line: string): Record<string, number | string> {
  const at = line.indexOf("{");
  expect(at).toBeGreaterThan(0);
  return JSON.parse(line.slice(at)) as Record<string, number | string>;
}

const dgramSockets: DgramSocket[] = [];
afterEach(() => {
  for (const s of dgramSockets.splice(0)) {
    try {
      s.close();
    } catch {
      /* 已关闭 */
    }
  }
});

describe("AP2 首包延迟埋点（MUSICFLOW_AP2_TRACE）", () => {
  it("门控缺省关闭：整场会话零 trace 输出，且绝不写落盘文件", async () => {
    expect(process.env["MUSICFLOW_AP2_TRACE"] ?? "").not.toBe("1");
    expect(AP2_TRACE_ON).toBe(false);

    // 即使运行期把落盘路径塞进 env，模块加载时已解析为 "" ⇒ 永不写文件
    const file = join(tmpdir(), `mf-ap2-trace-off-${Date.now()}.jsonl`);
    const prevFile = process.env["MUSICFLOW_AP2_TRACE_FILE"];
    process.env["MUSICFLOW_AP2_TRACE_FILE"] = file;

    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m: unknown) => {
      lines.push(String(m));
    });
    try {
      const sink = countingSink();
      const session = new Ap2StreamSession({
        host: "127.0.0.1",
        port: 1,
        controllerId: "F00FBABE0009",
        sourceRate: 48000,
        client: fakeClient(5000, bplistDecode, bplistEncode),
        sink,
      });
      await session.open();
      const sent = await session.pumpRealtime(provider(40, 352));
      expect(sent).toBe(40);
      expect(sink.packets).toBe(40);
      await session.close();
    } finally {
      spy.mockRestore();
      if (prevFile === undefined) delete process.env["MUSICFLOW_AP2_TRACE_FILE"];
      else process.env["MUSICFLOW_AP2_TRACE_FILE"] = prevFile;
    }

    // ① 没有任何 trace 行；② 正常业务日志仍在（说明 spy 本身有效）
    expect(lines.filter((l) => l.includes("[airplay-ap2] trace")).length).toBe(0);
    expect(lines.filter((l) => l.includes('"ev":"trace"')).length).toBe(0);
    expect(lines.some((l) => l.includes("[airplay-ap2] setup"))).toBe(true);
    // ③ 门控关 ⇒ 没有落盘副作用
    expect(existsSync(file)).toBe(false);
  });

  it("门控打开：一行 JSON，字段齐全并落到 MUSICFLOW_AP2_TRACE_FILE", async () => {
    const file = join(tmpdir(), `mf-ap2-trace-on-${Date.now()}.jsonl`);
    const prevGate = process.env["MUSICFLOW_AP2_TRACE"];
    const prevFile = process.env["MUSICFLOW_AP2_TRACE_FILE"];
    process.env["MUSICFLOW_AP2_TRACE"] = "1";
    process.env["MUSICFLOW_AP2_TRACE_FILE"] = file;
    vi.resetModules();

    // 真 UDP 出口（打在本地回环的空端口上，收不到 ICMP 不可达），用以实测 #4/#7 两段
    const udp = createSocket("udp4");
    dgramSockets.push(udp);
    await new Promise<void>((r) => udp.bind(0, "127.0.0.1", r));
    const dataPort = udp.address().port;

    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m: unknown) => {
      lines.push(String(m));
    });
    try {
      const traceMod = await import("../../src/services/airplay/ap2/ap2Trace.js");
      expect(traceMod.AP2_TRACE_ON).toBe(true); // 门控常量在加载时生效

      const bplist = await import("../../src/services/airplay/ap2/bplist.js");
      const { UdpAudioSink } = await import("../../src/services/airplay/ap2/rtpAudio.js");
      const { Ap2StreamSession: TracedSession } = await import(
        "../../src/services/airplay/ap2/ap2Stream.js"
      );

      const sink = new UdpAudioSink();
      const session = new TracedSession({
        host: "127.0.0.1",
        port: 1,
        controllerId: "F00FBABE000A",
        sourceRate: 48000,
        client: fakeClient(dataPort, bplist.bplistDecode, (v) => bplist.bplistEncode(v)),
        sink,
      });
      await session.open();
      const sent = await session.pumpRealtime(provider(40, 352));
      expect(sent).toBe(40);
      await session.close();
    } finally {
      spy.mockRestore();
      vi.resetModules();
      if (prevGate === undefined) delete process.env["MUSICFLOW_AP2_TRACE"];
      else process.env["MUSICFLOW_AP2_TRACE"] = prevGate;
      if (prevFile === undefined) delete process.env["MUSICFLOW_AP2_TRACE_FILE"];
      else process.env["MUSICFLOW_AP2_TRACE_FILE"] = prevFile;
    }

    // ① 恰好一行 trace（emit 幂等：够样本出一次，pumpRealtime 收尾再调用也只出一次）
    const traceLines = lines.filter((l) => l.includes('"ev":"trace"'));
    expect(traceLines.length).toBe(1);
    expect(traceLines[0]!.includes("\n")).toBe(false); // 一行，不带换行

    // ② 字段齐全
    const rec = parseTraceLine(traceLines[0]!);
    expect(Object.keys(rec).sort()).toEqual([...TRACE_KEYS].sort());
    expect(rec["ev"]).toBe("trace");
    expect(rec["dev"]).toBe("F00FBABE000A");
    expect(rec["rate"]).toBe(48000);
    expect(rec["loops"]).toBeGreaterThanOrEqual(1);
    expect(rec["totalUs"]).toBeGreaterThan(0);
    // 假控制面 eventPort=0 ⇒ 排水通道未建 ⇒ dTimingUs 应为 0（如实反映该分支未走）
    expect(rec["dTimingUs"]).toBe(0);
    expect(rec["dCallerSchedUs"]).toBeGreaterThanOrEqual(0);
    expect(rec["dFirstPullUs"]).toBeGreaterThanOrEqual(0);
    expect(rec["pullWaitMs"]).toBeGreaterThanOrEqual(0);
    // 真 UDP 出口 ⇒ 两段耗时确为数值（常量门控下 createSocket 实测一般 > 0）
    expect(typeof rec["dDgramImportUs"]).toBe("number");
    expect(typeof rec["dSocketUs"]).toBe("number");
    expect(rec["loopDelayP95Us"]).toBeGreaterThanOrEqual(rec["loopDelayP50Us"]);

    // ③ 落盘 jsonl：一行且与日志一致
    expect(existsSync(file)).toBe(true);
    const fileLines = readFileSync(file, "utf8").trim().split("\n");
    expect(fileLines.length).toBe(1);
    expect(JSON.parse(fileLines[0]!) as Record<string, unknown>).toEqual(rec);
  });
});
