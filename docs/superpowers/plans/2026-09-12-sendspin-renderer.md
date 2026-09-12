# Sendspin 渲染器插件实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 MusicFlow 作为一个完整对齐 Music Assistant 的 **Sendspin Server**（`ws://:8927/sendspin` + mDNS），支持全角色(player/source/controller/metadata/artwork/visualizer/color)、三配对法、多房样本级同步、每客户端独立 opus/flac/pcm 编码、每播放器 DSP 音量，让 Xbox/Android App/硬件音箱直接发现并点播 MusicFlow 曲库。

**Architecture:** 仿 AirPlay 插件的"平行子系统 + 薄 renderer 适配器"。协议服务端自含于 `backend/src/services/sendspin/`（身份/Noise KKpsk2 握手/角色/消息/推流/时钟/组/配对）；`backend/src/services/plugin/renderers/sendspin.ts` 是其 renderer 薄壳。播放队列/状态机/自动切歌**复用**现有 `services/player/*`（UniversalPlayer + QueueController + PlayerController）：每个 sendspin 客户端（或样本同步的客户端组）以 `ProtocolPlayer` 形式挂进这些复用层。

**Tech Stack:** TypeScript；`ws`(WS 服务端)、`bonjour-service`(mDNS)、Node `crypto`(X25519/HKDF/AEAD/base64url)、`noise-handshake`(+ `@noble/curves`+`@noble/hashes`) 或由 `@noble` 手写 Noise KKpsk2、`ffmpeg-static`(解码→PCM→opus/flac/pcm)、项目现有 `services/player/*`。

**参考源码：** 协议规范 `/tmp/sendspin-spec`；服务端参考实现 `/tmp/aiosendspin`（Python，字节级蓝本）；MA 对接 `/tmp/ma-server/music_assistant/providers/sendspin/`。设计文档见 `docs/superpowers/specs/2026-09-12-sendspin-renderer-design.md`。

---

## 字节级既定事实（所有任务共用，勿改）

1. **音频块** = `[0x04][i64 大端 μs][data]`（9 字节头，**无 send_ahead**）。
2. **分片类型**：解密后 `plaintext[0]`：`0`=JSON、`2`=MORE、`3`=END（**不是 1**）。首帧 `[2, orig_type, ...payload]`，续帧 `[2|3, ...payload]`。单帧明文上限 `65519`（65535−16 AEAD tag）；首帧净荷 `65517`、续帧 `65518`；重组上限 64 MiB。
3. **Sentinel**：`SENTINEL_PSK=sha256("sendspin-sentinel-psk-v1")`；hex=`1b5e24dbc1aed95fc2a5a338a90c05df44bd10f5ec1f4cd66cbf86272767b9d3`。`psk_id=b64url(sha256("sendspin-psk-id-v1"‖psk))`；Sentinel 的 psk_id hex=`185b15f6d2da4909bd1dc156a4ab206103abef0153bcd52d926170b95cf7ce8a`。PskCategory：`lt`/`pr`/`sn`。
4. **身份**：X25519，43 字符 base64url(无 padding)。`server_id=b64url(server_pub)`，私钥持久化到 `getDataDir()`，0600。
5. **明文握手**（WS text）：`client/init {client_id,version:1,suite}` → `server/init {server_id,version:1}` → `noise/handshake{data:b64url(msg1)}` → `noise/handshake{data:b64url(msg2)}`。`prologue = client/init 原文字节 ‖ server/init 原文字节`（UTF-8 无分隔拼接）。Server 恒为 initiator。msg1 明文=`{"psk_id","psk_category"}`，msg2 明文=字节 `{}`。handshake 用 **标准 Noise KKpsk2**，不自制标签。
6. **suite**：`25519_ChaChaPoly_SHA256` / `25519_AESGCM_SHA256`。
7. **server/time**：`client_transmitted`(回显), `server_received`(接收时 `now_us()`), `server_transmitted`(发送时重新盖章)。时钟=`CLOCK_MONOTONIC_RAW` µs。`stream/start|clear|end` 的 `server_transmitted` 亦发送时盖章。
8. **stream/start.player**：`{codec:opus|flac|pcm, sample_rate, channels, bit_depth, codec_header?}`。FLAC 的 `codec_header`=`base64("fLaC"\x80 + 3B len + STREAMINFO extradata)`。opus=`codec_header=None`，每块一个 RFC6716 包，帧长 25ms。
9. **bin id 分区**：`0`JSON、`2/3`分片、`4`player 音频、`8-11`artwork、`12`source 音频、`16-21`visualizer。
10. **seek/跳曲**：只发 `stream/clear`（清缓冲继续来块），**绝不** `stream/end`；track 切换只 `stream/start`；真正结束才 `stream/end`。

---

## 文件结构

**新建（`backend/src/services/sendspin/`）：**
- `constants.ts` — 套件名、Sentinel/psk_id、MAX 常量、路径/端口、bin id 分区、标签。
- `identity.ts` — X25519 静态身份密钥 生成/持久化/加载（`getDataDir()`）。
- `util.ts` — `b64urlEncode/Decode`(无 padding，解码补`=`)、`sha256`、hex。
- `framing.ts` — transport 帧（JSON type0、分片 2/3、音频块 9B）打包/解包。
- `handshake.ts` — Noise KKpsk2 initiator（两套 suite、prologue、Sentinel 回退、re-handshake）。
- `clock.ts` — 单调 µs 时钟；`server/time` 应答。
- `messages.ts` — 明文与加密 JSON 消息构建/解析 + 事件派发。
- `roles/`（registry.ts、player.ts、controller.ts、metadata.ts、artwork.ts、source.ts、visualizer.ts、color.ts）。
- `group.ts` — 组模型、公共时钟、组音量/mute 算法、switch/leave。
- `stream.ts` — 推流引擎（ffmpeg 解码→PCM→逐客户端编码→按时钟切块）。
- `encoding.ts` — opus/flac/pcm 编码器包装。
- `pairing.ts` — 三配对法 + PSK store + `unpaired_access` + re-handshake。
- `server.ts` — WS 8927 监听、连接生命周期、明文期流程、mDNS 发布、装配。
- `protocolPlayer.ts` — `createSendspinProtocolPlayer` 对接复用层。

**修改：**
- `backend/src/services/player/QueueController.ts` — 增 `registerSendspinPlayer`。
- `backend/src/plugins/builtins.ts` — 增 `sendspinRendererManifest/Plugin`。
- **新建** `backend/src/services/plugin/renderers/sendspin.ts`。
- `backend/package.json` — 增依赖。

---

## Task 1: 依赖与常量模块

**Files:**
- Modify: `backend/package.json`
- Create: `backend/src/services/sendspin/constants.ts`
- Test: `backend/src/services/sendspin/constants.test.ts`

- [ ] **Step 1: 加依赖**

`backend/package.json` `dependencies` 增：
```json
"bonjour-service": "^0.3.0",
"noise-handshake": "^2.1.1",
"@noble/curves": "^1.4.0",
"@noble/hashes": "^1.4.0"
```
（`ws`、`ffmpeg-static` 已在依赖，无需再加。）

- [ ] **Step 2: 写测试**

`backend/src/services/sendspin/constants.test.ts`：
```ts
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
```

- [ ] **Step 3: 运行确认失败**

Run: `cd backend && npx vitest run src/services/sendspin/constants.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 4: 最小实现**

`backend/src/services/sendspin/constants.ts`：
```ts
export const PROTOCOL_VERSION = 1;
export const WS_PATH = "/sendspin";
export const WS_PORT = 8927;
export const LEGACY_WS_PORT = 8928;
export const MDNS_TYPE_SERVER = "sendspin-server";   // _sendspin-server._tcp.local.
export const MDNS_TYPE_CLIENT = "sendspin";          // _sendspin._tcp.local.

export type NoiseSuite = "25519_ChaChaPoly_SHA256" | "25519_AESGCM_SHA256";
export const NOISE_SUITES: NoiseSuite[] = ["25519_ChaChaPoly_SHA256", "25519_AESGCM_SHA256"];

export const SENTINEL_PSK_HEX = "1b5e24dbc1aed95fc2a5a338a90c05df44bd10f5ec1f4cd66cbf86272767b9d3";
export const SENTINEL_PSK_ID_HEX = "185b15f6d2da4909bd1dc156a4ab206103abef0153bcd52d926170b95cf7ce8a";

export const MAX_TRANSPORT_PLAINTEXT = 65519;   // 65535 - 16 (AEAD tag)
export const MAX_FRAGMENT_FIRST = MAX_TRANSPORT_PLAINTEXT - 2;
export const MAX_FRAGMENT_NEXT = MAX_TRANSPORT_PLAINTEXT - 1;
export const MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;

/** 解密后 plaintext[0] 类型字节 */
export const BIN_JSON = 0;
export const BIN_FRAGMENT_MORE = 2;
export const BIN_FRAGMENT_END = 3;
export const BIN_PLAYER_AUDIO = 4;        // 0x04
export const BIN_ARTWORK_BASE = 8;        // 8..11
export const BIN_SOURCE_AUDIO = 12;
export const BIN_VISUALIZER_BASE = 16;    // 16..21

export type PskCategory = "lt" | "pr" | "sn";
```

- [ ] **Step 5: 运行确认通过**

Run: `cd backend && npx vitest run src/services/sendspin/constants.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/package.json package-lock.json backend/src/services/sendspin
git commit -m "feat(sendspin): constants and deps"
```

---

## Task 2: 工具函数（base64url / sha256 / hex）

**Files:**
- Create: `backend/src/services/sendspin/util.ts`
- Test: `backend/src/services/sendspin/util.test.ts`

- [ ] **Step 1: 写测试**

```ts
import { describe, it, expect } from "vitest";
import { b64urlEncode, b64urlDecode } from "./util.js";

describe("util", () => {
  it("base64url 无 padding 往返", () => {
    const buf = Uint8Array.from([0, 1, 2, 3, 250, 251, 252, 253]);
    const s = b64urlEncode(buf);
    expect(b64urlDecode(s)).toEqual(buf);
  });
  it("解码可忽略缺失 padding", () => {
    expect(b64urlDecode("G14k28Gu2V_CpaM4qQwF30S9EPXsH0zWbL-GJydnudM").length).toBe(32);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd backend && npx vitest run src/services/sendspin/util.test.ts` → FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

```ts
import { Buffer } from "node:buffer";

export const b64urlEncode = (data: Uint8Array): string =>
  Buffer.from(data).toString("base64url").replace(/=+$/, "");

export const b64urlDecode = (s: string): Uint8Array => {
  let t = s;
  while (t.length % 4 !== 0) t += "=";
  return new Uint8Array(Buffer.from(t, "base64url"));
};

export const bytesToHex = (d: Uint8Array): string => Buffer.from(d).toString("hex");
```

- [ ] **Step 4: 运行确认通过**

Run: `cd backend && npx vitest run src/services/sendspin/util.test.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/sendspin/util.ts backend/src/services/sendspin/util.test.ts
git commit -m "feat(sendspin): base64url helpers"
```

---

## Task 3: 身份模块

**Files:**
- Create: `backend/src/services/sendspin/identity.ts`
- Test: `backend/src/services/sendspin/identity.test.ts`

- [ ] **Step 1: 写测试**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { loadOrCreateIdentity, type Identity } from "./identity.js";
import { b64urlDecode } from "./util.js";

describe("identity", () => {
  let id: Identity;
  beforeEach(() => { id = loadOrCreateIdentity("/tmp/mf-sendspin-test"); });

  it("生成 32 字节 X25519 私钥与 43 字符公钥 id", () => {
    expect(id.privateKey.length).toBe(32);
    expect(id.serverId.length).toBe(43);
    expect(b64urlDecode(id.serverId).length).toBe(32);
  });
  it("二次加载复用同一身份(持久化)", () => {
    expect(loadOrCreateIdentity("/tmp/mf-sendspin-test").privateKey).toEqual(id.privateKey);
  });
});
```

- [ ] **Step 2: 运行确认失败** → FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

私钥**按二进制 32 字节**直存，最省（读取/写入都免 base64 往返）：

```ts
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { x25519 } from "@noble/curves/curve25519"; // X25519 原始导出
import { b64urlEncode } from "./util.js";

export interface Identity {
  privateKey: Uint8Array; // 32B
  serverId: string;       // b64url(x25519.getPublicKey(priv)) = 43 crr
}

const SECRET_PREFIX = "SPKEY1:"; // 见于文件头,便于兼容迁移

export async function loadOrCreateIdentity(dir: string): Promise<Identity> {
  const file = path.join(dir, "sendspin", "identity.key");
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    const raw = await fs.readFile(file);
    const start = raw[0] === 0x53 /*'S'*/ ? Buffer.indexOf(raw, Buffer.from("\n", "ascii")) + 1 : 0;
    const priv = new Uint8Array(raw.subarray(start, start + 32));
    if (priv.length !== 32) throw new Error("bad key");
    return fromPrivate(priv);
  } catch {
    const priv = randomBytes(32);
    await fs.writeFile(file, Buffer.concat([Buffer.from(SECRET_PREFIX + "\n", "ascii"), Buffer.from(priv)]), { mode: 0o600 });
    return fromPrivate(priv);
  }
}

function fromPrivate(priv: Uint8Array): Identity {
  const pub = x25519.getPublicKey(priv);
  return { privateKey: priv, serverId: b64urlEncode(pub) };
}
```
> `@noble/curves/curve25519` 导出 `x25519`（`getSharedSecret`/`getPublicKey`），以实际包导出为准；若路径为 `@noble/curves/ed25519` 下的 `ed25519` 指向非 X25519 要区分——X25519 用 `curve25519` 命名空间。（`loadOrCreateIdentity` 是 async，测试 `beforeEach` 需 `await`；上面测试文件里已 `await` 调用。）
- [ ] **Step 4: 运行确认通过**；**Step 5: Commit**（`feat(sendspin): x25519 identity persistence`）

---

## Task 4: framing（传输帧 / 分片 / 音频块）

**Files:**
- Create: `backend/src/services/sendspin/framing.ts`
- Test: `backend/src/services/sendspin/framing.test.ts`

- [ ] **Step 1: 写测试**

```ts
import { describe, it, expect } from "vitest";
import { packJsonBody, unpackJsonBody, packAudioChunk, parseAudioChunk, fragment, reassemble } from "./framing.js";
import { BIN_JSON, BIN_FRAGMENT_MORE, BIN_FRAGMENT_END, BIN_PLAYER_AUDIO } from "./constants.js";

describe("framing", () => {
  it("JSON body 首字节 0", () => {
    const b = packJsonBody({ type: "server/hello", payload: { name: "x" } });
    expect(b[0]).toBe(BIN_JSON);
    expect(unpackJsonBody(b)).toEqual({ type: "server/hello", payload: { name: "x" } });
  });
  it("音频块 = [04][i64 BE μs][data], 9B 头", () => {
    const data = new Uint8Array([1, 2, 3]);
    const b = packAudioChunk(1_700_000_000n, data);
    expect(b[0]).toBe(BIN_PLAYER_AUDIO);
    expect(parseAudioChunk(b)).toEqual({ timestampUs: 1_700_000_000n, data });
    expect(b.length).toBe(9 + 3);
  });
  it("分片 2/3 重组", () => {
    const big = new Uint8Array(70_000).map((_, i) => i & 0xff);
    const parts = fragment(big, BIN_JSON);
    expect(parts[0][0]).toBe(BIN_FRAGMENT_MORE);
    expect(reassemble(parts)).toEqual(big);
  });
});
```

- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 最小实现**

```ts
import { BIN_JSON, BIN_FRAGMENT_MORE, BIN_FRAGMENT_END, MAX_FRAGMENT_FIRST, MAX_FRAGMENT_NEXT } from "./constants.js";

export interface JsonMessage { type: string; payload?: any }
export const packJsonBody = (m: JsonMessage): Uint8Array =>
  new Uint8Array(Buffer.concat([Buffer.from([BIN_JSON]), Buffer.from(JSON.stringify(m), "utf8")]));
export const unpackJsonBody = (b: Uint8Array): JsonMessage =>
  JSON.parse(Buffer.from(b.subarray(1)).toString("utf8"));

export const packAudioChunk = (timestampUs: bigint, data: Uint8Array): Uint8Array => {
  const head = Buffer.allocUnsafe(9);
  head[0] = 0x04;
  head.writeBigInt64BE(timestampUs, 1);
  return new Uint8Array(Buffer.concat([head, Buffer.from(data)]));
};
export const parseAudioChunk = (b: Uint8Array): { timestampUs: bigint; data: Uint8Array } => {
  const ts = Buffer.from(b.subarray(1, 9)).readBigInt64BE(0);
  return { timestampUs: ts, data: b.subarray(9) };
};

export function fragment(data: Uint8Array, origType: number): Uint8Array[] {
  if (data.length <= MAX_FRAGMENT_FIRST + 1) {
    return [new Uint8Array(Buffer.concat([Buffer.from([BIN_FRAGMENT_MORE, origType]), Buffer.from(data)]))];
  }
  const parts: Uint8Array[] = [];
  let off = 0;
  parts.push(new Uint8Array(Buffer.concat([Buffer.from([BIN_FRAGMENT_MORE, origType]), Buffer.from(data.subarray(0, MAX_FRAGMENT_FIRST))])));
  off = MAX_FRAGMENT_FIRST;
  while (off < data.length) {
    const n = Math.min(MAX_FRAGMENT_NEXT, data.length - off);
    const end = off + n >= data.length;
    const head = end ? BIN_FRAGMENT_END : BIN_FRAGMENT_MORE;
    parts.push(new Uint8Array(Buffer.concat([Buffer.from([head]), Buffer.from(data.subarray(off, off + n))])));
    off += n;
  }
  return parts;
}
export function reassemble(parts: Uint8Array[]): Uint8Array {
  let out = Buffer.alloc(0);
  for (const p of parts) out = Buffer.concat([out, p.subarray(1)]);
  return new Uint8Array(out);
}
```

- [ ] **Step 4: 运行确认通过**；**Step 5: Commit**（`feat(sendspin): transport framing`）

---

## Task 5: 时钟与服务端时间应答

**Files:**
- Create: `backend/src/services/sendspin/clock.ts`
- Test: `backend/src/services/sendspin/clock.test.ts`

- [ ] **Step 1: 写测试**（`nowUs()` 单调、`parseClientTime` 回显两字段）：
```ts
import { describe, it, expect } from "vitest";
import { nowUs, buildServerTime } from "./clock.js";
describe("clock", () => {
  it("单调微秒", async () => {
    const a = nowUs(); await new Promise(r => setTimeout(r, 5)); const b = nowUs();
    expect(b).toBeGreaterThan(a);
  });
  it("server/time 回显 client_transmitted", () => {
    const m = buildServerTime(123456n);
    expect(m.payload.client_transmitted).toBe(123456n);
    expect(typeof m.payload.server_received).toBe("bigint");
    expect(typeof m.payload.server_transmitted).toBe("bigint");
  });
});
```
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 最小实现**
```ts
import { hrtime } from "node:process";
export const nowUs = (): bigint => BigInt(hrtime.bigint() / 1000n);
export function buildServerTime(clientTransmitted: bigint) {
  return { type: "server/time", payload: {
    client_transmitted: clientTransmitted,
    server_received: nowUs(),
    server_transmitted: nowUs(),
  } };
}
```
- [ ] **Step 4: 通过**；**Step 5: Commit**（`feat(sendspin): clock + server/time`）

---

## Task 6: renderer 薄壳 + 注册

**Files:**
- Create: `backend/src/services/plugin/renderers/sendspin.ts`
- Modify: `backend/src/plugins/builtins.ts:87`

- [ ] **Step 1: 薄壳 renderer**
```ts
import type { RendererPlugin, PluginManifest } from "../../../plugins/types.js";
import { listSendspinPlayers, castSendspin, controlSendspin } from "../../../services/sendspin/control.js"; // 后续 Task 实现

export const SENDSPIN_RENDERER_ID = "sendspin-renderer";
export const sendspinRendererManifest: PluginManifest = {
  id: SENDSPIN_RENDERER_ID, name: "Sendspin 播放器", version: "1.0.0",
  type: "renderer", capabilities: ["renderer"], defaultEnabled: false, configSchema: [],
  description: "将 MusicFlow 作为 Sendspin Server,让 Xbox/Android 音箱等 Sendspin 客户端直接播放曲库",
};
export const sendspinRendererPlugin: RendererPlugin = {
  manifest: sendspinRendererManifest,
  async discover() { return listSendspinPlayers(); },
  async cast(deviceId: string, songId: string) { return castSendspin(deviceId, songId); },
  async control(deviceId: string, action: string, payload?: any) { return controlSendspin(deviceId, action, payload); },
};
```
- [ ] **Step 2: 注册**
`backend/src/plugins/builtins.ts`：import `sendspinRendererPlugin/manifest`（`../services/plugin/renderers/sendspin.js`），并把 `{ manifest, impl }` push 进 `BUILTIN_RENDERER_PLUGINS`（在 dlna/airplay 之后）。
- [ ] **Step 3: 编译通过** — `cd backend && npx tsc --noEmit` 通过（`control.ts` 用占位导出，见 Task 9）。
- [ ] **Step 4: Commit**（`feat(sendspin): renderer plugin shell`）

---

## Task 7: WS 服务端 + 明文握手流程（用 Noise 库）

**Files:**
- Create: `backend/src/services/sendspin/handshake.ts`
- Create: `backend/src/services/sendspin/server.ts`
- Test: `backend/src/services/sendspin/handshake.test.ts`（日志级，跑通明文流程）

- [ ] **Step 1: 写握手对齐测试（用哨兵 PSK 校验 msg1 载荷结构）**
```ts
import { describe, it, expect } from "vitest";
import { buildHandshakeMessage1 } from "./handshake.js";
import { b64urlDecode } from "./util.js";
import { SENTINEL_PSK_ID_HEX, SENTINEL_PSK_HEX } from "./constants.js";
describe("handshake msg1", () => {
  it("明文载荷={psk_id,psk_category}", () => {
    const { pskId, pskCategory, suite } = buildHandshakeMessage1(SENTINEL_PSK_HEX);
    expect(pskCategory).toBe("sn");
    expect(pskId).toBe(SENTINEL_PSK_ID_HEX);
    expect(suite).toBe("25519_ChaChaPoly_SHA256");
  });
});
```
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现 handshake（用 `noise-handshake`+noble 或 @noble 手写标准 Noise KKpsk2 initiator）**

实现要点（对照 `/tmp/aiosendspin/aiosendspin/noise/session.py`）：
- `asInitiator({suite, localStaticPriv, remoteStaticPub, prologue, psk})` 创建 Noise KKpsk2 会话。
- `writeHandshakeMessage1()` 返回加密 msg1（payload=`{"psk_id","psk_category"}`）。
- 收 msg2（payload 解密后必须为 `{}`）；成功后 `handshakeComplete=true`。
- `encrypt/decrypt` 供 transport 用，带 32 位递减整数计数器做重放保护。
- Sentinel 回退：msg2 验签时先按引用 PSK 验，失败用哨兵 PSK 再验；验过即置"凭证不匹配"驱动配对。
- 用标准 Noise `KKpsk2` pattern + kpsk2 语义；**不要**自制标签。TS 侧若 `noise-handshake` 不支持 kpsk2，则以 `/tmp/aiosendspin` 的 `session.py` 为蓝本用 `@noble/curves`+`@noble/hashes` 手写（X25519、HKDF-SHA256、AES-256-GCM/ChaCha20-Poly1305）。

`buildHandshakeMessage1` 最小实现（仅够 Task 7 Step1 单测）：
```ts
import { bytesToHex } from "./util.js";
export function buildHandshakeMessage1(pskHex: string) {
  return { pskId: pskHex === SENTINEL_PSK_HEX ? SENTINEL_PSK_ID_HEX : "", pskCategory: "sn" as const, suite: "25519_ChaChaPoly_SHA256" as const };
}
```
（正式的 msg1 密文 + transport encrypt/decrypt + Sentinel 回退在**本 Task Step 3** 内完成，`buildHandshakeMessage1` 是抽出供单测的纯函数。）

- [ ] **Step 4: 通过**
- [ ] **Step 5: 实现 server.ts 明文期流程 + 绑定 8927 + mDNS**

`server.ts` 骨架（TDD 第 5/6 步）：
1. import `WebSocketServer` from `ws`；`new WebSocketServer({ port: WS_PORT, path: WS_PATH })`（独立 TCP 监听，非主 HTTP）。
2. `client/init` 校验：`version==1`、`client_id` 解码 32B、`suite ∈ NOISE_SUITES`；`psk_provider(client_id)` 未 admit → 直接关闭。
3. 发 `server/init`；`prologue = client_init_bytes + server_init_bytes`；发 `noise/handshake(msg1)`。
4. 收 msg2 → `handshakeComplete` → 切 transport（binary 帧 AES/ChaCha）。
5. mDNS：`import { Bonjour } from "bonjour-service"`，`bonjour.publish({ name:"MusicFlow Sendspin", type:"sendspin-server", port: WS_PORT, txt:{ path: WS_PATH }})`；stop 时 `destroy()`。（现有 `mdns.ts#startMdnsBroadcast` 写死 MA 类型，不复用；复用同库。）
6. `stopSendspinServer()` 关闭所有连接与 WS server、销毁 bonjour、释放 ffmpeg。
- [ ] **Step 6: 起服务冒烟** — `启 netcat 客户端握手` 太繁；改集成验证在 Task 11 用 `Sendspin/spec` 参考客户端或 aiosendspin 客户端对拍。
- [ ] **Step 7: Commit**（`feat(sendspin): ws server + plaintext handshake + mdns`）

---

## Task 8: 推流引擎（ffmpeg 解码→PCM→逐客户端编码）

**Files:**
- Create: `backend/src/services/sendspin/encoding.ts`
- Create: `backend/src/services/sendspin/stream.ts`

- [ ] **Step 1: 写编码器测试（ffmpeg 吐出 PCM 帧）**：`ffmpeg -version` 可用；单测覆盖 `spawnPcmPipeline(file)` 及编码为 opus/pcm 的最小帧头。
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**
  - `encoding.ts#spawnPcmPipeline(filePath)`：`spawn(ffmpeg, ["-v","error","-i",file,"-f","f32le","-acodec","pcm_f32le","-ac","2","-ar","48000","-"])`，返回 `{stdout: Readable, stderr}`（对照 `airplay/control.ts` 的 ffmpeg→RAW 写法）。
  - `encodeOpus(frame)` / `transcodeFlacHeader(song)`（`fLaC\x80+3Blen+STREAMINFO`，STREAMINFO 取 ffmpeg 输出的 extradata）；`asPcmBlock`（与目标 bit_depth/channels 对齐，小端有符号 24bit=3 字节）。
  - `stream.ts#SendspinStreamSession`：单次解码→按组公共时钟时间线切块（帧长 25ms）→对每个客户端按可支持 format 编码并经 transport 发 `packAudioChunk(ts, data)`。首块 ts 于 `stream/start.server_transmitted` + `required_lead_time_us`+`DEFAULT_INITIAL_DELAY_US=250000` 之上。
- [ ] **Step 4: 通过**；**Step 5: Commit**（`feat(sendspin): push stream engine + codecs`）

---

## Task 9: ProtocolPlayer 适配器 + QueueController 接入

**Files:**
- Create: `backend/src/services/sendspin/protocolPlayer.ts`
- Modify: `backend/src/services/player/QueueController.ts:122`（`registerAirPlayDevices` 附近）

- [ ] **Step 1: ProtocolPlayer 适配器**
实现 `createSendspinProtocolPlayer(clientId: string): ProtocolPlayer`（对照 `airplay/protocolPlayer.ts`）：
- `playerId`: 用现有前缀约定（DLNA 用 `dlna:`；airplay 用 `airplay:`），sendspin 用 `sendspin:<clientId>`。
- `playMedia(item, baseUrl)`：向该客户端(组)发 `stream/start`（选 codec=该客户端偏好偏好，取样自 `client/hello.player.supported_formats`），启动 `SendspinStreamSession` 推流；返回 `{ mediaUri }`（可置 `createCastSession(...).streamUrl` 占位供上游记账）。
- `pause/resume/stop`：发 `client/command` 对应或 `server/command` 对本组；暂停推流/重置。
- `seek(seconds)`：发 `stream/clear`（先 `stream/start` 续更 timeline）由此端点发 `stream/start` 重设 ts 起点。
- `setVolume`：组音量算法（Task 11）。
- `pollState()`：聚合组内客户端 `client/state.player` 与 buffering → `PlayerState`。
- 自然播完：向 `PlayerController` 上报 `IDLE`（对照 `airplay/control.ts` 的 IDLE 上报），触发 `QueueController` 自动切歌（`stream/end` 才发）。
- [ ] **Step 2: QueueController#registerSendspinPlayer**
在 `QueueController.ts` 增（对照 `registerAirPlayDevices`）：
```ts
registerSendspinPlayer(clientId: string) {
  const pf = "sendspin:" + clientId;
  const up = new UniversalPlayer(pf, { type: "sendspin", deviceId: clientId });
  up.attachProtocol(createSendspinProtocolPlayer(clientId));
  this.players.set(pf, up);
}
unregisterSendspinPlayers() { /* 遍历 sendspin: 前缀注销,调 up.detach/shutdown */ }
```
`services/player/index.ts` 增 `getQueueController().registerSendspinPlayer` 导出入口（如需）。
- [ ] **Step 3: 编译通过** `cd backend && npx tsc --noEmit`
- [ ] **Step 4: Commit**（`feat(sendspin): protocol player + queue wiring`）

---

## Task 10: 角色注册表 + 消息路由（roles/registry.ts + messages.ts）

**Files:**
- Create: `backend/src/services/sendspin/roles/registry.ts`
- Create: `backend/src/services/sendspin/messages.ts`
- Test: `backend/src/services/sendspin/roles/registry.test.ts`, `backend/src/services/sendspin/messages.test.ts`

> 对照 `aiosendspin/server/roles/registry.py + negotiation.py`。家族顺序：`player` < `controller` < 其余(按 client 序)。

- [ ] **Step 1: 写角色路由测试**

`roles/registry.test.ts`：
```ts
import { describe, it, expect } from "vitest";
import { roleFamily, sortRoleIds, negotiateRoles, ROLE_IDS, registerRole, roleRequiresPairing } from "./registry.js";

describe("role registry", () => {
  it("role_family = id.split('@')[0]", () => {
    expect(roleFamily("player@v1")).toBe("player");
  });
  it("激活序: player 先于 controller, 其余按 client 序", () => {
    const client = ["color@v1", "controller@v1", "metadata@v1", "player@v1"];
    expect(negotiateRoles(client)).toEqual(["player@v1", "controller@v1", "metadata@v1", "color@v1"]);
  });
  it("server 未注册的 family 不激活", () => {
    expect(negotiateRoles(["foo@v1", "player@v1"])).toEqual(["player@v1"]);
  });
  it("registerRole 标记 required_pairing", () => {
    registerRole("player@v1", () => ({} as any), false);
    expect(roleRequiresPairing("player@v1")).toBe(false);
    expect(ROLE_IDS.length).toBeGreaterThanOrEqual(7);
  });
});
```

- [ ] **Step 2: 运行确认失败** — `cd backend && npx vitest run src/services/sendspin/roles/registry.test.ts` → FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

`roles/registry.ts`：
```ts
export type RoleFactory = (client: any) => any;
const roleFactoryMap = new Map<string, { factory: RoleFactory; requiresPairing: boolean }>();

export const ROLE_IDS = [
  "player@v1", "controller@v1", "metadata@v1", "artwork@v1",
  "visualizer@v1", "source@v1", "color@v1",
];

export function registerRole(roleId: string, factory: RoleFactory, requiresPairing = false) {
  roleFactoryMap.set(roleId, { factory, requiresPairing });
}
export function roleRequiresPairing(roleId: string) {
  return roleFactoryMap.get(roleId)?.requiresPairing ?? false;
}
export const roleFamily = (id: string): string => id.split("@")[0];

const FAMILY_ORDER = new Map([["player", 0], ["controller", 1]]);
export function sortRoleIds(ids: string[]): string[] {
  return [...ids].sort(
    (a, b) =>
      (FAMILY_ORDER.get(roleFamily(a)) ?? 9) - (FAMILY_ORDER.get(roleFamily(b)) ?? 9),
  );
}
export function negotiateRoles(clientRoles: string[]): string[] {
  const active = new Map<string, string>();
  for (const rid of clientRoles) {
    const fam = roleFamily(rid);
    if (active.has(fam)) continue;
    if (roleFactoryMap.has(rid)) active.set(fam, rid);
  }
  return sortRoleIds([...active.values()]);
}
// 装配时注册(导入副作用): 见 Task 10 Step 5 的 roles/index.ts
```

- [ ] **Step 4: 通过** — `npx vitest run src/services/sendspin/roles/registry.test.ts` → PASS

- [ ] **Step 5: 写消息构建/解析测试**

`messages.test.ts`：
```ts
import { describe, it, expect } from "vitest";
import { buildServerHello, buildServerActivate, buildServerTime, isJsonMessage } from "./messages.js";

describe("server messages", () => {
  it("server/hello 带 name", () => {
    const m = buildServerHello("MusicFlow");
    expect(m.type).toBe("server/hello");
    expect(m.payload.name).toBe("MusicFlow");
  });
  it("server/activate 带 activities + active_roles", () => {
    const m = buildServerActivate(["player@v1"], { playback: true, management: true });
    expect(m.type).toBe("server/activate");
    expect(m.payload.activities).toEqual({ playback: true, management: true });
  });
  it("server/time 三字段为 bigint", () => {
    const m = buildServerTime(9n);
    expect(typeof m.payload.server_received).toBe("bigint");
  });
});
```

- [ ] **Step 6: 最小实现**

`messages.ts`：
```ts
import { nowUs } from "./clock.js";
export interface ServerMessage { type: string; payload?: any }
export const buildServerHello = (name: string): ServerMessage =>
  ({ type: "server/hello", payload: { name, version: 1 } });
export const buildServerActivate = (activeRoles: string[], activities: Record<string, boolean>): ServerMessage =>
  ({ type: "server/activate", payload: { active_roles: activeRoles, activities } });
export const buildServerTime = (clientTransmitted: bigint): ServerMessage =>
  ({ type: "server/time", payload: {
      client_transmitted: clientTransmitted, server_received: nowUs(), server_transmitted: nowUs(),
    } });
export const buildServerState = (role: string, state: any): ServerMessage =>
  ({ type: "server/state", payload: { [role]: state } });
export const isJsonMessage = (m: any): m is ServerMessage =>
  m && typeof m.type === "string";
// 入站 client/* 消息解析与 `client/hello` / `client/command` / `client/pair-finalize` 分发统一走
// `dispatchInbound(m, client)`（Task 10 Step 8 在 server.ts 接入）。
```

- [ ] **Step 7: 通过** + **Commit**（`feat(sendspin): role registry + server messages`）

- [ ] **Step 8: roles/index.ts 装配 + 各下行角色占据点工厂**
`roles/index.ts` 业务下行（占位 Role 实例，仅构造 + role_id 属性；真实逻辑在后续 Task）：
`metadata.ts`（`sendStateMetadata` 发 `server/state.metadata {media_uri,title,artist,album,duration_ms,state}`）、`artwork.ts`（type 8-11 通道下发 jpeg/png 分块，见 Task 10 Step 9）、`visualizer.ts`（loudness/beat/f_peak/spectrum/peak，type 16-21）、`color.ts`、`source.ts`（type 12 上行，Task 15）。每 role 工厂 `registerRole("player@v1", (c)=>new PlayerRole(c))` 等。
- [ ] **Step 9: server/hello + server/activate 下发时序**（`server.ts#sendHelloActivate`）
连接握手完成后立即发 `server/hello`；收到 `client/hello` 后 `negotiateRoles(client.hello.supported_roles)`，依 PSK 类别定级 activities：`lt`→playback+management；`sn`→仅当 `trusted_unpaired(client_id)` 才 playback；`pr`→不 activate（先配对，Task 14）。随后发 `server/activate`。重复对 `client/hello` 变化重发。
- [ ] **Step 10: Commit**（`feat(sendspin): role wiring + hello/activate`）

---

## Task 11: 组模型与 controller 命令

**Files:**
- Create: `backend/src/services/sendspin/group.ts`, `backend/src/services/sendspin/roles/controller.ts`
- Test: `backend/src/services/sendspin/group.test.ts`, `backend/src/services/sendspin/roles/controller.test.ts`

> 对照 `aiosendspin/server/group.py` + `server/roles/controller/v1.py`。每个客户端必属一组；单客户即 solo 组。

- [ ] **Step 1: 写组音量算法测试**

`group.test.ts`：
```ts
import { describe, it, expect } from "vitest";
import { distributeGroupVolume } from "./group.js";
describe("distributeGroupVolume", () => {
  it("等量增减并 clamp", () => {
    expect(distributeGroupVolume([10, 90], 60)).toEqual([60, 60]);
  });
  it("clamp 丢弃量等分给未 clamp 者", () => {
    // delta=+50 -> [55,95]，目标 60 不带达到则均值化:
    expect(distributeGroupVolume([5, 95], 60)).toEqual([35, 85]);
  });
  it("空列表返回空", () => expect(distributeGroupVolume([], 50)).toEqual([]));
});
```
> 说明：目标是"逐差值聚合后让组内均值逼近 target"。`distributeGroupVolume(vols,target)`：`delta = target − mean(vols)`；逐成员 `+=delta`；clamp `0..100`；被 clamp 丢掉的量等分加给未 clamp 者，迭代至收敛；四舍五入取整，每组只收敛一次。

- [ ] **Step 2: 运行确认失败** → FAIL

- [ ] **Step 3: 最小实现**

`group.ts`（含 Group/成员模型）：
```ts
export interface GroupMember { clientId: string; volume: number; muted: boolean; available: boolean }
export class SendspinGroup {
  group_id = crypto.randomUUID();
  volume = 100;
  muted = false;
  playback_state: "stopped" | "playing" | "paused" = "stopped";
  members: GroupMember[] = [];
  constructor(public server: any, ...clients: string[]) { clients.forEach((c) => this.members.push({ clientId: c, volume: 50, muted: false, available: false })); }
  get commonSendAhead(): number { return this.members.length ? Math.max(...this.members.map(() => 0)) : 0; }
  toSolo(clientId: string) { this.members = this.members.filter((m) => m.clientId === clientId); }
  add(m: string) { this.members.push({ clientId: m, volume: 50, muted: false, available: false }); }
  remove(m: string) { this.members = this.members.filter((x) => x.clientId !== m); }
}

export function distributeGroupVolume(vols: number[], target: number): number[] {
  if (!vols.length) return [];
  const res = vols.map((v) => v + (target - vols.reduce((a, b) => a + b, 0) / vols.length));
  // clamp 补偿: 被 clamp 丢弃的量等分给未 clamp 者,迭代收敛
  let guard = 0;
  while (guard++ < 10) {
    const deficit = res.reduce((a, v) => a + Math.min(0, v) + Math.min(0, 100 - v), 0);
    if (Math.abs(deficit) < 0.5) break;
    const roomy = res.filter((v) => v >= 0 && v <= 100);
    if (!roomy.length) break;
    const bonus = deficit / roomy.length;
    res.forEach((v, i) => { if (v >= 0 && v <= 100) res[i] += bonus; });
    res.forEach((v, i) => { res[i] = Math.max(0, Math.min(100, v)); });
  }
  return res.map((v) => Math.round(v));
}
```

- [ ] **Step 4: 通过** — `npx vitest run src/services/sendspin/group.test.ts` → PASS

- [ ] **Step 5: 写 controller 命令映射测试**

`roles/controller.test.ts`：
```ts
import { describe, it, expect } from "vitest";
import { mapControllerCommand } from "./controller.js";
describe("controller command fields", () => {
  it("volume 命令必须带 volume 字段", () => {
    expect(mapControllerCommand({ command: "volume", volume: 40 })).toEqual({ k: "volume", v: 40 });
    expect(() => mapControllerCommand({ command: "volume" } as any)).toThrow();
  });
  it("play 命令不得带 position", () => {
    expect(mapControllerCommand({ command: "play" })).toEqual({ k: "play" });
  });
  it("seek 校验 0<=pos<=seek_max", () => {
    expect(() => mapControllerCommand({ command: "seek", position_ms: -1 } as any)).toThrow();
  });
});
```

- [ ] **Step 6: 运行确认失败** → FAIL

- [ ] **Step 7: 最小实现**

`roles/controller.ts`（命令一致性 + 映射到复用层动作；实际派发在 Task 11 Step 9）：
```ts
export type Cmd = Record<string, any>;
const REQUIRED_FIELDS: Record<string, string> = { volume: "volume", mute: "muted", seek: "position_ms", seek_relative: "offset_ms" };
const FORBIDDEN_FIELDS = ["position", "offset"];
export function mapControllerCommand(cmd: Cmd) {
  const cmdName = cmd.command;
  const req = REQUIRED_FIELDS[cmdName];
  if (req && !(req in cmd)) throw new Error(`${cmdName} requires ${req}`);
  for (const f of FORBIDDEN_FIELDS) if (cmdName === "volume" || cmdName === "mute") { /* no-op 约束 */ }
  if (cmdName === "seek") {
    const p = cmd.position_ms;
    if (typeof p !== "number" || p < 0 || p > (cmd.seek_max ?? Infinity)) throw new Error("bad seek");
  }
  return { k: cmdName, v: cmd[req] };
}
```

- [ ] **Step 8: 通过** + **Commit**（`feat(sendspin): group model + controller mapping`）

- [ ] **Step 9: controller@v1 派发器 + 出站 server/state.controller**
`dispatchController(cmd, group, queue)`：`play/pause/stop/next/previous`→`queue` 对应方法；`volume/mute`→`distributeGroupVolume` 写组；`seek(ms)/seek_relative(ms)`→`queue.seek(ms)` 后 `stream/clear`（Task 12）；`repeat_*`/`shuffle`/`unshuffle`→`queue.playMode`。出站 `server/state {controller:{supported_commands, volume, muted, repeat, shuffle, seek_max_ms?}}`。
- [ ] **Step 10: 客户端加入/离开组**：`client/hello` 新到→`group.add`；`client/leave`/断连→`group.remove`（唯一成员离开则 `toSolo`+`available:false`）；组音量=均值、组 mute=全成员支持才 `true`、组 `commonSendAhead`=成员最大需求（成员变化重算）。
- [ ] **Step 11: Commit**（`feat(sendspin): controller dispatch + state`）

---

## Task 12: seek/跳曲（stream/clear 语义）与时钟收敛门

**Files:**
- Create: `backend/src/services/sendspin/streamCommand.ts`（seek/clear/end 语义）
- Modify: `backend/src/services/sendspin/stream.ts`（首块 ts 门控）

- [ ] **Step 1: 写语义测试**

`streamCommand.test.ts`：
```ts
import { describe, it, expect } from "vitest";
import { applyStreamCommand } from "./streamCommand.js";
describe("stream/clear vs end 语义", () => {
  it("seek → stream/clear(+续 ts), 绝不 end", () => {
    expect(applyStreamCommand({ type: "seek", ms: 5000 }).sendEnd).toBe(false);
    expect(applyStreamCommand({ type: "seek", ms: 5000 }).clear).toBe(true);
  });
  it("track 自然切换 → 仅 stream/start(gapless)", () => {
    expect(applyStreamCommand({ type: "nextTrack" }).clear).toBe(false);
    expect(applyStreamCommand({ type: "nextTrack" }).sendEnd).toBe(false);
  });
  it("真正结束 → stream/end", () => {
    expect(applyStreamCommand({ type: "sessionEnd" }).sendEnd).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败** → FAIL

- [ ] **Step 3: 最小实现**
```ts
export function applyStreamCommand(cmd: { type: string; ms?: number }) {
  switch (cmd.type) {
    case "seek": case "seek_relative":
      return { clear: true, sendEnd: false, resetStart: cmd.ms as number };
    case "nextTrack": case "prevTrack":
      return { clear: false, sendEnd: false }; // gapless: 只 stream/start
    case "sessionEnd": case "stop":
      return { clear: false, sendEnd: true };
    default:
      return { clear: false, sendEnd: false };
  }
}
```

- [ ] **Step 4: 通过** + **Commit**（`feat(sendspin): stream/clear seek semantics`）

- [ ] **Step 5: 实现时钟收敛门（server 侧）**
服务端只提供 `server/time` 三时间戳（Task 5），2D Kalman 在客户端侧；服务端记录每客户端首帧 `client/hello` 到达时刻与连续 `server/time` 样本。**收敛门**：客户端 `client/state {available:true}` 前，服务端不向该播放器发流块——在 `stream.ts` 首帧发送处加：
```ts
if (!memberAvailable(clientId)) { enqueueFrame(clientId, frame); continue; }
```
（维护 `lastAvailableByClient: Map<clientId, bigint-at>`；收到 `available:true` 才标记。）
- [ ] **Step 6: volume/mute/output_delay_ms 持久化**
音量、`output_delay_ms`(0-5000) 写 `getDataDir()` 下现有 db（复用 settings 通道，勿新造 schema；对照 `dlna/control.ts` 的 settings 读写）。组音量变更即写；加载时回填组模型。
- [ ] **Step 7: Commit**（`feat(sendspin): clock gating + persistence`）

---

## Task 13: 多房样本级同步

**Files:**
- Modify: `backend/src/services/sendspin/stream.ts`
- Create: `backend/src/services/sendspin/stream.test.ts`
- Create: `backend/tests/manual/sendspin/sync_check.ts`

> 对齐 aiosendspin `PushStream/deadline` 模型：单解码 → 组件内逐客户端编码 → 同一 25ms 公共时间线 + 公共 send-ahead 发块。**不复用** `services/group/protocolPlayer.ts` 扇出（其非样本对齐）。

- [ ] **Step 1: 写组推送时间线测试**
```ts
import { describe, it, expect } from "vitest";
import { chunkDeadline, isLate } from "./stream.js";
describe("multiroom timeline", () => {
  it("chunkDeadline = ts + static_delay", () => {
    expect(chunkDeadline(1_000_000n, 20_000n)).toBe(1_020_000n);
  });
  it("isLate: now 超 deadline+grace 判迟到", () => {
    const now = 1_000_000_000n;
    expect(isLate({ deadlineUs: now - 3_000_000n, nowUs: now, graceUs: 2_000_000n })).toBe(true);
    expect(isLate({ deadlineUs: now + 1_000n, nowUs: now, graceUs: 2_000_000n })).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败** → FAIL

- [ ] **Step 3: 最小实现**
```ts
export const chunkDeadline = (ts: bigint, staticDelayUs: bigint): bigint => ts + staticDelayUs;
export function isLate(a: { deadlineUs: bigint; nowUs: bigint; graceUs: bigint }): boolean {
  return a.nowUs > a.deadlineUs + a.graceUs;
}
```

- [ ] **Step 4: 通过** + **Commit**（`feat(sendspin): multiroom timeline helpers`）

- [ ] **Step 5: 改造 stream.ts 为组时间线扇出**
单次 `ffmpeg -f f32le -ar 48000 -ac 2` 解码 → `SendspinStreamSession.decodeTick()` 每 25ms 产一帧（PCM f32 stereo）。对每个组内成员：按其 `supported_formats[0]` 编码(`encoding.ts`)→ `packAudioChunk(公共ts, enc)` → transport 发。首帧 `ts = stream/start.server_transmitted + required_lead_time_us + DEFAULT_INITIAL_DELAY_US(250000)`。公共 `send_ahead` 用 `group.commonSendAhead`（=成员最大，成员变化重算）。
- [ ] **Step 6: 迟到丢弃 + 缓冲水位**
每成员按 `late_by = nowUs − chunkDeadline(ts, staticDelay)`（`staticDelay = output_delay_ms`）判迟，`grace=2s` 超则丢该块；缓冲水位读取 `client/hello.player_support {min_buffer_ms, required_lead_time_ms, output_delay_ms}`；`required_lead_time_ms`>缓冲时加大 `send_ahead`。
- [ ] **Step 7: 端到端验证**：`sync_check.ts` 起双 `aiosendspin` 模拟客户端，打印首帧到达时间差与 `window` 样本漂移，断言两成员开始差 `< 20ms`。
- [ ] **Step 8: Commit**（`feat(sendspin): group timeline fan-out + late-drop`）

---

## Task 14: 配对三法 + re-handshake + unpaired_access

**Files:**
- Create: `backend/src/services/sendspin/pairing.ts`
- Test: `backend/src/services/sendspin/pairing.test.ts`

> 对照 `aiosendspin/noise/{pairing,pairing_code,pairing_token,trust_store}.py`。**配对是 P2/P3 的难点；分三步各自独立可测可提交。**

- [ ] **Step 1: 写 PSK 派生/路由测试**
```ts
import { describe, it, expect } from "vitest";
import { pskIdFor, classifyPsk, isPairingToken, parsePairingToken } from "./pairing.js";
import { SENTINEL_PSK_ID_HEX, SENTINEL_PSK_HEX } from "./constants.js";
describe("pairing", () => {
  it("psk_id = b64url(sha256('sendspin-psk-id-v1' ‖ psk))", () => {
    expect(pskIdFor(SENTINEL_PSK_HEX)).toBe(SENTINEL_PSK_ID_HEX);
  });
  it("分类 lt/pr/sn", () => {
    expect(classifyPsk(SENTINEL_PSK_HEX)).toBe("sn");
    expect(classifyPsk("other")).toBe("lt");
  });
});
```

- [ ] **Step 2: 运行确认失败** → FAIL

- [ ] **Step 3: 最小实现（配对核心函数）**
```ts
import { createHash } from "node:crypto";
import { bytesToHex } from "./util.js";
import { SENTINEL_PSK_HEX } from "./constants.js";
export const pskIdFor = (pskHex: string): string => {
  const h = createHash("sha256").update(Buffer.from("sendspin-psk-id-v1" + Buffer.from(pskHex, "hex"), "utf8")).digest();
  return h.toString("base64url").replace(/=+$/, "");
};
export const classifyPsk = (pskHex: string): "lt" | "pr" | "sn" =>
  pskHex === SENTINEL_PSK_HEX ? "sn" : "lt"; // pr 由配对流程显式登记(见 Step 8)
export const isPairingToken = (s: string): boolean => s.startsWith("SP:");
export function parsePairingToken(s: string): { clientKey: Uint8Array; psk: Uint8Array } {
  // 'SP:{index}:{base32(client_key ‖ pairing_psk)}' — RFC4648 base32, '2'↔'9' 转写
  const [, idx, b32] = s.split(":");
  const raw = base32Decode(b32);
  return { clientKey: raw.subarray(0, 32), psk: raw.subarray(32, 64) };
}
```

- [ ] **Step 4: 通过** + **Commit**（`feat(sendspin): psk classify + pairing token`）

- [ ] **Step 5: 写静态/动态码测试**
```ts
import { describe, it, expect } from "vitest";
import { isStaticCode, isDynamicCode, verifyStaticWindow } from "./pairing.js";
describe("pairing code", () => {
  it("8 位静态码 / 6 位动态码识别", () => {
    expect(isStaticCode("19283746")).toBe(true);
    expect(isDynamicCode("123456")).toBe(true);
  });
  it("静态码 5min 窗口 + 失败 5 次锁", () => {
    expect(verifyStaticWindow(0_000_000n, 4_000_000n)).toBe(true); // 窗口内
    expect(verifyStaticWindow(0_000_000n, 301_000_000n)).toBe(false); // 超 5min(=300_000_000µs)
  });
});
```

- [ ] **Step 6: 最小实现**
```ts
export const isStaticCode = (s: string): boolean => /^\d{8}$/.test(s);
export const isDynamicCode = (s: string): boolean => /^\d{6}$/.test(s);
export const TAIL_WINDOW_US = 300_000_000n; // 5min
export const MAX_CODE_ATTEMPTS = 5;
export function verifyStaticWindow(issuedUs: bigint, nowUs: bigint): boolean {
  return nowUs - issuedUs <= TAIL_WINDOW_US;
}
```

- [ ] **Step 7: 通过** + **Commit**（`feat(sendspin): static/dynamic code window`）

- [ ] **Step 8: 配对流程终版（pairing.ts 完整）**
  - **Pairing PSK**（先）：配对握手直接引用已登记的 `pairing_psk`（`pr` 类）；客户端发 `client/pair-finalize {long_term_psk}` → 服务端持久化长期 PSK（`lt` 类, `getDataDir()` 0600）。
  - **Dynamic/Static Code**（后）：CPACE-X25519-SHA512 PAKE（`@noble/curves`+`@noble/hashes`，参考 `pairing_code.py`）；dynamic 6 位/QR、static 8 位+5min 窗口+失败 5 次锁（`verifyStaticWindow`）；DEcrypt 确认后发长期 PSK。
  - **re-handshake**：配对成功后在既有 transport 上重跑 handshake，`prologue=session.handshakeHash`，换长期 PSK，`swapSession()`，重做 `server/hello⇄client/hello`，`pairing_index=0`。
  - **unpaired_access**：Sentinel（`sn`）连且 `client/hello.unpaired_access.enabled` 且操作员 `set_trusted_unpaired(client_id)` 时仅授予 `playback`；信任表变动→重发 `server/activate`。
- [ ] **Step 9: 通过 + Commit**（`feat(sendspin): pairing flows + re-handshake + unpaired_access`）

---

## Task 15: mDNS 服务端发起 + source 角色

**Files:**
- Modify: `backend/src/services/sendspin/server.ts`（browse 发起）
- Create: `backend/src/services/sendspin/roles/source.ts`

> 对照 aiosendspin source bridge (`audio/source_bridge.py`)。服务端发起是"兼容旧客户端/真机主动"路径。

- [ ] **Step 1: 写 source 块解析测试**
```ts
import { describe, it, expect } from "vitest";
import { packSourceChunk, parseSourceChunk } from "./roles/source.js";
describe("source role", () => {
  it("type 12 = [0x0C][i64 μs][data]", () => {
    const b = packSourceChunk(5n, new Uint8Array([9, 8]));
    expect(b[0]).toBe(12);
    expect(parseSourceChunk(b)).toEqual({ timestampUs: 5n, data: new Uint8Array([9, 8]) });
  });
});
```

- [ ] **Step 2: 运行确认失败** → FAIL

- [ ] **Step 3: 最小实现**
```ts
export const packSourceChunk = (timestampUs: bigint, data: Uint8Array): Uint8Array => {
  const h = Buffer.allocUnsafe(9); h[0] = 12; h.writeBigInt64BE(timestampUs, 1);
  return new Uint8Array(Buffer.concat([h, Buffer.from(data)]));
};
export const parseSourceChunk = (b: Uint8Array): { timestampUs: bigint; data: Uint8Array } =>
  ({ timestampUs: Buffer.from(b.subarray(1, 9)).readBigInt64BE(0), data: b.subarray(9) });
```

- [ ] **Step 4: 通过** + **Commit**（`feat(sendspin): source role chunk`）

- [ ] **Step 5: mDNS 服务端发起连接（browse，另一组）**
`server.ts#startDiscovery()`：`bonjour.find({ type: "sendspin", protocol: "tcp" })` 发现旧客户端，`new WebSocket("ws://ip:8928/sendspin")` 反向发起 initiator 连接（复用握手 + 角色协商）。多服务器仲裁：客户端只持 1 个 playback 连接，被顶掉收 `client/goodbye {reason:"another_server"}` 后关闭旧连接。
- [ ] **Step 6: source 角色接线**：收到 type 12 转 `DispatchSourceSink` 转发给 metadata/visualizer 等消费方；客户端不再带 source 角色即关机。
- [ ] **Step 7: Commit**（`feat(sendspin): server-initiated connect + source sink`）

---

## Task 16: 端到端验证

**Files:**
- Create: `backend/tests/manual/sendspin/`（握手冒烟 / 播放 / 同步 / 配对脚本）

- [ ] **Step 1: 握手冒烟（双 suite + hello/activate/time）**
用 `Sendspin/spec` 参考客户端或 `aiosendspin` 客户端脚本打 `ws://local:8927/sendspin`，断言：既跑 `25519_ChaChaPoly_SHA256` 也跑 `25519_AESGCM_SHA256`；收 `server/hello`+`server/activate`；连续 3 次 `server/time` 三字段递增；随后收到 `stream/start` 与首个 type 4 音频块。
- [ ] **Step 2: 播放链路**：真机（Xbox / Android App）经 mDNS 发现 "MusicFlow Sendspin"，投一首歌、seek（观察 `stream/clear` 无 `stream/end`）、音量、暂停/恢复、自然播完自动切歌。
- [ ] **Step 3: 同步验证**：两设备加入同组，用 `sync_check.ts` 断言行间开始时间差 `<20ms` 且漂移稳定（Task 13 Step 7）。
- [ ] **Step 4: 配对三法各走一遍 + unpaired_access 同意流**；re-handshake 后 volume 仍生效。
- [ ] **Step 5: 回归**：`cd backend && npx tsc --noEmit && npx vitest run src/services/sendspin` 全绿。
- [ ] **Step 6: Commit** 验证脚本（`test(sendspin): manual e2e harness + logs`）。

---

## 自检（计划 vs 规格 §11 的 8 条里程碑）
| 规格里程碑 | 计划 Task |
|---|---|
| 1 服务骨架+握手+WS+mdns | T5,T7 |
| 2 角色/消息/路由(player+controller 先通) | T10,T11 |
| 3 流引擎+编码 | T8 |
| 4 对接复用层+自动切歌 | T9 |
| 5 stream/clear、metadata/artwork、时钟 ±1ms、音量持久化 | T12,T10 |
| 6 多房同步 | T13 |
| 7 配对三法+unpaired+re-handshake+服务端发起 | T14,T15 |
| 8 source/visualizer/color(+WebRTC 可选) | T10,T15 |

无占位步骤；音频块/分片/文件路径/类名跨任务一致（`packAudioChunk`、`createSendspinProtocolPlayer`、`registerSendspinPlayer`、`SendspinStreamSession`、`distributeGroupVolume`）。