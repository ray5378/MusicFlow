// 群组准入的 AP2 配对门(未配对 AP2 不得进组)钉定用例。
//
// 用户规则(2026-10-27 拍板):
//   1. **未配对的 AP2 设备不得加入群组**(只有「新加入」严格禁止);
//   2. 凭据失效**不摘出已有的组**:已在组内的成员凭据失效只让播放回落 AP1
//      (设备视图标「需重新配对」),删/加别的成员仍必须成功(不得把组锁死 —— O1 不回退);
//   3. AP1-only 设备(supportsAp2=false,例:HiVi)完全不受影响;
//   5. 不新增 `ap2:` 命名空间(成员 id 仍是 `airplay:<deviceId>`)。
//
// 这里**用真实的 airplay/control.ts**(真 isAirPlayMemberSelectable / 真 selectableOf /
// 真 hap_credentials 读库),只把设备发现(discovery)换成夹具 —— 这样「未配对」的判定
// 走的是生产代码,而不是在测试里复刻一份判据。
import "../plugins/_env.js";

import { describe, it, expect, beforeEach, vi } from "vitest";
import { sqlite } from "../../src/db/index.js";

const D = vi.hoisted(() => {
  let devices: Record<string, any> = {};
  return {
    set(v: Record<string, any>) {
      devices = v;
    },
    get(id: string) {
      return devices[id];
    },
    list() {
      return Object.values(devices);
    },
  };
});

vi.mock("../../src/services/airplay/discovery.js", () => ({
  getAirPlayDevice: (id: string) => D.get(id),
  getAirPlayDevices: () => D.list(),
  onAirPlayEvent: () => undefined,
  startAirPlayDiscovery: async () => undefined,
  stopAirPlayDiscovery: async () => undefined,
  setAirPlayPersist: () => undefined,
  removeAirPlayDevice: () => undefined,
  addPersistedAirPlayDevice: () => undefined,
}));

import { GroupManager, splitMemberId } from "../../src/services/group/index.js";
import { isAirPlayMemberSelectable } from "../../src/services/airplay/control.js";

/** 合法 192 hex 凭据(64 hex LTPK + 128 hex LTSK) —— 只需形态合法,内容与本文件无关。 */
const CREDS = "a".repeat(64) + "b".repeat(128);

const NOW = "2026-10-27T00:00:00.000Z";

/** 直接改凭据列(模拟「配对成功」/「pair-verify 连败后凭据被清」两条真实路径)。 */
function setCreds(deviceId: string, hex: string): void {
  sqlite.prepare(
    `INSERT INTO airplay_devices (id, name, alias, first_seen, last_seen, available, disabled, hap_credentials, updated_at)
     VALUES (?, '', '', ?, ?, 1, 0, ?, ?)
     ON CONFLICT(id) DO UPDATE SET hap_credentials = excluded.hap_credentials`,
  ).run(deviceId, NOW, NOW, hex, NOW);
}

/** 设备档案夹具:AP2 已配对 / AP2 未配对 / AP1-only(HiVi)。 */
function seedDevices(): void {
  D.set({
    "hp-paired": { id: "hp-paired", name: "客厅 HomePod", host: "192.168.1.51", port: 7000, supportsRsa: false, supportsAp2: true, available: true, lastSeen: Date.now() },
    "hp-unpaired": { id: "hp-unpaired", name: "书房 HomePod", host: "192.168.1.52", port: 7000, supportsRsa: false, supportsAp2: true, available: true, lastSeen: Date.now() },
    hivi: { id: "hivi", name: "HiVi", host: "192.168.1.60", port: 5000, supportsRsa: false, supportsAp2: false, available: true, lastSeen: Date.now() },
  });
}

function memberIdsOf(gm: GroupManager, id: string): string[] {
  return gm.get(id)?.memberIds ?? [];
}

describe("群组准入:未配对 AP2 不得进组", () => {
  let gm: GroupManager;

  beforeEach(() => {
    sqlite.exec("DELETE FROM player_groups");
    sqlite.exec("DELETE FROM airplay_devices");
    seedDevices();
    setCreds("hp-paired", CREDS);
    gm = new GroupManager();
    gm.loadFromDb();
  });

  it("前置:真正的 selectable 判据 = 已配对 AP2 可选 / 未配对 AP2 不可选 / AP1-only 恒可选", () => {
    expect(isAirPlayMemberSelectable("hp-paired")).toBe(true);
    expect(isAirPlayMemberSelectable("hp-unpaired")).toBe(false);
    expect(isAirPlayMemberSelectable("hivi")).toBe(true);
  });

  it("建组:成员含未配对 AP2 ⇒ 拒绝,文案要求先完成 AirPlay 2 配对", () => {
    expect(() => gm.createGroup("客厅组", ["airplay:hp-unpaired"])).toThrow(
      /完成 AirPlay 2 配对后才能加入群组/,
    );
    expect(gm.list()).toHaveLength(0);
  });

  it("两个写入口都拦:PUT 全量(setMembers)与增量(applyMemberDelta)对「新加入」的未配对 AP2 都拒", () => {
    const g = gm.createGroup("空组", []);
    expect(() => gm.setMembers(g.id, ["airplay:hp-unpaired"])).toThrow(/完成 AirPlay 2 配对后才能加入群组/);
    expect(() => gm.applyMemberDelta(g.id, { add: ["airplay:hp-unpaired"] })).toThrow(
      /完成 AirPlay 2 配对后才能加入群组/,
    );
    // 拒绝必须无损:库里成员没被改写
    expect(memberIdsOf(gm, g.id)).toEqual([]);
  });

  it("已配对 AP2 可进组;AP1-only 设备(HiVi)完全不受影响 ⇒ 允许 AP1 + AP2 混合组", () => {
    const g = gm.createGroup("混合组", ["airplay:hp-paired", "airplay:hivi"]);
    expect(memberIdsOf(gm, g.id)).toEqual(["airplay:hp-paired", "airplay:hivi"]);
    // 协议逐成员选,不是组级:两台设备同组共存
    expect(memberIdsOf(gm, g.id).every((m) => splitMemberId(m)?.kind === "airplay")).toBe(true);
  });

  it("已在组内成员凭据失效:不摘出组,且删/改其它成员仍成功(O1 不回退)", () => {
    const g = gm.createGroup("客厅组", ["airplay:hp-paired", "airplay:hivi"]);
    // 凭据失效(等价 pair-verify 连败 3 次 → clearHapCredentials)
    setCreds("hp-paired", "");
    expect(isAirPlayMemberSelectable("hp-paired")).toBe(false);
    // ① 不摘组:成员原样保留(播放回落 AP1,视图标「需重新配对」)
    expect(memberIdsOf(gm, g.id)).toEqual(["airplay:hp-paired", "airplay:hivi"]);
    // ② 删掉别的成员必须成功(只校验新加入的差集,历史失效成员不得把组锁死)
    const delta = gm.applyMemberDelta(g.id, { remove: ["airplay:hivi"] });
    expect(delta?.removed).toEqual(["airplay:hivi"]);
    expect(memberIdsOf(gm, g.id)).toEqual(["airplay:hp-paired"]);
    // ③ 再次提交「不含新成员」的全量列表同样成功
    expect(() => gm.setMembers(g.id, ["airplay:hp-paired"])).not.toThrow();
    // ④ 但若要「新加入」一台未配对 AP2,仍然被拒
    expect(() => gm.setMembers(g.id, ["airplay:hp-paired", "airplay:hp-unpaired"])).toThrow(
      /完成 AirPlay 2 配对后才能加入群组/,
    );
  });

  it("不新增 ap2: 命名空间:用 ap2:<id> 提交仍是未知前缀 ⇒ 拒绝", () => {
    const g = gm.createGroup("空组", []);
    expect(() => gm.applyMemberDelta(g.id, { add: ["ap2:hp-paired"] })).toThrow(/不是合法的群组成员/);
    expect(memberIdsOf(gm, g.id)).toEqual([]);
  });

  it("DLNA 仍禁入(AP2 门不放宽任何既有 allowlist)", () => {
    const g = gm.createGroup("空组", []);
    expect(() => gm.applyMemberDelta(g.id, { add: ["dlna:dlna-1"] })).toThrow(/DLNA 设备不支持加入群组/);
    expect(() => gm.applyMemberDelta(g.id, { add: ["local:me"] })).toThrow(/不是合法的群组成员/);
    expect(() => gm.applyMemberDelta(g.id, { add: ["group:g2"] })).toThrow(/不是合法的群组成员/);
  });
});
