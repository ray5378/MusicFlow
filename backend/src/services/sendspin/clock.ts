/** 单一时钟源已上移 `utils/hostClock.ts`(AirPlay 桥接 Phase 1:发送侧 tsUs 与
 *  RAOP NTP 必须同源可比)。此处保留 re-export,既有 `./clock.js` import 全部不动。 */
export { nowUs, setNowUsOverride } from "../../utils/hostClock.js";
import { nowUs } from "../../utils/hostClock.js";

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
