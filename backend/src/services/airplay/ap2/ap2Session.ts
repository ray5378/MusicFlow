// ==================== AP2 会话编排（Phase 6b 批 2）====================
//
// 消费 6a 契约的连接级编排骨架：
//   - pairNewDevice：新设备走 PIN 配对窗（/pair-pin-start → pair-setup M1-M6），
//     成功后回调新 controller seed（上层写 hap_credentials —— 写库失败视为配对
//     失败回滚，6a 契约：不得向对端宣称配对成功）。
//   - openVerifiedChannel：既有凭据（getHapCredentials 读行 → hex）走 pair-verify
//     M1-M4 免 PIN 重建加密通道（6a 出口「重启免 PIN」的实现路径）。
//     verify 失败由上层调 recordPairVerifyResult（连败 N 次清凭据回配对窗）。
// 批 4 在此之上接 SETUP/RECORD/timing 与 BridgeSession。
import type { Socket } from "node:net";
import {
  HapPairingClient,
  storedCredsFromHex,
  type HapPairSetupResult,
} from "./hapPairing.js";
import { Ap2RtspClient, type RtspCommonHeaders } from "./rtspClient.js";

/** 6a hex 凭据（parseHapCredentials 输出直接透传）。 */
export interface HapCredsHex {
  accessoryLTPK: string;
  controllerLTSK: string;
}

/** 新设备 PIN 配对：返回 6a 形态凭据（上层 saveHapCredentials）。
 *  opts.onNewControllerSeed：seed 生成时回调（写库失败抛错 ⇒ 本函数抛错，
 *  不宣称配对成功）。 */
export async function pairNewDevice(opts: {
  host: string;
  port: number;
  /** controller 配对标识（DACP-ID，同时是 6a 设备侧 id 的 wire 名）。 */
  controllerId: string;
  pin: string;
  onNewControllerSeed?: (seedHex: string) => void;
  timeoutMs?: number;
}): Promise<HapCredsHex> {
  const client = new Ap2RtspClient();
  try {
    await client.connect(opts.host, opts.port);
    const common: RtspCommonHeaders = { dacpId: opts.controllerId, activeRemote: "ap0000000000", hkp: 2 };
    // /pair-pin-start：bed 侧初始化 HAP 对象并展示 PIN（cliairplay 同款序列）。
    await client.request({
      method: "POST",
      url: "/pair-pin-start",
      common,
      contentType: "application/octet-stream",
      body: Buffer.alloc(0),
      timeoutMs: opts.timeoutMs,
    });
    const pairing = new HapPairingClient(
      {
        exchange: async (body: Buffer) => {
          const resp = await client.request({
            method: "POST",
            url: "/pair-setup",
            common,
            contentType: "application/pairing+tlv8",
            body,
            timeoutMs: opts.timeoutMs,
          });
          return resp.body;
        },
      },
      Buffer.from(opts.controllerId, "utf8"),
    );
    let setup: HapPairSetupResult;
    try {
      setup = await pairing.pairSetup(opts.pin);
    } catch (e) {
      throw e; // 上层据此决定重试/清凭据（本函数不触碰 DB）
    }
    const seedHex = setup.controllerSeed.toString("hex");
    opts.onNewControllerSeed?.(seedHex);
    const ltsk64 = Buffer.concat([setup.controllerSeed, setup.controllerLTPK]).toString("hex");
    return { accessoryLTPK: setup.accessoryLTPK.toString("hex"), controllerLTSK: ltsk64 };
  } finally {
    client.destroy();
  }
}

/** 既有凭据 → pair-verify → 加密 RTSP 通道（免 PIN）。
 *  返回的 client 已升级加密，直接可用（批 4 的 SETUP/RECORD 在其上）。 */
export async function openVerifiedChannel(opts: {
  host: string;
  port: number;
  controllerId: string;
  creds: HapCredsHex;
  timeoutMs?: number;
}): Promise<{ client: Ap2RtspClient; sharedKey: Buffer }> {
  const client = new Ap2RtspClient();
  await client.connect(opts.host, opts.port);
  const common: RtspCommonHeaders = { dacpId: opts.controllerId, activeRemote: "ap0000000000", hkp: 2 };
  const pairing = new HapPairingClient(
    {
      exchange: async (body: Buffer) => {
        const resp = await client.request({
          method: "POST",
          url: "/pair-verify",
          common,
          contentType: "application/pairing+tlv8",
          body,
          timeoutMs: opts.timeoutMs,
        });
        return resp.body;
      },
    },
    Buffer.from(opts.controllerId, "utf8"),
  );
  const { sharedKey } = await pairing.pairVerify(storedCredsFromHex(opts.creds));
  client.upgradeToEncrypted(sharedKey);
  return { client, sharedKey };
}

/** 底层 socket 访问（集成测试/批 4 摘除用）。 */
export type { Socket };
