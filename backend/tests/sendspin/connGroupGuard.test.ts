// Fix-2C 单测:resolveLiveGroup 的 conn.group 失配防御(经 pollCore 观测)。
// 场景:conn.group 指向已 groups.delete 的陈旧悬挂引用 ⇒ 必须回落在册 ug: 组,
// 而不是读已死组的 current(假 IDLE/假暂停视图的来源)。
import { describe, expect, it } from "vitest";
import { pollCore } from "../../src/services/sendspin/playerCore.js";

type AnyGrp = Record<string, unknown>;

function mkConn(): Record<string, unknown> {
  return { sendGroupUpdate() { /* stub */ } };
}

function mkGrp(name: string, members: unknown[], current: AnyGrp | null): AnyGrp {
  return { name, members: new Set(members), current, paused: false, positionMs: 0 };
}

function mkSrv(conn: unknown, groups: [string, AnyGrp][], bare: AnyGrp): Record<string, unknown> {
  return {
    clients: new Map([["c1", conn]]),
    groups: new Map(groups),
    group: (_id: string) => bare,
  };
}

describe("Fix-2C: resolveLiveGroup conn.group 失配防御(经 pollCore)", () => {
  it("conn.group 指向已注销组 → 回落扫 ug: 注册表,读到在册组的 current", () => {
    const conn = mkConn();
    (conn as { group?: unknown }).group = mkGrp("ug:dead", [], null); // 已 groups.delete 的陈旧引用
    const live = mkGrp("ug:g1", [conn], { durationMs: 60000 });       // 在册、含此连接
    const srv = mkSrv(conn, [["ug:g1", live]], mkGrp("c1", [], null));
    expect(pollCore(srv as never, "c1").playing).toBe(true);
  });

  it("conn.group 陈旧且注册表无含此连接的 ug: 组 → 回落单设备组(旧行为,热重连窗口)", () => {
    const conn = mkConn();
    (conn as { group?: unknown }).group = mkGrp("ug:dead", [], null);
    const srv = mkSrv(conn, [], mkGrp("c1", [], null));
    expect(pollCore(srv as never, "c1").playing).toBe(false);
  });

  it("conn.group 在册 → 直通(正常路径零变化)", () => {
    const conn = mkConn();
    const live = mkGrp("ug:g1", [conn], { durationMs: 60000 });
    (conn as { group?: unknown }).group = live;
    const srv = mkSrv(conn, [["ug:g1", live]], mkGrp("c1", [], null));
    expect(pollCore(srv as never, "c1").playing).toBe(true);
  });
});
