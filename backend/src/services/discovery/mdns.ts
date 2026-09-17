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
// 额外服务(插件用):与主广播共用一个 Bonjour 实例,避免多实例抢 5353 端口。
// key 由调用方定,同一 key 重复 publish 先撤旧的。mdns 层只管发布,不懂业务。
const extraServices = new Map<string, any>();

const SERVICE_TYPE = "musicflow";
const PROTO = "tcp";

const log = createLogger("mDNS");

/** 共享 Bonjour 实例(供插件复用,如 sendspin 浏览 _sendspin._tcp 设备)。
 *  只给 socket,不懂业务;避免各插件自建实例抢 5353 端口。 */
export function getSharedBonjour(): Bonjour {
  if (!bonjour) bonjour = new Bonjour();
  return bonjour;
}
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
    log.info(`[mDNS] broadcasting ${instanceName}._${SERVICE_TYPE}._${PROTO}.local. on :${port} (uuid=${uuid})`);
  } catch (e: any) {
    log.error("publish failed", { err: e.message });
  }
}

export function stopMdnsBroadcast(): void {
  try { service?.stop(); } catch {}
  for (const [key, svc] of extraServices) {
    try { svc?.stop(); } catch {}
    extraServices.delete(key);
  }
  try { bonjour?.destroy(); } catch {}
  bonjour = null;
  service = null;
}

/** 发布一个额外 mDNS 服务(供内置插件如 sendspin 用)。
 *  参数全由调用方给(名/类型/端口/txt),mdns 层不掺任何业务认知。
 *  返回 key,stopExtraService(key) 撤销。 */
export function publishExtraService(
  key: string,
  opts: { name: string; type: string; port: number; txt?: Record<string, string> },
): void {
  unpublishExtraService(key);
  if (!bonjour) bonjour = new Bonjour();
  try {
    const svc = bonjour.publish({
      name: opts.name,
      type: opts.type,
      protocol: PROTO,
      port: opts.port,
      txt: opts.txt ?? {},
    });
    extraServices.set(key, svc);
    log.info(`[mDNS] broadcasting _${opts.type}._${PROTO}.local. on :${opts.port}`);
  } catch (e: any) {
    log.error("extra publish failed", { key, err: e.message });
  }
}

export function unpublishExtraService(key: string): void {
  const svc = extraServices.get(key);
  if (!svc) return;
  try { svc?.stop(); } catch {}
  extraServices.delete(key);
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
