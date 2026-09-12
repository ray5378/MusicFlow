import { describe, it, expect } from "vitest";
import { b64urlEncode, b64urlDecode, bytesToHex } from "./util.js";

describe("util", () => {
  it("base64url 无 padding 往返", () => {
    const buf = Uint8Array.from([0, 1, 2, 3, 250, 251, 252, 253]);
    const s = b64urlEncode(buf);
    expect(b64urlDecode(s)).toEqual(buf);
  });
  it("解码可忽略缺失 padding", () => {
    expect(b64urlDecode("G14k28Gu2V_CpaM4qQwF30S9EPXsH0zWbL-GJydnudM").length).toBe(32);
  });
  it("bytesToHex", () => {
    expect(bytesToHex(Uint8Array.from([0x01, 0xab, 0xff]))).toBe("01abff");
  });
});