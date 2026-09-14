import WebSocket from "ws";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { setSendspinIdentityDir, startSendspinService, stopSendspinService, getSendspinServer } from "/workspace/MusicFlow/backend/src/services/sendspin/index.js";
import { pumpFor, overridePumpSource } from "/workspace/MusicFlow/backend/src/services/sendspin/streamEngine.js";

const t = (m: string) => console.log(`[t=${Date.now() % 100000}] ${m}`);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sendspin-hang2-"));
setSendspinIdentityDir(dir);
t("starting");
await startSendspinService(18938);
overridePumpSource(async () => ({ pcm: new Float32Array(48000 * 2 * 30), durationMs: 30000 }));
t("calling stop");
await Promise.race([
  stopSendspinService().then(() => t("stop resolved")),
  new Promise((_, rej) => setTimeout(() => rej(new Error("STOP HANGS")), 15000)),
]);
t("ALL DONE");
process.exit(0);
