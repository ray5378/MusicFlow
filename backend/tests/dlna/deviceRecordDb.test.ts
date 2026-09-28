// services/dlna/control.ts —— 设备持久化与回环凭证的「写后读回」契约。
//
// 这一组用例全打下 sqlite 真实库上(每文件独立 DATA_DIR),专攻那些**缓存里没有、
// 但库里有记录**的边界:离线设备 / 手动禁用的设备 / 刚入库还没被主动扫描捞到的设备。
// 它们的共同要求:写已经成功,就不能因为"内存缓存里没有"而返回 undefined ——
// 调用方会把 undefined 翻成 404,于是用户"改了个名字却被告知设备不存在"。
import "../plugins/_env.js";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initDatabase, sqlite } from "../../src/db/index.js";

// eventing 真单例会带订阅续期定时器;这里只用到 `emitDeviceListChanged`,换掉即可,
// 免得测试结束后留下没清干净的定时器。
vi.mock("../../src/services/dlna/eventing.js", () => ({
  getEventManager: () => ({
    emit: () => {},
    emitDeviceListChanged: () => {},
    isSubscribed: () => false,
    subscribe: async () => {},
  }),
}));

import {
  createCastSession,
  resolveCastSession,
  setDeviceAlias,
  setDeviceDisabled,
  isDeviceDisabled,
  mintRawStreamToken,
  resolveRawStreamToken,
  loopbackBase,
  setRuntimePort,
  getCachedDevices,
} from "../../src/services/dlna/control.js";

let seq = 0;
const nextId = () => `b7rec-${++seq}`;

/** 直接往库里塞一条设备记录(模拟"重启后从库里恢复、还没被这一轮扫描捞到")。 */
function insertRow(o: Partial<Record<string, unknown>> = {}): string {
  const id = String(o.id ?? nextId());
  sqlite.prepare(
    `INSERT INTO dlna_devices (id, name, alias, manufacturer, model, first_seen, last_seen, available, disabled, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    (o.name as string) ?? "",
    (o.alias as string) ?? "",
    (o.manufacturer as string) ?? "",
    (o.model as string) ?? "",
    (o.first_seen as string) ?? "2026-01-01T00:00:00.000Z",
    (o.last_seen as string) ?? "",
    (o.available as number) ?? 0,
    (o.disabled as number) ?? 0,
    (o.updated_at as string) ?? "2026-01-01T00:00:00.000Z",
  );
  return id;
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("readDlnaDeviceRow:缓存缺失时必须能从库里读回", () => {
  it("改名的设备不在内存缓存 → 依然返回最新状态(不能被翻成 404)", () => {
    const id = insertRow({ name: "Kitchen", manufacturer: "MUZO", model: "H5" });
    expect(getCachedDevices().some((d) => d.id === id)).toBe(false);

    const got = setDeviceAlias(id, "厨房");
    expect(got).toBeDefined();
    expect(got!.alias).toBe("厨房");
    // 库里的记录一律按「离线」读回 —— 它没有 location / control URL,还不能播放,
    // 要等下一轮扫描或 SSDP alive 到达。这不算错,调用方据此知道此刻投不了。
    expect(got!.available).toBe(false);
    expect(got!.location).toBe("");
    expect(got!.manufacturer).toBe("MUZO");
    expect(got!.model).toBe("H5");
  });

  it("库里 name 为空 → 回落到『未知设备』,不返回空字符串给用户列表", () => {
    const id = insertRow({ name: "" });
    const got = setDeviceAlias(id, "书房");
    expect(got!.name).toBe("未知设备");
  });

  it("last_seen 是 ISO 字符串 → 解析成毫秒;空串则是 0(不是 NaN)", () => {
    const withTs = insertRow({ last_seen: "2026-03-04T05:06:07.000Z" });
    expect(setDeviceAlias(withTs, "x")!.lastSeen).toBe(Date.parse("2026-03-04T05:06:07.000Z"));
    const empty = insertRow({ last_seen: "" });
    expect(setDeviceAlias(empty, "y")!.lastSeen).toBe(0);
  });

  it("彻底不存在的设备 → undefined(调用方的 404 在这种情况才是对的)", () => {
    expect(setDeviceAlias("no-such-" + nextId(), "z")).toBeUndefined();
    expect(setDeviceDisabled("no-such-" + nextId(), true)).toBeUndefined();
  });
});

describe("setDeviceDisabled:禁用于启用都必须落库并可读回", () => {
  it("先禁用再启用 → disabled 位跟着走,且 DB 兜底的判定同步更新", () => {
    const id = insertRow({ name: "Bedroom" });
    expect(setDeviceDisabled(id, true)!.disabled).toBe(true);
    expect(isDeviceDisabled(id)).toBe(true);      // 走的是 DB 兜底分支(设备不在缓存)
    expect(setDeviceDisabled(id, false)!.disabled).toBe(false);
    expect(isDeviceDisabled(id)).toBe(false);
  });

  it("完全未知的设备被禁用 → 拒绝并返回 undefined(不许凭空造出一条记录)", () => {
    const id = "never-seen-" + nextId();
    expect(setDeviceDisabled(id, true)).toBeUndefined();
    const row = sqlite.prepare("SELECT 1 AS x FROM dlna_devices WHERE id = ?").get(id);
    expect(row).toBeUndefined();   // 守卫在前:不在缓存也不在库 ⇒ 直接拒绝
    expect(isDeviceDisabled(id)).toBe(false);
  });
});

describe("回环取流凭证:坏数据不能拖累取流", () => {
  it("headers_json 损坏 → headers 作废但 url 仍能取到(不能把整条凭证判废)", () => {
    const token = mintRawStreamToken("https://cdn.example.com/a.flac", { Authorization: "Bearer x" });
    sqlite.prepare("UPDATE raw_stream_tokens SET headers_json = ? WHERE token = ?")
      .run("{not-json", token);
    const got = resolveRawStreamToken(token);
    expect(got).not.toBeNull();
    expect(got!.url).toBe("https://cdn.example.com/a.flac");
    expect(got!.headers).toBeUndefined();
  });

  it("loopbackBase:无运行时端口时用 PORT,有则用运行时的那条", () => {
    const prev = process.env.PORT;
    process.env.PORT = "49001";
    expect(loopbackBase()).toBe("http://127.0.0.1:49001");
    // 入口 listen 之后回填的端口优先级更高(测试起在随机端口也必须打通)
    setRuntimePort(49002);
    expect(loopbackBase()).toBe("http://127.0.0.1:49002");
    process.env.PORT = prev ?? "";
    if (prev === undefined) delete process.env.PORT;
  });
});

describe("createCastSession:会话表不能无限增长", () => {
  it("超过 50 条的惰性清理只清已过期的 —— 在用的会话必须活下来", () => {
    for (let i = 0; i < 40; i++) {
      createCastSession(`stale-${i}`, `dev-${i}`, "http://192.168.1.5:46400");
    }
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 7 * 24 * 60 * 60 * 1000); // 前进 7d > 6h TTL

    // 此时系统时间已过 7 天:立刻再读一条刚建的会话应该还在有效期内。
    const freshBefore = createCastSession("old-1", "dev-old", "http://192.168.1.5:46400").token;
    expect(resolveCastSession(freshBefore)).not.toBeNull();

    const keep = createCastSession("fresh-1", "dev-fresh", "http://192.168.1.5:46400").token;
    // 越过 50 条 ⇒ 触发惰性清理。它可能清理掉上面那堆过期会话,
    // 但**绝不能**把还在有效期内的 keep 一并丢掉(丢掉就是"歌放到一半被判 token 无效")。
    for (let i = 0; i < 12; i++) {
      createCastSession(`filler-${i}`, `dev-filler-${i}`, "http://192.168.1.5:46400");
    }
    expect(resolveCastSession(keep)).toEqual({ songId: "fresh-1", deviceId: "dev-fresh" });
    // 同一 (songId, deviceId) 依然会被复用(不是被清掉后重新洗牌)
    expect(createCastSession("fresh-1", "dev-fresh", "http://192.168.1.5:46400").token).toBe(keep);
    vi.useRealTimers();
  });
});
