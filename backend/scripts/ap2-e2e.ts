// ==================== AP2 realtime 床端整链路实测脚本（Phase 6b 批 4）====================
//
// 用途：对「230 床」（ap2_bed.sh 起的 ap2-receiver）跑完整链路——
//   pair（PIN）→ SETUP(session) → RECORD → SETUP(stream, type 96/ct 2 ALAC)
//   → event/timing 排水 → PCM →(按需 147/160)→ ALAC escape → ChaCha RTP/UDP
//   → bed 解码落盘（out.pcm）→ 与输入逐字节/RMS/FFT 比对（配对分析见 ap2-e2e-analyze.py）。
//
// 手动脚本，**不进 vitest 套件、CI 永不执行**：
//   - 缺省（无 MF_AP2_E2E=1）只打印用法并退出（退出码 0），不连任何端口。
//
// 前置条件（缺一不可）：
//   1) 床已启动：/root/ap2_bed.sh start 3（三端口 LISTEN：7200 控制面、NTP/timing、UDP 音频）
//   2) 床侧落盘路径存在且可写：AP2_PCM_OUT（默认 /tmp/ap2recv/out.pcm），跑前清空
//   3) 网络可达：脚本所在机能直连 AP2_HOST:AP2_PORT
//   4) 配对 PIN：AP2_PIN（床缺省 3939，transient 会话 hkp=4 免持久凭据）
//      ⚠ 本脚本**不能**用来验证「免 PIN 重连」：它每次都是新进程，且不接收已持久化的
//      凭据（ap2Stream.ts:208-222：无 creds ⇒ 无条件 pairNewDevice）⇒ 跑两次必两次要
//      PIN，会得到假 FAIL。免 PIN 验证入口见 scripts/ap2-pin-reuse.ts。
//
// 用法：
//   MF_AP2_E2E=1 AP2_HOST=192.168.10.230 AP2_PORT=7200 AP2_PIN=3939 \
//   AP2_DUR=30 AP2_SRC_RATE=48000 AP2_PREF_RATE=44100 \
//   AP2_LATENCY_MIN=0 AP2_LATENCY_MAX=0 \
//   AP2_PCM_IN=/tmp/ap2recv/in.pcm \
//   npx tsx scripts/ap2-e2e.ts
//
// 关于 AP2_LATENCY_MIN（床端直通验证必看）：
//   bed 用 `buffer = latencyMin*7/spf + 1` 决定 RTPRealtimeBuffer 长度，而该队列是
//   `deque(maxlen)`：appendleft 新包会淘汰最右（最旧 = 下一个该播）的包，随后 pop 同一个
//   seq 只会拿到 None —— 满载即稳定丢包（J=11025 → 220 包；30s 实测只写出 34%，且
//   相邻块重复率 0，说明是「丢」不是「重」）。所以床端逐字节验证用 latencyMin=0
//   （buffer=1，1 进 1 出，不淘汰）；声明 11025 才是贴近真机的正常值。
//
// 产物：
//   AP2_PCM_IN（输入 s16le/48k/2ch）+ AP2_MANIFEST（JSON：速率/帧数/包数/时长）
//   AP2_RTP_DUMP（可选：4B 大端长度 + UDP 包体，供床侧 python 独立解密/解码对账）
//   —— 分析：python3 scripts/ap2-e2e-analyze.py <in.pcm> <out.pcm> --rate <agreedRate> [--in-rate 48000]
//
// 判读口径（lead 定，2026-10 实测结论见下）：
//   - 48k 直通（escape ALAC 无重采样）：输入/输出 PCM 应**逐字节一致**（允许头部静音偏移）；
//   - 44.1k 重采样：不做逐字节比较，按 RMS + 互相关（cc_align 思路）比；
//   - 频率偏差以 FFT 主峰量化（双音 440Hz + 1000Hz 便于同时看两个峰的比值）。
//
// ⚠ 床侧 PCM 落盘的实测结论（2026-10-25，6b 批 4）：
//   bed 的 `process()`（audio.py:616）走 PyAV AudioResampler(s16p→s16 packed) 再取
//   `planes[0]`，在本环境（PyAV 19 / 已打 patch 1）会把每包 352 帧变成 384 帧且内容错乱
//   （实测 out.pcm 与输入 0/495 块吻合、零交叉数 314 vs 102、相邻块重复率 0）。
//   因此 **out.pcm 不能作为「我方链路是否正确」的判据**；权威判据是：
//   抓包 → 床侧 python 独立解密（ChaCha20-Poly1305，nonce=包尾 8B、AAD=头[4:12]）
//   → PyAV 解码（手工交织 plane，不经过 AudioResampler）→ 与输入 PCM 逐块比对。
//   该口径在 30s/48k 下 4090/4090 包逐字节命中（见批 4 汇报）。
//   out.pcm 只用于观察「床侧抖动缓冲行为」（丢包率 / 重复率），不作为编码链路证据。
import { closeSync, openSync, writeFileSync, writeSync } from "node:fs";
import { Ap2StreamSession, type Ap2AudioSink, type Ap2PcmProvider } from "../src/services/airplay/ap2/ap2Stream.js";
import { UdpAudioSink } from "../src/services/airplay/ap2/rtpAudio.js";

const ENABLED = process.env["MF_AP2_E2E"] === "1";

const HOST = process.env["AP2_HOST"] ?? "192.168.10.230";
const PORT = Number(process.env["AP2_PORT"] ?? 7200);
const PIN = process.env["AP2_PIN"] ?? "3939";
const DUR_S = Number(process.env["AP2_DUR"] ?? 30);
const SRC_RATE = Number(process.env["AP2_SRC_RATE"] ?? 48000);
const PREF_RATE = process.env["AP2_PREF_RATE"] ? Number(process.env["AP2_PREF_RATE"]) : undefined;
const SPF = Number(process.env["AP2_SPF"] ?? 352);
const PCM_IN = process.env["AP2_PCM_IN"] ?? "";
const MANIFEST = process.env["AP2_MANIFEST"] ?? "";
const CONTROLLER_ID = process.env["AP2_CONTROLLER_ID"] ?? "F00FBABE0002";
// 抖动缓冲声明（样本数）：bed 侧 buffer = latencyMin*7/spf + 1。
// 床的 RTPRealtimeBuffer 是「先 appendleft 再 pop 同一包」的满载淘汰队列——
// 缓冲越大，满载时被淘汰的恰是「下一个该播」的包，稳定丢包（30s 实测只写出 34%）。
// 故床端直通验证用 latencyMin=0（buffer=1，1 进 1 出，不淘汰）。
const LATENCY_MIN = process.env["AP2_LATENCY_MIN"] ? Number(process.env["AP2_LATENCY_MIN"]) : 11025;
const LATENCY_MAX = process.env["AP2_LATENCY_MAX"] ? Number(process.env["AP2_LATENCY_MAX"]) : 88200;
// 可选：把发出的 UDP 包原样落盘（4B 大端长度 + 包体），供床侧 python 独立解密/解码对账。
const RTP_DUMP = process.env["AP2_RTP_DUMP"] ?? "";
// 可选：固定 shk（64 hex）。仅离线对账用；缺省每次随机会话随机，安全口径与产品一致。
const SHK_HEX = process.env["AP2_SHK"] ?? "";

const USAGE = `用法（手动，CI 不跑）：
  MF_AP2_E2E=1 AP2_HOST=192.168.10.230 AP2_PORT=7200 AP2_PIN=3939 \\
  AP2_DUR=30 AP2_SRC_RATE=48000 AP2_PREF_RATE=44100 \\
  AP2_PCM_IN=/tmp/ap2recv/in.pcm AP2_MANIFEST=/tmp/ap2recv/manifest.json \\
  npx tsx scripts/ap2-e2e.ts

前置：床已起（/root/ap2_bed.sh start 3，三端口 LISTEN）、AP2_PCM_OUT 已清空、
      PIN 为 3939（transient hkp=4）。

⚠ 本脚本不能验证「免 PIN 重连」（不接收已持久化凭据 ⇒ 必然假 FAIL）；
  免 PIN 验证入口见 scripts/ap2-pin-reuse.ts。`;

/** 双音（440Hz + 1000Hz，幅度 6000/4000，立体声同相）s16le @ rate。 */
function dualTone(seconds: number, rate: number): Buffer {
  const frames = Math.round(rate * seconds);
  const buf = Buffer.alloc(frames * 4);
  const a1 = 6000;
  const a2 = 4000;
  for (let i = 0; i < frames; i++) {
    const v = Math.round(
      a1 * Math.sin((2 * Math.PI * 440 * i) / rate) + a2 * Math.sin((2 * Math.PI * 1000 * i) / rate),
    );
    buf.writeInt16LE(v, i * 4);
    buf.writeInt16LE(v, i * 4 + 2);
  }
  return buf;
}

/** 抓包 sink：照常发 UDP，同时把每个包按「4B 大端长度 + 包体」落盘（独立对账用）。 */
function makeDumpSink(dumpPath: string): Ap2AudioSink {
  const real = new UdpAudioSink();
  const fd = openSync(dumpPath, "w");
  let closed = false;
  return {
    connect: (host: string, port: number) => real.connect(host, port),
    send: (pkt: Buffer) => {
      real.send(pkt);
      const head = Buffer.alloc(4);
      head.writeUInt32BE(pkt.length, 0);
      writeSync(fd, Buffer.concat([head, pkt]));
    },
    destroy: () => {
      real.destroy();
      if (!closed) {
        closed = true;
        try {
          closeSync(fd);
        } catch {
          /* 已关闭 */
        }
      }
    },
  };
}

/** 供给器：按桥的粒度（SPF 帧 = 1408B）切块给出，null = 给完。 */function makeProvider(pcm: Buffer, chunkBytes: number): Ap2PcmProvider {
  let off = 0;
  return {
    pull: async (): Promise<Buffer | null> => {
      if (off + chunkBytes > pcm.length) return null;
      const chunk = pcm.subarray(off, off + chunkBytes);
      off += chunkBytes;
      return chunk;
    },
  };
}

async function main(): Promise<void> {
  if (!ENABLED) {
    console.log("[ap2-e2e] 未启用：设置 MF_AP2_E2E=1 才会真正连床执行。\n");
    console.log(USAGE);
    return;
  }

  const pcm = dualTone(DUR_S, SRC_RATE);
  const expectedChunks = Math.floor(pcm.length / (SPF * 4));
  console.log(`[ap2-e2e] 输入：${DUR_S}s 双音 440Hz+1000Hz @${SRC_RATE}Hz，${pcm.length}B → ${expectedChunks} 块（${SPF} 帧/块）`);
  if (PCM_IN) {
    writeFileSync(PCM_IN, pcm);
    console.log(`[ap2-e2e] 输入已落盘：${PCM_IN}`);
  }

  const session = new Ap2StreamSession({
    host: HOST,
    port: PORT,
    controllerId: CONTROLLER_ID,
    pin: PIN,
    sourceRate: SRC_RATE,
    preferredRate: PREF_RATE,
    spf: SPF,
    // ⚠ 本脚本**不能**用来验「6a 重启免 PIN」：每次都是新进程，且不接收已持久化的凭据
    //   （ap2Stream.ts:208-222：无 creds ⇒ 无条件 pairNewDevice，必弹 PIN）⇒ 跑两次会
    //   两次都要 PIN，得到假 FAIL。免 PIN 验证入口见 scripts/ap2-pin-reuse.ts。
    //   hkp 缺省 4（e2e 场景）；需要生产口径时用 MF_AP2_E2E_HKP=2 覆盖，缺省行为不变。
    //   注：hkp 不决定 pairing 是否落库 —— pair-setup 请求头恒为 hkp: 2（ap2Session.ts:40/:92）。
    hkp: Number(process.env["MF_AP2_E2E_HKP"] ?? 4),
    latencyMin: LATENCY_MIN,
    latencyMax: LATENCY_MAX,
    sink: RTP_DUMP ? makeDumpSink(RTP_DUMP) : undefined,
    shk: SHK_HEX ? Buffer.from(SHK_HEX, "hex") : undefined,
  });

  let opened = false;
  const t0 = Date.now();
  try {
    const info = await session.open();
    opened = true;
    console.log(`[ap2-e2e] open: ${JSON.stringify(info)}`);

    const sent = await session.pumpRealtime(makeProvider(pcm, SPF * 4));
    const pumpMs = Date.now() - t0;
    console.log(`[ap2-e2e] pump 完成：${sent} 包 / ${pumpMs}ms（期望 ${expectedChunks} 包）`);

    await new Promise((r) => setTimeout(r, 1500)); // 尾部抖动缓冲排气
    const stats = session.stats;
    console.log(`[ap2-e2e] stats: ${JSON.stringify(stats)}`);

    if (MANIFEST) {
      writeFileSync(MANIFEST, JSON.stringify({
        host: HOST, port: PORT, sourceRate: SRC_RATE, agreedRate: info.agreedRate,
        preferredRate: PREF_RATE ?? null, rateFromDevice: info.rateFromDevice,
        resampled: info.resampled, spf: SPF, packets: sent, pumpMs,
        latencyMin: LATENCY_MIN, latencyMax: LATENCY_MAX,
        inputBytes: pcm.length, inputSeconds: DUR_S, stats,
        ts: new Date().toISOString(),
      }, null, 2));
      console.log(`[ap2-e2e] manifest 已落盘：${MANIFEST}`);
    }
  } finally {
    if (opened) await session.close();
    console.log(`[ap2-e2e] closed（state=${session.currentState}）`);
  }
}

main().catch((e: unknown) => {
  console.error("[ap2-e2e] FAILED:", e);
  process.exitCode = 1;
});
