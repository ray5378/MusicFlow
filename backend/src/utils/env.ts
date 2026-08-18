import fs from "fs";
import path from "path";
import crypto from "crypto";
import { createLogger } from "../utils/logger.js";

// Lazily load a backend/.env file if present (no dotenv dependency).
// Real env vars always take precedence; existing vars are never overwritten.
function loadDotEnv() {
  try {
    const file = path.resolve(process.cwd(), ".env");
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m || m[1] in process.env) continue;
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
}

const log = createLogger("FATAL");
export function getDataDir(): string {
  return process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve(process.cwd(), "data");
}

export function getJwtSecret(): string {
  loadDotEnv();
  const secret = process.env.JWT_SECRET;
  if (secret && secret.length >= 32) return secret;
  // JWT_SECRET is optional: auto-generate one and persist it next to the DB so
  // restarts keep the same secret without any configuration.
  const secretFile = path.join(getDataDir(), ".jwt-secret");
  try {
    if (fs.existsSync(secretFile)) {
      const stored = fs.readFileSync(secretFile, "utf8").trim();
      if (stored.length >= 32) return stored;
    }
    const generated = crypto.randomBytes(32).toString("hex");
    fs.mkdirSync(getDataDir(), { recursive: true });
    fs.writeFileSync(secretFile, generated, { mode: 0o600 });
    console.log(`[SECRET] JWT_SECRET 未配置,已自动生成并保存到 ${secretFile}`);
    return generated;
  } catch (e: any) {
    log.error("无法生成 JWT_SECRET", { err: e.message });
    process.exit(1);
  }
}

export const JWT_SECRET = getJwtSecret();

export function getCorsOrigins(): string[] {
  loadDotEnv();
  const raw = process.env.CORS_ORIGINS || "";
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}

export function getPlayHistoryRetentionDays(): number {
  loadDotEnv();
  const raw = process.env.PLAY_HISTORY_RETENTION_DAYS;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 3;
}