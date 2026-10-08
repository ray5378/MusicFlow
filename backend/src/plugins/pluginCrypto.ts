// ==================== 沙箱插件密码学原语(唯一实现源) ====================
//
// 为什么集中在一个文件:同一套原语有三个消费方,必须逐字节一致——
//   1. 主线程沙箱注入      backend/src/plugins/sandbox.ts  (host.crypto.* → env.crypto.*)
//   2. 直连宿主(direct)    backend/src/plugins/discovery.ts (env.crypto)
//   3. worker 批量任务     backend/src/plugins/sandboxWorker.ts (env.crypto)
// 任何一处私有实现漂移,都会表现为「后台任务里签名能过、前台不能过」这类极难定位的问题,
// 因此这里既是实现源,也是 hostApiParity 双向断言的构造真源。
//
// 契约(与 SandboxHostEnv.crypto / host.crypto 对齐):
//   - 全部为**纯同步**函数:输入字符串,成功返回字符串。
//   - **失败一律返回 { error: string },绝不抛异常**——这是沙箱 hostSync 的语义:
//     插件侧对返回值做判断,而不是 try/catch 一个二进制异常。
//   - 枚举入参一律严格校验;非法 mode / padding / encoding、key 长度不对、
//     hex 或 base64 格式错、gcm 密文长度不足 —— 一律返回 { error },不抛。
//   - hex 输出一律**小写**(Node toString("hex") 的默认行为)。上游部分协议要大写
//     HEX(网易云 eapi、QQ zzcSign 的 sha1),由插件自行 .toUpperCase()。
//
// 与上游 multiPlatformMusicApi 协议的逐字节对齐要点(插件据此复刻):
//   ① AES-GCM 输出布局 = [12B IV]‖[ct]‖[16B authTag](IV 在最前),
//      与上游 Buffer.concat([iv, ct, tag]).toString("base64") 完全一致;
//      iv 省略/空串时由宿主生成 12 字节随机 IV 并前置;解密从密文头部切出 IV。
//      createCipheriv 显式传 { authTagLength: 16 }。
//   ② RSA padding:"none" = 宿主先把 data **左补 0x00 到 128 字节**,再
//      publicEncrypt(RSA_NO_PADDING),复刻上游 Buffer.alloc(128) +
//      buffer.copy(padded, 128 - len)。补零由宿主完成,**插件不碰二进制**。
//   ③ 默认值:data/key/iv 输入编码为 "utf8",输出为 "base64";mode:"ecb" 忽略 iv。
//      rsaEncrypt 的 outputEncoding 默认 "hex"(上游 encSecKey 为 HEX)。
//
// ⚠️ 本文件只被 discovery.ts / sandboxWorker.ts 静态引用;sandbox.ts 保持零新依赖
//    (worker 以原生 ESM 加载它),只做 this.env.crypto.* 转发。

import {
  constants as cryptoConstants,
  createCipheriv,
  createDecipheriv,
  createHash,
  publicEncrypt,
  randomBytes as nodeRandomBytes,
} from "node:crypto";

/** 原语结果:成功为字符串;失败为 { error }(绝不抛异常)。 */
export type CryptoResult = string | { error: string };

/** AES 加密入参(枚举值严格校验)。 */
export type AesEncryptOpts = {
  mode: "cbc" | "ecb" | "gcm";
  data: string;
  key: string;
  iv?: string;
  dataEncoding?: "utf8" | "base64" | "hex";
  keyEncoding?: "utf8" | "base64" | "hex";
  ivEncoding?: "utf8" | "base64" | "hex";
  outputEncoding?: "base64" | "hex";
};

/** AES 解密入参(输出恒为 utf8 明文)。 */
export type AesDecryptOpts = {
  mode: "cbc" | "ecb" | "gcm";
  data: string;
  key: string;
  iv?: string;
  dataEncoding?: "utf8" | "base64" | "hex";
  keyEncoding?: "utf8" | "base64" | "hex";
  ivEncoding?: "utf8" | "base64" | "hex";
};

/** RSA 加密入参。 */
export type RsaEncryptOpts = {
  data: string;
  publicKey: string;
  padding?: "pkcs1" | "none";
  dataEncoding?: "utf8" | "base64" | "hex";
  outputEncoding?: "hex" | "base64";
};

/** host.crypto 暴露的原语集合。 */
export interface PluginCrypto {
  md5(input: string): CryptoResult;
  sha1(input: string): CryptoResult;
  sha256(input: string): CryptoResult;
  randomBytes(len: number): CryptoResult;
  aesEncrypt(opts: AesEncryptOpts): CryptoResult;
  aesDecrypt(opts: AesDecryptOpts): CryptoResult;
  rsaEncrypt(opts: RsaEncryptOpts): CryptoResult;
}

const AES_KEY_BYTES = 16; // aes-128
const CBC_IV_BYTES = 16;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const GCM_MIN_BYTES = GCM_IV_BYTES + GCM_TAG_BYTES; // 28
const RSA_NONE_BLOCK_BYTES = 128; // 1024-bit 公钥块(上游固定 Buffer.alloc(128))
const RANDOM_MIN_BYTES = 1;
const RANDOM_MAX_BYTES = 1024;

const INPUT_ENCODINGS = ["utf8", "base64", "hex"] as const;
const OUTPUT_ENCODINGS = ["base64", "hex"] as const;

/** 构造错误信封。 */
function err(message: string): { error: string } {
  return { error: message };
}

/** 判定返回值是否为错误信封。 */
function isErr(value: unknown): value is { error: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { error?: unknown }).error === "string"
  );
}

/** 是否普通对象(排除 null / 数组)。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 描述异常信息(用于错误信封,绝不外抛)。 */
function describe(e: unknown): string {
  if (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string") {
    return String((e as { message: string }).message);
  }
  return String(e);
}

/**
 * 按指定编码把字符串解码为 Buffer。非法编码 / 非法字面量返回 { error }。
 * - hex:必须为偶数长度且仅含 [0-9a-fA-F](Buffer.from 对非法 hex 会静默截断,故先校验)。
 * - base64:必须为 4 的倍数且仅含标准字母表(Buffer.from 对非法 base64 同样宽松)。
 */
function decodeField(value: unknown, encoding: unknown, field: string): Buffer | { error: string } {
  if (typeof value !== "string") return err(`${field} 必须是字符串`);
  if (!(INPUT_ENCODINGS as readonly unknown[]).includes(encoding)) {
    return err(`未知的 ${field}Encoding: ${String(encoding)}`);
  }
  if (encoding === "utf8") return Buffer.from(value, "utf8");
  if (encoding === "hex") {
    if (value.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(value)) {
      return err(`${field} 不是合法的 hex 字符串`);
    }
    return Buffer.from(value, "hex");
  }
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    return err(`${field} 不是合法的 base64 字符串`);
  }
  return Buffer.from(value, "base64");
}

/** 摘要族:输入强制字符串化(与既有 host.crypto.md5 行为一致),恒返回小写 hex。 */
function digest(algo: "md5" | "sha1" | "sha256", input: unknown): string {
  return createHash(algo).update(String(input ?? "")).digest("hex");
}

/**
 * AES 加密。
 * - cbc/ecb 走 aes-128-cbc / aes-128-ecb(iv 必须 16 字节;ecb 忽略 iv)。
 * - gcm 走 aes-128-gcm,输出 [12B IV]‖[ct]‖[16B tag](与上游逐字节对齐)。
 */
function aesEncrypt(opts: AesEncryptOpts): CryptoResult {
  try {
    if (!isPlainObject(opts)) return err("aesEncrypt: 参数必须是对象");
    const mode = opts.mode;
    if (mode !== "cbc" && mode !== "ecb" && mode !== "gcm") {
      return err(`aesEncrypt: 未知 mode(${String(mode)}),仅支持 cbc / ecb / gcm`);
    }
    const dataEncoding = opts.dataEncoding ?? "utf8";
    const keyEncoding = opts.keyEncoding ?? "utf8";
    const ivEncoding = opts.ivEncoding ?? "utf8";
    const outputEncoding = opts.outputEncoding ?? "base64";
    if (!(OUTPUT_ENCODINGS as readonly unknown[]).includes(outputEncoding)) {
      return err(`aesEncrypt: 未知 outputEncoding(${String(outputEncoding)}),仅支持 base64 / hex`);
    }

    const dataBuf = decodeField(opts.data, dataEncoding, "data");
    if (isErr(dataBuf)) return dataBuf;
    const keyBuf = decodeField(opts.key, keyEncoding, "key");
    if (isErr(keyBuf)) return keyBuf;
    if (keyBuf.length !== AES_KEY_BYTES) {
      return err(`aesEncrypt: aes-128 key 必须 ${AES_KEY_BYTES} 字节(实际 ${keyBuf.length})`);
    }

    if (mode === "ecb") {
      const cipher = createCipheriv("aes-128-ecb", keyBuf, null);
      const out = Buffer.concat([cipher.update(dataBuf), cipher.final()]);
      return out.toString(outputEncoding);
    }

    if (mode === "cbc") {
      const ivBuf = decodeField(opts.iv ?? "", ivEncoding, "iv");
      if (isErr(ivBuf)) return ivBuf;
      if (ivBuf.length !== CBC_IV_BYTES) {
        return err(`aesEncrypt: cbc iv 必须 ${CBC_IV_BYTES} 字节(实际 ${ivBuf.length})`);
      }
      const cipher = createCipheriv("aes-128-cbc", keyBuf, ivBuf);
      const out = Buffer.concat([cipher.update(dataBuf), cipher.final()]);
      return out.toString(outputEncoding);
    }

    // gcm:① 输出布局 [12B IV]‖[ct]‖[16B authTag]
    let ivBuf: Buffer;
    if (opts.iv === undefined || opts.iv === "") {
      ivBuf = nodeRandomBytes(GCM_IV_BYTES);
    } else {
      const decoded = decodeField(opts.iv, ivEncoding, "iv");
      if (isErr(decoded)) return decoded;
      if (decoded.length !== GCM_IV_BYTES) {
        return err(`aesEncrypt: gcm iv 必须 ${GCM_IV_BYTES} 字节(实际 ${decoded.length})`);
      }
      ivBuf = decoded;
    }
    const cipher = createCipheriv("aes-128-gcm", keyBuf, ivBuf, { authTagLength: GCM_TAG_BYTES });
    const ct = Buffer.concat([cipher.update(dataBuf), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([ivBuf, ct, tag]).toString(outputEncoding);
  } catch (e) {
    return err("aesEncrypt 失败: " + describe(e));
  }
}

/**
 * AES 解密,恒返回 utf8 明文。
 * - gcm 入参布局与 aesEncrypt 一致:[12B IV]‖[ct]‖[16B tag],总长须 ≥ 28 字节。
 */
function aesDecrypt(opts: AesDecryptOpts): CryptoResult {
  try {
    if (!isPlainObject(opts)) return err("aesDecrypt: 参数必须是对象");
    const mode = opts.mode;
    if (mode !== "cbc" && mode !== "ecb" && mode !== "gcm") {
      return err(`aesDecrypt: 未知 mode(${String(mode)}),仅支持 cbc / ecb / gcm`);
    }
    const dataEncoding = opts.dataEncoding ?? "utf8";
    const keyEncoding = opts.keyEncoding ?? "utf8";
    const ivEncoding = opts.ivEncoding ?? "utf8";

    const inputBuf = decodeField(opts.data, dataEncoding, "data");
    if (isErr(inputBuf)) return inputBuf;
    const keyBuf = decodeField(opts.key, keyEncoding, "key");
    if (isErr(keyBuf)) return keyBuf;
    if (keyBuf.length !== AES_KEY_BYTES) {
      return err(`aesDecrypt: aes-128 key 必须 ${AES_KEY_BYTES} 字节(实际 ${keyBuf.length})`);
    }

    if (mode === "ecb") {
      const decipher = createDecipheriv("aes-128-ecb", keyBuf, null);
      return Buffer.concat([decipher.update(inputBuf), decipher.final()]).toString("utf8");
    }

    if (mode === "cbc") {
      const ivBuf = decodeField(opts.iv ?? "", ivEncoding, "iv");
      if (isErr(ivBuf)) return ivBuf;
      if (ivBuf.length !== CBC_IV_BYTES) {
        return err(`aesDecrypt: cbc iv 必须 ${CBC_IV_BYTES} 字节(实际 ${ivBuf.length})`);
      }
      const decipher = createDecipheriv("aes-128-cbc", keyBuf, ivBuf);
      return Buffer.concat([decipher.update(inputBuf), decipher.final()]).toString("utf8");
    }

    // gcm:从密文头部切出 IV,尾部 16 字节为 authTag
    if (inputBuf.length < GCM_MIN_BYTES) {
      return err(`aesDecrypt: gcm 密文不足 ${GCM_MIN_BYTES} 字节(12B IV + 16B tag)`);
    }
    const ivBuf = inputBuf.subarray(0, GCM_IV_BYTES);
    const tag = inputBuf.subarray(inputBuf.length - GCM_TAG_BYTES);
    const ct = inputBuf.subarray(GCM_IV_BYTES, inputBuf.length - GCM_TAG_BYTES);
    const decipher = createDecipheriv("aes-128-gcm", keyBuf, ivBuf, { authTagLength: GCM_TAG_BYTES });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch (e) {
    return err("aesDecrypt 失败: " + describe(e));
  }
}

/**
 * RSA 加密。
 * - padding:"none"(②)= 左补 0x00 到 128 字节后 RSA_NO_PADDING(复刻上游,补零由宿主做)。
 * - padding:"pkcs1"(默认)= RSA_PKCS1_PADDING。
 */
function rsaEncrypt(opts: RsaEncryptOpts): CryptoResult {
  try {
    if (!isPlainObject(opts)) return err("rsaEncrypt: 参数必须是对象");
    const padding = opts.padding ?? "pkcs1";
    if (padding !== "pkcs1" && padding !== "none") {
      return err(`rsaEncrypt: 未知 padding(${String(padding)}),仅支持 pkcs1 / none`);
    }
    const dataEncoding = opts.dataEncoding ?? "utf8";
    const outputEncoding = opts.outputEncoding ?? "hex";
    if (outputEncoding !== "hex" && outputEncoding !== "base64") {
      return err(`rsaEncrypt: 未知 outputEncoding(${String(outputEncoding)}),仅支持 hex / base64`);
    }
    if (typeof opts.publicKey !== "string" || opts.publicKey.length === 0) {
      return err("rsaEncrypt: publicKey 必须是非空 PEM 字符串");
    }

    const dataBuf = decodeField(opts.data, dataEncoding, "data");
    if (isErr(dataBuf)) return dataBuf;

    if (padding === "none") {
      if (dataBuf.length > RSA_NONE_BLOCK_BYTES) {
        return err(
          `rsaEncrypt: padding:"none" 时 data 不得超过 ${RSA_NONE_BLOCK_BYTES} 字节(实际 ${dataBuf.length})`
        );
      }
      const padded = Buffer.alloc(RSA_NONE_BLOCK_BYTES);
      dataBuf.copy(padded, RSA_NONE_BLOCK_BYTES - dataBuf.length);
      const out = publicEncrypt(
        { key: opts.publicKey, padding: cryptoConstants.RSA_NO_PADDING },
        padded
      );
      return out.toString(outputEncoding);
    }

    const out = publicEncrypt(
      { key: opts.publicKey, padding: cryptoConstants.RSA_PKCS1_PADDING },
      dataBuf
    );
    return out.toString(outputEncoding);
  } catch (e) {
    return err("rsaEncrypt 失败: " + describe(e));
  }
}

/** 构造沙箱脚本可用的密码学原语集合(三个消费方共用同一实现)。 */
export function createPluginCrypto(): PluginCrypto {
  return {
    md5: (input: string): CryptoResult => digest("md5", input),
    sha1: (input: string): CryptoResult => digest("sha1", input),
    sha256: (input: string): CryptoResult => digest("sha256", input),
    randomBytes: (len: number): CryptoResult => {
      if (typeof len !== "number" || !Number.isInteger(len)) {
        return err("randomBytes: len 必须是整数");
      }
      if (len < RANDOM_MIN_BYTES || len > RANDOM_MAX_BYTES) {
        return err(
          `randomBytes: len 必须在 ${RANDOM_MIN_BYTES}..${RANDOM_MAX_BYTES} 之间(实际 ${String(len)})`
        );
      }
      return nodeRandomBytes(len).toString("hex");
    },
    aesEncrypt,
    aesDecrypt,
    rsaEncrypt,
  };
}
