// Zeroconf/mDNS broadcast so the Home Assistant integration can auto-discover
// this MusicFlow instance (manifest.json declares _musicflow._tcp.local.).
//
// Mirrors MA's `_music_assistant._tcp.local.` broadcast. Uses `bonjour-service`
// (pure JS, no native deps — friendly to HA OS amd64/arm64 add-ons).
//
// A stable server UUID is persisted under ./data/.server-uuid so the same
// instance keeps the same UUID across restarts (HA's config flow uses it for
// unique_id deduplication).
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { Bonjour } from "bonjour-service";
import { getDataDir } from "../../utils/env.js";
import { createLogger } from "../../utils/logger.js";

let bonjour: Bonjour | null = null;
let service: any = null;

const SERVICE_TYPE = "musicflow";
const PROTO = "tcp";

const log = createLogger("mDNS");
export function startMdnsBroadcast(port: number): void {
  if (bonjour) return;
  bonjour = new Bonjour();

  const hostname = (os.hostname() || "musicflow").toLowerCase().replace(/[^a-z0-9-]/g, "");
  const instanceName = `MusicFlow-${hostname}`;
  const uuid = getServerUuid();
  const version = readVersion();

  try {
    service = bonjour.publish({
      name: instanceName,
      type: SERVICE_TYPE,
      protocol: PROTO,
      port,
      txt: {
        version,
        uuid,
      },
    });
    console.log(`[mDNS] broadcasting ${instanceName}._${SERVICE_TYPE}._${PROTO}.local. on :${port} (uuid=${uuid})`);
  } catch (e: any) {
    log.error("publish failed", { err: e.message });
  }
}

export function stopMdnsBroadcast(): void {
  try { service?.stop(); } catch {}
  try { bonjour?.destroy(); } catch {}
  bonjour = null;
  service = null;
}

function getServerUuid(): string {
  const dataDir = getDataDir();
  const file = path.join(dataDir, ".server-uuid");
  try {
    if (fs.existsSync(file)) {
      const stored = fs.readFileSync(file, "utf8").trim();
      if (/^[0-9a-f-]{36}$/i.test(stored)) return stored;
    }
    fs.mkdirSync(dataDir, { recursive: true });
    const generated = crypto.randomUUID();
    fs.writeFileSync(file, generated, { mode: 0o600 });
    return generated;
  } catch {
    // Fallback to a transient UUID if persistence fails (worse for HA dedup,
    // but still functional).
    return crypto.randomUUID();
  }
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8"));
    return pkg.version || "1.0.0";
  } catch {
    return "1.0.0";
  }
}
