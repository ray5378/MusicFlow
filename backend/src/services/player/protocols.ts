// ==================== 渲染器协议/能力位清单(阶段 5.1 / 5.2) ====================
//
// 目录用途:**仅诊断 / 测试 / 缺省值**。核心播放路径不得据此按协议名分支 ——
// 协议标识已是开放字符串(RendererProtocol = string),插件通过 manifest.protocols
// 自述归属,门面只按声明筛选。
import type { PluginManifest, RendererCapability } from "../../plugins/types.js";

/** 已知内置渲染器协议标识(诊断/测试用;不是白名单,第三方协议不受此限)。 */
export const KNOWN_RENDERER_PROTOCOLS = ["airplay", "dlna", "sendspin"] as const;

export const PROTOCOL_AIRPLAY = "airplay";
export const PROTOCOL_DLNA = "dlna";
export const PROTOCOL_SENDSPIN = "sendspin";

/** 未声明 `playerCapabilities` 时的缺省能力位 = 现状全支持(不得收窄)。 */
export const DEFAULT_RENDERER_CAPABILITIES: readonly RendererCapability[] = [
  "play",
  "pause",
  "seek",
  "volume",
  "mute",
  "next_previous",
  "set_members",
  "accurate_time",
  "gapless",
];

/** 读取插件声明的播放器能力位;缺省返回全支持集合。 */
export function playerCapabilitiesOf(
  manifest: Pick<PluginManifest, "playerCapabilities"> | null | undefined,
): RendererCapability[] {
  const declared = manifest?.playerCapabilities;
  return declared && declared.length ? [...declared] : [...DEFAULT_RENDERER_CAPABILITIES];
}

/** 读取插件声明的协议标识;缺省返回 undefined(表示不过滤,保持旧行为)。 */
export function manifestProtocols(manifest: Pick<PluginManifest, "protocols"> | null | undefined): string[] | undefined {
  const declared = manifest?.protocols;
  return Array.isArray(declared) && declared.length ? declared : undefined;
}
