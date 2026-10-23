// ==================== AP2 发送端(cliairplay 编排层)====================
//
// 全部协议细节都在二进制里,本目录只有四块编排:
//   - binary    二进制定位/自检/总开关(`MUSICFLOW_AP2_CLI=0` 一键回落自研 RAOP);
//   - cliSink   单设备会话:stdin 喂 PCM、cmdpipe 发 START/FLUSH/PAUSE/VOLUME;
//   - pairing   pair-setup 两段式(设备显示 PIN → 提交 PIN → 192 hex 凭据);
//   - ptpDaemon 多机共享时钟(默认关;统一 START 锚点已够,开它要 bind 319/320)。
export {
  findCliBinary,
  checkCliBinary,
  isAp2StreamingAvailable,
  ap2RuntimeInfo,
  resetAp2BinaryCache,
  shouldUseAp2,
} from "./binary.js";
export { CliSink, deriveDacpId, serializeTxt } from "./cliSink.js";
export type { CliSinkArgs, CliSinkEndInfo } from "./cliSink.js";
export { ptpDaemon } from "./ptpDaemon.js";
export { startPairSetup, submitPairPin, cancelPairSetup, cancelAllPairing } from "./pairing.js";
export type { PairStartResult, PairSubmitResult } from "./pairing.js";
