import jwt from "jsonwebtoken";
import md5 from "md5";
import { createHash } from "node:crypto";
import { JWT_SECRET } from "./env.js";

export function generateToken(userId: string, username: string, isAdmin: boolean): string {
  return jwt.sign({ uid: userId, sub: username, adm: isAdmin, iss: "ND" }, JWT_SECRET, { expiresIn: "24h" });
}

export function md5Hash(str: string): string {
  return md5(str);
}

/** API key 的单向摘要(sha256 hex)。用于 apiKeyHash 列与内存鉴权索引,
 *  避免依赖明文比对。 */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}
