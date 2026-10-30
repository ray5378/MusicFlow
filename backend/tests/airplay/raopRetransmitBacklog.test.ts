// RAOP 重传缓冲覆盖能力测试(v4.10.6 方案 A)。
//
// 为什么单独测:真机取证(240 / HiVi 192.168.10.30)显示设备侧 WiFi 空口会
// **一次丢掉约 240 个连续 RTP 包**(≈1.92s 音频),且每次爆发都是同样的签名
// (657 条重传请求 / 240 个连续 seq)。旧实现只保留最近 128 包(≈1.02s),
// 更早的包补不到 ⇒ 设备缓冲(约 1.0s)被抽干 ⇒ 曲中失声数秒后自愈。
// 这个数字如果被人改回小值,症状会**静默复发**(补不到时源码 continue,不报错),
// 所以必须用测试钉死「覆盖能力 ≥ 一次真实爆发」。
//
// 手法:与 raopPlayer.test.ts 一致 —— 不连真网络,构造 RaopPlayer 后塞入假
// UDP socket,直接驱动 sendChunk / onLoss,断言补发行为。

import "../plugins/_env.js";

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import {
  RaopPlayer,
  CHUNK_LEN,
  SAMPLE_RATE,
  AUDIO_BACKLOG_MAX_PACKETS,
  AUDIO_BACKLOG_ALLOWED_PACKETS,
  resolveAudioBacklogMaxPackets,
} from "../../src/services/airplay/raop.js";

const HOST = "10.0.0.2";

class FakeUdp extends EventEmitter {
  sent: Array<{ buf: Buffer; port: number; addr: string }> = [];
  constructor(public port: number) {
    super();
  }
  send(buf: Buffer, _o: number, _l: number, port: number, addr: string): void {
    this.sent.push({ buf, port, addr });
  }
  close(): void {
    /* noop */
  }
  address() {
    return { address: HOST, port: this.port };
  }
  bind(_p: number, _cb?: () => void): void {
    /* noop */
  }
}

const cleanup: Array<() => void> = [];

function makePlayer() {
  const p = new RaopPlayer({ host: HOST } as any);
  const audio = new FakeUdp(6001);
  const ctrl = new FakeUdp(6002);
  const anyP = p as any;
  anyP.audioSocket = audio;
  anyP.ctrlSocket = ctrl;
  anyP.serverAudioPort = 7000;
  anyP.serverControlPort = 7001;
  anyP.started = true;
  anyP.headTs = 441000;
  anyP.baseTs = 441000;
  anyP.startTs = 441000;
  anyP.seq = 0;
  cleanup.push(() => {
    if (anyP.syncTimer) clearInterval(anyP.syncTimer);
    for (const s of [audio, ctrl]) s.removeAllListeners();
  });
  return { p, anyP, audio, ctrl };
}

function pcmChunk(): Buffer {
  return Buffer.alloc(CHUNK_LEN * 4);
}

beforeEach(() => {
  cleanup.length = 0;
});
afterEach(() => {
  for (const fn of cleanup) fn();
});

describe("RAOP 重传缓冲:覆盖一次真实的空口突发", () => {
  it("上限常量 = 2048 包(≈16.4s),足以覆盖实测的 240 包突发", () => {
    expect(AUDIO_BACKLOG_MAX_PACKETS).toBe(2048);
    const coverSec = (AUDIO_BACKLOG_MAX_PACKETS * CHUNK_LEN) / SAMPLE_RATE;
    expect(coverSec).toBeGreaterThan(16); // 2048*352/44100 ≈ 16.35s
    // 实测一次爆发 = 240 包,必须远远装得下
    expect(AUDIO_BACKLOG_MAX_PACKETS).toBeGreaterThanOrEqual(240 * 4);
  });

  it("缓冲水位封顶在 AUDIO_BACKLOG_MAX_PACKETS(旧值 128 已被覆盖)", () => {
    const { p } = makePlayer();
    for (let i = 0; i < AUDIO_BACKLOG_MAX_PACKETS + 100; i++) p.sendChunk(pcmChunk());
    expect(p.backlogPackets).toBe(AUDIO_BACKLOG_MAX_PACKETS);
  });

  it("核心回归:一次丢 240 个连续包 ⇒ 全部补发得回来(miss=0)", () => {
    const { p, ctrl } = makePlayer();
    for (let i = 0; i < 1000; i++) p.sendChunk(pcmChunk()); // seq 1..1000
    ctrl.sent.length = 0;
    // 真机签名:一次请求 240 个连续 seq
    (p as any).onLoss(761, 240, 7001);
    expect(ctrl.sent.length).toBe(240);
    expect(p.lossRequestedCount).toBe(240);
    expect(p.lossResentCount).toBe(240);
    expect(p.lossMissCount).toBe(0);
  });

  it("对照:只发 128 包的旧水位下,同样 240 包突发会补不回来", () => {
    // 把缓冲人为压到旧上限,证明「128 不够」不是推测
    const { p, ctrl } = makePlayer();
    for (let i = 0; i < 1000; i++) p.sendChunk(pcmChunk());
    const backlog = (p as any).audioBacklog as Map<number, Buffer>;
    while (backlog.size > 128) {
      backlog.delete(backlog.keys().next().value as number);
    }
    ctrl.sent.length = 0;
    (p as any).onLoss(761, 240, 7001);
    expect(ctrl.sent.length).toBeLessThan(240);
    expect(p.lossMissCount).toBeGreaterThan(0);
  });

  it("补不到时 miss 计数累加(可观测,不再静默)", () => {
    const { p, ctrl } = makePlayer();
    for (let i = 0; i < AUDIO_BACKLOG_MAX_PACKETS + 50; i++) p.sendChunk(pcmChunk());
    ctrl.sent.length = 0;
    // seq 1 早已被淘汰
    (p as any).onLoss(1, 1, 7001);
    expect(ctrl.sent.length).toBe(0);
    expect(p.lossRequestedCount).toBe(1);
    expect(p.lossMissCount).toBe(1);
  });

  it("n>1 只有存在于缓冲的才补发,缺失部分计入 miss", () => {
    const { p, ctrl } = makePlayer();
    for (let i = 0; i < 10; i++) p.sendChunk(pcmChunk()); // seq 1..10
    ctrl.sent.length = 0;
    (p as any).onLoss(5, 10, 7001); // 要 5..14,其中 11..14 不存在
    expect(ctrl.sent.length).toBe(6); // 5..10
    expect(p.lossResentCount).toBe(6);
    expect(p.lossMissCount).toBe(4);
  });
});

describe("重传缓冲档位可配置(MF_BRIDGE_RAOP_BACKLOG_PACKETS)", () => {
  const key = "MF_BRIDGE_RAOP_BACKLOG_PACKETS";
  const saved = process.env[key];
  const setEnv = (v: string | undefined) => {
    if (v === undefined) delete process.env[key];
    else process.env[key] = v;
  };
  afterEach(() => setEnv(saved));

  it("档位表 = 512/1024/2048/4096/8192", () => {
    expect([...AUDIO_BACKLOG_ALLOWED_PACKETS]).toEqual([512, 1024, 2048, 4096, 8192]);
  });

  it("未设置 ⇒ 默认档 2048", () => {
    setEnv(undefined);
    expect(resolveAudioBacklogMaxPackets()).toBe(2048);
  });

  it("合法档位原样生效", () => {
    for (const v of [512, 1024, 2048, 4096, 8192]) {
      setEnv(String(v));
      expect(resolveAudioBacklogMaxPackets()).toBe(v);
    }
  });

  it("非档位值 ⇒ 取不小于它的最小档(1000 → 1024)", () => {
    setEnv("1000");
    expect(resolveAudioBacklogMaxPackets()).toBe(1024);
  });

  it("超过最大档 ⇒ 钳到 8192", () => {
    setEnv("99999");
    expect(resolveAudioBacklogMaxPackets()).toBe(8192);
  });

  it("8192 档生效:8192 * 352 / 44100 ≈ 65.4s", () => {
    setEnv("8192");
    expect(resolveAudioBacklogMaxPackets()).toBe(8192);
    expect((8192 * CHUNK_LEN) / SAMPLE_RATE).toBeGreaterThan(65);
  });

  it("非法值 ⇒ 回落默认档 2048(不静默吞成 0)", () => {
    setEnv("abc");
    expect(resolveAudioBacklogMaxPackets()).toBe(2048);
    setEnv("0");
    expect(resolveAudioBacklogMaxPackets()).toBe(2048);
  });

  it("实例在构造时读档位:设为 512 ⇒ 缓冲封顶 512", () => {
    setEnv("512");
    const { p } = makePlayer();
    expect(p.backlogMaxPackets).toBe(512);
    for (let i = 0; i < 600; i++) p.sendChunk(pcmChunk());
    expect(p.backlogPackets).toBe(512);
  });
});
