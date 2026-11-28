// ==================== 设备 ↔ 协议绑定解析（阶段 5.5） ====================
//
// 一台设备可能有多个出口协议（如某音箱同时支持 AirPlay 与 DLNA）。本模块把
// 「设备档案 → 一组 bindings」这件事收敛为**唯一解析点**，QueueController 不再
// 各自写死协议常量。
//
// 纪律（对齐 docs/renderer-plugin-migration-plan.md §13.3 5.5 / §0.2）：
// - 默认行为逐项等价：开关关闭（缺省）时只走「现有协议派生单条 priority=100」，
//   不读任何覆盖、不额外调插件、不新增日志，调用次数与改动前完全一致；
// - 开关 `MF_RENDERER_MULTI_BINDING=1` 才启用覆盖与回退；
// - 解析顺序 = 可用性 → priority（数值小者优先，稳定排序保留声明顺序）→
//   插件注册顺序（由 createRendererPlayer 内部保证）；
// - 「可用性」用同步工厂返回值判定：插件 createPlayer 返回 null = 该协议/该设备
//   不可用（三内置插件都以自身设备表做归属校验）。禁止为了探活引入 await。
import { createRendererPlayer } from "../pluginAccess.js";
import { getSetting } from "../settings.js";
import { createLogger } from "../../utils/logger.js";
import type { ProtocolPlayer } from "./types.js";

const log = createLogger("renderer-resolve");

/** 绑定项：某个协议出口。缺省 priority=100（数值越小越优先）。 */
export interface DeviceBinding {
  /** 协议标识（开放字符串，插件在 manifest.protocols 自述归属）。 */
  protocol: string;
  /** 优先级，缺省 100；数值小者先试。 */
  priority?: number;
  /** 该协议下的设备 id；缺省 = 注册键（逻辑设备 id）。 */
  deviceId?: string;
  /** 协议私有参数（本阶段仅透传存储，不解释）。 */
  options?: Record<string, unknown>;
}

export interface ResolvedRenderer {
  /** 插件新建的播放器实例（每次调用新建，不缓存）。 */
  player: ProtocolPlayer;
  /** 命中的绑定项。 */
  binding: DeviceBinding;
  /** 实际协议（= binding.protocol）。 */
  protocol: string;
}

export const DEFAULT_BINDING_PRIORITY = 100;

/** 覆盖存储的 settings 键前缀（写入口随 5.7 设备级配置提供；当前可手工配置）。 */
export const BINDING_SETTING_PREFIX = "renderer.bindings.";

/** 多绑定开关：缺省关闭（0），验完再翻 1（§13.3 5.5 回滚开关）。 */
export function multiBindingEnabled(): boolean {
  return process.env.MF_RENDERER_MULTI_BINDING === "1";
}

/** 归一化绑定数组：丢弃非法项、按协议去重、priority 升序（稳定排序）。 */
export function normalizeBindings(raw: unknown): DeviceBinding[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: DeviceBinding[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const src = item as Record<string, unknown>;
    const protocol = typeof src.protocol === "string" ? src.protocol.trim() : "";
    if (!protocol || seen.has(protocol)) continue;
    seen.add(protocol);
    const n = Number(src.priority);
    const binding: DeviceBinding = {
      protocol,
      priority: Number.isFinite(n) ? n : DEFAULT_BINDING_PRIORITY,
    };
    if (typeof src.deviceId === "string" && src.deviceId.trim()) binding.deviceId = src.deviceId.trim();
    if (src.options && typeof src.options === "object") binding.options = src.options as Record<string, unknown>;
    out.push(binding);
  }
  return out.sort((a, b) => (a.priority ?? DEFAULT_BINDING_PRIORITY) - (b.priority ?? DEFAULT_BINDING_PRIORITY));
}

/** 现有协议派生单条绑定（等价于改动前的行为）。 */
export function defaultBindings(protocol: string): DeviceBinding[] {
  return [{ protocol, priority: DEFAULT_BINDING_PRIORITY }];
}

/** 读设备绑定覆盖；无覆盖/坏 JSON/空数组一律返回 null。 */
export function readBindingsOverride(deviceId: string): DeviceBinding[] | null {
  try {
    const raw = getSetting(BINDING_SETTING_PREFIX + deviceId, "");
    if (!raw) return null;
    const list = normalizeBindings(JSON.parse(raw));
    return list.length ? list : null;
  } catch {
    return null;
  }
}

/**
 * 设备最终生效的绑定（已排序）。
 * - 开关关闭：恒为 `[{protocol, priority:100}]`（零覆盖、零额外调用）；
 * - 开关打开：有覆盖用覆盖，否则回落单条。
 */
export function resolveDeviceBindings(deviceId: string, protocol: string): DeviceBinding[] {
  if (!multiBindingEnabled()) return defaultBindings(protocol);
  return readBindingsOverride(deviceId) ?? defaultBindings(protocol);
}

/**
 * 按绑定顺序向插件要播放器：首个非 null 命中即返回。
 *
 * 与 `createRendererPlayer` 的差异只有两点：候选协议来自绑定（可多条）+
 * 命中回退时落一条 `renderer resolve` 日志。开关关闭时等价于单条默认绑定。
 */
export function resolveRendererForDevice(deviceId: string, protocol: string): ResolvedRenderer | null {
  const bindings = resolveDeviceBindings(deviceId, protocol);
  for (const binding of bindings) {
    const player = createRendererPlayer(binding.protocol, binding.deviceId ?? deviceId);
    if (!player) continue;
    if (multiBindingEnabled()) {
      const fallback = binding.protocol !== protocol;
      const line =
        `renderer resolve deviceId=${deviceId} protocol=${binding.protocol} ` +
        `requested=${protocol} binding=${binding.priority ?? DEFAULT_BINDING_PRIORITY}` +
        (fallback ? " fallback=1" : "");
      if (fallback) log.info(line);
      else log.debug(line);
    }
    return { player, binding, protocol: binding.protocol };
  }
  return null;
}
