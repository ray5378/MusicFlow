// v4.3.1 热修回归:qrLogin 能力必须在 validateManifest 白名单与 derivePermissions
// 权限推导中可达 —— 缺口表现:插件声明 capabilities:["qrLogin",...] 被
// 「含非法能力: qrLogin」拒载,qrLogin 三方法永远到不了 /action 端点。
import { describe, it, expect } from "vitest";
import { validateManifest, derivePermissions } from "../../src/plugins/discovery.js";

function baseManifest(caps: string[]) {
  return {
    id: "f-qr",
    name: "f-qr",
    version: "1.0.0",
    type: "recommender",
    capabilities: caps,
    configSchema: [],
  };
}

describe("validateManifest · qrLogin 能力白名单", () => {
  it("接受声明 qrLogin 的 manifest(不再报「含非法能力: qrLogin」)", () => {
    expect(validateManifest(baseManifest(["qrLogin", "recommendPlaylist"]))).toBeNull();
  });
  it("仍拒绝真正不存在的能力(白名单未放开)", () => {
    expect(validateManifest(baseManifest(["noSuchCap" as never]))).toMatch(/非法能力/);
  });
});

describe("derivePermissions · qrLogin 权限推导", () => {
  it("derivePermissions([\"qrLogin\"]) 含 net + storage(host.http + host.storage)", () => {
    const perms = derivePermissions(["qrLogin"]);
    expect(perms).toContain("net");
    expect(perms).toContain("storage");
  });
  it("与其余能力推导取并集后仍完整", () => {
    const perms = derivePermissions(["qrLogin", "recommendPlaylist"]);
    for (const p of ["net", "storage"]) expect(perms).toContain(p);
  });
});
