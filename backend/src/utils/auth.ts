import jwt from "jsonwebtoken";
import md5 from "md5";
import { JWT_SECRET } from "./env.js";

export function generateToken(userId: string, username: string, isAdmin: boolean): string {
  return jwt.sign({ uid: userId, sub: username, adm: isAdmin, iss: "ND" }, JWT_SECRET, { expiresIn: "24h" });
}

export function md5Hash(str: string): string {
  return md5(str);
}
