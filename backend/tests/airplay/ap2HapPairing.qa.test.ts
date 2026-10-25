// ==================== AP2 HAP 配对状态机（Phase 6b 批 1）跨实现验证 ====================
//
// 测试向量由 230 床 venv 生成（tests/fixtures/ap2/hap_vectors.json）：
// python 侧 = 床对端库 ap2/pairing/srp.py + cryptography + pycryptodome + hkdf
// （accessory 侧独立实现）；TS 侧 = SrpClient/hapPairing（独立实现）。
// 固定全部随机数 ⇒ 两侧输出必须逐字节一致 —— 跨实现（非同源）验证。
//
// MUST be the first import: 在 backend 模块加载前把 DATA_DIR 指到隔离临时目录。
import "../plugins/_env.js";

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  TlvTag,
  tlvDecode,
  tlvEncode,
} from "../../src/services/airplay/ap2/tlv8.js";
import { SrpClient } from "../../src/services/airplay/ap2/srp6a.js";
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
  x25519Shared,
} from "../../src/services/airplay/ap2/hapCrypto.js";
import {
  HapPairingClient,
  HapPairingError,
  storedCredsFromHex,
} from "../../src/services/airplay/ap2/hapPairing.js";
import type { HapTransport } from "../../src/services/airplay/ap2/hapPairing.js";

const vec = JSON.parse(
  readFileSync(
    path.resolve(fileURLToPath(import.meta.url), "..", "..", "fixtures", "ap2", "hap_vectors.json"),
    "utf8",
  ),
) as {
  meta: { srp_username: string; pin: string; ctrl_id: string; acc_id: string };
  setup: {
    salt: string; server_public: string; client_secret_a: string;
    expected_client_public_A: string; expected_client_proof_M1: string;
    server_proof_M2: string; srp_session_key_K: string;
    ctrl_seed: string; ctrl_pk: string; m5_enc: string; acc_pk: string; m6_enc: string;
  };
  verify: {
    cli_curve_priv: string; cli_curve_pub: string; acc_curve_pub: string;
    shared_key: string; m2_enc: string; m3_enc: string;
  };
};

const hex = (s: string) => Buffer.from(s, "hex");
const ctrlId = Buffer.from(vec.meta.ctrl_id, "utf8");

describe("TLV8 编解码（hap.py Tlv8 语义对齐）", () => {
  it("基本往返：State/Method 单字节 + Buffer 值", () => {
    const buf = tlvEncode([
      [TlvTag.STATE, 1],
      [TlvTag.METHOD, 0],
      [TlvTag.PUBLICKEY, hex("aabbccdd")],
      [TlvTag.IDENTIFIER, "abc"],
    ]);
    const map = tlvDecode(buf);
    expect(map.get(TlvTag.STATE)?.[0]).toBe(1);
    expect(map.get(TlvTag.METHOD)?.[0]).toBe(0);
    expect(map.get(TlvTag.PUBLICKEY)!.toString("hex")).toBe("aabbccdd");
    expect(map.get(TlvTag.IDENTIFIER)!.toString("utf8")).toBe("abc");
  });

  it(">255B 值自动 255 分片；decode 同 tag 拼接还原（hap.py 行为）", () => {
    const big = Buffer.alloc(700, 0xab);
    const buf = tlvEncode([[TlvTag.ENCRYPTEDDATA, big]]);
    const map = tlvDecode(buf);
    expect(map.get(TlvTag.ENCRYPTEDDATA)!.equals(big)).toBe(true);
  });

  it("空 value 编码为 len=0；截断输入 decode 抛错", () => {
    const buf = tlvEncode([[TlvTag.FLAGS, Buffer.alloc(0)]]);
    expect(Buffer.from(buf).toString("hex")).toBe("1300");
    expect(() => tlvDecode(Buffer.from([TlvTag.STATE, 8, 0x01]))).toThrow(/截断/);
  });
});

describe("SRP-6a client（跨实现：对端库固定向量）", () => {
  const s = vec.setup;

  function mkClient(): SrpClient {
    const c = new SrpClient(vec.meta.srp_username, vec.meta.pin, {
      clientSecret: BigInt("0x" + s.client_secret_a),
    });
    c.start(hex(s.salt), hex(s.server_public));
    return c;
  }

  it("clientPublic/proof 与对端库期望逐字节一致；server proof 校验通过", () => {
    const c = mkClient();
    expect(c.clientPublic.toString("hex")).toBe(s.expected_client_public_A);
    expect(c.proof.toString("hex")).toBe(s.expected_client_proof_M1);
    expect(c.verifyServerProof(hex(s.server_proof_M2))).toBe(true);
  });

  it("sessionKey 与 accessory 侧 K 一致（HKDF 根，跨实现核心）", () => {
    expect(mkClient().sessionKey.toString("hex")).toBe(s.srp_session_key_K);
  });

  it("错误 PIN → proof 不同、server proof 校验失败", () => {
    const c = new SrpClient(vec.meta.srp_username, "0000", {
      clientSecret: BigInt("0x" + s.client_secret_a),
    });
    c.start(hex(s.salt), hex(s.server_public));
    expect(c.proof.toString("hex")).not.toBe(s.expected_client_proof_M1);
    expect(c.verifyServerProof(hex(s.server_proof_M2))).toBe(false);
  });

  it("恶意对端：B ≡ 0 拒绝", () => {
    const c = new SrpClient(vec.meta.srp_username, vec.meta.pin);
    expect(() => c.start(hex(s.salt), Buffer.alloc(64, 0))).toThrow(/B ≡ 0/);
  });
});

describe("hapCrypto 原语", () => {
  it("Ed25519 签名/验签 + raw 公钥推导（用向量密钥交叉断言）", () => {
    const seed = hex(vec.setup.ctrl_seed);
    expect(ed25519RawPublic(seed).toString("hex")).toBe(vec.setup.ctrl_pk);
    const data = Buffer.from("hello");
    const sig = ed25519Sign(seed, data);
    expect(ed25519Verify(hex(vec.setup.ctrl_pk), data, sig)).toBe(true);
    expect(ed25519Verify(hex(vec.setup.acc_pk), data, sig)).toBe(false);
  });

  it("ChaCha20-Poly1305 往返；篡改/tag 损坏 → null；密文与向量侧 AEAD 互操作", () => {
    const key = hkdfSha512(Buffer.alloc(32, 1), Buffer.from("salt"), Buffer.from("info"), 32);
    const nonce = Buffer.alloc(12, 7);
    const plain = Buffer.from("cross-impl-check");
    const enc = chachaEncrypt(key, nonce, plain);
    expect(chachaDecrypt(key, nonce, enc)!.equals(plain)).toBe(true);
    expect(chachaDecrypt(key, nonce, Buffer.concat([enc.subarray(0, enc.length - 1), Buffer.from([enc[enc.length - 1]! ^ 1])]))).toBeNull();
    // 解密向量侧（pycryptodome）密文：key/nonce 用 setup_key 派生域,这里用
    // 向量 m5_enc 反向验证 —— TS chachaDecrypt 必须能解 python 侧加密的数据。
    const vecEnc = hex(vec.setup.m5_enc);
    const setupKey = hkdfSha512(
      hex(vec.setup.srp_session_key_K),
      Buffer.from("Pair-Setup-Encrypt-Salt", "utf8"),
      Buffer.from("Pair-Setup-Encrypt-Info", "utf8"),
      32,
    );
    // 8B HAP nonce ≡ 左补 4 零的 12B（pycryptodome 8B nonce 实测等价）
    const nonce8 = (n: string) => Buffer.concat([Buffer.alloc(4), Buffer.from(n, "ascii")]);
    const dec = chachaDecrypt(setupKey, nonce8("PS-Msg05"), vecEnc);
    expect(dec).not.toBeNull();
    const map = tlvDecode(dec!);
    expect(map.get(TlvTag.IDENTIFIER)!.toString("utf8")).toBe(vec.meta.ctrl_id);
    expect(map.get(TlvTag.PUBLICKEY)!.toString("hex")).toBe(vec.setup.ctrl_pk);
  });

  it("6a 64B controllerLTSK 布局（seed++pub）：往返一致，pub 与 seed 不符抛错", () => {
    const seed = hex(vec.setup.ctrl_seed);
    const stored = controllerLtskToStorage(seed);
    expect(stored.length).toBe(64);
    const back = controllerLtskFromStorage(stored);
    expect(back.seed.equals(seed)).toBe(true);
    const bad = Buffer.concat([seed, hex(vec.setup.acc_pk)]); // pub 换成别人的
    expect(() => controllerLtskFromStorage(bad)).toThrow(/不一致/);
  });

  it("HKDF-SHA-512 与 x25519 ECDH 基本互操作", () => {
    const a = x25519Generate();
    const b = x25519Generate();
    const s1 = x25519Shared(a.privateKey, b.publicKey);
    const s2 = x25519Shared(b.privateKey, a.publicKey);
    expect(s1.equals(s2)).toBe(true);
    expect(s1.length).toBe(32);
    expect(hkdfSha512(s1, Buffer.from("salt"), Buffer.from("info"), 32).length).toBe(32);
  });
});

describe("HapPairingClient.pairSetup（全流程跨实现）", () => {
  const s = vec.setup;

  it("M1-M6 全流程：复用 seed 时 M5/M6 与向量逐字节一致；新 seed 路径回调持久化", async () => {
    const calls: number[] = [];
    // 第一段（复用向量 seed）= 全确定性 ⇒ M5 密文应与 python 向量逐字节一致；
    // 第二段（新随机 seed）只做密码学断言（sub 结构 + Ed25519 验签）。
    let expectVectorM5 = true;
    const transport: HapTransport = {
      async exchange(req) {
        const map = tlvDecode(req);
        calls.push(map.get(TlvTag.STATE)![0]!);
        const state = map.get(TlvTag.STATE)![0]!;
        if (state === 1) {
          return tlvEncode([
            [TlvTag.STATE, 2],
            [TlvTag.SALT, hex(s.salt)],
            [TlvTag.PUBLICKEY, hex(s.server_public)],
          ]);
        }
        if (state === 3) {
          // M4：断言 M3 携带的 A/proof 与向量一致后返回 server proof
          expect(map.get(TlvTag.PUBLICKEY)!.toString("hex")).toBe(s.expected_client_public_A);
          expect(map.get(TlvTag.PROOF)!.toString("hex")).toBe(s.expected_client_proof_M1);
          return tlvEncode([
            [TlvTag.STATE, 4],
            [TlvTag.PROOF, hex(s.server_proof_M2)],
          ]);
        }
        if (state === 5) {
          const m5enc = map.get(TlvTag.ENCRYPTEDDATA)!;
          if (expectVectorM5) {
            expect(m5enc.toString("hex")).toBe(s.m5_enc);
          }
          // 通用密码学断言：解密 sub-TLV，ID 正确、签名可由其中的 LTPK 验证
          const setupKey = hkdfSha512(
            hex(s.srp_session_key_K),
            Buffer.from("Pair-Setup-Encrypt-Salt", "utf8"),
            Buffer.from("Pair-Setup-Encrypt-Info", "utf8"),
            32,
          );
          const sub = chachaDecrypt(setupKey, Buffer.concat([Buffer.alloc(4), Buffer.from("PS-Msg05", "ascii")]), m5enc);
          expect(sub).not.toBeNull();
          const sm = tlvDecode(sub!);
          expect(sm.get(TlvTag.IDENTIFIER)!.toString("utf8")).toBe(vec.meta.ctrl_id);
          const pub = sm.get(TlvTag.PUBLICKEY)!;
          const sig = sm.get(TlvTag.SIGNATURE)!;
          const ctrlX = hkdfSha512(
            hex(s.srp_session_key_K),
            Buffer.from("Pair-Setup-Controller-Sign-Salt", "utf8"),
            Buffer.from("Pair-Setup-Controller-Sign-Info", "utf8"),
            32,
          );
          expect(ed25519Verify(pub, Buffer.concat([ctrlX, sm.get(TlvTag.IDENTIFIER)!, pub]), sig)).toBe(true);
          return tlvEncode([
            [TlvTag.STATE, 6],
            [TlvTag.ENCRYPTEDDATA, hex(s.m6_enc)],
          ]);
        }
        throw new Error(`意外状态 ${state}`);
      },
    };
    const client = new HapPairingClient(transport, ctrlId);
    // —— 复用 seed 路径：全流程确定性，M5 密文与向量全等 ——
    const r1 = await client.pairSetup(vec.meta.pin, {
      srpClientSecret: BigInt("0x" + s.client_secret_a),
      getStoredSeed: () => controllerLtskToStorage(hex(s.ctrl_seed)),
    });
    expectVectorM5 = false;
    expect(calls).toEqual([1, 3, 5]);
    expect(r1.accessoryLTPK.toString("hex")).toBe(s.acc_pk);
    expect(r1.accessoryId.toString("utf8")).toBe(vec.meta.acc_id);
    expect(r1.controllerSeed.toString("hex")).toBe(s.ctrl_seed);
    expect(r1.controllerSeedIsNew).toBe(false);
    expect(r1.controllerLTPK.toString("hex")).toBe(s.ctrl_pk);
    expect(r1.srpSessionKey.toString("hex")).toBe(s.srp_session_key_K);

    // —— 新 seed 路径：随机 seed ⇒ onNewSeed 必须回调供上层持久化 ——
    let newSeed: Buffer | null = null;
    const r2 = await client.pairSetup(vec.meta.pin, {
      srpClientSecret: BigInt("0x" + s.client_secret_a),
      onNewSeed: (seed) => {
        newSeed = seed;
      },
    });
    expect(r2.controllerSeedIsNew).toBe(true);
    expect(r2.controllerSeed.equals(newSeed!)).toBe(true);
    expect(r2.controllerLTPK.toString("hex")).toBe(ed25519RawPublic(r2.controllerSeed).toString("hex"));

    // 6a hex 存储形态往返
    expect(
      storedCredsFromHex({
        accessoryLTPK: s.acc_pk,
        controllerLTSK: controllerLtskToStorage(hex(s.ctrl_seed)).toString("hex"),
      }).accessoryLTPK.toString("hex"),
    ).toBe(s.acc_pk);
  });

  it("对端拒绝（ERROR busy）→ HapPairingError(kind=rejected, code=7)", async () => {
    const transport: HapTransport = {
      async exchange() {
        return tlvEncode([
          [TlvTag.STATE, 2],
          [TlvTag.ERROR, 7],
        ]);
      },
    };
    const client = new HapPairingClient(transport, ctrlId);
    await expect(client.pairSetup(vec.meta.pin)).rejects.toMatchObject({
      name: "HapPairingError",
      kind: "rejected",
      tlvError: 7,
    });
  });

  it("server proof 错误（PIN 错）→ HapPairingError(kind=auth)", async () => {
    const transport: HapTransport = {
      async exchange(req) {
        const state = tlvDecode(req).get(TlvTag.STATE)![0]!;
        if (state === 1) {
          return tlvEncode([
            [TlvTag.STATE, 2],
            [TlvTag.SALT, hex(s.salt)],
            [TlvTag.PUBLICKEY, hex(s.server_public)],
          ]);
        }
        return tlvEncode([
          [TlvTag.STATE, 4],
          [TlvTag.PROOF, hex(s.server_proof_M2)], // 用对 PIN=3939 的 proof 配错 PIN client
        ]);
      },
    };
    const client = new HapPairingClient(transport, ctrlId);
    await expect(client.pairSetup("0000")).rejects.toMatchObject({
      name: "HapPairingError",
      kind: "auth",
    });
  });
});

describe("HapPairingClient.pairVerify（全流程跨实现）", () => {
  const v = vec.verify;
  const s = vec.setup;

  it("M1-M4 全流程：sharedKey 与 accessory 侧一致、M3 密文与向量一致", async () => {
    const transport: HapTransport = {
      async exchange(req) {
        const map = tlvDecode(req);
        const state = map.get(TlvTag.STATE)![0]!;
        if (state === 1) {
          expect(map.get(TlvTag.PUBLICKEY)!.toString("hex")).toBe(v.cli_curve_pub);
          return tlvEncode([
            [TlvTag.STATE, 2],
            [TlvTag.PUBLICKEY, hex(v.acc_curve_pub)],
            [TlvTag.ENCRYPTEDDATA, hex(v.m2_enc)],
          ]);
        }
        // M3：密文必须与 python 向量一致（X25519 + 签名确定性）
        expect(map.get(TlvTag.ENCRYPTEDDATA)!.toString("hex")).toBe(v.m3_enc);
        return tlvEncode([[TlvTag.STATE, 4]]);
      },
    };
    const client = new HapPairingClient(transport, ctrlId);
    const result = await client.pairVerify(
      {
        accessoryLTPK: hex(s.acc_pk),
        controllerSeed: controllerLtskToStorage(hex(s.ctrl_seed)),
      },
      { ephemeralPrivate: hex(v.cli_curve_priv) }, // 向量固定 ephemeral ⇒ M3 密文跨实现一致
    );
    expect(result.sharedKey.toString("hex")).toBe(v.shared_key);
    expect(result.accessoryCurvePublic.toString("hex")).toBe(v.acc_curve_pub);
  });

  it("accessory 签名不对（换错 LTPK）→ HapPairingError(kind=auth)", async () => {
    // 用 controller 的 LTPK 冒充 accessory（签名来自 ACC_SEED ⇒ 校验必失败）
    const transport: HapTransport = {
      async exchange(req) {
        const state = tlvDecode(req).get(TlvTag.STATE)![0]!;
        if (state === 1) {
          return tlvEncode([
            [TlvTag.STATE, 2],
            [TlvTag.PUBLICKEY, hex(v.acc_curve_pub)],
            [TlvTag.ENCRYPTEDDATA, hex(v.m2_enc)],
          ]);
        }
        return tlvEncode([[TlvTag.STATE, 4]]);
      },
    };
    const client = new HapPairingClient(transport, ctrlId);
    await expect(
      client.pairVerify(
        {
          accessoryLTPK: hex(s.ctrl_pk), // 错的 LTPK
          controllerSeed: controllerLtskToStorage(hex(s.ctrl_seed)),
        },
        { ephemeralPrivate: hex(v.cli_curve_priv) },
      ),
    ).rejects.toMatchObject({ name: "HapPairingError", kind: "auth" });
  });

  it("凭据 seed/pub 不一致 → HapCryptoError", async () => {
    const client = new HapPairingClient({ async exchange() { return Buffer.alloc(0); } }, ctrlId);
    await expect(
      client.pairVerify({
        accessoryLTPK: hex(s.acc_pk),
        controllerSeed: Buffer.concat([hex(s.ctrl_seed), hex(s.acc_pk)]), // 坏存储
      }),
    ).rejects.toThrow(/不一致/);
  });
});

describe("随机路径自洽（非向量回归）", () => {
  it("随机 Ed25519/X25519 密钥 sign-verify 与 ECDH 对称", () => {
    const seed = ed25519GenerateSeed();
    const pub = ed25519RawPublic(seed);
    const sig = ed25519Sign(seed, pub);
    expect(ed25519Verify(pub, pub, sig)).toBe(true);
    expect(constantTimeEqual(pub, pub)).toBe(true);
  });
});
