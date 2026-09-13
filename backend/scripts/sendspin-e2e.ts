// ==================== Sendspin 真实端到端(server 侧) ====================
// 启动真实 SendspinServer(绑 :8927/sendspin) + 真实 QueueController/PlayerController
// 决策链,配真实 @discordjs/opus 编码器。等待真实 aiosendspin 客户端拨入并 activate,
// 然后给每个已激活客户端 playFrom 一组 3 首合成曲,靠事件驱动 pollState 自动切歌,
// 打印每首起播与结束,供外部真实客户端验证「握手/hello/activate + 真实推流 + 切歌跟随」。
//
// 运行:  MUSICFLOW_DATA_DIR=/tmp/mf-e2e ./node_modules/.bin/tsx scripts/sendspin-e2e.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initDatabase } from "../src/db/index.js";
import { PlayerController } from "../src/services/player/PlayerController.js";
import { QueueController } from "../src/services/player/QueueController.js";
import { PlaybackState, type PlayerState } from "../src/services/player/types.js";
import {
  getPlayerController,
  getQueueController,
  wirePlayerQueueControllers,
} from "../src/services/player/index.js";
import {
  setSendspinIdentityDir,
  startSendspinService,
  stopSendspinService,
  getSendspinServer,
} from "../src/services/sendspin/index.js";
import { createSendspinProtocolPlayer } from "../src/services/sendspin/protocolPlayer.js";
import { overridePumpSource } from "../src/services/sendspin/streamEngine.js";

const RATE = 48000;
const CH = 2;
const AUDIO_MS = 800; // 每首合成曲时长(自然播完触发自动切歌)
const POLL_MS = 150;
const N_ACTIVATE = parseInt(process.env.SENDSPIN_E2E_N || "4", 10);

const log = (...a: unknown[]) => console.log("[e2e-server]", ...a);

function toneMs(ms: number): Float32Array {
  const n = Math.floor((RATE * CH * ms) / 1000);
  const out = new Float32Array(n);
  const freq = 440;
  for (let i = 0; i < Math.floor(n / CH); i++) {
    const v = 0.5 * Math.sin((2 * Math.PI * freq * i) / RATE);
    out[i * 2] = v;
    out[i * 2 + 1] = v;
  }
  return out;
}

const played: string[] = [];
overridePumpSource(async (songId: string) => {
  played.push(songId);
  return { pcm: toneMs(AUDIO_MS), durationMs: AUDIO_MS };
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mf-sendspin-e2e-"));
  setSendspinIdentityDir(tmp);
  initDatabase(); // 建全量 schema(device_queues 等),否则 QueueController.persist 会崩。

  wirePlayerQueueControllers();
  const pc = getPlayerController();
  const qc = getQueueController();

  await startSendspinService();
  const srv = getSendspinServer();
  log(`server listening, server_id=${srv?.serverId.slice(0, 16)}...`);

  // 等 N 个真实客户端完成握手+activate(server 侧 onActivated 已注册为播放器)。
  const deadline = Date.now() + 30_000;
  while (srv!.clients.size < N_ACTIVATE && Date.now() < deadline) {
    log(`waiting for clients... activated=${srv!.clients.size}/${N_ACTIVATE}`);
    await sleep(500);
  }
  const clients = [...srv!.clients.keys()];
  log(`=== activated ${clients.length} clients: ${clients.map((c) => c.slice(0, 10)).join(",")} ===`);
  if (clients.length === 0) { log("no clients"); await stopSendspinService(); return; }

  // 每个真实客户端各建一条队列(单 client 即 solo 组),播同一组 3 首。
  const items = [
    { songId: "e2e-track-1", title: "Track 1", mime: "audio/opus", duration: AUDIO_MS / 1000 },
    { songId: "e2e-track-2", title: "Track 2", mime: "audio/opus", duration: AUDIO_MS / 1000 },
    { songId: "e2e-track-3", title: "Track 3", mime: "audio/opus", duration: AUDIO_MS / 1000 },
  ];
  const pByClient = new Map<string, ReturnType<typeof createSendspinProtocolPlayer>>();
  for (const cid of clients) {
    qc.playFrom(cid, items, 0, "http://lan-base");
    pByClient.set(cid, createSendspinProtocolPlayer(cid));
  }
  log(`=== started queue on ${clients.length} players; polling to drive auto-advance ===`);

  // 事件驱动 poll:每 POLL_MS 上报一次(仅变化时),驱动自动切歌;真实时间。
  let lastByClient = new Map<string, PlaybackState>();
  const ranFor = 15_000;
  const t0 = Date.now();
  while (Date.now() - t0 < ranFor) {
    await sleep(POLL_MS);
    for (const cid of clients) {
      const st: PlayerState = await pByClient.get(cid)!.pollState();
      if (st.playbackState !== lastByClient.get(cid)) {
        lastByClient.set(cid, st.playbackState);
        pc.reportState(st);
        const cur = srv!.group(cid).current;
        log(`state ${st.playbackState} ${cid.slice(0, 8)} cur=${cur?.songId ?? "(none)"} pos=${st.position.toFixed(2)}`);
      }
    }
  }
  log("=== summary ===");
  log(`played sequence (merged): ${JSON.stringify(played)}`);
  for (const cid of clients) {
    const g = srv!.group(cid);
    log(`client ${cid.slice(0, 8)}: current=${g.current?.songId ?? "(none)"} posMs=${g.positionMs} members=${g.members.size}`);
  }
  log(`expected per-client sequence: ["e2e-track-1","e2e-track-2","e2e-track-3"]`);

  await stopSendspinService();
  fs.rmSync(tmp, { recursive: true, force: true });
}

main().catch((e) => {
  console.error("[e2e-server] FAILED:", e);
  process.exitCode = 1;
});