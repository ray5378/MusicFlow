import { hrtime } from "node:process";

/** 单调微秒时钟 (host monotonic, 不受 NTP 回拨影响) */
export const nowUs = (): bigint => BigInt(hrtime.bigint() / 1000n);

export function buildServerTime(clientTransmitted: bigint) {
  return {
    type: "server/time",
    payload: {
      client_transmitted: clientTransmitted,
      server_received: nowUs(),
      server_transmitted: nowUs(),
    },
  };
}