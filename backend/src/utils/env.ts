import fs from "fs";
import path from "path";

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

export function getJwtSecret(): string {
  loadDotEnv();
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    console.error("[FATAL] 环境变量 JWT_SECRET 未设置或长度不足 32 字符,拒绝启动。");
    console.error("       该密钥用于 JWT 签名和 pass_enc 密码加密,必须为每台部署随机生成。");
    console.error("       生成: openssl rand -hex 32");
    console.error("       并在 backend/.env 写入 JWT_SECRET=<值> 后重新启动。");
    process.exit(1);
  }
  return secret;
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
  return Number.isFinite(n) && n >= 0 ? n : 180;
}