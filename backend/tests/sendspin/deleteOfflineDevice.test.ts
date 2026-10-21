// 删除「离线 Sendspin 设备」的语义锁(2026-10-21 用户需求):
//   - 只有**离线**设备可删;在线一律拒绝(删除不可撤销,避免误删正在播放的设备);
//   - 删除 = 彻底移除:持久档案(音量/禁用/6053 密钥)、配对记录、改名/隐藏偏好、
//     peer 占位行、记住的拨号目标;下次要用必须重新发现/配对;
//   - 未知设备 → not-found(不凭空删除、不报 500)。
// 与「禁用」(可恢复)和「解绑」(在线、只清配置)的边界由本文件钉死。
//
// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { initDatabase, db, sqlite, encryptPassword } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { getPeerManager } from "../../src/services/peer.js";
import * as ds from "../../src/services/sendspin/deviceState.js";
import * as pp from "../../src/services/playerPrefs.js";
import {
  sendspinDeleteOfflineDevice,
  setSendspinIdentityDir,
  rememberDialTarget,
  listDialTargets,
} from "../../src/services/sendspin/index.js";

const CID = "delete-offline-1";
const PID = `sendspin:${CID}`;
const HOST = "203.0.113.9";
const UID = "u-del-offline"; // 改名/隐藏偏好是「每用户」的,必须有一条真实用户行(FK)
const pm = getPeerManager();

function clear(): void {
  ds.deleteDeviceVolumeState(CID);
  pm.removeSendspinPeer(CID);
  pp.purgePeerPrefsAllOwners(PID);
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  sqlite.prepare("DELETE FROM users WHERE id = ?").run(UID);
  db.insert(users).values({
    id: UID,
    username: `del-owner-${Date.now()}`,
    password: "",
    salt: "salt",
    subsonicSalt: "subsalt",
    passEnc: encryptPassword("pw"),
    isAdmin: 0,
    isActive: 1,
    email: "",
  }).run();
  setSendspinIdentityDir(fs.mkdtempSync(path.join(os.tmpdir(), "sendspin-delete-")));
});

beforeEach(clear);
afterEach(clear);

describe("sendspinDeleteOfflineDevice:只有离线设备可删", () => {
  it("在线设备拒绝删除,档案与 peer 原样保留", async () => {
    ds.saveDeviceVolumeState(CID, { volume: 33 });
    pm.registerSendspin(CID, "Speaker", true);

    expect(await sendspinDeleteOfflineDevice(CID)).toBe("online");
    expect(ds.getDeviceVolumeState(CID)?.volume).toBe(33);
    expect(pm.get(PID)?.available).toBe(true);
  });

  it("离线设备:档案 / 改名 / 隐藏 / 占位行 / 拨号记忆全部清掉", async () => {
    ds.saveDeviceVolumeState(CID, { volume: 33 });
    ds.saveDeviceHost(CID, HOST); // 保留音量,只更新 last_host
    pp.setPeerNameOverride(UID, PID, "旧客厅音箱");
    pp.setPeerHidden(UID, PID, true);
    await rememberDialTarget(HOST, 8928);
    pm.registerSendspin(CID, "Speaker", true);
    pm.markSendspinUnavailable(CID); // 断连只置离线:行还在
    expect(pm.get(PID)?.available).toBe(false);

    expect(await sendspinDeleteOfflineDevice(CID)).toBe("deleted");
    expect(ds.getDeviceVolumeState(CID)).toBeNull();
    expect(ds.getDeviceLastHost(CID)).toBe("");
    expect(pp.getPeerNameOverride(UID, PID)).toBe("");
    expect(pp.isPeerHidden(UID, PID)).toBe(false);
    expect(pm.get(PID)).toBeUndefined();
    // 拨号记忆也要遗忘,否则自动发现下一轮又会把它拨回来
    expect((await listDialTargets()).some((t) => t.host === HOST)).toBe(false);
  });

  it("已禁用且离线:可删除,并从禁用清单消失", async () => {
    ds.saveDeviceDisabled(CID, true);
    expect(ds.listDisabledDeviceIds()).toContain(CID);

    expect(await sendspinDeleteOfflineDevice(CID)).toBe("deleted");
    expect(ds.listDisabledDeviceIds()).not.toContain(CID);
    expect(ds.getDeviceDisabled(CID)).toBe(false);
  });

  it("未知设备 → not-found(幂等,不凭空删除)", async () => {
    expect(await sendspinDeleteOfflineDevice("never-seen-xyz")).toBe("not-found");
    expect(await sendspinDeleteOfflineDevice("")).toBe("not-found");
  });
});
