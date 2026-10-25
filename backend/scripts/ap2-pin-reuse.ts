// ==================== AP2 免 PIN 重连验证脚本（Phase 6b 出口判据①）====================
//
// 用途：验证 AP2「首次配对（pair-setup，需 PIN）→ 独立进程免 PIN 重连（pair-verify）」，
// 即 **HAP pairing 是否真的持久化生效**。这是验收矩阵「6a 的重启免 PIN」的复现入口。
//
// ⚠ 为什么必须用本脚本，不能拿 ap2-e2e.ts 连跑两次代替：
//   根因**不是 hkp**，而是「有没有把已持久化的凭据传进来」。ap2Stream.ts:208-222 的择路是：
//     有 `opts.creds` → openVerifiedChannel（pair-verify，免 PIN）；
//     无 `opts.creds` → 无条件 pairNewDevice（pair-setup，必弹 PIN）。
//   `scripts/ap2-e2e.ts` 每次都是新进程，且不接收/不持久化 creds（凭据只活在本进程内存
//   `this.opts.creds`），所以「跑两次 e2e」必然两次都要 PIN —— 会得到**假 FAIL**，不是 bug。
//
//   实测澄清（2026-10-26，230 床，别再被旧说法带偏）：bed 侧 `pairings.txt` 在 **hkp=4**
//   的场次里**同样会新增/更新 LTPK**（因为 pair-setup 请求头在 ap2Session.ts:40 / :92 里
//   硬编码 `hkp: 2`，与 opts.hkp 无关）。所以 **hkp 并不是「是否落库」的开关**。
//   hkp 的真实作用：ap2Stream.ts:229 把它写进 SETUP(session) 的 `X-Apple-HKP` 头，影响
//   床侧会话语义；生产默认值为 2（`this.opts.hkp ?? 2`）。
//   结论：本脚本固定 `hkp: 2` 是为了**与生产口径一致**，别无他意 —— 别改成 4。
//
// 手动脚本，**CI 永不执行**（与 ap2-e2e.ts 的 MF_AP2_E2E 同风格）：
//   - 缺省（无 MF_AP2_PIN_REUSE=1）只打印一行提示并 process.exit(0)，不连任何端口；
//   - 位于 `scripts/`，文件名非 `*.test.ts`，不在 vitest 收集范围
//     （vitest.config.ts: include 只收 `tests/**/*.test.ts` 与 `src/services/sendspin/**`）。
//
// 前置条件（缺一不可）：
//   1) 床已启动且可达：AP2_HOST:AP2_PORT（缺省 127.0.0.1:7200）处于 LISTEN；
//      床侧 `ap2_bed.sh start N` 起实例后，7200 对应头一个实例；
//   2) 配对 PIN：AP2_PIN（缺省 3939）；
//   3) AP2_CONTROLLER_ID 可配（缺省 F00FBABE0007；首次运行会在床侧 `pairings/` 新增一条）；
//   4) 床实例的 `pairings/` 不会被重启清掉（已实测 `ap2_bed.sh stop`+`start` 后保留）。
//      若将来床改成「重启即清配对」，则「整床重启免 PIN」需换验证方式（本脚本会 FAIL）。
//   5) RUN=2 依赖 RUN=1 写下的凭据文件 AP2_CREDS_FILE（缺省 /tmp/ap2-pin-reuse-creds.json）。
//      这是脚本层对「我方持久化」的显式模拟；生产路径落 SQLite
//      （src/services/airplay/ap2/hapCredentials.ts 的 saveHapCredentials/getHapCredentials）。
//
// 用法（在 backend/ 下执行）：
//   ① 首次配对（进程 A）：MF_AP2_PIN_REUSE=1 RUN=1 npx tsx scripts/ap2-pin-reuse.ts
//   ② 免 PIN 重连（进程 B）：MF_AP2_PIN_REUSE=1 RUN=2 npx tsx scripts/ap2-pin-reuse.ts
//   ③ 同进程串行冒烟：MF_AP2_PIN_REUSE=1 RUN=12 npx tsx scripts/ap2-pin-reuse.ts
//
// ⚠ 权威验证必须用 **两个独立进程**（①+②）：同进程串行（③）只能证明「凭据对象可复用」，
//   不构成「重启后免 PIN」的证据（进程没重启，内存本来就还在）。③ 仅作快速冒烟。
//
// 输出：stdout **只打一行 JSON**（便于脚本断言），字段：
//   run         "1" / "2" / "12-a" / "12-b"
//   mode        "pair-setup"（真的走了 PIN 配对窗）/ "pair-verify"（复用凭据免 PIN）
//   seedFired   这次连**有没有真的走 pairNewDevice**（不是「有没有配 PIN」）：
//               由 ap2Session.ts:34 的 onNewControllerSeed 回调置位，只有 pairing 的 seed
//               真被生成时才会触发 ⇒ pair-verify 路径必为 false
//   packets     UDP 音频包数（>0 才算真出流，否则只是「握手通了」）
//   encrypted   通道是否已升级加密（rtspClient.ts:160 的 getter，须在 close 前取）
//   agreedRate  协商出的流速率；credsSaved（仅 RUN=1）凭据是否已落盘
// 诊断与错误一律走 stderr，stdout 保持单行 JSON。
//
// 实测基线（2026-10，230 床 ap2-1，controllerId=F00FBABE0007，每场 3s）：
//   RUN=1 → {"mode":"pair-setup","seedFired":true,"packets":409,"encrypted":true}
//   RUN=2 → {"mode":"pair-verify","seedFired":false,"packets":409,"encrypted":true}
//   旁证：pcap 第二场 POST /pair-setup 0 次、pair-pin-start 0 次、POST /pair-verify 2 次；
//         床侧 pairings/pairings.txt 前后逐字节一致。
//
// 说明：本脚本不重实现 HAP 握手 —— 直接复用 ap2Session.ts 的 pairNewDevice /
// openVerifiedChannel（由 Ap2StreamSession.open() 按「有无 creds」自动择路）。
import { readFileSync, writeFileSync } from "node:fs";
import {
  Ap2StreamSession,
  type Ap2PcmProvider,
} from "../src/services/airplay/ap2/ap2Stream.js";
import type { HapCredsHex } from "../src/services/airplay/ap2/ap2Session.js";

const ENABLED = process.env["MF_AP2_PIN_REUSE"] === "1";

const USAGE = `用法（手动，CI 不跑）：
  MF_AP2_PIN_REUSE=1 RUN=1 npx tsx scripts/ap2-pin-reuse.ts   # 进程 A：首次 PIN 配对
  MF_AP2_PIN_REUSE=1 RUN=2 npx tsx scripts/ap2-pin-reuse.ts   # 进程 B：只读凭据，免 PIN
  MF_AP2_PIN_REUSE=1 RUN=12 npx tsx scripts/ap2-pin-reuse.ts  # 同进程串行（仅冒烟，非权威）

可选 env：AP2_HOST(127.0.0.1) AP2_PORT(7200) AP2_PIN(3939) AP2_CONTROLLER_ID
          AP2_CREDS_FILE(/tmp/ap2-pin-reuse-creds.json) AP2_DUR(3)。
          本脚本 hkp 恒为 2（与生产默认一致），不提供 env 覆盖。

前置：床已起且 7200 LISTEN、PIN 为 3939。
注意：scripts/ap2-e2e.ts 不接收已持久化凭据 ⇒ 跑两次必两次要 PIN，**不能**验本判据。`;

const HOST = process.env["AP2_HOST"] ?? "127.0.0.1";
const PORT = Number(process.env["AP2_PORT"] ?? 7200);
const PIN = process.env["AP2_PIN"] ?? "3939";
const DUR_S = Number(process.env["AP2_DUR"] ?? 3);
const SRC_RATE = Number(process.env["AP2_SRC_RATE"] ?? 48000);
const PREF_RATE = process.env["AP2_PREF_RATE"] ? Number(process.env["AP2_PREF_RATE"]) : undefined;
const SPF = Number(process.env["AP2_SPF"] ?? 352);
const CONTROLLER_ID = process.env["AP2_CONTROLLER_ID"] ?? "F00FBABE0007";
const CREDS_FILE = process.env["AP2_CREDS_FILE"] ?? "/tmp/ap2-pin-reuse-creds.json";
/** 阶段：1=首次配对；2=独立进程免 PIN；12=同进程串行（仅冒烟）。 */
const RUN = process.env["RUN"] ?? process.env["AP2_REUSE_RUN"] ?? "1";
/** 固定 2：与生产默认一致（ap2Stream.ts:229 `this.opts.hkp ?? 2`）。hkp 会写进
 *  SETUP(session) 的 X-Apple-HKP 头、影响床侧会话语义；它**不**决定 pairing 是否落库
 *  （pair-setup 请求头恒为 hkp: 2，见 ap2Session.ts:40/:92），别当成 transient 开关。 */
const HKP = 2;

/** 双音（440Hz + 1000Hz）s16le @ rate，与 ap2-e2e.ts 一致，便于 FFT/互相关对账。 */
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

/** 供给器：按桥粒度（SPF 帧 = 1408B）切块给出，null = 给完。 */
function makeProvider(pcm: Buffer, chunkBytes: number): Ap2PcmProvider {
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

/** 单场结果（stdout 那行 JSON 的形状）。 */
interface RunReport {
  run: string;
  mode: "pair-setup" | "pair-verify";
  seedFired: boolean;
  packets: number;
  encrypted: boolean;
  agreedRate?: number;
  credsSaved?: boolean;
}

type CredsCarrier = { opts: { creds?: HapCredsHex } };
type ClientCarrier = { client?: { encrypted?: boolean } | null };

/**
 * 跑一场：open（自动择 pair-setup / pair-verify）→ 推流 → 收尾。
 * @param creds 有凭据 ⇒ 走 pair-verify（免 PIN）；无 ⇒ 走 pairNewDevice（需 pin）
 */
async function oneRun(
  run: string,
  creds: HapCredsHex | undefined,
  pin: string | undefined,
): Promise<{ report: RunReport; credsOut?: HapCredsHex }> {
  const mode: "pair-setup" | "pair-verify" = creds ? "pair-verify" : "pair-setup";
  let seedFired = false;
  const pcm = dualTone(DUR_S, SRC_RATE);
  const session = new Ap2StreamSession({
    host: HOST,
    port: PORT,
    controllerId: CONTROLLER_ID,
    creds,
    pin,
    sourceRate: SRC_RATE,
    preferredRate: PREF_RATE,
    spf: SPF,
    hkp: HKP,
    latencyMin: Number(process.env["AP2_LATENCY_MIN"] ?? 11025),
    latencyMax: Number(process.env["AP2_LATENCY_MAX"] ?? 88200),
    // seed 只在 pairNewDevice（PIN 配对）里生成 ⇒ 它是「本场是否真走 pair-setup」的硬证据。
    onNewControllerSeed: (_seedHex: string) => {
      seedFired = true;
    },
  });
  let opened = false;
  let packets = 0;
  let agreedRate: number | undefined;
  let encrypted = false;
  try {
    const info = await session.open();
    opened = true;
    agreedRate = info.agreedRate;
    // 必须在 close() 之前取：ap2Stream.ts:495 收尾时会把 client 置回 null。
    encrypted = (session as unknown as ClientCarrier).client?.encrypted === true;
    packets = await session.pumpRealtime(makeProvider(pcm, SPF * 4));
    await new Promise((r) => setTimeout(r, 800)); // 尾部抖动缓冲排气
  } catch (e: unknown) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(
      `连 ${HOST}:${PORT} 失败（controllerId=${CONTROLLER_ID}，阶段 run=${run}，mode=${mode}）：${reason}`,
    );
  } finally {
    if (opened) await session.close();
  }
  const credsOut = (session as unknown as CredsCarrier).opts?.creds;
  const report: RunReport = { run, mode, seedFired, packets, encrypted, agreedRate };
  return { report, credsOut };
}

function readCreds(): HapCredsHex {
  try {
    return JSON.parse(readFileSync(CREDS_FILE, "utf8")) as HapCredsHex;
  } catch (e: unknown) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(
      `读凭据失败：${CREDS_FILE}（${reason}）—— 请先跑 RUN=1 完成首次配对`,
    );
  }
}

/** stdout 只留一行 JSON；诊断走 stderr。 */
function emit(report: RunReport): void {
  console.log(JSON.stringify(report));
}

async function main(): Promise<void> {
  if (!ENABLED) {
    console.log("[ap2-pin-reuse] 未启用：设置 MF_AP2_PIN_REUSE=1 才会连床执行（CI 永不执行）。");
    console.log(USAGE);
    process.exit(0);
  }

  if (RUN === "1") {
    const a = await oneRun("1", undefined, PIN);
    if (!a.credsOut) throw new Error("首次配对未产出凭据（pair-setup 未完成？）");
    writeFileSync(CREDS_FILE, JSON.stringify(a.credsOut, null, 2));
    emit({ ...a.report, credsSaved: true });
    return;
  }

  if (RUN === "2") {
    // 独立进程、只读凭据、不传 pin —— 这才是「重启后免 PIN」的权威口径。
    const b = await oneRun("2", readCreds(), undefined);
    emit(b.report);
    return;
  }

  if (RUN === "12") {
    process.stderr.write(
      "[ap2-pin-reuse] RUN=12 为同进程串行冒烟，**不构成免 PIN 证据**；权威验证请用 RUN=1 + RUN=2 两个独立进程。\n",
    );
    const a = await oneRun("12-a", undefined, PIN);
    if (!a.credsOut) throw new Error("12-a 未产出凭据");
    writeFileSync(CREDS_FILE, JSON.stringify(a.credsOut, null, 2));
    emit({ ...a.report, credsSaved: true });
    const b = await oneRun("12-b", a.credsOut, undefined);
    emit(b.report);
    return;
  }

  throw new Error(`未知 RUN=${RUN}（只允许 1 / 2 / 12）`);
}

main().catch((e: unknown) => {
  process.stderr.write(`[ap2-pin-reuse] FAILED: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
