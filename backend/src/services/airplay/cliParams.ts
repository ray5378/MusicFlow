// ==================== 设备 → cliairplay 参数(主进程侧,纯函数)====================
//
// 两条通道(AP1 RAOP / AP2 native/auto)的**唯一**参数装配点。放在一处的原因:
// 端口、TXT、凭据这三样错任何一个都表现为"握手超时"或"连上但静音",而它们在
// 单播与组播两条链路上必须完全一致 —— 各写一遍必然漂移。
//
// 端口规则(最容易踩):
//   - AP1 拨 `_raop._tcp` 的端口(5000 左右,`AirPlayDevice.port`);
//   - AP2 拨 `_airplay._tcp` 的端口(7000,`device.ap2.port`)。
//   同一台设备两个端口不同,拿错 = 连不上。
import type { AirPlayDevice } from "./discovery.js";
import { serializeTxt, isAp2StreamingAvailable } from "./ap2/index.js";
import type { AirplayCliArgs } from "./sessionRuntime.js";

export interface CliRoutePlan {
  route: "cli" | "raop";
  host: string;
  port: number;
  cli: AirplayCliArgs;
}

/**
 * 给 cliairplay 的 `--et`(RAOP 加密类型)。
 *
 * 为什么不能原样透传设备的 `et`:cliairplay 判定"是否走 auth-setup"只看 `et` 里有没有
 * 1(rsa),而 auth-setup 需要**设备的公钥** `pk`。真实接收端(230 上的 shairport
 * MusicFlow-230-AP1)广播 `et=0,1` 却**不给 `pk`**,于是二进制去试 auth-setup,
 * 被设备以 `RTSP/1.0 400` 拒掉 ⇒ `[STATUS] error code=connect_failed`,
 * 表现为"AP1 设备扫得到、投不上"。实测同一设备 `--et 0` 立刻 ANNOUNCE/SETUP/RECORD 全过。
 *
 * 所以口径是「**拿不到 pk 就不加密**」:没有公钥,本来也没有任何一方能把 AES key 解出来。
 * 设备真的要求加密时一定会同时广播 `et ∋ 1` 与 `pk`,那条路径原样透传,行为不变。
 */
export function raopEtFor(dev: Pick<AirPlayDevice, "et" | "pk">): string {
  const pk = typeof dev.pk === "string" ? dev.pk.trim() : "";
  const et = typeof dev.et === "string" ? dev.et.trim() : "";
  const wantsRsa = /(^|,)\s*1\s*(,|$)/.test(et);
  return pk && wantsRsa ? et : "0";
}

/**
 * 组装某设备的投播参数。
 *
 * @param dev      discovery 里的设备条目
 * @param opts.creds  HAP 凭据(192 hex,配对得到);没有就走 transient 配对
 * @param opts.volume 起播音量 0-100
 * @param opts.forceTransport 显式覆盖通道(排障/单测;正常不要传)
 */
export function planCliRoute(
  dev: AirPlayDevice,
  opts: { creds?: string; volume?: number; secret?: string; forceTransport?: "cli" | "raop" } = {},
): CliRoutePlan {
  const ap2 = !!dev.supportsAp2;
  // 通道:默认 cli;二进制不可用(MUSICFLOW_AP2_CLI=0 或未安装)时回落自研 RAOP。
  // **端口必须跟着通道走**:cliairplay 走 AP2 要拨 `_airplay` 的 7000,自研 RAOP 拨
  // `_raop` 的 5000。拿错端口的表现是"握手超时",而且很难从日志看出来。
  const route = opts.forceTransport ?? (isAp2StreamingAvailable() ? "cli" : "raop");
  const port = route === "cli" && ap2 ? (dev.ap2?.port ?? 7000) : dev.port;
  // AP2 的 `_airplay` TXT 原样给二进制(它按 features 决定 native/compat 与 PTP/NTP);
  // AP1 没有这个记录,必须显式 `raop`,否则二进制会按"无 features ⇒ AP2 native"处理。
  const protocol: AirplayCliArgs["protocol"] = ap2 ? "auto" : "raop";
  return {
    route,
    host: dev.host,
    port,
    cli: {
      protocol,
      txt: ap2 ? serializeTxt(dev.ap2?.raw) || undefined : undefined,
      creds: ap2 ? opts.creds : undefined,
      secret: ap2 ? undefined : opts.secret,
      raopTxt: {
        et: raopEtFor(dev),
        am: dev.am,
        pk: dev.pk,
        cn: dev.cn,
        md: dev.md,
        // UDN 只影响二进制在 mDNS 里怎么自称,取稳定 id 即可。
        udn: dev.id,
      },
      name: dev.alias || dev.name,
      volume: opts.volume,
    },
  };
}
