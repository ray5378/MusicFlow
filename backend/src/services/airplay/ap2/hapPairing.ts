// ==================== HAP 配对状态机（controller 侧，Phase 6b 批 1）====================
//
// 消费 6a 契约的 pair-setup / pair-verify 流程，与对端
// /tmp/ap2recv/ap2/pairing/hap.py（accessory 侧）逐字对齐：
//
//   pair-setup（SRP-6a 3072 + Ed25519 交换）：
//     M1 {STATE=1, METHOD=0} → M2 {STATE=2, SALT, PUBLICKEY(B)}
//     M3 {STATE=3, PUBLICKEY(A), PROOF(M1)} → M4 {STATE=4, PROOF(M2)}
//     M5 {STATE=5, ENCRYPTEDDATA(sub: ID/PUB/SIG, ChaCha "PS-Msg05")}
//       → M6 {STATE=6, ENCRYPTEDDATA(sub: accessory ID/PUB/SIG, "PS-Msg06")}
//       sub-TLV 加密密钥 = HKDF(SRP K, "Pair-Setup-Encrypt-Salt"/"-Info")
//       controller 签名材料 = HKDF(K,"Pair-Setup-Controller-Sign-Salt"/"-Info")||ID||LTPK
//       accessory  签名材料 = HKDF(K,"Pair-Setup-Accessory-Sign-Salt"/"-Info")||ID||LTPK
//
//   pair-verify（X25519 ephemeral + Ed25519 LTPK 签名）：
//     M1 {STATE=1, PUB(eph)} → M2 {STATE=2, PUB(acc), ENC("PV-Msg02", acc 签名)}
//     M3 {STATE=3, ENC("PV-Msg03", controller 签名)} → M4 {STATE=4}
//     会话加密密钥 = HKDF(shared, "Pair-Verify-Encrypt-Salt"/"-Info")（verify 内用）
//     **会话数据密钥 = shared 本身**（HAPSocket 用 "Control-Salt" 再派生，批 2）
//
// 批 1 边界：transport 由注入方提供（单测假对端 / 批 4 接 HTTP+HAPSocket）；
// 6a 契约钩子经回调出接（本模块不 import db）：
//   - onNewSeed：首次 pair-setup 生成的 controller seed（上层调 saveHapCredentials）
//   - 配对成败的 recordPairSetupSuccess / recordPairVerifyResult 由上层接线。
import {
  chachaDecrypt,
  chachaEncrypt,
  constantTimeEqual,
  controllerLtskFromStorage,
  controllerLtskToStorage,
  ed25519GenerateSeed,
  ed25519RawPublic,
  ed25519Sign,
  ed25519Verify,
  hkdfSha512,
  x25519Generate,
  x25519RawPublic,
  x25519Shared,
} from "./hapCrypto.js";
import { SrpClient, SrpAuthError } from "./srp6a.js";
import { TlvTag, tlvDecode, tlvEncode, tlvRequire } from "./tlv8.js";

/** 底部 transport：一次请求-响应（HTTP POST /pair-setup|/pair-verify 或 HAPSocket）。 */
export interface HapTransport {
  exchange(reqBody: Buffer): Promise<Buffer>;
}

/** 6a 存储凭据的 Buffer 形态（上层从 hapCredentials.ts parse 得来）。 */
export interface HapStoredCredentials {
  accessoryLTPK: Buffer;
  controllerSeed: Buffer;
}

export interface HapPairSetupResult {
  accessoryLTPK: Buffer;
  accessoryId: Buffer;
  controllerSeed: Buffer;
  controllerLTPK: Buffer;
  /** SRP 会话密钥 K（64B）——仅 M5/M6 派生用，不持久、不落日志。 */
  srpSessionKey: Buffer;
  /** 本次是否新生成了 controller seed（true ⇒ 上层必须持久化）。 */
  controllerSeedIsNew: boolean;
}

export interface HapPairVerifyResult {
  /** 会话密钥：X25519 shared secret（32B）。批 2 派生 Control-Read/Write。 */
  sharedKey: Buffer;
  accessoryCurvePublic: Buffer;
}

export type HapPairingErrorKind = "protocol" | "auth" | "rejected";

export class HapPairingError extends Error {
  constructor(
    public readonly kind: HapPairingErrorKind,
    message: string,
    public readonly tlvError?: number,
  ) {
    super(message);
    this.name = "HapPairingError";
  }
}

const SALT_SETUP_ENCRYPT = Buffer.from("Pair-Setup-Encrypt-Salt", "utf8");
const INFO_SETUP_ENCRYPT = Buffer.from("Pair-Setup-Encrypt-Info", "utf8");
const SALT_CTRL_SIGN = Buffer.from("Pair-Setup-Controller-Sign-Salt", "utf8");
const INFO_CTRL_SIGN = Buffer.from("Pair-Setup-Controller-Sign-Info", "utf8");
const SALT_ACC_SIGN = Buffer.from("Pair-Setup-Accessory-Sign-Salt", "utf8");
const INFO_ACC_SIGN = Buffer.from("Pair-Setup-Accessory-Sign-Info", "utf8");
const SALT_VERIFY_ENCRYPT = Buffer.from("Pair-Verify-Encrypt-Salt", "utf8");
const INFO_VERIFY_ENCRYPT = Buffer.from("Pair-Verify-Encrypt-Info", "utf8");
// HAP 规范 nonce 是 8B ASCII 名（"PS-Msg05" 等）；对端 pycryptodome 8B nonce
// 已实测等价于 RFC7539 12B = 4 个零字节 + 8B 名（向量解密验证）。Node 只收 12B。
const nonce8 = (name: string): Buffer =>
  Buffer.concat([Buffer.alloc(4, 0), Buffer.from(name, "ascii")]);
const NONCE_PS05 = nonce8("PS-Msg05");
const NONCE_PS06 = nonce8("PS-Msg06");
const NONCE_PV02 = nonce8("PV-Msg02");
const NONCE_PV03 = nonce8("PV-Msg03");

/** TLV error code → 语义名（hap.py PairingErrors）。 */
const ERROR_NAMES: Record<number, string> = {
  0: "reserved",
  1: "unknown",
  2: "authentication",
  3: "backoff",
  4: "maxpeers",
  5: "maxtries",
  6: "unavailable",
  7: "busy",
};

/** 解析 accessory 响应；带 Error TLV 时直接抛 rejected。 */
function parseResponse(res: Buffer, expectState: number, stage: string): Map<number, Buffer> {
  const map = tlvDecode(res);
  const err = map.get(TlvTag.ERROR);
  if (err && err.length > 0) {
    const code = err[0];
    throw new HapPairingError(
      "rejected",
      `${stage} 被对端拒绝: ${ERROR_NAMES[code] ?? code}`,
      code,
    );
  }
  const state = tlvRequire(map, TlvTag.STATE, `${stage} State`);
  if (state.length < 1 || state[0] !== expectState) {
    throw new HapPairingError(
      "protocol",
      `${stage} 状态不符: 期望 ${expectState} 实得 ${state.length ? state[0] : "?"}`,
    );
  }
  return map;
}

export class HapPairingClient {
  constructor(
    private readonly transport: HapTransport,
    /** controller 配对标识（wire utf8，如 MusicFlow 设备 ID）。 */
    private readonly controllerId: Buffer,
  ) {}

  /** pair-setup M1-M6。成功即「配对成立」——上层负责调 recordPairSetupSuccess。
   *  opts.getStoredSeed：重配对场景复用既有 controller seed（保证 LTPK 不变）；
   *  opts.onNewSeed：本次新生成 seed 时回调（上层必须持久化，写库失败应视为
   *  配对失败回滚——写库失败不得向对端宣称配对成功，6a 契约）；
   *  opts.srpClientSecret：注入固定 SRP 私钥（跨实现向量测试用；生产不传）。 */
  async pairSetup(
    password: string,
    opts?: {
      getStoredSeed?: () => Buffer | null;
      onNewSeed?: (seed: Buffer) => void;
      srpClientSecret?: bigint;
    },
  ): Promise<HapPairSetupResult> {
    const srp = new SrpClient("Pair-Setup", password, opts?.srpClientSecret !== undefined
      ? { clientSecret: opts.srpClientSecret }
      : undefined);
    try {
      // ---- M1 → M2 ----
      const m2 = parseResponse(
        await this.transport.exchange(tlvEncode([
          [TlvTag.STATE, 1],
          [TlvTag.METHOD, 0],
        ])),
        2,
        "pair-setup M2",
      );
      srp.start(tlvRequire(m2, TlvTag.SALT, "M2 Salt"), tlvRequire(m2, TlvTag.PUBLICKEY, "M2 PublicKey"));

      // ---- M3 → M4 ----
      const m4 = parseResponse(
        await this.transport.exchange(tlvEncode([
          [TlvTag.STATE, 3],
          [TlvTag.PUBLICKEY, srp.clientPublic],
          [TlvTag.PROOF, srp.proof],
        ])),
        4,
        "pair-setup M4",
      );
      const serverProof = tlvRequire(m4, TlvTag.PROOF, "M4 Proof");
      if (!srp.verifyServerProof(serverProof)) {
        throw new HapPairingError("auth", "pair-setup M4: server proof 校验失败（PIN 错误或对端损坏）");
      }
      const srpKey = srp.sessionKey;

      // ---- M5（交换 controller 长期密钥）→ M6 ----
      const setupKey = hkdfSha512(srpKey, SALT_SETUP_ENCRYPT, INFO_SETUP_ENCRYPT, 32);
      let seed: Buffer;
      let seedIsNew = false;
      const stored = opts?.getStoredSeed?.() ?? null;
      if (stored) {
        // 复用既有 seed（controllerLtskFromStorage 会校验 pub 推导一致性）。
        seed = controllerLtskFromStorage(stored).seed;
      } else {
        seed = ed25519GenerateSeed();
        seedIsNew = true;
      }
      const ctrlLtpk = ed25519RawPublic(seed);
      const ctrlX = hkdfSha512(srpKey, SALT_CTRL_SIGN, INFO_CTRL_SIGN, 32);
      const ctrlSig = ed25519Sign(seed, Buffer.concat([ctrlX, this.controllerId, ctrlLtpk]));
      const m6 = parseResponse(
        await this.transport.exchange(tlvEncode([
          [TlvTag.STATE, 5],
          [TlvTag.ENCRYPTEDDATA, chachaEncrypt(setupKey, NONCE_PS05, tlvEncode([
            [TlvTag.IDENTIFIER, this.controllerId],
            [TlvTag.PUBLICKEY, ctrlLtpk],
            [TlvTag.SIGNATURE, ctrlSig],
          ]))],
        ])),
        6,
        "pair-setup M6",
      );
      const m6Enc = tlvRequire(m6, TlvTag.ENCRYPTEDDATA, "M6 EncryptedData");
      const m6Sub = chachaDecrypt(setupKey, NONCE_PS06, m6Enc);
      if (!m6Sub) throw new HapPairingError("auth", "pair-setup M6 解密失败（对端密钥不一致）");
      const m6Map = tlvDecode(m6Sub);
      const accId = tlvRequire(m6Map, TlvTag.IDENTIFIER, "M6 accessory Identifier");
      const accLtpk = tlvRequire(m6Map, TlvTag.PUBLICKEY, "M6 accessory PublicKey");
      const accSig = tlvRequire(m6Map, TlvTag.SIGNATURE, "M6 accessory Signature");
      const accX = hkdfSha512(srpKey, SALT_ACC_SIGN, INFO_ACC_SIGN, 32);
      if (!ed25519Verify(accLtpk, Buffer.concat([accX, accId, accLtpk]), accSig)) {
        throw new HapPairingError("auth", "pair-setup M6: accessory 签名校验失败");
      }
      if (seedIsNew) opts?.onNewSeed?.(seed);
      return {
        accessoryLTPK: accLtpk,
        accessoryId: accId,
        controllerSeed: seed,
        controllerLTPK: ctrlLtpk,
        srpSessionKey: srpKey,
        controllerSeedIsNew: seedIsNew,
      };
    } catch (e) {
      if (e instanceof HapPairingError || e instanceof SrpAuthError) throw e;
      throw new HapPairingError("protocol", `pair-setup 协议异常: ${(e as Error).message}`);
    }
  }

  /** pair-verify M1-M4。失败由上层调 recordPairVerifyResult(deviceId,false)。
   *  返回的 sharedKey 是会话数据加密根（HAPSocket 派生 Control-Read/Write）。
   *  opts.ephemeralPrivate：注入固定 X25519 ephemeral（跨实现向量测试用；
   *  生产路径一律不传）。 */
  async pairVerify(
    creds: HapStoredCredentials,
    opts?: { ephemeralPrivate?: Buffer },
  ): Promise<HapPairVerifyResult> {
    // controllerSeed 64B 校验（pub 推导一致）后取回 32B seed。
    const accessoryLTPK = creds.accessoryLTPK;
    const { seed: controllerSeed } = controllerLtskFromStorage(creds.controllerSeed);
    try {
      const eph = opts?.ephemeralPrivate
        ? { privateKey: opts.ephemeralPrivate, publicKey: x25519RawPublic(opts.ephemeralPrivate) }
        : x25519Generate();
      // ---- M1 → M2 ----
      const m2 = parseResponse(
        await this.transport.exchange(tlvEncode([
          [TlvTag.STATE, 1],
          [TlvTag.PUBLICKEY, eph.publicKey],
        ])),
        2,
        "pair-verify M2",
      );
      const accCurvePub = tlvRequire(m2, TlvTag.PUBLICKEY, "M2 PublicKey");
      const m2Enc = tlvRequire(m2, TlvTag.ENCRYPTEDDATA, "M2 EncryptedData");
      const sharedKey = x25519Shared(eph.privateKey, accCurvePub);
      const pvKey = hkdfSha512(sharedKey, SALT_VERIFY_ENCRYPT, INFO_VERIFY_ENCRYPT, 32);
      const m2Sub = chachaDecrypt(pvKey, NONCE_PV02, m2Enc);
      if (!m2Sub) throw new HapPairingError("auth", "pair-verify M2 解密失败");
      const m2Map = tlvDecode(m2Sub);
      const accId = tlvRequire(m2Map, TlvTag.IDENTIFIER, "M2 accessory Identifier");
      const accSig = tlvRequire(m2Map, TlvTag.SIGNATURE, "M2 accessory Signature");
      // accessory_info = acc_curve_pub || acc_id || client_curve_pub（hap.py 对齐）
      if (!ed25519Verify(accessoryLTPK, Buffer.concat([accCurvePub, accId, eph.publicKey]), accSig)) {
        throw new HapPairingError("auth", "pair-verify M2: accessory 签名校验失败（凭据失效？）");
      }

      // ---- M3 → M4 ----
      const ctrlSig = ed25519Sign(
        controllerSeed,
        Buffer.concat([eph.publicKey, this.controllerId, accCurvePub]),
      );
      const m4 = parseResponse(
        await this.transport.exchange(tlvEncode([
          [TlvTag.STATE, 3],
          [TlvTag.ENCRYPTEDDATA, chachaEncrypt(pvKey, NONCE_PV03, tlvEncode([
            [TlvTag.IDENTIFIER, this.controllerId],
            [TlvTag.SIGNATURE, ctrlSig],
          ]))],
        ])),
        4,
        "pair-verify M4",
      );
      return { sharedKey, accessoryCurvePublic: accCurvePub };
    } catch (e) {
      if (e instanceof HapPairingError) throw e;
      throw new HapPairingError("protocol", `pair-verify 协议异常: ${(e as Error).message}`);
    }
  }
}

/** 便捷：从 6a 的 hex 存储（parseHapCredentials 输出）构造 Buffer 凭据。 */
export function storedCredsFromHex(creds: { accessoryLTPK: string; controllerLTSK: string }): HapStoredCredentials {
  return {
    accessoryLTPK: Buffer.from(creds.accessoryLTPK, "hex"),
    controllerSeed: Buffer.from(creds.controllerLTSK, "hex"),
  };
}

/** 导出常量时间比较（上层校验用）。 */
export { constantTimeEqual, controllerLtskToStorage };
