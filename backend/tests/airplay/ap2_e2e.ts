// 批 4 前置：对床整链路实测（pump 已知 PCM → bed 解码落盘 out.pcm）
import { readFileSync } from "node:fs";
import { Ap2StreamSession } from "../../src/services/airplay/ap2/ap2Stream.js";

const HOST = process.env.AP2_HOST ?? "192.168.10.230";
const PORT = Number(process.env.AP2_PORT ?? 7200);
const DUR = Number(process.env.AP2_DUR ?? 6); // 秒
const SPF = 352;
const SR = 44100;

function tone(seconds: number): Buffer {
  const n = Math.round(SR * seconds);
  const buf = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const v = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / SR));
    buf.writeInt16LE(v, i * 4);
    buf.writeInt16LE(v, i * 4 + 2);
  }
  return buf;
}

(async () => {
  const pcm = tone(DUR);
  const session = new Ap2StreamSession({
    host: HOST,
    port: PORT,
    controllerId: "F00FBABE0002",
    pin: process.env.AP2_PIN ?? "3939",
    sampleRate: SR,
    spf: SPF,
    hkp: 4,
  });
  const info = await session.open();
  console.log("[e2e] session open:", JSON.stringify(info));
  let off = 0;
  const periodMs = (SPF / SR) * 1000;
  const t0 = Date.now();
  let sent = 0;
  while (off + SPF * 4 <= pcm.length) {
    sent += session.pump(pcm.subarray(off, off + SPF * 4));
    off += SPF * 4;
    const target = t0 + (off / 4 / SR) * 1000;
    const wait = target - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  console.log(`[e2e] pumped packets=${sent} in ${Date.now() - t0}ms`);
  await new Promise((r) => setTimeout(r, 1500));
  await session.close();
  console.log("[e2e] closed");
  void readFileSync;
})().catch((e) => { console.error('[e2e] FAILED:', e); process.exit(1); });
