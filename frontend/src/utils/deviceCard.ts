// 本端的「设备名片」:注册时随 /v1/peers/register 上报,供服务端把本机实例分进
// 「客户端」类别(Web 端按「浏览器 · 系统」近似命名,不再单列 Web 播放器模块)。
//
// 网页端**拿不到电脑名**(浏览器安全限制),只能给「浏览器 · 系统」这种近似标签;
// Android / Windows 客户端各自上报真实机型名 / 电脑名(服务端不区分来源,统一存
// platform + model 两个字段)。旧客户端不上报 → 服务端两字段留空,前端退回兜底名。

export interface DeviceCard {
  /** 平台标识,如 web / android / windows / ios / macos。 */
  platform: string;
  /** 机型名 / 电脑名 / 「浏览器 · 系统」。取不到时缺省。 */
  model?: string;
}

function browserName(ua: string): string {
  if (/Edg\//.test(ua)) return "Edge";
  if (/OPR\//.test(ua) || /Opera/.test(ua)) return "Opera";
  if (/Firefox\//.test(ua)) return "Firefox";
  if (/Chrome\//.test(ua)) return "Chrome";
  if (/Safari\//.test(ua)) return "Safari";
  return "Browser";
}

function osName(ua: string): string {
  if (/Windows NT/.test(ua)) return "Windows";
  if (/Android/.test(ua)) return "Android";
  if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
  if (/Mac OS X/.test(ua)) return "macOS";
  if (/Linux/.test(ua)) return "Linux";
  return "Unknown";
}

/** 取本端的设备名片(Web 端:浏览器 · 系统;取不到就只给 platform)。 */
export function getDeviceCard(): DeviceCard {
  try {
    const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
    if (!ua) return { platform: "web" };
    return { platform: "web", model: `${browserName(ua)} · ${osName(ua)}` };
  } catch {
    return { platform: "web" };
  }
}
