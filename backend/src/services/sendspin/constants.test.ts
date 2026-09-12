import { describe, it, expect } from "vitest";
import { SENTINEL_PSK_HEX, SENTINEL_PSK_ID_HEX, PROTOCOL_VERSION, WS_PATH, MAX_TRANSPORT_PLAINTEXT } from "./constants.js";

describe("sendspin constants", () => {
  it("哨兵 PSK 与 psk_id 固定值", () => {
    expect(SENTINEL_PSK_HEX).toBe("1b5e24dbc1aed95fc2a5a338a90c05df44bd10f5ec1f4cd66cbf86272767b9d3");
    expect(SENTINEL_PSK_ID_HEX).toBe("185b15f6d2da4909bd1dc156a4ab206103abef0153bcd52d926170b95cf7ce8a");
  });
  it("协议版本与路径", () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(WS_PATH).toBe("/sendspin");
  });
  it("单帧明文上限", () => expect(MAX_TRANSPORT_PLAINTEXT).toBe(65519));
});