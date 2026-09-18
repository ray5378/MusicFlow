// sendspin 按设备音量持久化:表读写 / 字段合并 / 夹取 / 删除(解绑与忘记设备时调)。
// 表在 tests/setup.ts 的 initDatabase() 里随全量 schema 一起建好。
import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { sqlite, db, encryptPassword } from "../../db/index.js";
import { users, playerNameOverrides, playerPrefs } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import {
  getDeviceVolumeState,
  saveDeviceVolumeState,
  deleteDeviceVolumeState,
  getDeviceDisabled,
  saveDeviceDisabled,
  getDeviceEsphome,
  saveDeviceEsphome,
  listEsphomeCreds,
  readLegacyPluginEsphome,
  inheritLegacyEsphomePsk,
  purgeDeviceArtifacts,
} from "./deviceState.js";

describe("sendspin deviceState (按设备持久音量)", () => {
  const CID = "dev-state-test-1";
  const rowCount = () =>
    (sqlite.prepare("SELECT COUNT(*) AS c FROM sendspin_device_state WHERE client_id = ?").get(CID) as any).c;

  beforeEach(() => {
    sqlite.prepare("DELETE FROM sendspin_device_state WHERE client_id = ?").run(CID);
  });

  it("无行返回 null(调用方回退缺省 100/false)", () => {
    expect(getDeviceVolumeState(CID)).toBeNull();
  });

  it("写入后可读回;按字段合并,另一字段保持不变;upsert 不产生第二行", () => {
    saveDeviceVolumeState(CID, { volume: 42 });
    expect(getDeviceVolumeState(CID)).toEqual({ volume: 42, muted: false });
    // 只改 muted → volume 保留
    saveDeviceVolumeState(CID, { muted: true });
    expect(getDeviceVolumeState(CID)).toEqual({ volume: 42, muted: true });
    // 只改 volume → muted 保留
    saveDeviceVolumeState(CID, { volume: 7 });
    expect(getDeviceVolumeState(CID)).toEqual({ volume: 7, muted: true });
    expect(rowCount()).toBe(1);
  });

  it("音量夹取到 0..100,非法值回退 100", () => {
    saveDeviceVolumeState(CID, { volume: 250 });
    expect(getDeviceVolumeState(CID)!.volume).toBe(100);
    saveDeviceVolumeState(CID, { volume: -5 });
    expect(getDeviceVolumeState(CID)!.volume).toBe(0);
    saveDeviceVolumeState(CID, { volume: Number.NaN });
    expect(getDeviceVolumeState(CID)!.volume).toBe(100);
  });

  it("空 clientId 一律 no-op(不建行、不报错)", () => {
    saveDeviceVolumeState("", { volume: 30 });
    expect(getDeviceVolumeState("")).toBeNull();
  });

  it("删除后回到无行(解绑 / 忘记设备语义),重复删除幂等", () => {
    saveDeviceVolumeState(CID, { volume: 55, muted: true });
    expect(getDeviceVolumeState(CID)).toEqual({ volume: 55, muted: true });
    deleteDeviceVolumeState(CID);
    expect(getDeviceVolumeState(CID)).toBeNull();
    deleteDeviceVolumeState(CID);
    expect(getDeviceVolumeState(CID)).toBeNull();
  });

  // ---- 禁用态(与 DLNA dlna_devices.disabled 同语义) ----

  it("禁用态缺省 false(无行即启用)", () => {
    expect(getDeviceDisabled(CID)).toBe(false);
    expect(getDeviceDisabled("")).toBe(false);
  });

  it("写禁用态后可读回;不产生第二行", () => {
    saveDeviceDisabled(CID, true);
    expect(getDeviceDisabled(CID)).toBe(true);
    expect(rowCount()).toBe(1);
    saveDeviceDisabled(CID, false);
    expect(getDeviceDisabled(CID)).toBe(false);
    expect(rowCount()).toBe(1);
  });

  it("禁用态与音量互不覆盖(同一行两个独立字段)", () => {
    saveDeviceVolumeState(CID, { volume: 33, muted: true });
    saveDeviceDisabled(CID, true);
    // 写禁用不该动音量/静音
    expect(getDeviceVolumeState(CID)).toEqual({ volume: 33, muted: true });
    expect(getDeviceDisabled(CID)).toBe(true);
    // 写音量不该动禁用
    saveDeviceVolumeState(CID, { volume: 44 });
    expect(getDeviceDisabled(CID)).toBe(true);
    expect(getDeviceVolumeState(CID)).toEqual({ volume: 44, muted: true });
    expect(rowCount()).toBe(1);
  });

  it("无行时直接写禁用态也能建行(volume/muted 取缺省)", () => {
    saveDeviceDisabled(CID, true);
    expect(getDeviceVolumeState(CID)).toEqual({ volume: 100, muted: false });
    expect(getDeviceDisabled(CID)).toBe(true);
  });

  it("解绑(删行)会一并清掉禁用态 —— 与「解绑即删除播放器」一致", () => {
    saveDeviceDisabled(CID, true);
    deleteDeviceVolumeState(CID);
    expect(getDeviceDisabled(CID)).toBe(false);
  });

  // ---- ESPHome 6053 凭据(每台设备各自一把;按 clientId 存,不按会变的 host) ----

  it("无行返回空凭据 psk='' / port=0(即「不连 6053」)", () => {
    expect(getDeviceEsphome(CID)).toEqual({ psk: "", port: 0 });
    expect(getDeviceEsphome("")).toEqual({ psk: "", port: 0 });
  });

  it("写密钥后可读回;端口非法回退 0(=用缺省 6053);psk 去空白", () => {
    saveDeviceEsphome(CID, "  secret-key  ", 6054);
    expect(getDeviceEsphome(CID)).toEqual({ psk: "secret-key", port: 6054 });
    // 非法端口:0 / 越界 / 小数 / 非数字 一律落 0,交给上层回退 6053
    for (const p of [0, -1, 70000, 1.5, Number.NaN]) {
      saveDeviceEsphome(CID, "k", p as number);
      expect(getDeviceEsphome(CID).port).toBe(0);
    }
    saveDeviceEsphome(CID, "k", 6053);
    expect(getDeviceEsphome(CID).port).toBe(6053);
  });

  it("关键:每台设备各存各的密钥,互不覆盖(不是全局一把)", () => {
    const A = "dev-state-esp-a";
    const B = "dev-state-esp-b";
    sqlite.prepare("DELETE FROM sendspin_device_state WHERE client_id IN (?, ?)").run(A, B);
    saveDeviceEsphome(A, "key-a", 6053);
    saveDeviceEsphome(B, "key-b", 6054);
    expect(getDeviceEsphome(A)).toEqual({ psk: "key-a", port: 6053 });
    expect(getDeviceEsphome(B)).toEqual({ psk: "key-b", port: 6054 });
    // 清 A 不影响 B
    saveDeviceEsphome(A, "", 0);
    expect(getDeviceEsphome(A)).toEqual({ psk: "", port: 0 });
    expect(getDeviceEsphome(B)).toEqual({ psk: "key-b", port: 6054 });
    sqlite.prepare("DELETE FROM sendspin_device_state WHERE client_id IN (?, ?)").run(A, B);
  });

  it("写密钥不动 volume / muted / disabled(同一行四个独立字段)", () => {
    saveDeviceVolumeState(CID, { volume: 21, muted: true });
    saveDeviceDisabled(CID, true);
    saveDeviceEsphome(CID, "k", 6053);
    expect(getDeviceVolumeState(CID)).toEqual({ volume: 21, muted: true });
    expect(getDeviceDisabled(CID)).toBe(true);
    expect(getDeviceEsphome(CID)).toEqual({ psk: "k", port: 6053 });
    expect(rowCount()).toBe(1);
  });

  it("无行时直接写密钥也能建行(volume/muted 取缺省)", () => {
    saveDeviceEsphome(CID, "k", 6053);
    expect(getDeviceVolumeState(CID)).toEqual({ volume: 100, muted: false });
    expect(rowCount()).toBe(1);
  });

  it("listEsphomeCreds 只列已填密钥的设备,空串一律排除", () => {
    const A = "dev-state-esp-list-a";
    const B = "dev-state-esp-list-b";
    sqlite.prepare("DELETE FROM sendspin_device_state WHERE client_id IN (?, ?)").run(A, B);
    saveDeviceEsphome(A, "key-a", 6053);
    saveDeviceEsphome(B, "", 6053); // 没填 → 不该出现在列表里
    const listed = listEsphomeCreds().filter((c) => c.clientId === A || c.clientId === B);
    expect(listed).toEqual([{ clientId: A, psk: "key-a", port: 6053 }]);
    sqlite.prepare("DELETE FROM sendspin_device_state WHERE client_id IN (?, ?)").run(A, B);
  });

  // ---- 升级迁移:旧版「插件页全局密钥」→ 每台设备各自的密钥 ----
  // 背景:密钥从「插件页一把全局」改成「每台设备各自一把」后,老用户设备行上是空的。
  // 不做继承,升级后会静默失联(桥不再连、音量按钮置灰),得为每台设备重填一遍。

  const writePluginCfg = (cfg: any) =>
    sqlite
      .prepare("INSERT INTO plugins (id, name, config) VALUES ('sendspin-renderer', 'sendspin-renderer', ?) ON CONFLICT(id) DO UPDATE SET config = excluded.config")
      .run(JSON.stringify(cfg));
  const clearPluginCfg = () =>
    sqlite.prepare("DELETE FROM plugins WHERE id = 'sendspin-renderer' OR name = 'sendspin-renderer'").run();
  /** 每个用例换一个 clientId:继承是「同一设备只一次」的进程内记忆,复用会互相干扰。 */
  let seq = 0;
  const freshId = () => `dev-state-legacy-${++seq}`;

  it("readLegacyPluginEsphome 读得到旧字段;无行/空值 = 空凭据", () => {
    clearPluginCfg();
    expect(readLegacyPluginEsphome()).toEqual({ psk: "", port: 0 });
    writePluginCfg({ esphome_psk: " legacy-key ", esphome_port: 6054 });
    expect(readLegacyPluginEsphome()).toEqual({ psk: "legacy-key", port: 6054 });
    // 非法端口落 0(上层回退 6053)
    writePluginCfg({ esphome_psk: "legacy-key", esphome_port: 70000 });
    expect(readLegacyPluginEsphome().port).toBe(0);
    clearPluginCfg();
  });

  it("窗口期内、设备还没有自己的密钥 ⇒ 继承旧全局密钥并落库", () => {
    const cid = freshId();
    writePluginCfg({ esphome_psk: "legacy-key", esphome_port: 6054 });
    expect(inheritLegacyEsphomePsk(cid)).toBe(true);
    expect(getDeviceEsphome(cid)).toEqual({ psk: "legacy-key", port: 6054 });
    clearPluginCfg();
  });

  it("已有自己密钥的设备不被覆盖(继承只补空缺)", () => {
    const cid = freshId();
    saveDeviceEsphome(cid, "own-key", 6053);
    writePluginCfg({ esphome_psk: "legacy-key", esphome_port: 6054 });
    expect(inheritLegacyEsphomePsk(cid)).toBe(false);
    expect(getDeviceEsphome(cid)).toEqual({ psk: "own-key", port: 6053 });
    clearPluginCfg();
  });

  it("设备行已记过的端口优先于旧全局端口", () => {
    const cid = freshId();
    saveDeviceEsphome(cid, "", 6100); // 只留端口
    writePluginCfg({ esphome_psk: "legacy-key", esphome_port: 6054 });
    expect(inheritLegacyEsphomePsk(cid)).toBe(true);
    expect(getDeviceEsphome(cid)).toEqual({ psk: "legacy-key", port: 6100 });
    clearPluginCfg();
  });

  it("同一设备只继承一次(第二次直接 false,不重写)", () => {
    const cid = freshId();
    writePluginCfg({ esphome_psk: "legacy-key", esphome_port: 6054 });
    expect(inheritLegacyEsphomePsk(cid)).toBe(true);
    // 用户随后清掉自己的密钥 —— 不该被「再继承一次」偷偷写回来
    saveDeviceEsphome(cid, "", 6054);
    expect(inheritLegacyEsphomePsk(cid)).toBe(false);
    expect(getDeviceEsphome(cid).psk).toBe("");
    clearPluginCfg();
  });

  it("窗口期已过 ⇒ 不再继承(避免旧密钥泼给之后新加的设备)", () => {
    const cid = freshId();
    writePluginCfg({ esphome_psk: "legacy-key", esphome_port: 6054 });
    expect(inheritLegacyEsphomePsk(cid, -1)).toBe(false);
    expect(getDeviceEsphome(cid)).toEqual({ psk: "", port: 0 });
    clearPluginCfg();
  });

  it("没有旧全局密钥 ⇒ 不继承;空 clientId ⇒ 不继承", () => {
    clearPluginCfg();
    expect(inheritLegacyEsphomePsk(freshId())).toBe(false);
    writePluginCfg({ esphome_psk: "legacy-key" });
    expect(inheritLegacyEsphomePsk("")).toBe(false);
    clearPluginCfg();
  });
});

// 解绑的完整语义:清掉服务端为这台设备保存过的**一切**。
// 与 deleteDeviceVolumeState(只删状态行)的区别是本组的核心 —— 改名/隐藏偏好同样要被清,
// 否则设备重连后会带着旧名字「复活」(用户以为已经清干净了)。
describe("purgeDeviceArtifacts(解绑 = 清掉这台设备的所有痕迹)", () => {
  const U1 = "purge-owner-1";
  const U2 = "purge-owner-2";
  const DEV = "purge-dev-1";
  const OTHER = "purge-dev-other";
  const peer = (cid: string) => "sendspin:" + cid;

  beforeAll(() => {
    for (const id of [U1, U2]) {
      sqlite.prepare("DELETE FROM users WHERE id = ?").run(id);
      db.insert(users).values({
        id,
        username: id + "-" + Date.now(),
        password: "",
        salt: "salt",
        subsonicSalt: "subsalt",
        passEnc: encryptPassword("pw"),
        isAdmin: 0,
        isActive: 1,
        email: "",
      }).run();
    }
  });

  afterAll(() => {
    for (const p of [peer(DEV), peer(OTHER)]) {
      db.delete(playerNameOverrides).where(eq(playerNameOverrides.peerId, p)).run();
      db.delete(playerPrefs).where(eq(playerPrefs.peerId, p)).run();
    }
    sqlite.prepare("DELETE FROM sendspin_device_state WHERE client_id IN (?, ?)").run(DEV, OTHER);
    sqlite.prepare("DELETE FROM users WHERE id IN (?, ?)").run(U1, U2);
  });

  /** 给 DEV 铺满「保存过的配置」:状态行 + 两个用户的改名 + 一个隐藏偏好。 */
  function seed(): void {
    saveDeviceVolumeState(DEV, { volume: 33, muted: true });
    saveDeviceDisabled(DEV, true);
    saveDeviceEsphome(DEV, "purge-key", 6054);
    for (const uid of [U1, U2]) {
      db.insert(playerNameOverrides)
        .values({ ownerUserId: uid, peerId: peer(DEV), displayName: "我的设备-" + uid, updatedAt: new Date().toISOString() })
        .run();
    }
    db.insert(playerPrefs)
      .values({ ownerUserId: U1, peerId: peer(DEV), hidden: 1, updatedAt: new Date().toISOString() })
      .run();
  }

  it("清掉状态行:音量/静音/禁用/6053 密钥/端口 全回缺省", () => {
    seed();
    purgeDeviceArtifacts(DEV);
    expect(getDeviceVolumeState(DEV)).toBeNull();
    expect(getDeviceDisabled(DEV)).toBe(false);
    expect(getDeviceEsphome(DEV)).toEqual({ psk: "", port: 0 });
  });

  it("清掉**所有用户**的改名与隐藏偏好(不只发起人那一份)", () => {
    seed();
    purgeDeviceArtifacts(DEV);
    expect(db.select().from(playerNameOverrides).where(eq(playerNameOverrides.peerId, peer(DEV))).all()).toEqual([]);
    expect(db.select().from(playerPrefs).where(eq(playerPrefs.peerId, peer(DEV))).all()).toEqual([]);
  });

  it("只清这一台:别的设备的行一动不动", () => {
    saveDeviceVolumeState(OTHER, { volume: 44, muted: false });
    saveDeviceEsphome(OTHER, "other-key", 6053);
    db.insert(playerNameOverrides)
      .values({ ownerUserId: U1, peerId: peer(OTHER), displayName: "别人", updatedAt: new Date().toISOString() })
      .run();

    seed();
    purgeDeviceArtifacts(DEV);

    expect(getDeviceVolumeState(OTHER)).toEqual({ volume: 44, muted: false });
    expect(getDeviceEsphome(OTHER)).toEqual({ psk: "other-key", port: 6053 });
    expect(db.select().from(playerNameOverrides).where(eq(playerNameOverrides.peerId, peer(OTHER))).all()).toHaveLength(1);
  });

  it("幂等:设备本就没被配置过 / 空 clientId ⇒ 不报错", () => {
    const fresh = "purge-never-configured";
    expect(() => purgeDeviceArtifacts(fresh)).not.toThrow();
    expect(() => purgeDeviceArtifacts(fresh)).not.toThrow();
    expect(() => purgeDeviceArtifacts("")).not.toThrow();
    expect(getDeviceVolumeState(fresh)).toBeNull();
  });
});
