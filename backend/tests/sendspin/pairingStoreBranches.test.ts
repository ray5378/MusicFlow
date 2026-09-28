// ==================== PairingStore 加载/热身补测 ====================
//
// 缺口:PairingStore.open 的**已有文件**加载分支（records 校验 + unpairedApproved）、
// listRecords 形状、touchRecord 的 lastUsedAt 刷新与落盘。
// 契约:
//   - pskHex 长度 ≠ 64 的记录视为损坏，**丢弃**（否则握手 msg1 会引用到非法 psk_id）；
//   - unpairedApproved 只接受数字（时间戳），非数字丢弃；
//   - listRecords 必须把 Map key 补成 clientId（子进程快照/前端列表依赖该字段）；
//   - touchRecord 只在记录存在时刷新 lastUsedAt 并落盘，未知 clientId 静默 no-op。
import "../plugins/_env.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { PairingStore } from "../../src/services/sendspin/pairingStore.js";

const GOOD = "ab".repeat(32); // 64 hex

describe("PairingStore.open 既有文件", () => {
  let dir: string;
  let store: PairingStore;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sendspin-pstore-br-"));
    fs.mkdirSync(path.join(dir, "sendspin"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "sendspin", "pairing_store.json"),
      JSON.stringify({
        records: {
          good: { pskHex: GOOD, pskId: "id-good", createdAt: 1, lastUsedAt: 0 },
          // 损坏行:pskHex 长度不对 —— 必须被丢弃，不得进内存
          shortpsk: { pskHex: "abcd", pskId: "id-bad", createdAt: 2, lastUsedAt: 2 },
          // 结构不对:缺少 pskHex
          malformed: { createdAt: 3, lastUsedAt: 3 },
        },
        unpairedApproved: { appr: 123, notnum: "x" },
      }),
      "utf8",
    );
    store = await PairingStore.open(dir);
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("合法记录被加载，损坏记录被丢弃", () => {
    expect(store.getRecord("good")?.pskHex).toBe(GOOD);
    expect(store.getRecord("shortpsk")).toBeUndefined();
    expect(store.getRecord("malformed")).toBeUndefined();
  });

  it("unpairedApproved 只收数字时间戳", () => {
    expect(store.listApproved()).toEqual([{ clientId: "appr", approvedAt: 123 }]);
    expect(store.isApproved("notnum")).toBe(false);
    expect(store.isApproved("appr")).toBe(true);
  });

  it("listRecords 形状 = {clientId, ...record}", () => {
    const rows = store.listRecords();
    expect(rows).toHaveLength(1);
    // lastUsedAt 可能被同文件的其他用例（touchRecord）刷新过，故只断言不变字段，
    // 保持用例顺序无关（套件 shuffle 开启）。
    expect(rows[0]).toMatchObject({
      clientId: "good",
      pskHex: GOOD,
      pskId: "id-good",
      createdAt: 1,
    });
    expect(rows[0]).toHaveProperty("lastUsedAt");
  });

  it("touchRecord：已存在则刷新 lastUsedAt 并落盘；未知 clientId 静默", async () => {
    await store.touchRecord("ghost"); // 不存在的：no-op，不抛
    expect(store.getRecord("ghost")).toBeUndefined();

    await store.touchRecord("good");
    expect(store.getRecord("good")!.lastUsedAt).toBeGreaterThan(0);

    // 落盘（防抖 200ms）后再开一个新实例，确认 lastUsedAt 的刷新被持久化
    await new Promise((r) => setTimeout(r, 320));
    const reopened = await PairingStore.open(dir);
    expect(reopened.getRecord("good")!.lastUsedAt).toBeGreaterThan(0);
  });
});
