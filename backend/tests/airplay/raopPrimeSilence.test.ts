// exp4 prime 静默失败回归:端口未解析时不得灌包(240 实证 dgram 抛
// "Port should be > 0 and < 65536. Received type number (0)" 被吞);session 就绪后
// 用 session 端口灌包;真·首包 marker 位保留(prime 结束复位 started)。
import { describe, expect, it } from "vitest";
import { RaopPlayer } from "../../src/services/airplay/raop.js";

type Any = any;

function mkPlayer(): Any {
  return new RaopPlayer({ host: "127.0.0.1", port: 5000 }) as Any;
}

/** 假 audioSocket:记录 send(buffer, offset, length, port, address)。 */
function fakeSocket(sent: Any[]) {
  return { send: (...a: Any[]) => { sent.push(a); } };
}

describe("RaopPlayer.primeSilence(exp4 prime 修复)", () => {
  it("端口未解析(0)→ 不灌包、不抛、返回 false", () => {
    const p = mkPlayer();
    const sent: Any[] = [];
    p.audioSocket = fakeSocket(sent);
    p.serverAudioPort = 0;
    expect(p.primeSilence(10)).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("session 端口就绪 → prime 直接用 session 端口灌 count 包", () => {
    const p = mkPlayer();
    const sent: Any[] = [];
    p.audioSocket = fakeSocket(sent);
    p.startTs = 12345;
    const ok = p.primeSilence(3, { session: "s1", audioPort: 6000, controlPort: 6001, timingPort: 6002 });
    expect(ok).toBe(true);
    expect(p.serverAudioPort).toBe(6000);
    expect(p.serverControlPort).toBe(6001);
    expect(sent).toHaveLength(3);
    for (const a of sent) expect(a[3]).toBe(6000); // dgram send(buf, off, len, port, addr)
  });

  it("prime 结束复位 started ⇒ 真·首包仍带 marker 位", () => {
    const p = mkPlayer();
    const sent: Any[] = [];
    p.audioSocket = fakeSocket(sent);
    p.startTs = 777;
    p.primeSilence(2, { session: "s", audioPort: 6010, controlPort: 6011, timingPort: 6012 });
    expect(p.started).toBe(false);
    // prime 的**第一个**包确实带了 marker(0x60|0x80),后续包不带。
    expect(sent[0][0][1]).toBe(0xe0);
    expect(sent[1][0][1]).toBe(0x60);
  });

  it("count ≤ 0 → 返回 false 且不发包", () => {
    const p = mkPlayer();
    const sent: Any[] = [];
    p.audioSocket = fakeSocket(sent);
    expect(p.primeSilence(0, { session: "s", audioPort: 6020, controlPort: 6021, timingPort: 6022 })).toBe(false);
    expect(sent).toHaveLength(0);
  });
});
