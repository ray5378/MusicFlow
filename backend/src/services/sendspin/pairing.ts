// ==================== 配对三法 PSK 派生 ====================
//
// 几种配对方生成 32B 会话 PSK(发给 connect/hello 的 client 明文体,由客户端在握手时
// 作为 pskToken 使用;见 aiosendspin server/pairing.py)。本模块只负责:
//   - generating 配对 PSK 候选
//   - 动态码/cpac 占位(配合 pairing xs 组件的 PAKE)
//   - 静态码窗口与失败锁定的纯逻辑(可单测)
// 密码学 PAKE(CPACE-X25519-SHA512)在 pairing/paxr 单独组件实现。

import { randomBytes } from "node:crypto";

export type PairingMethod = "psk" | "dynamic" | "static";

/** 生成 32B 临时会话 PSK(hex)。 */
export function generateSessionPsk(): string {
  return randomBytes(32).toString("hex");
}

/** 生成动态码(6 位数字)。 */
export function generateDynamicCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/** 生成静态码(6 位数字)。 */
export function generateStaticCode(): string {
  return generateDynamicCode();
}

export class StaticCodeGate {
  windowStartMs = 0;
  failures = 0;
  readonly windowMs: number;
  readonly maxFailures: number;

  constructor(windowMs = 5 * 60 * 1000, maxFailures = 5) {
    this.windowMs = windowMs;
    this.maxFailures = maxFailures;
  }

  reset(nowMs = Date.now()): void {
    this.windowStartMs = nowMs;
    this.failures = 0;
  }

  expired(nowMs = Date.now()): boolean {
    return nowMs - this.windowStartMs > this.windowMs;
  }

  recordFailure(): number {
    this.failures += 1;
    return this.failures;
  }

  locked(): boolean {
    return this.failures >= this.maxFailures;
  }
}

export function attemptStaticCode(
  gate: StaticCodeGate,
  expected: string,
  given: string,
  nowMs = Date.now(),
): { ok: boolean; locked: boolean; remaining: number } {
  if (gate.locked() && !gate.expired(nowMs)) return { ok: false, locked: true, remaining: 0 };
  if (gate.expired(nowMs)) gate.reset(nowMs);
  if (expected !== given) {
    const f = gate.recordFailure();
    return { ok: false, locked: f >= gate.maxFailures, remaining: gate.maxFailures - f };
  }
  gate.failures = 0;
  return { ok: true, locked: false, remaining: gate.maxFailures };
}