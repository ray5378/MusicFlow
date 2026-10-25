/** bridge-soak 子进程(由 scripts/bridge-soak.mjs 以 `node --import tsx` 拉起):
 *  MFAB_MODE=server → bridge listener(runBridgeServerMain);
 *  MFAB_MODE=sender → 以 MFAB_BYTES_PER_SEC 节奏推 48k s16le PCM(时长 MFAB_DURATION_MS)。
 *
 *  仅数据面:不做任何选歌/预取逻辑(桥只消费 PCM;选歌/判完整属 Phase 3 组泵语义)。
 */
import { runBridgeServerMain } from "../src/services/airplay/bridgeServer.js";
import type { BridgeProtocol } from "../src/services/airplay/rates.js";
import { BridgeMember } from "../src/services/sendspin/bridgeMember.js";

const env = process.env;
const mode = env.MFAB_MODE ?? "server";

if (mode === "server") {
  await runBridgeServerMain(env);
} else {
  const bytesPerSec = Number(env.MFAB_BYTES_PER_SEC ?? 192_000);
  const durationMs = Number(env.MFAB_DURATION_MS ?? 600_000);
  const member = new BridgeMember({
    deviceId: env.MFAB_DEVICE_ID ?? "soak",
    token: env.MFAB_TOKEN ?? "soak",
    protocol: (env.MFAB_PROTOCOL ?? "raop") as BridgeProtocol,
    socketPath: env.MFAB_SOCKET_PATH ?? "",
    log: (...args: unknown[]) => console.log("[sender]", ...args),
  });
  member.start();

  // 20ms 帧节奏(与组泵周期对齐),帧大小按码率折算,保持 4 字节(1 帧 PCM)对齐
  const chunkMs = 20;
  const chunkBytes = Math.round((bytesPerSec * chunkMs) / 1000 / 4) * 4;
  const chunkUs = BigInt(chunkMs * 1000);
  const chunk = Buffer.alloc(chunkBytes);
  let tsUs = 0n;
  const started = Date.now();
  const timer = setInterval(() => {
    member.pushAudio(chunk, tsUs);
    tsUs += chunkUs;
    if (Date.now() - started >= durationMs) {
      clearInterval(timer);
      const st = member.stats();
      console.log(`[sender] done sentFrames=${st.sentFrames} maxQueueMs=${Math.round(st.maxQueueMs)} reconnects=${st.reconnects} drops=${st.droppedFrames}`);
      member.stop();
      setTimeout(() => process.exit(0), 100).unref?.();
    }
  }, chunkMs);
}
