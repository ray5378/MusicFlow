// ==================== Sendspin 角色注册表 + 角色协商 ====================
//
// 对照 aiosendspin/server/roles/{registry,negotiation}.py。每个角色版本以
// `registerRole` 注册;`negotiateRoles` 按「客户端声明 ∩ 服务端支持」选出激活角色,
// 家族顺序 `player` < `controller` < 其余(按 client 序)。

export type RoleFactory = (client: any) => any;

const roleFactoryMap = new Map<string, { factory: RoleFactory; requiresPairing: boolean }>();

export const ROLE_IDS = [
  "player@v1",
  "controller@v1",
  "metadata@v1",
  "artwork@v1",
  "visualizer@v1",
  "source@v1",
  "color@v1",
];

export function registerRole(roleId: string, factory: RoleFactory, requiresPairing = false): void {
  roleFactoryMap.set(roleId, { factory, requiresPairing });
}

export function roleRequiresPairing(roleId: string): boolean {
  return roleFactoryMap.get(roleId)?.requiresPairing ?? false;
}

export const roleFamily = (id: string): string => id.split("@")[0];

const FAMILY_ORDER = new Map([
  ["player", 0],
  ["controller", 1],
]);

export function sortRoleIds(ids: string[]): string[] {
  return [...ids].sort(
    (a, b) => (FAMILY_ORDER.get(roleFamily(a)) ?? 9) - (FAMILY_ORDER.get(roleFamily(b)) ?? 9),
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