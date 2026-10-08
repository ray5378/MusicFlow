// ==================== host.crypto 密码学原语 KAT + 契约测试 ====================
//
// pluginCrypto.ts 是宿主侧 host.crypto 的**唯一实现源**(discovery.ts / sandboxWorker.ts
// 直接注入;主线程沙箱 sandbox.ts 逐方法转发)。本测试用**已知答案**(KAT)锁定逐字节协议,
// 因为插件侧 QQ/网易云的签名必须与上游 multiPlatformMusicApi 逐字节一致——
// 任何「差不多」的实现漂移都会让签名在真实平台上被拒,且极难定位。
//
// 覆盖:
//   1. 契约形状:createPluginCrypto() 恰好导出 7 个原语。
//   2. 摘要族 KAT:md5 / sha1 / sha256 空串 + "abc"(标准向量)。
//   3. AES-128 KAT:ECB / CBC(NIST SP800-38A)+ GCM(NIST test case 2)+ gcm 输出布局。
//   4. RSA KAT:padding "none" 左补零到 128 字节(固定公钥 → 固定密文)。
//   5. randomBytes 边界。
//   6. 错误信封:非法枚举/长度/编码一律返回 { error },绝不抛异常(hostSync 语义)。
import { describe, it, expect } from "vitest";
import { createPluginCrypto } from "../../src/plugins/pluginCrypto.js";

const crypto = createPluginCrypto();

/** 断言成功返回字符串并取值。 */
function ok(v: unknown): string {
  expect(typeof v, `期望字符串,实际 ${JSON.stringify(v)}`).toBe("string");
  return v as string;
}
/** 断言返回错误信封 { error },返回其消息。 */
function err(v: unknown): string {
  expect(v, "期望 { error } 信封").toBeTruthy();
  expect(typeof v, "错误信封必须是对象").toBe("object");
  const e = (v as { error?: unknown }).error;
  expect(typeof e, "错误信封须含字符串 error").toBe("string");
  return e as string;
}
/** 断言函数调用不抛异常(hostSync 语义:失败也返回信封,不抛)。 */
function notThrow(fn: () => unknown): unknown {
  let out: unknown;
  expect(() => { out = fn(); }).not.toThrow();
  return out;
}

// ---- 摘要族标准向量 ----
const MD5_EMPTY = "d41d8cd98f00b204e9800998ecf8427e";
const MD5_ABC = "900150983cd24fb0d6963f7d28e17f72";
const SHA1_EMPTY = "da39a3ee5e6b4b0d3255bfef95601890afd80709";
const SHA1_ABC = "a9993e364706816aba3e25717850c26c9cd0d89d";
const SHA256_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const SHA256_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

// ---- AES-128(NIST SP800-38A F.1.1 ECB / F.2.1 CBC + GCM test case 2)----
const AES_KEY_HEX = "2b7e151628aed2a6abf7158809cf4f3c";
const AES_PT_HEX = "6bc1bee22e409f96e93d7e117393172a";
// 含默认 PKCS7 填充块(明文恰 16B → 密文 32B;首块 = NIST 向量)。
const AES_ECB_CT_HEX = "3ad77bb40d7a3660a89ecaf32466ef97a254be88e037ddd9d79fb6411c3f9df8";
const AES_CBC_IV_HEX = "000102030405060708090a0b0c0d0e0f";
const AES_CBC_CT_HEX = "7649abac8119b246cee98e9b12e9197d8964e0b149c10b7b682e6e39aaeb731c";

// GCM:K=0^16, P=0^16, IV=0^12 → C / Tag 固定;输出布局 = IV‖C‖Tag。
const GCM_KEY_HEX = "00000000000000000000000000000000";
const GCM_IV_HEX = "000000000000000000000000";
const GCM_PT_HEX = "00000000000000000000000000000000";
const GCM_CT_HEX = "0388dace60b6a392f328c2b971b2fe78";
const GCM_TAG_HEX = "ab6e47d42cec13bdf53a67b21257bddf";
const GCM_LAYOUT_HEX = GCM_IV_HEX + GCM_CT_HEX + GCM_TAG_HEX;
const GCM_LAYOUT_B64 = "AAAAAAAAAAAAAAAAA4jazmC2o5LzKMK5cbL+eKtuR9Qs7BO99TpnshJXvd8=";

// ---- RSA:固定 1024-bit 公钥 + padding "none" 的已知输出(数据 "hello-rsa-none")----
const RSA_PUB = [
  "-----BEGIN PUBLIC KEY-----",
  "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDmhu10mWCyBrpQkMF36Pq/MCHb",
  "L6EbS9WL8nRnea9FrksxijV+dVgNGELWy9FnhIkxezfgiOawDUNcIezO0i8RsCT+",
  "BwD0gdBKfskzt+iLbE52gKQng7GhoHqCheBOvnW6bkDRFDqbo5NlkEuOy+vEZyw+",
  "HSNh00TUxnQsTcR20QIDAQAB",
  "-----END PUBLIC KEY-----",
].join("\n");
const RSA_NONE_HEX =
  "278ab47c5905a0b6ed5f981403a9a74ccb5a997344c4067369b562f26252204c" +
  "495bc9e46182ec9dcc996e316b294bdd791d400643daef5d1f79bbd925021b48" +
  "5e824cf352a80cf1d3077a58bf30571e48deeb79a38b6dabf6d98cf63bd037f8" +
  "89b0ca4dea51698ee84adaadb339ab57f7e08ad8262cac36389cae6eb670a339";

describe("pluginCrypto · 契约形状", () => {
  it("恰好导出 10 个原语", () => {
    expect(Object.keys(crypto).sort()).toEqual(
      [
        "aesDecrypt", "aesEncrypt", "base64Decode", "base64Encode", "md5",
        "randomBytes", "rsaEncrypt", "sha1", "sha256", "utf8Decode",
      ].sort()
    );
  });
});

describe("pluginCrypto · 摘要族 KAT", () => {
  it("md5 空串 / abc", () => {
    expect(ok(crypto.md5(""))).toBe(MD5_EMPTY);
    expect(ok(crypto.md5("abc"))).toBe(MD5_ABC);
  });
  it("sha1 空串 / abc", () => {
    expect(ok(crypto.sha1(""))).toBe(SHA1_EMPTY);
    expect(ok(crypto.sha1("abc"))).toBe(SHA1_ABC);
  });
  it("sha256 空串 / abc", () => {
    expect(ok(crypto.sha256(""))).toBe(SHA256_EMPTY);
    expect(ok(crypto.sha256("abc"))).toBe(SHA256_ABC);
  });
  it("输出恒为小写 hex", () => {
    expect(ok(crypto.md5("ABC"))).toBe(ok(crypto.md5("ABC")).toLowerCase());
  });
});

describe("pluginCrypto · AES-128 KAT(ECB/CBC/GCM)", () => {
  it("ECB 加密(hex 输出,含 PKCS7 填充块)", () => {
    const out = ok(crypto.aesEncrypt({
      mode: "ecb", data: AES_PT_HEX, key: AES_KEY_HEX,
      dataEncoding: "hex", keyEncoding: "hex", outputEncoding: "hex",
    }));
    expect(out).toBe(AES_ECB_CT_HEX);
  });
  it("ECB 解密回明文(utf8;解密恒返回 utf8 明文)", () => {
    // 注意:aesDecrypt 契约恒返回 utf8 明文,故此处用 UTF-8 安全明文做往返;
    // NIST 那份二进制明文无法无损穿过 utf8 字符串(非法字节会变 U+FFFD)。
    const ct = ok(crypto.aesEncrypt({ mode: "ecb", data: "hello-ecb-16byte", key: AES_KEY_HEX, keyEncoding: "hex" }));
    const out = ok(crypto.aesDecrypt({ mode: "ecb", data: ct, key: AES_KEY_HEX, keyEncoding: "hex", dataEncoding: "base64" }));
    expect(out).toBe("hello-ecb-16byte");
  });
  it("CBC 加密(NIST IV)", () => {
    const out = ok(crypto.aesEncrypt({
      mode: "cbc", data: AES_PT_HEX, key: AES_KEY_HEX, iv: AES_CBC_IV_HEX,
      dataEncoding: "hex", keyEncoding: "hex", ivEncoding: "hex", outputEncoding: "hex",
    }));
    expect(out).toBe(AES_CBC_CT_HEX);
  });
  it("CBC 往返", () => {
    const ct = ok(crypto.aesEncrypt({ mode: "cbc", data: "hello-cbc", key: "0123456789abcdef", iv: "abcdef0123456789" }));
    // aesEncrypt 默认输出 base64 → 解密侧须显式声明 dataEncoding(decrypt 的 data 默认 utf8)。
    const out = ok(crypto.aesDecrypt({ mode: "cbc", data: ct, key: "0123456789abcdef", iv: "abcdef0123456789", dataEncoding: "base64" }));
    expect(out).toBe("hello-cbc");
  });
  it("GCM 布局 = [12B IV]‖[ct]‖[16B tag],与 NIST 向量逐字节一致(hex + base64)", () => {
    const hex = ok(crypto.aesEncrypt({
      mode: "gcm", data: GCM_PT_HEX, key: GCM_KEY_HEX, iv: GCM_IV_HEX,
      dataEncoding: "hex", keyEncoding: "hex", ivEncoding: "hex", outputEncoding: "hex",
    }));
    expect(hex).toBe(GCM_LAYOUT_HEX);
    const b64 = ok(crypto.aesEncrypt({
      mode: "gcm", data: GCM_PT_HEX, key: GCM_KEY_HEX, iv: GCM_IV_HEX,
      dataEncoding: "hex", keyEncoding: "hex", ivEncoding: "hex",
    }));
    expect(b64).toBe(GCM_LAYOUT_B64);
  });
  it("GCM 解密回明文(自动头部切 IV / 尾部切 tag)", () => {
    const out = ok(crypto.aesDecrypt({ mode: "gcm", data: GCM_LAYOUT_B64, key: GCM_KEY_HEX, keyEncoding: "hex", dataEncoding: "base64" }));
    expect(Buffer.from(out, "utf8").toString("hex")).toBe(GCM_PT_HEX);
  });
  it("GCM 省略 IV → 宿主生成 12 字节随机 IV 并前置,可自解密", () => {
    const ct = ok(crypto.aesEncrypt({ mode: "gcm", data: "random-iv", key: "0123456789abcdef" }));
    const raw = Buffer.from(ct, "base64");
    expect(raw.length).toBeGreaterThanOrEqual(28); // 12(IV) + 明文长度 + 16(tag)
    const out = ok(crypto.aesDecrypt({ mode: "gcm", data: ct, key: "0123456789abcdef", dataEncoding: "base64" }));
    expect(out).toBe("random-iv");
  });
});

describe("pluginCrypto · RSA KAT(padding none 左补零 128)", () => {
  it("padding:'none' 复刻上游 RSA_NO_PADDING(固定公钥 → 固定密文)", () => {
    const out = ok(crypto.rsaEncrypt({ data: "hello-rsa-none", publicKey: RSA_PUB, padding: "none", outputEncoding: "hex" }));
    expect(out).toBe(RSA_NONE_HEX);
  });
  it("padding 默认 pkcs1,输出 1024-bit(256 hex),且与 none 不同", () => {
    const out = ok(crypto.rsaEncrypt({ data: "hello", publicKey: RSA_PUB }));
    expect(out).toMatch(/^[0-9a-f]{256}$/);
    expect(out).not.toBe(RSA_NONE_HEX);
  });
  it("padding:'none' 时 data 超过 128 字节 → 错误", () => {
    err(crypto.rsaEncrypt({ data: "x".repeat(129), publicKey: RSA_PUB, padding: "none" }));
  });
});

describe("pluginCrypto · randomBytes 边界", () => {
  it("合法范围返回对应长度的 hex", () => {
    expect(ok(crypto.randomBytes(1))).toMatch(/^[0-9a-f]{2}$/);
    expect(ok(crypto.randomBytes(16))).toMatch(/^[0-9a-f]{32}$/);
    expect(ok(crypto.randomBytes(1024))).toMatch(/^[0-9a-f]{2048}$/);
  });
  it("两次调用结果不同(真随机)", () => {
    expect(ok(crypto.randomBytes(16))).not.toBe(ok(crypto.randomBytes(16)));
  });
  it("越界 / 非整数 → 错误", () => {
    err(crypto.randomBytes(0));
    err(crypto.randomBytes(1025));
    err(crypto.randomBytes(2.5));
    err(crypto.randomBytes("8" as unknown as number));
  });
});

describe("pluginCrypto · 错误信封(绝不抛异常)", () => {
  const badCases: Array<[string, () => unknown]> = [
    ["aesEncrypt 未知 mode", () => crypto.aesEncrypt({ mode: "xyz" as never, data: "a", key: "0123456789abcdef" })],
    ["aesEncrypt key 长度非 16", () => crypto.aesEncrypt({ mode: "ecb", data: "a", key: "short" })],
    ["aesEncrypt hex data 非法", () => crypto.aesEncrypt({ mode: "ecb", data: "zz", key: AES_KEY_HEX, dataEncoding: "hex", keyEncoding: "hex" })],
    ["aesEncrypt base64 data 非法", () => crypto.aesEncrypt({ mode: "ecb", data: "!!!notb64", key: AES_KEY_HEX, dataEncoding: "base64", keyEncoding: "hex" })],
    ["aesEncrypt 未知 outputEncoding", () => crypto.aesEncrypt({ mode: "ecb", data: "a", key: "0123456789abcdef", outputEncoding: "utf8" as never })],
    ["aesEncrypt 未知 dataEncoding(decodeField 拒绝)", () => crypto.aesEncrypt({ mode: "ecb", data: "a", key: "0123456789abcdef", dataEncoding: "bogus" as never })],
    ["aesEncrypt gcm iv 长度非 12 字节", () => crypto.aesEncrypt({ mode: "gcm", data: "a", key: "0123456789abcdef", iv: "001122", ivEncoding: "hex" })],
    ["aesEncrypt cbc iv 长度非 16 字节", () => crypto.aesEncrypt({ mode: "cbc", data: "a", key: "0123456789abcdef", iv: "short" })],
    ["aesEncrypt cbc 缺 iv", () => crypto.aesEncrypt({ mode: "cbc", data: "a", key: "0123456789abcdef" })],
    ["aesEncrypt 非对象入参", () => crypto.aesEncrypt(null as never)],
    ["aesDecrypt gcm 密文过短", () => crypto.aesDecrypt({ mode: "gcm", data: "AAAA", key: "0123456789abcdef" })],
    ["aesDecrypt 未知 mode", () => crypto.aesDecrypt({ mode: "des" as never, data: "a", key: "0123456789abcdef" })],
    ["aesDecrypt key 长度非 16", () => crypto.aesDecrypt({ mode: "ecb", data: "a", key: "short" })],
    ["aesDecrypt cbc iv 长度非 16 字节", () => crypto.aesDecrypt({ mode: "cbc", data: "a", key: "0123456789abcdef", iv: "short" })],
    ["rsaEncrypt 未知 outputEncoding", () => crypto.rsaEncrypt({ data: "a", publicKey: RSA_PUB, outputEncoding: "utf8" as never })],
    ["aesDecrypt 非对象入参", () => crypto.aesDecrypt(undefined as never)],
    ["rsaEncrypt 未知 padding", () => crypto.rsaEncrypt({ data: "a", publicKey: RSA_PUB, padding: "boom" as never })],
    ["rsaEncrypt 空 publicKey", () => crypto.rsaEncrypt({ data: "a", publicKey: "" })],
    ["rsaEncrypt 非 PEM publicKey", () => crypto.rsaEncrypt({ data: "a", publicKey: "not-a-pem" })],
    ["rsaEncrypt 非对象入参", () => crypto.rsaEncrypt("nope" as never)],
    ["base64Encode 非法 hex 输入", () => crypto.base64Encode("zz", { inputEncoding: "hex" })],
    ["base64Encode 未知 inputEncoding", () => crypto.base64Encode("a", { inputEncoding: "utf16" as never })],
    ["base64Encode latin1 含 >0xFF 码点", () => crypto.base64Encode("汉字", { inputEncoding: "latin1" })],
    ["base64Encode 非对象 opts", () => crypto.base64Encode("a", "x" as never)],
    ["base64Decode 非法 base64", () => crypto.base64Decode("!!!")],
    ["base64Decode 长度 %4==1", () => crypto.base64Decode("Q")],
    ["base64Decode 未知 outputEncoding", () => crypto.base64Decode("QQ==", { outputEncoding: "utf8" as never })],
    ["base64Decode 非字符串 input", () => crypto.base64Decode(5 as never)],
    ["utf8Decode 非法 UTF-8 序列", () => crypto.utf8Decode("\u00ff\u00fe")],
    ["utf8Decode 非法 hex", () => crypto.utf8Decode("zz", { inputEncoding: "hex" })],
    ["utf8Decode 未知 inputEncoding", () => crypto.utf8Decode("a", { inputEncoding: "base64" as never })],
    ["utf8Decode 非字符串 input", () => crypto.utf8Decode(null as never)],
  ];
  for (const [name, fn] of badCases) {
    it(`${name} → { error }(不抛)`, () => {
      const v = notThrow(fn);
      err(v);
    });
  }
});

describe("pluginCrypto · base64 / UTF-8 原语 KAT(纯字符串出入参)", () => {
  it("base64Encode 默认 utf8 → base64(带 padding)", () => {
    expect(ok(crypto.base64Encode("hello"))).toBe("aGVsbG8=");
    expect(ok(crypto.base64Encode("AB"))).toBe("QUI=");
  });
  it("base64Encode latin1 / hex 输入编码", () => {
    expect(ok(crypto.base64Encode("\u0000\u00ff", { inputEncoding: "latin1" }))).toBe("AP8=");
    expect(ok(crypto.base64Encode("00ff", { inputEncoding: "hex" }))).toBe("AP8=");
  });
  it("base64Decode 默认 latin1(每字符一字节,同 atob 语义)/ hex", () => {
    const s = ok(crypto.base64Decode("AP8="));
    expect(s.length).toBe(2);
    expect(s.charCodeAt(0)).toBe(0x00);
    expect(s.charCodeAt(1)).toBe(0xff);
    expect(ok(crypto.base64Decode("AP8=", { outputEncoding: "hex" }))).toBe("00ff");
  });
  it("base64Decode 容忍空白、接受 unpadded", () => {
    expect(ok(crypto.base64Decode(" QQ == "))).toBe("A");
    expect(ok(crypto.base64Decode("QQ"))).toBe("A");
    expect(ok(crypto.base64Decode("QUI"))).toBe("AB");
  });
  it("base64Encode/Decode padded 环回:len%3==1 与 %3==2 至少各一条", () => {
    for (const n of [1, 2, 4, 5, 7, 8]) {
      let s = "";
      for (let i = 0; i < n; i++) s += String.fromCharCode((i * 61 + n) & 0xff);
      const b64 = ok(crypto.base64Encode(s, { inputEncoding: "latin1" }));
      expect(b64.endsWith("="), `len=${n} 应为 padded base64`).toBe(true);
      expect(b64, `len=${n} 与 Node 参考`).toBe(Buffer.from(s, "latin1").toString("base64"));
      expect(ok(crypto.base64Decode(b64)), `len=${n} 环回`).toBe(s);
    }
    // 显式各留一条锚点用例(%3==1 → 2 个 =;%3==2 → 1 个 =)
    expect(ok(crypto.base64Encode("ABCD", { inputEncoding: "latin1" }))).toBe("QUJDRA==");
    expect(ok(crypto.base64Encode("ABCDE", { inputEncoding: "latin1" }))).toBe("QUJDREU=");
  });
  it("utf8Decode latin1(默认)/ hex → 正确解码多字节字符", () => {
    const latin1 = "\u00e4\u00bd\u00a0\u00e5\u00a5\u00bd"; // "你好" 的 UTF-8 字节按 latin1 表达
    expect(ok(crypto.utf8Decode(latin1))).toBe("你好");
    expect(ok(crypto.utf8Decode("e4bda0e5a5bd", { inputEncoding: "hex" }))).toBe("你好");
    expect(ok(crypto.utf8Decode("plain"))).toBe("plain");
  });
  it("utf8Decode 保留 BOM(与 Buffer.toString('utf8') 一致,不做静默剥离)", () => {
    expect(ok(crypto.utf8Decode("\u00ef\u00bb\u00bf"))).toBe("\ufeff");
  });
  it("与 Node Buffer 参考逐字节一致(latin1 语义,长度 0..9)", () => {
    for (let n = 0; n <= 9; n++) {
      let s = "";
      for (let i = 0; i < n; i++) s += String.fromCharCode((i * 29 + 7) & 0xff);
      const b64 = ok(crypto.base64Encode(s, { inputEncoding: "latin1" }));
      expect(b64).toBe(Buffer.from(s, "latin1").toString("base64"));
      expect(ok(crypto.base64Decode(b64))).toBe(Buffer.from(b64, "base64").toString("latin1"));
    }
  });
});
