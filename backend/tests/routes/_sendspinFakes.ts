// sendspin 服务层的测试假体(仅用于**路由层**测试:routes/api/sendspin.ts)。
//
// 这些入口在路由里都是 `await import(...)` 动态加载的,不在 shared.ts 的覆盖范围内,
// 所以必须单独替换。真实服务行为由 src/services/sendspin/*.test.ts 覆盖。
//
// 用法(配合 importOriginal 保真,只覆盖需要控制的那几个):
//   vi.mock("../../src/services/sendspin/index.js", async (importOriginal) => {
//     const actual = await importOriginal<Record<string, unknown>>();
//     const { sf } = await import("./_sendspinFakes.js");
//     return { ...actual, ...sf };
//   });
import { vi } from "vitest";

export type Any = any;

const DEFAULTS = {
  // ---- services/sendspin/deviceState.ts ----
  getDeviceDisabled: () => false,
  listDisabledDeviceIds: () => [] as string[],
  listEsphomeCreds: () => [] as Any[],
  getDeviceEsphome: () => ({ psk: "", port: 6053 }) as Any,

  // ---- services/sendspin/index.ts ----
  sendspinEsphomeStatus: async () => ({ devices: [] as Any[] }),
  // 开环健康(ok / degraded / stalled)。4.0.86 起路由要给在线连接行回
  // `streamHealth: srv.sinkHealthOf(clientId)`(见 routes/api/sendspin.ts),
  // 服务层真实行为由 src/services/sendspin/sinkHealth.test.ts 覆盖;
  // 路由层默认给 ok,需要制造 stalled 的用例用 mockImplementation 覆盖。
  sinkHealthOf: () => "ok" as Any,
  sendspinSetDisabled: async () => true,
  sendspinGetEsphomeVolume: async () => null as Any,
  sendspinSaveEsphomeCreds: async () => ({ host: "" }) as Any,
  resolveEsphomeHost: () => "",
  sendspinSetEsphomeVolume: async () => ({ ok: true, code: "", sent: true }) as Any,
  sendspinSetEsphomeMuted: async () => ({ ok: true, code: "", sent: true }) as Any,
  rememberDialTarget: async () => undefined,
  listDialTargets: async () => [] as Any[],
  forgetDialTarget: async () => true,
  sendspinUnpair: async () => true,

  // ---- services/sendspin/esphomeBridge.ts ----
  probeEsphome: async () => ({ ok: false, code: "no_psk" }) as Any,
};

type FnName = keyof typeof DEFAULTS;

/** 受控的 sendspin 服务入口。 */
export const sf = Object.fromEntries(
  Object.entries(DEFAULTS).map(([k, impl]) => [k, vi.fn(impl as Any)]),
) as Record<FnName, ReturnType<typeof vi.fn>> & { ESPHOME_API_PORT: number };

/** ESPHome 默认端口(路由用它做兜底)。 */
sf.ESPHOME_API_PORT = 6053;

export function resetSendspinFakes(): void {
  for (const [k, impl] of Object.entries(DEFAULTS)) {
    const f = (sf as Any)[k];
    f.mockReset();
    f.mockImplementation(impl as Any);
  }
  sf.ESPHOME_API_PORT = 6053;
}
