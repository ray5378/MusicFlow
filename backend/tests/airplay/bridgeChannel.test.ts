import { describe, expect, it } from "vitest";

import {
  FRAME_HEADER_SIZE,
  FRAME_TYPE,
  FRAME_VERSION,
  MAX_PAYLOAD_BYTES,
  FrameDecoder,
  FrameSequencer,
  bridgeSocketPath,
  decodeBoundaryReason,
  decodeConfigPayload,
  encodeAudio,
  encodeBoundary,
  encodeConfig,
  encodeFrame,
  encodeHeartbeat,
} from "../../src/services/airplay/bridgeChannel.js";

/** mulberry32 固定种子 PRNG(可复现)。 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomPayload(rand: () => number, len: number): Buffer {
  const buf = Buffer.alloc(len);
  for (let i = 0; i < len; i++) buf[i] = Math.floor(rand() * 256);
  return buf;
}

describe("bridgeChannel:28B 帧编解码(§4.2)", () => {
  it("四类帧编码→解析往返字段一致", () => {
    const audio = encodeAudio(7, 42, 1234567890123n, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
    const cfg = encodeConfig({ deviceId: "dev", protocol: "raop", rate: 48000, channels: 2, format: "s16le", sessionToken: "tok" });
    const bnd = encodeBoundary(9, 1, "seek");
    const hb = encodeHeartbeat(9, 2);

    const frames = new FrameDecoder().push(Buffer.concat([audio, cfg, bnd, hb]));
    expect(frames.length).toBe(4);

    expect(frames[0]).toMatchObject({ type: FRAME_TYPE.AUDIO, generation: 7, sequence: 42, tsUs: 1234567890123n });
    expect(Buffer.from(frames[0]!.payload).equals(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]))).toBe(true);

    expect(frames[1]!.type).toBe(FRAME_TYPE.CONFIG);
    expect(decodeConfigPayload(frames[1]!)).toEqual({
      deviceId: "dev", protocol: "raop", rate: 48000, channels: 2, format: "s16le", sessionToken: "tok",
    });

    expect(frames[2]!.type).toBe(FRAME_TYPE.BOUNDARY);
    expect(frames[2]!.generation).toBe(9);
    expect(decodeBoundaryReason(frames[2]!)).toBe("seek");

    expect(frames[3]!.type).toBe(FRAME_TYPE.HEARTBEAT);
    expect(frames[3]!.payload.byteLength).toBe(0);
    expect(frames[3]!.tsUs).toBe(0n);

    // 头尺寸/魔数/版本常量自洽
    expect(audio.length).toBe(FRAME_HEADER_SIZE + 8);
    expect(audio.toString("latin1", 0, 4)).toBe("MFAB");
    expect(audio.readUInt8(4)).toBe(FRAME_VERSION);
  });

  it("1000 随机帧往返字节一致(混合类型/长度/generation)", () => {
    const rand = rng(20260315);
    const enc: Buffer[] = [];
    const expectList: { type: number; gen: number; seq: number; tsUs: bigint; payload: Buffer }[] = [];
    for (let i = 0; i < 1000; i++) {
      const type = (Math.floor(rand() * 4) + 1) as 1 | 2 | 3 | 4;
      const gen = Math.floor(rand() * 0xffffffff);
      const seq = Math.floor(rand() * 0xffffffff);
      const tsUs = BigInt(Math.floor(rand() * 2 ** 53));
      const len = Math.floor(rand() * 3000);
      const payload = type === FRAME_TYPE.AUDIO ? randomPayload(rand, len) : randomPayload(rand, Math.min(len, 64));
      enc.push(encodeFrame({ type, flags: i % 2, generation: gen, sequence: seq, tsUs, payload }));
      expectList.push({ type, gen, seq, tsUs, payload });
    }
    const frames = new FrameDecoder().push(Buffer.concat(enc));
    expect(frames.length).toBe(1000);
    for (let i = 0; i < 1000; i++) {
      const f = frames[i]!;
      const e = expectList[i]!;
      expect(f.type).toBe(e.type);
      expect(f.generation).toBe(e.gen);
      expect(f.sequence).toBe(e.seq);
      expect(f.tsUs).toBe(e.tsUs);
      expect(Buffer.from(f.payload).equals(e.payload)).toBe(true);
    }
  });

  it("粘包/半包撕裂:按任意 1-7 字节切块喂解析器,结果与整包一致", () => {
    const rand = rng(777);
    const whole = Buffer.concat([
      encodeAudio(1, 1, 1000n, randomPayload(rand, 5000)),
      encodeHeartbeat(1, 2),
      encodeBoundary(1, 3, "track"),
      encodeAudio(1, 4, 4000n, randomPayload(rand, 17)),
      encodeConfig({ deviceId: "d", protocol: "raop", rate: 48000, channels: 2, format: "s16le", sessionToken: "t" }),
    ]);
    const reference = new FrameDecoder().push(whole);

    for (const chunkSize of [1, 2, 3, 5, 7]) {
      const dec = new FrameDecoder();
      const out = [];
      for (let off = 0; off < whole.length; off += chunkSize) {
        out.push(...dec.push(whole.subarray(off, Math.min(whole.length, off + chunkSize))));
      }
      expect(out.length).toBe(reference.length);
      for (let i = 0; i < reference.length; i++) {
        expect(out[i]!.type).toBe(reference[i]!.type);
        expect(out[i]!.sequence).toBe(reference[i]!.sequence);
        expect(out[i]!.tsUs).toBe(reference[i]!.tsUs);
        expect(Buffer.from(out[i]!.payload).equals(reference[i]!.payload)).toBe(true);
      }
    }
  });

  it("非法 magic / version / type / payloadLen 立即抛错(不得错位续读)", () => {
    const good = encodeHeartbeat(1, 1);

    const badMagic = Buffer.from(good);
    badMagic[0] = 0x58; // "X"
    expect(() => new FrameDecoder().push(badMagic)).toThrow(/magic/);

    const badVersion = Buffer.from(good);
    badVersion[4] = FRAME_VERSION + 1;
    expect(() => new FrameDecoder().push(badVersion)).toThrow(/version/);

    const badType = Buffer.from(good);
    badType[5] = 6; // 超出 1..5
    expect(() => new FrameDecoder().push(badType)).toThrow(/type/);

    const bigLen = Buffer.from(good);
    bigLen.writeUInt32LE(MAX_PAYLOAD_BYTES + 1, 24);
    expect(() => new FrameDecoder().push(bigLen)).toThrow(/large/);

    // 撕裂的坏头也要抛(≥28B 即校验;不足 28B 属半包,等下一段)
    expect(() => new FrameDecoder().push(badVersion.subarray(0, 28))).toThrow(/version/);
    expect(() => new FrameDecoder().push(badVersion.subarray(0, 10))).not.toThrow();
  });

  it("payload 上限:恰为 1MiB 可过,超过抛错", () => {
    const ok = encodeAudio(1, 1, 0n, Buffer.alloc(MAX_PAYLOAD_BYTES, 7));
    expect(ok.length).toBe(FRAME_HEADER_SIZE + MAX_PAYLOAD_BYTES);
    expect(new FrameDecoder().push(ok)[0]!.payload.byteLength).toBe(MAX_PAYLOAD_BYTES);
    expect(() => encodeAudio(1, 1, 0n, Buffer.alloc(MAX_PAYLOAD_BYTES + 1))).toThrow(/large/);
  });
});

describe("bridgeChannel:generation/sequence 管理", () => {
  it("FrameSequencer:同 generation 内自增,reset 归零;u32 回绕安全", () => {
    const s = new FrameSequencer();
    expect(s.take()).toBe(1);
    expect(s.take()).toBe(2);
    s.reset(0xffffffff);
    expect(s.generation).toBe(0xffffffff);
    expect(s.take()).toBe(1);
    expect(s.take()).toBe(2);
    // 回绕:0xffffffff + 1 → 0(>>> 0 语义)
    const w = new FrameSequencer();
    w.reset(1);
    (w as unknown as { seq: number }).seq = 0xffffffff;
    expect(w.take()).toBe(0);
    expect(w.take()).toBe(1);
  });
});

describe("bridgeChannel:socket 会合路径(§4.1)", () => {
  it("路径确定性、恒定长度、< 100 字节;Windows 走命名管道分支", () => {
    const p1 = bridgeSocketPath("550e8400-e29b-41d4-a716-446655440000", "a".repeat(64));
    const p2 = bridgeSocketPath("550e8400-e29b-41d4-a716-446655440000", "a".repeat(64));
    expect(p1).toBe(p2); // 确定性
    // deviceId/token 长度不影响文件名:超长输入文件名仍恒定 16 字符("<11 hash>.sock")
    const p3 = bridgeSocketPath("x".repeat(200), "t".repeat(200), "linux");
    expect(Buffer.byteLength(p3, "utf8")).toBeLessThan(100);
    expect(p3.slice(p3.lastIndexOf("/") + 1).length).toBe(16);
    expect(Buffer.byteLength(p1, "utf8")).toBeLessThan(100);
    // 11 位 base36 文件名
    expect(p1.endsWith(".sock")).toBe(true);
    const base = p1.slice(p1.lastIndexOf("/") + 1);
    expect(base.length).toBe(11 + 5); // <11 hash>.sock

    const win = bridgeSocketPath("dev", "tok", "win32");
    expect(win.startsWith("\\\\.\\pipe\\mfab-")).toBe(true);
    expect(win.length).toBe("\\\\.\\pipe\\mfab-".length + 11);

    // 极端 tmpdir 下仍须断言失败而不是 bind ENAMETOOLONG
    const orig = process.env.TMPDIR;
    process.env.TMPDIR = "/" + "d".repeat(200);
    try {
      expect(() => bridgeSocketPath("dev", "tok", "linux")).toThrow(/too long/);
    } finally {
      if (orig === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = orig;
    }
  });

  it("CONFIG/BOUNDARY 校验:字段缺失或口径不符抛错", () => {
    const badCfg = encodeFrame({
      type: FRAME_TYPE.CONFIG, flags: 0, generation: 0, sequence: 0, tsUs: 0n,
      payload: Buffer.from(JSON.stringify({ deviceId: "d", sessionToken: "t", protocol: "raop", rate: 44100, channels: 2, format: "s16le" }), "utf8"),
    });
    const badCfgFrame = new FrameDecoder().push(badCfg)[0]!;
    expect(() => decodeConfigPayload(badCfgFrame)).toThrow(/rate/);

    const badBnd = encodeFrame({
      type: FRAME_TYPE.BOUNDARY, flags: 0, generation: 1, sequence: 1, tsUs: 0n,
      payload: Buffer.from(JSON.stringify({ reason: "restart" }), "utf8"),
    });
    const badBndFrame = new FrameDecoder().push(badBnd)[0]!;
    expect(() => decodeBoundaryReason(badBndFrame)).toThrow(/reason/);
  });
});
