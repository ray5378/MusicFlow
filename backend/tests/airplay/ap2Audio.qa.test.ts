// ==================== AP2 音频面（Phase 6b 批 3）验证 ====================
//
// - ALAC escape 编码：自洽解码（镜像 ffmpeg 语法的 mini decoder）+ 床 venv PyAV
//   跨实现解码还原（无床环境自动跳过，向量验证在 230 上执行）。
// - RTP realtime 打包：结构逐字节断言 + ChaCha 解密还原 + AAD 绑定。
// - NTP timing 请求：32B 形态 + DrainChannel 本地 TCP 字节到达。
//
// MUST be the first import: 在 backend 模块加载前把 DATA_DIR 指到隔离临时目录。
import "../plugins/_env.js";

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createDecipheriv } from "node:crypto";
import { createServer, type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { AlacEncoder, AlacError } from "../../src/services/airplay/ap2/alac.js";
import {
  RtpRealtimeSender,
  UdpAudioSink,
} from "../../src/services/airplay/ap2/rtpAudio.js";
import {
  EventTimingChannels,
  buildNtpRequest,
  ntpTimestamp,
} from "../../src/services/airplay/ap2/timingClient.js";

const execFileP = promisify(execFile);
const SPF = 352;

/** 确定性 LCG PCM（s16le 交织，双端一致的测试信号）。 */
function lcgPcm(frames: number, seed: number): Buffer {
  let s = seed >>> 0;
  const next = (): number => {
    s = (s * 1103515245 + 12345) >>> 0;
    return (s >>> 16) - 0x8000; // 有符号 16bit 域
  };
  const out = Buffer.alloc(frames * SPF * 2 * 2);
  for (let i = 0; i < out.length / 2; i++) out.writeInt16LE(next(), i * 2);
  return out;
}

// ---------------------------------------------------------------------------
// ALAC
// ---------------------------------------------------------------------------
describe("AlacEncoder（escape 模式）", () => {
  it("帧长确定：3+16+1+32+2+1 + 352*2*16 + 3 bit → 1416B", () => {
    const enc = new AlacEncoder({ spf: SPF });
    const pcm = lcgPcm(1, 1);
    const frame = enc.encodeFrame(pcm);
    // bits = 3+4+12+1+32+2+1+11264+3 = 11322 → ceil/8 = 1416
    expect(frame.length).toBe(1416);
  });

  it("同输入同输出（确定性，供跨实现比对）", () => {
    const enc = new AlacEncoder({ spf: SPF });
    const pcm = lcgPcm(1, 0xABCD);
    expect(Buffer.compare(enc.encodeFrame(pcm), enc.encodeFrame(pcm))).toBe(0);
  });

  it("非整帧输入抛 AlacError", () => {
    const enc = new AlacEncoder({ spf: SPF });
    expect(() => enc.encodeFrame(Buffer.alloc(100))).toThrow(AlacError);
  });

  it("镜像 ffmpeg 语法的 mini 解码器逐字节还原 PCM", () => {
    const enc = new AlacEncoder({ spf: SPF });
    const pcmIn = lcgPcm(2, 777);
    const pcmOut = Buffer.alloc(pcmIn.length);
    // mini decoder：MSB 位读，按 ffmpeg alac.c decode_element 顺序
    const makeReader = (buf: Buffer) => {
      let bitPos = 0;
      return {
        get(n: number): number {
          let v = 0;
          for (let i = 0; i < n; i++) {
            v = (v << 1) | ((buf[bitPos >> 3]! >> (7 - (bitPos & 7))) & 1);
            bitPos++;
          }
          return v;
        },
      };
    };
    for (let f = 0; f < 2; f++) {
      const r = makeReader(enc.encodeFrame(pcmIn.subarray(f * 1408, (f + 1) * 1408)));
      expect(r.get(3)).toBe(1); // TYPE_CPE
      expect(r.get(16)).toBe(0); // tag+保留
      expect(r.get(1)).toBe(1); // has_size
      expect(r.get(2)).toBe(0); // extra_bits
      expect(r.get(1)).toBe(1); // 未压缩（is_compressed=!bit ⇒ bit=1）
      expect(r.get(32)).toBe(SPF);
      for (let i = 0; i < SPF; i++) {
        for (let ch = 0; ch < 2; ch++) {
          const v = r.get(16);
          pcmOut.writeInt16LE(v >= 0x8000 ? v - 0x10000 : v, (i * 2 + ch) * 2 + f * 1408);
        }
      }
      expect(r.get(3)).toBe(7); // TYPE_END
    }
    expect(Buffer.compare(pcmIn, pcmOut)).toBe(0);
  });
});

describe("ALAC 跨实现：床 venv PyAV(alac) 解码还原（无床环境跳过）", () => {
  const bedPython = "/root/ap2venv/bin/python";
  const decoderScript = path.resolve(
    fileURLToPath(import.meta.url), "..", "..", "fixtures", "ap2", "alac_decode.py",
  );

  it.skipIf(!existsSync(bedPython) || !existsSync(decoderScript))(
    "TS 编码 → PyAV 解码 → PCM 逐字节一致", async () => {
      const enc = new AlacEncoder({ spf: SPF });
      const pcmIn = lcgPcm(5, 0x5eed);
      const frames: string[] = [];
      for (let f = 0; f < 5; f++) {
        frames.push(enc.encodeFrame(pcmIn.subarray(f * enc.frameBytes, (f + 1) * enc.frameBytes)).toString("hex"));
      }
      const dir = mkdtempSync(path.join(os.tmpdir(), "alac-"));
      const cfg = path.join(dir, "cfg.json");
      const out = path.join(dir, "out.pcm");
      writeFileSync(cfg, JSON.stringify({ sr: 44100, ss: 16, cc: 2, spf: SPF, frames }));
      await execFileP(bedPython, [decoderScript, cfg, out]);
      const pcmOut = readFileSync(out);
      expect(pcmOut.length).toBe(pcmIn.length);
      expect(Buffer.compare(pcmIn, pcmOut)).toBe(0);
    },
  );
});

// ---------------------------------------------------------------------------
// RTP realtime
// ---------------------------------------------------------------------------
describe("RtpRealtimeSender", () => {
  const key = Buffer.alloc(32, 0x33);
  const enc = new AlacEncoder({ spf: SPF });

  /** 镜像加密侧的解密（node crypto，AAD 绑定校验）。 */
  function decryptPacket(pkt: Buffer, sessionKey: Buffer): { plain: Buffer; seq: number; ts: number; ssrc: number; pt: number } {
    const seq = pkt.readUInt16BE(2);
    const ts = pkt.readUInt32BE(4);
    const ssrc = pkt.readUInt32BE(8);
    const pt = pkt[1]! & 0x7f;
    const nonce8 = pkt.subarray(pkt.length - 8);
    const n12 = Buffer.alloc(12);
    nonce8.copy(n12, 4);
    const body = pkt.subarray(12, pkt.length - 8);
    const d = createDecipheriv("chacha20-poly1305", sessionKey, n12, { authTagLength: 16 });
    d.setAAD(pkt.subarray(4, 12));
    // ⚠️ Node ≥24：decipher 不会自动取输入尾部 16B 当 tag，必须显式 setAuthTag
    d.setAuthTag(body.subarray(body.length - 16));
    const plain = Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]);
    return { plain, seq, ts, ssrc, pt };
  }

  it("包结构与推进：0x80 头/PT96/seq++/ts+=352/ssrc，长度 = 12+密文+16tag+8nonce", () => {
    const sender = new RtpRealtimeSender(key, { ssrc: 0x12345678 });
    const pkt = sender.next(enc.encodeFrame(Buffer.alloc(1408)), SPF);
    expect(pkt[0]).toBe(0x80);
    expect(decryptPacket(pkt, key).pt).toBe(96);
    expect(decryptPacket(pkt, key).ssrc).toBe(0x12345678);
    expect(decryptPacket(pkt, key).seq).toBe(0);
    expect(decryptPacket(pkt, key).ts).toBe(0);
    expect(decryptPacket(pkt, key).plain.length).toBe(1416);
    expect(pkt.length).toBe(12 + 1416 + 16 + 8);
    const pkt2 = sender.next(enc.encodeFrame(Buffer.alloc(1408)), SPF);
    expect(decryptPacket(pkt2, key).seq).toBe(1);
    expect(decryptPacket(pkt2, key).ts).toBe(SPF);
  });

  it("解密还原 ALAC 帧；AAD（ts/ssrc）篡改即解密失败", () => {
    const pcm = lcgPcm(1, 42);
    const sender = new RtpRealtimeSender(key);
    const pkt = sender.next(enc.encodeFrame(pcm), SPF);
    expect(Buffer.compare(decryptPacket(pkt, key).plain, enc.encodeFrame(pcm))).toBe(0);
    const tampered = Buffer.from(pkt);
    tampered[5]! ^= 0x01; // 破坏 AAD 区（timestamp 字节）
    expect(() => decryptPacket(tampered, key)).toThrow();
  });

  it("seq 回绕（65535→0）", () => {
    const sender = new RtpRealtimeSender(key);
    (sender as unknown as { seq: number }).seq = 0xffff;
    const pkt = sender.next(enc.encodeFrame(Buffer.alloc(1408)), SPF);
    expect(decryptPacket(pkt, key).seq).toBe(0xffff);
    const pkt2 = sender.next(enc.encodeFrame(Buffer.alloc(1408)), SPF);
    expect(decryptPacket(pkt2, key).seq).toBe(0);
  });
});

describe("UdpAudioSink（本地回环，包到达即可）", () => {
  it("send 到本地 UDP 服务器", async () => {
    const dgram = await import("node:dgram");
    const srv = dgram.createSocket("udp4");
    const got = new Promise<Buffer>((resolve) => {
      srv.once("message", (m) => resolve(m));
    });
    await new Promise<void>((r) => srv.bind(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    const sink = new UdpAudioSink();
    await sink.connect("127.0.0.1", port);
    const pkt = Buffer.from([1, 2, 3]);
    sink.send(pkt);
    expect(await got).toEqual(pkt);
    sink.destroy();
    srv.close();
  });
});

// ---------------------------------------------------------------------------
// NTP timing
// ---------------------------------------------------------------------------
describe("NTP timing 报文与排水通道", () => {
  it("ntpTimestamp：1900 纪元 + 32bit 分数", () => {
    const ts = ntpTimestamp(Date.UTC(2025, 0, 1)); // 秒 = 1735689600
    const sec = ts.readUInt32BE(0);
    expect(sec).toBe(1735689600 + 2208988800);
    expect(ts.readUInt32BE(4)).toBe(0);
  });

  it("buildNtpRequest：32B、头 0x80 0xd3、seq 与时间字段落位", () => {
    const pkt = buildNtpRequest(7, Buffer.alloc(8), 1700000000000);
    expect(pkt.length).toBe(32);
    expect(pkt[0]).toBe(0x80);
    expect(pkt[1]).toBe(0xd3);
    expect(pkt.readUInt16BE(2)).toBe(7);
    expect(pkt.readUInt32BE(8)).toBe(0); // lastReply 空
    const sec = pkt.readUInt32BE(16);
    expect(sec).toBe(Math.floor(1700000000000 / 1000) + 2208988800);
  });

  it("EventTimingChannels：TCP 到达字节 = buildNtpRequest 输出", async () => {
    const received: Buffer[] = [];
    const srv = createServer((sock) => {
      sock.on("data", (c: Buffer) => received.push(c));
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    const chans = new EventTimingChannels();
    // event 通道也要连（测试里随便一个本地端口不 accept 也算建立成功）
    await chans.connect("127.0.0.1", { eventPort: port, timingPort: port });
    expect(chans.ntpConnected).toBe(true);
    chans.startNtp(20);
    await new Promise((r) => setTimeout(r, 120));
    chans.stopNtp();
    chans.destroy();
    srv.close();
    expect(received.length).toBeGreaterThanOrEqual(3);
    const joined = Buffer.concat(received);
    expect(joined.length % 32).toBe(0);
    expect(joined.subarray(0, 2)).toEqual(Buffer.from([0x80, 0xd3]));
    // seq 递增：第 1 个请求 seq=0、第 2 个 seq=1
    expect(joined.readUInt16BE(2)).toBe(0);
    expect(joined.readUInt16BE(34)).toBe(1);
  });
});
