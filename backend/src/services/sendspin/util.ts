import { Buffer } from "node:buffer";

export const b64urlEncode = (data: Uint8Array): string =>
  Buffer.from(data).toString("base64url").replace(/=+$/, "");

export const b64urlDecode = (s: string): Uint8Array => {
  let t = s;
  while (t.length % 4 !== 0) t += "=";
  return new Uint8Array(Buffer.from(t, "base64url"));
};

export const bytesToHex = (d: Uint8Array): string => Buffer.from(d).toString("hex");