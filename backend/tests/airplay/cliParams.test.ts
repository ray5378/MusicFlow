// 设备 → cliairplay 参数装配的契约测试(tests 只钉"决定",不碰真实进程)。
//
// 这一层是 AP1/AP2 统一到 cliairplay 之后**唯一**的参数装配点,单播和组播都走它。
// 三样东西错任何一个都表现为"握手超时"或"连上但静音":
//   1. 端口 —— AP2 拨 `_airplay` 的 7000,AP1 拨 `_raop` 的端口;拿错就是连不上;
//   2. 协议 —— AP1 必须显式 `raop`(没有 `_airplay` TXT,`auto` 会被判成 AP2 native);
//   3. `et` —— 见下面 raopEtFor 的注释,这是 230 真机上实测踩到的坑。
import { describe, it, expect, afterEach } from "vitest";
import { planCliRoute, raopEtFor } from "../../src/services/airplay/cliParams.js";
import type { AirPlayDevice } from "../../src/services/airplay/discovery.js";

function dev(over: Partial<AirPlayDevice> = {}): AirPlayDevice {
  return {
    id: "AA:BB:CC:DD:EE:FF",
    name: "Living Room",
    host: "192.168.10.230",
    port: 5000,
    supportsRsa: false,
    supportsAp2: false,
    lastSeen: Date.now(),
    available: true,
    ...over,
  } as AirPlayDevice;
}

/** 同时广播 `_raop`(5000) 与 `_airplay`(7000) 的 AP2 设备。 */
function ap2Dev(over: Partial<AirPlayDevice> = {}): AirPlayDevice {
  return dev({
    supportsAp2: true,
    ap2Key: "pi-1",
    ap2: {
      protovers: "1.1",
      pi: "pi-1",
      port: 7000,
      raw: { features: "0x5A7FFFF7,0x1E", protovers: "1.1", pi: "pi-1", deviceid: "AA:BB:CC:DD:EE:FF" },
      lastSeen: Date.now(),
    },
    ...over,
  });
}

describe("raopEtFor:拿不到 pk 就不加密", () => {
  it("广播 et=0,1 但没有 pk(230 上的 shairport 实测)⇒ 归 0", () => {
    // 实测证据:同一台接收端 --et 0,1 时 cliairplay 会试 auth-setup 被 RTSP 400 拒;
    // 改成 --et 0 立刻 ANNOUNCE/SETUP/RECORD 全过。
    expect(raopEtFor({ et: "0,1" })).toBe("0");
    expect(raopEtFor({ et: "0,1", pk: "" })).toBe("0");
    expect(raopEtFor({ et: "0,1", pk: "   " })).toBe("0");
  });

  it("et 含 1 且有 pk ⇒ 原样透传(设备真要求加密时走 RSA 路径)", () => {
    expect(raopEtFor({ et: "0,1", pk: "MIIBIjANBg" })).toBe("0,1");
    expect(raopEtFor({ et: "1", pk: "MIIBIjANBg" })).toBe("1");
  });

  it("et 不含 1(即使有 pk)⇒ 归 0,与自研 raop.ts 的 `et ∋ 1` 口径一致", () => {
    expect(raopEtFor({ et: "0", pk: "MIIBIjANBg" })).toBe("0");
    expect(raopEtFor({ et: undefined, pk: "MIIBIjANBg" })).toBe("0");
    expect(raopEtFor({})).toBe("0");
  });

  it("et 里的 1 必须是独立项,不能被 10 / 21 这种串误命中", () => {
    expect(raopEtFor({ et: "10", pk: "k" })).toBe("0");
    expect(raopEtFor({ et: "21", pk: "k" })).toBe("0");
    expect(raopEtFor({ et: " 0 , 1 ", pk: "k" })).toBe("0 , 1"); // 首尾空白被 trim
  });
});

describe("planCliRoute:AP1 设备", () => {
  const d = dev({ et: "0,1", am: "ShairportSync", cn: "0,1", md: "0,1,2", port: 7000 });

  it("拨 _raop 端口、协议锁死 raop、不带 _airplay TXT 与凭据", () => {
    const p = planCliRoute(d, { forceTransport: "cli", secret: "s3cret", creds: "deadbeef" });
    expect(p.route).toBe("cli");
    expect(p.port).toBe(7000);
    expect(p.cli.protocol).toBe("raop");
    // AP1 没有 _airplay 记录:TXT 必须为空,否则二进制按 AP2 去握手
    expect(p.cli.txt).toBeUndefined();
    // 凭据是 AP2 的东西,不允许漏到 AP1 分支
    expect(p.cli.creds).toBeUndefined();
    expect(p.cli.secret).toBe("s3cret");
    expect(p.cli.raopTxt).toMatchObject({
      et: "0",            // 无 pk ⇒ 不加密(见上面 raopEtFor)
      am: "ShairportSync",
      cn: "0,1",
      md: "0,1,2",
      udn: d.id,
    });
  });

  it("回落自研 RAOP 时端口仍是 _raop 端口,参数不参与", () => {
    const p = planCliRoute(d, { forceTransport: "raop" });
    expect(p.route).toBe("raop");
    expect(p.port).toBe(7000);
  });
});

describe("planCliRoute:AP2 设备", () => {
  it("拨 _airplay 端口、协议 auto、TXT 原样透传、凭据只走 AP2", () => {
    const d = ap2Dev({ port: 5000, alias: "书房" });
    const p = planCliRoute(d, { forceTransport: "cli", creds: "AA".repeat(96), volume: 37, secret: "nope" });
    expect(p.port).toBe(7000);              // 不是设备表里的 raop 端口
    expect(p.cli.protocol).toBe("auto");
    expect(p.cli.creds).toBe("AA".repeat(96));
    expect(p.cli.secret).toBeUndefined();   // secret 是 AP1 的东西
    expect(p.cli.volume).toBe(37);
    expect(p.cli.name).toBe("书房");         // alias 优先于 name
    expect(p.cli.txt).toContain("features=");
    expect(p.cli.txt).toContain("protovers=1.1");
    expect(p.cli.raopTxt?.udn).toBe(d.id);
  });

  it("缺 ap2.port 时兜底 7000(不能退化成 raop 端口)", () => {
    const d = ap2Dev();
    d.ap2 = { ...d.ap2!, port: undefined };
    const p = planCliRoute(d, { forceTransport: "cli" });
    expect(p.port).toBe(7000);
  });

  it("没有 _airplay TXT 的 AP2-only 设备:txt 为空但仍走 auto + 7000", () => {
    const d = ap2Dev();
    d.ap2 = { lastSeen: Date.now() } as any;
    const p = planCliRoute(d, { forceTransport: "cli" });
    expect(p.cli.txt).toBeUndefined();
    expect(p.cli.protocol).toBe("auto");
    expect(p.port).toBe(7000);
  });
});

describe("通道开关:二进制不可用时逐字回落到自研 RAOP", () => {
  const saved = process.env.MUSICFLOW_AP2_CLI;
  afterEach(() => {
    if (saved === undefined) delete process.env.MUSICFLOW_AP2_CLI;
    else process.env.MUSICFLOW_AP2_CLI = saved;
  });

  it("MUSICFLOW_AP2_CLI=0 ⇒ route=raop,端口回到 _raop 端口", () => {
    process.env.MUSICFLOW_AP2_CLI = "0";
    const p = planCliRoute(ap2Dev(), {});
    expect(p.route).toBe("raop");
    expect(p.port).toBe(5000);
  });
});
