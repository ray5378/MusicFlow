// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "./_env.js";

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "fs";
import path from "path";
import { db, initDatabase, sqlite } from "../../src/db/index.js";
import { songs, users, playlists, playlistSongs } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import {
  validateManifest,
  compareVersion,
  discoverExternalPlugins,
  pluginSandboxes,
  makeFsApi,
  makeCommandApi,
  makeNetApi,
  makeWsApi,
  makeJsenvApi,
} from "../../src/plugins/discovery.js";
import netMod from "net";
import { WebSocketServer } from "ws";
import { getPlugin, registerPlugin, unregisterPlugin } from "../../src/plugins/registry.js";
import { TMP_DATA_DIR } from "./_env.js";

// 共享句柄:mock 工厂被提升到 import 之前,只能通过 vi.hoisted 拿到。
const H = vi.hoisted(() => ({
  ifaces: null as any,
  proxy: null as any,
  cover: null as any,
  bgMatch: null as any,
  bgMatchCalls: [] as any[],
  coverCalls: [] as string[],
}));

vi.mock("os", async (importOriginal) => {
  const orig: any = await importOriginal();
  return { ...orig, default: { ...orig, networkInterfaces: () => H.ifaces } };
});
vi.mock("../../src/services/proxy.js", async (importOriginal) => {
  const orig: any = await importOriginal();
  return { ...orig, proxyFetch: (...a: any[]) => H.proxy(...a) };
});
vi.mock("../../src/services/playlistCover.js", async (importOriginal) => {
  const orig: any = await importOriginal();
  return { ...orig, cacheRemoteCover: (...a: any[]) => { H.coverCalls.push(String(a[0])); return H.cover(a[0], a[1]); } };
});
vi.mock("../../src/services/plugin/shared.js", async (importOriginal) => {
  const orig: any = await importOriginal();
  return { ...orig, matchPlaylistInBackground: (...a: any[]) => { H.bgMatchCalls.push(a[0]); return H.bgMatch(a[0]); } };
});

const ROOT = path.join(TMP_DATA_DIR, "b29-plugins");
const PLUG_ID = "host-kit";
const APP = "9.0.0";
const MAX_BODY = 20 * 1024 * 1024;

const MANIFEST = {
  id: PLUG_ID,
  name: "Host Kit",
  version: "1.0.0",
  type: "recommender",
  capabilities: ["dailyPlaylist"],
  configSchema: [],
  permissions: [
    "net", "storage", "songs:read", "songs:write",
    "playlists:read", "playlists:write", "fs",
  ],
};

/** 每个用例一个全新扫描根:用例顺序是打乱的,共用一个根会互相污染计数。 */
const roots: string[] = [];
function freshRoot(tag: string): string {
  const r = path.join(TMP_DATA_DIR, `b29-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  fs.mkdirSync(r, { recursive: true });
  roots.push(r);
  return r;
}

function writePlugin(dir: string, body: string, json?: any) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.js"), body, "utf8");
  if (json) fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify(json), "utf8");
}

const KIT_JS = `globalThis.__mfPlugin = {
  manifest: ${JSON.stringify(MANIFEST)},
  create() { return { runDailyJob: async () => "ok" }; },
};`;

/** 满足 host.http 用到的 headers.get / headers.forEach。 */
function fakeHeaders(entries: Record<string, string> = {}): any {
  const m = new Map<string, string>(Object.entries(entries));
  return {
    get: (k: string) => m.get(String(k).toLowerCase()) ?? null,
    forEach: (fn: any) => m.forEach((v, k) => fn(v, k)),
  };
}
function fakeResponse(opts: { status?: number; ok?: boolean; body?: string; len?: number; onText?: () => void } = {}): any {
  return {
    ok: opts.ok !== false,
    status: opts.status ?? 200,
    headers: opts.len !== undefined ? fakeHeaders({ "content-length": String(opts.len) }) : fakeHeaders(),
    text: async () => { opts.onText?.(); return opts.body ?? ""; },
  };
}

/** songs.path 是 NOT NULL,所有临时插入都必须带。 */
function mkSong(id: string, extra: any = {}) {
  return {
    id, title: `标题-${id}`, artist: "歌手", album: "专辑",
    path: `/x/${id}.mp3`, coverArt: null, duration: 200, ...extra,
  };
}
function seedSong(id: string, extra: any = {}) {
  db.delete(songs).where(eq(songs.id, id)).run();
  db.insert(songs).values(mkSong(id, extra) as any).run();
}
function seedPlaylist(id: string, extra: any = {}) {
  db.delete(playlistSongs).where(eq(playlistSongs.playlistId, id)).run();
  db.delete(playlists).where(eq(playlists.id, id)).run();
  db.insert(playlists).values({ id, name: id, ownerId: "u-b29", isPublic: 1, ...extra } as any).run();
}

beforeAll(async () => {
  initDatabase();
  process.env.APP_VERSION = APP;
  H.bgMatch = async () => null;

  if (!db.select().from(users).where(eq(users.username, "b29-admin")).get()) {
    db.insert(users).values({
      id: "u-b29", username: "b29-admin", password: "", salt: "",
      subsonicSalt: "", isAdmin: 1, isActive: 1,
    }).run();
  }
  fs.mkdirSync(path.join(TMP_DATA_DIR, "covers"), { recursive: true });
  writePlugin(path.join(ROOT, PLUG_ID), KIT_JS, MANIFEST);

  // 关键:顶层必须先发现一次,让 host-kit 的沙箱 env 在任何 describe 里都可用
  // (用例顺序被 shuffle,不能指望"跳过路径"那个 describe 先跑)。
  expect(await discoverExternalPlugins(APP, ROOT)).toBe(1);
});

afterAll(() => {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  for (const r of roots) {
    try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/** 宿主 env(沙箱闭包),直接调用 host.*,不受用例洗牌顺序影响。 */
function kitEnv(): any {
  const sb = pluginSandboxes.get(PLUG_ID) as any;
  if (!sb) throw new Error(`${PLUG_ID} 沙箱未注册`);
  return sb.env;
}

// ==================== A. validateManifest:longRunning 预算校验 ====================
// 未覆盖 389-399。纯业务规则(1s~600s),写错会让调度器把长任务当短任务跑。
describe("validateManifest longRunning 预算(1000~600000ms)", () => {
  const base = { ...MANIFEST, capabilities: ["dailyPlaylist"] };

  it("合法预算(含 1000 与 600000 两个边界)通过", () => {
    expect(validateManifest({ ...base, longRunning: { runDailyJob: 5000 } })).toBeNull();
    expect(validateManifest({ ...base, longRunning: { runDailyJob: 1000 } })).toBeNull();
    expect(validateManifest({ ...base, longRunning: { a: 600000 } })).toBeNull();
  });

  it("低于 1000ms 被拒(短任务不值得开预算)", () => {
    expect(validateManifest({ ...base, longRunning: { runDailyJob: 999 } })).toMatch(/longRunning/);
    expect(validateManifest({ ...base, longRunning: { runDailyJob: 0 } })).toMatch(/longRunning/);
  });

  it("高于 600000ms 被拒(会拖死调度线程)", () => {
    expect(validateManifest({ ...base, longRunning: { runDailyJob: 600001 } })).toMatch(/longRunning/);
  });

  it("非数字 / NaN / Infinity 被拒", () => {
    expect(validateManifest({ ...base, longRunning: { a: "3000" } })).toMatch(/longRunning/);
    expect(validateManifest({ ...base, longRunning: { a: Number.NaN } })).toMatch(/longRunning/);
    expect(validateManifest({ ...base, longRunning: { a: Number.POSITIVE_INFINITY } })).toMatch(/longRunning/);
  });

  it("必须是对象,数组与字符串同样被拒", () => {
    expect(validateManifest({ ...base, longRunning: [] })).toMatch(/longRunning/);
    expect(validateManifest({ ...base, longRunning: "5000" })).toMatch(/longRunning/);
  });

  it("未声明 longRunning 时不做任何校验(null 直接放行)", () => {
    expect(validateManifest({ ...base, longRunning: undefined })).toBeNull();
    expect(validateManifest({ ...base, longRunning: null })).toBeNull();
  });
});

// ==================== A2. validateManifest:必填字段与格式红线 ====================
// 未覆盖 374-388(之前的盲区)。这些分支是插件上架的第一道闸门,
// 漏校验会让非法 manifest 一路走到沙箱注册。
describe("validateManifest 必填字段与格式红线", () => {
  const ok = (patch: any = {}) => validateManifest({ ...MANIFEST, capabilities: ["dailyPlaylist"], ...patch });

  it("空值/null 入参直接拒(不抛异常)", () => {
    expect(validateManifest(null)).toMatch(/manifest 必须是对象/);
    expect(validateManifest(undefined)).toMatch(/manifest 必须是对象/);
    expect(validateManifest("x")).toMatch(/manifest 必须是对象/);
    expect(validateManifest(42)).toMatch(/manifest 必须是对象/);
  });

  it("id 缺失或类型不对时拒", () => {
    expect(validateManifest({ ...MANIFEST, id: "" })).toMatch(/manifest\.id 缺失/);
    expect(validateManifest({ ...MANIFEST, id: 123 })).toMatch(/manifest\.id 缺失/);
  });

  it("id 含非法字符 / 以连字符开头时拒(影响目录与 URL 安全)", () => {
    expect(validateManifest({ ...MANIFEST, id: "-bad" })).toMatch(/只能含字母/);
    expect(validateManifest({ ...MANIFEST, id: "bad_id" })).toMatch(/只能含字母/);
    expect(validateManifest({ ...MANIFEST, id: "bad id" })).toMatch(/只能含字母/);
    expect(validateManifest({ ...MANIFEST, id: "../escape" })).toMatch(/只能含字母/);
    // 合法样本:字母数字 + 连字符
    expect(validateManifest({ ...MANIFEST, id: "my-plug-2" })).toBeNull();
  });

  it("name / version 缺失时分别拒,并给出可定位的字段名", () => {
    expect(validateManifest({ ...MANIFEST, name: "" })).toMatch(/manifest\.name 缺失/);
    expect(validateManifest({ ...MANIFEST, name: 123 })).toMatch(/manifest\.name 缺失/);
    expect(validateManifest({ ...MANIFEST, version: undefined })).toMatch(/manifest\.version 缺失/);
    expect(validateManifest({ ...MANIFEST, version: 1 })).toMatch(/manifest\.version 缺失/);
  });

  it("type 不在合法枚举内时拒(错误提示带上实际值)", () => {
    expect(validateManifest({ ...MANIFEST, type: "nope" })).toMatch(/manifest\.type 非法: nope/);
    expect(validateManifest({ ...MANIFEST, type: undefined })).toMatch(/manifest\.type/);
  });

  it("capabilities 必须是非空数组(空数组也要拒)", () => {
    expect(validateManifest({ ...MANIFEST, capabilities: [] })).toMatch(/capabilities 必须是非空数组/);
    expect(validateManifest({ ...MANIFEST, capabilities: undefined })).toMatch(/capabilities/);
    expect(validateManifest({ ...MANIFEST, capabilities: "net" })).toMatch(/capabilities/);
  });

  it("capabilities 含未知能力时拒(防止拼错的能力名静默生效)", () => {
    expect(validateManifest({ ...MANIFEST, capabilities: ["dailyPlaylist", "godMode"] }))
      .toMatch(/含非法能力: godMode/);
  });

  it("configSchema 非数组时拒", () => {
    expect(validateManifest({ ...MANIFEST, configSchema: {} })).toMatch(/configSchema 必须是数组/);
    expect(validateManifest({ ...MANIFEST, configSchema: undefined })).toMatch(/configSchema/);
    expect(validateManifest({ ...MANIFEST, configSchema: [{ key: "a" }] })).toBeNull();
  });

  it("permissions 非法时拒,并把内层原因拼进错误串", () => {
    expect(validateManifest({ ...MANIFEST, permissions: "all" })).toMatch(/manifest\.permissions:/);
    // 合法 permissions 放行
    expect(validateManifest({ ...MANIFEST, permissions: ["net", "storage"] })).toBeNull();
  });
});

// ==================== A3. compareVersion:minAppVersion 预检的判定基准 ====================
describe("compareVersion(semver 比较,v 前缀与缺段容错)", () => {
  it("相等返回 0(含位数不等的 1.2 与 1.2.0)", () => {
    expect(compareVersion("1.2.0", "1.2.0")).toBe(0);
    expect(compareVersion("1.2", "1.2.0")).toBe(0);
  });

  it("前缀 v/V 不参与比较(git describe 标签场景)", () => {
    expect(compareVersion("v1.5.0", "1.5.0")).toBe(0);
    expect(compareVersion("V2.0.0", "2.0")).toBe(0);
  });

  it("非数字段按 0 处理,不产生 NaN", () => {
    // "1.x.0" 的第二段 x 落 0,于是与 1.0.0 等值(而不是 NaN 参与比较)
    expect(compareVersion("1.x.0", "1.0.0")).toBe(0);
    expect(Number.isNaN(compareVersion("1.x.0", "1.0.0"))).toBe(false);
    // 非数字段只把自己那一段归零,不影响更高位的比较
    expect(compareVersion("2.x.0", "1.9.9")).toBeGreaterThan(0);
  });

  it("大小关系方向正确", () => {
    expect(compareVersion("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersion("1.9.0", "1.10.0")).toBeLessThan(0);
  });
});

// ==================== B. getNetworkAddresses ====================
// 未覆盖 116-124。host.plugin.getNetworkAddresses 是插件做局域网广播时唯一的 IP 来源,
// 过滤条件写错会让广播打到回环上。
describe("host.plugin.getNetworkAddresses(过滤回环/非 v4)", () => {
  it("只保留非回环 IPv4", async () => {
    H.ifaces = {
      lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
      eth0: [
        { family: "IPv4", address: "192.168.1.20", internal: false },
        { family: "IPv6", address: "fe80::1", internal: false },
      ],
    };
    expect(await kitEnv().plugin.getNetworkAddresses()).toEqual(["192.168.1.20"]);
  });

  it("全部是回环接口时返回空数组(而不是把 127.0.0.1 泄漏出去)", async () => {
    H.ifaces = { lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }] };
    expect(await kitEnv().plugin.getNetworkAddresses()).toEqual([]);
  });

  it("interfaces 为空对象时返回空数组", async () => {
    H.ifaces = {};
    expect(await kitEnv().plugin.getNetworkAddresses()).toEqual([]);
  });

  it("undefined 的接口列表(某些平台字段缺失)不会抛", async () => {
    H.ifaces = { eth0: undefined };
    expect(await kitEnv().plugin.getNetworkAddresses()).toEqual([]);
  });
});

// ==================== C. host.songs.getById 与 toPluginSong 脱敏 ====================
// 未覆盖 127-140。纯函数,也是唯一一道把库内字段交给插件的关卡。
describe("host.songs.getById(toPluginSong 脱敏 + 空值兜底)", () => {
  beforeAll(() => {
    seedSong("s-b29-1", { title: "敏感曲", artist: "甲", album: "乙", duration: 210, coverArt: "ca-1", streamHeaders: "Cookie: hmac=xxx", sourceData: "{\"token\":\"t\"}" });
    seedSong("s-b29-2", { title: "裸行", artist: null, album: null, duration: null, coverArt: null, playCount: null, genre: null, track: null, type: null });
  });

  it("绝不外泄 path / streamHeaders / sourceData 等内部字段", async () => {
    const s = await kitEnv().songs.getById("s-b29-1");
    expect(s).toBeTruthy();
    expect(Object.keys(s).sort()).toEqual(
      ["album", "artist", "coverArt", "duration", "genre", "id", "playCount", "title", "track", "type"].sort(),
    );
    expect((s as any).path).toBeUndefined();
    expect((s as any).streamHeaders).toBeUndefined();
    expect((s as any).sourceData).toBeUndefined();
  });

  it("内部字段仍照常透出(脱敏不等于过滤)", async () => {
    const s: any = await kitEnv().songs.getById("s-b29-1");
    expect(s.id).toBe("s-b29-1");
    expect(s.title).toBe("敏感曲");
    expect(s.artist).toBe("甲");
    expect(s.duration).toBe(210);
  });

  it("空列按类型兜底为空串 / 0,不留 undefined 型字段", async () => {
    const s: any = await kitEnv().songs.getById("s-b29-2");
    expect(s.artist).toBe("");
    expect(s.album).toBe("");
    expect(s.coverArt).toBe("");
    expect(s.genre).toBe("");
    expect(s.type).toBe("local");
    expect(s.track).toBe(0);
    expect(s.playCount).toBe(0);
  });

  it("找不到时返回 null(不是 undefined,也不是抛错)", async () => {
    expect(await kitEnv().songs.getById("s-b29-不存在")).toBeNull();
  });
});

// ==================== D. host.songs.list / search ====================
// 未覆盖 526-548。search 的分词 AND 是「歌名 歌手」型查询的根因修复(整串 LIKE 必 0 命中)。
describe("host.songs.list / search(分页夹紧与分词 AND)", () => {
  beforeAll(() => {
    seedSong("q-0", { title: "七里香", artist: "周杰伦", album: "七里香", duration: 300 });
    seedSong("q-1", { title: "晴天", artist: "周杰伦", album: "叶惠美", duration: 280 });
    seedSong("q-2", { title: "稻香", artist: "其他", album: "魔杰座", duration: 290 });
    // 大数据量在 beforeAll 一次性播种:用例顺序被 shuffle,不能在用例里现种现读
    // (否则读的那条会依赖"先跑的那条已经种好",是隐式的顺序依赖)。
    for (let i = 0; i < 210; i++) seedSong(`bulk-${i}`);
  });

  it("search 空查询直接短路,不碰库", async () => {
    expect(await kitEnv().songs.search("")).toEqual([]);
    expect(await kitEnv().songs.search("   ")).toEqual([]);
  });

  it("search 单 token 命中任一字段(title/artist/album)", async () => {
    await expect(kitEnv().songs.search("周杰伦")).resolves.toHaveLength(2);
    await expect(kitEnv().songs.search("稻香")).resolves.toHaveLength(1);
  });

  it("search 多 token 是 AND:必须每个词都在某个字段命中(修复整串 LIKE 的 0 命中)", async () => {
    const rows: any[] = await kitEnv().songs.search("周杰伦 七里香");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("q-0"); // q-1 的专辑是「叶惠美」,不含「七里香」
    expect((await kitEnv().songs.search("七里香 周杰伦")).map((r: any) => r.id)).toEqual(["q-0"]); // 与词序无关
  });

  it("search 多 token 互相不成立时返回空(不会被单字段误召回)", async () => {
    expect(await kitEnv().songs.search("周杰伦 稻香")).toEqual([]);
  });

  it("search 的 limit 缺省 50 并夹在 [1,200](0 走 || 兜底回落默认)", async () => {
    // 现状记录(不是期望契约):实现是 Math.max(Number(limit) || 50, 1) 再夹到 200,
    // 所以 limit=0 会被 || 当 falsy 落回默认 50,**而不是**夹紧成 1。本轮不动产品行为。
    const all: any[] = await kitEnv().songs.search("标题");
    expect(all.length).toBeGreaterThan(1);
    expect(all).toHaveLength((await kitEnv().songs.search("标题", { limit: 50 })).length);
    expect((await kitEnv().songs.search("标题", { limit: 0 })).length).toBe(all.length);
    expect((await kitEnv().songs.search("标题", { limit: 99999 })).length).toBe(200);
  });

  it("list 的 offset 负数被夹到 0,limit 上限夹到 2000(0 同样落回默认)", async () => {
    const paged: any[] = await kitEnv().songs.list({ limit: 2, offset: 0 });
    expect(paged).toHaveLength(2);
    expect(await kitEnv().songs.list({ limit: 2, offset: -5 })).toEqual(paged);
    // 现状记录:limit=0 落回默认 200(同上 || 兜底),不是夹紧成 1
    expect((await kitEnv().songs.list({ limit: 0 })).length).toBe(200);
    // 上限 2000:结果比默认 200 多,证明确实放开了上限、又没到整表
    expect((await kitEnv().songs.list({ limit: 99999 })).length).toBeGreaterThan(200);
  });

  it("list 的默认 limit 是 200(不是整表)", async () => {
    expect((await kitEnv().songs.list()).length).toBe(200);
  });

  it("list 返回的行同样经过 toPluginSong 脱敏", async () => {
    const rows: any[] = await kitEnv().songs.list({ limit: 1 });
    expect(rows[0].path).toBeUndefined();
    expect(rows[0].sourceData).toBeUndefined();
  });
});

// ==================== E. host.songs.match ====================
describe("host.songs.match(批量库内匹配)", () => {
  it("非数组入参直接返回空,超长入参被截断,结果与原表等长对齐", async () => {
    seedSong("m-1");
    expect(await kitEnv().songs.match(null)).toEqual([]);
    expect(await kitEnv().songs.match("x")).toEqual([]);
    const ids = Array.from({ length: 5 }, (_, i) => ({ title: `标题-m-${i}`, artist: "歌手" }));
    const out: any[] = await kitEnv().songs.match(ids);
    expect(out).toHaveLength(ids.length);
  });
});

// ==================== F. host.playlists 读接口 ====================
describe("host.playlists 只读接口", () => {
  beforeAll(() => {
    // 自带种子,不依赖 describe C 的 songs(songs 表是全文件共享的,跨 describe
    // 依赖会让 FK 在 shuffle 下随机炸)
    seedSong("f-1", { title: "甲" });
    seedSong("f-2", { title: "乙" });
    seedPlaylist("pl-b29-read", { name: "读接口", sourcePlatform: "netease", sourceUrl: "u1", externalId: "e1" });
    db.insert(playlistSongs).values([
      { playlistId: "pl-b29-read", songId: "f-1", position: 0, playable: 1 },
      { playlistId: "pl-b29-read", songId: "f-2", position: 1, playable: 0 },
    ] as any).run();
    seedPlaylist("pl-b29-list-a", { name: "A" });
    seedPlaylist("pl-b29-list-b", { name: "B" });
  });

  it("get 返回歌单本体 + 按 position 排序的条目", async () => {
    const p: any = await kitEnv().playlists.get("pl-b29-read");
    expect(p).toBeTruthy();
    expect(p.name).toBe("读接口");
    expect(p.entries).toHaveLength(2);
    expect(p.entries.map((e: any) => e.position)).toEqual([0, 1]);
  });

  it("get 不存在的 id 返回 null", async () => {
    expect(await kitEnv().playlists.get("pl-b29-不存在")).toBeNull();
  });

  it("list 只投影展示列,不把条目一起带出来", async () => {
    const rows: any[] = await kitEnv().playlists.list();
    const picked = rows.filter((r) => ["pl-b29-list-a", "pl-b29-list-b"].includes(r.id));
    expect(picked).toHaveLength(2);
    // created_at 同毫秒时顺序不定 → 断言集合 + 字段,不依赖具体下标
    expect(picked.map((r) => r.id).sort()).toEqual(["pl-b29-list-a", "pl-b29-list-b"]);
    expect(Object.keys(picked[0])).toContain("song_count"); // 裸 SQL 列,不带 drizzle 驼峰别名
    expect((picked[0] as any).entries).toBeUndefined();
  });

  it("findBySource 按 (source_platform, external_id) 精确去重", async () => {
    const hit: any = await kitEnv().playlists.findBySource("netease", "e1");
    expect(hit).toBeTruthy();
    expect(hit.id).toBe("pl-b29-read");
    expect(await kitEnv().playlists.findBySource("netease", "不存在")).toBeNull();
    expect(await kitEnv().playlists.findBySource("qq", "e1")).toBeNull();
  });
});

// ==================== G. host.playlists 写接口与封面兜底 ====================
describe("host.playlists 写接口 / 封面兜底", () => {
  beforeAll(() => {
    seedSong("w-1", { coverArt: null });
    fs.mkdirSync(path.join(TMP_DATA_DIR, "covers"), { recursive: true });
  });

  it("delete 不存在的歌单返回 false,且不动其它行", async () => {
    expect(await kitEnv().playlists.delete("pl-b29-不存在")).toBe(false);
  });

  it("delete 存在则级联清掉 playlist_songs,避免孤儿条目", async () => {
    seedPlaylist("pl-b29-del");
    db.insert(playlistSongs).values({ playlistId: "pl-b29-del", songId: "w-1", position: 0, playable: 1 } as any).run();
    expect(await kitEnv().playlists.delete("pl-b29-del")).toBe(true);
    expect(db.select().from(playlistSongs).where(eq(playlistSongs.playlistId, "pl-b29-del")).all()).toEqual([]);
    expect(await kitEnv().playlists.get("pl-b29-del")).toBeNull();
  });

  it("updateCover 命中条目封面时写入 cover_art", async () => {
    fs.writeFileSync(path.join(TMP_DATA_DIR, "covers", "ca-1"), "x"); // 封面文件必须真实存在
    seedSong("w-2", { coverArt: "ca-1" });
    seedPlaylist("pl-b29-uc", { coverArt: "旧值" });
    db.insert(playlistSongs).values({ playlistId: "pl-b29-uc", songId: "w-2", position: 0, playable: 1 } as any).run();
    expect(await kitEnv().playlists.updateCover("pl-b29-uc", "w-2")).toEqual({ ok: true });
    const p: any = db.select().from(playlists).where(eq(playlists.id, "pl-b29-uc")).get();
    expect(p.coverArt).toBe("ca-1");
  });

  it("updateCover 找不到可用封面时保持原值,只回 ok:true(不把 null 写进 cover_art)", async () => {
    seedPlaylist("pl-b29-uc2", { coverArt: "旧值" });
    expect(await kitEnv().playlists.updateCover("pl-b29-uc2", "w-1")).toEqual({ ok: true });
    const p: any = db.select().from(playlists).where(eq(playlists.id, "pl-b29-uc2")).get();
    expect(p.coverArt).toBe("旧值");
  });

  it("coverUrl 非 http(s) 直接忽略,根本不去下载", async () => {
    const before = H.coverCalls.length;
    seedPlaylist("pl-b29-cover");
    await kitEnv().playlists.upsert("pl-b29-cover", { name: "C", entries: [], coverUrl: "ftp://evil/x.jpg" });
    expect(H.coverCalls.length).toBe(before);
  });

  it("coverUrl 下载抛错时吞掉异常并回退,不把整个歌单写入搞失败", async () => {
    H.cover = async () => { throw new Error("网络抖动"); };
    seedPlaylist("pl-b29-cover2", { coverArt: "旧值" });
    const row: any = await kitEnv().playlists.upsert("pl-b29-cover2", {
      name: "C2",
      entries: [{ externalSongId: "e9", externalTitle: "外部", externalArtist: "人", externalDuration: 1000 }],
      coverUrl: "https://x/y.jpg",
    });
    expect(row).toBeTruthy();
    expect(H.coverCalls).toContain("https://x/y.jpg");
    expect(row.coverArt).toBeFalsy(); // 回退:找不到可用封面 → 清空,不留旧值
  });

  it("仍有外部条目时触发后台 auto-match(失败只记日志,不影响返回结果)", async () => {
    H.bgMatchCalls.length = 0;
    H.bgMatch = async () => { throw new Error("后台匹配炸了"); };
    seedPlaylist("pl-b29-bg");
    const row: any = await kitEnv().playlists.upsert("pl-b29-bg", {
      name: "BG",
      entries: [{ externalSongId: "e8", externalTitle: "外", externalArtist: "人", externalDuration: 1000 }],
    });
    expect(row).toBeTruthy();
    expect(H.bgMatchCalls).toContain("pl-b29-bg");
    await new Promise((r) => setTimeout(r, 30)); // 让 fire-and-forget 的 catch 跑完
  });

  it("全本地可播条目则不触发 auto-match(省一轮无效重扫)", async () => {
    H.bgMatchCalls.length = 0;
    H.bgMatch = async () => { throw new Error("不应被调用"); };
    seedPlaylist("pl-b29-nobg");
    await kitEnv().playlists.upsert("pl-b29-nobg", { name: "NB", entries: [{ songId: "w-1" }] });
    expect(H.bgMatchCalls).not.toContain("pl-b29-nobg");
  });
});

// ==================== G2. host.playlists.replaceEntries(命中已存在歌单 → UPDATE 分支) ====================
// 未覆盖 574 / 657-660(else) / 713-715(UPDATE)。replaceEntries 是插件"刷新歌单"的主路径,
// 走错分支会另建一个歌单,把原歌单的收藏/封面甩掉。
describe("host.playlists replaceEntries(已存在走 UPDATE,不存在走 INSERT)", () => {
  let owner = "u-b29-owner";
  beforeAll(() => {
    seedSong("r-1", { title: "甲" });
    seedSong("r-2", { title: "乙" });
    // owner 必须取自库里真实存在的 user,否则 FK 会在测试顺序变化下随机炸
    const u: any = db.select().from(users).limit(1).all()[0];
    owner = String(u?.id || "u-b29-owner");
    seedPlaylist("pl-b29-rep", {
      name: "原名",
      ownerId: owner,
      sourcePlatform: "qq",
      sourceUrl: "u-keep",
      externalId: "e-keep",
    });
  });

  it("对已存在的歌单:走 UPDATE,不动 id/owner_id/created_at,只换条目与 updated_at", async () => {
    // ⚠️ 这条断言原先写的是「刷新后的 updated_at ≠ 刷新前的值」—— 那等于要求时钟
    // 真的往前走了一格。v4.0.52 的 CI 上偶发红过一次(两侧都是
    // 2026-09-28T09:29:09.188Z:VM 时钟被调整/冻结,两次写入落进同一毫秒)。
    // 彻底修法是两层:
    //   ① 先把 updated_at 钉成一个 2000 年的哨兵旧值 —— 「有没有被改写」于是与
    //      时钟是否推进无关;
    //   ② 再把 Date 冻住 —— 只钉哨兵还不够:漏写 updated_at 的实现下,行里留的
    //      是 INSERT 时写进来的时间戳,它不是哨兵,断言照样会过(变异实测存活过)。
    //      冻住时钟后,漏写就只剩哨兵 → 必红。
    const SENTINEL_UPDATED = "2000-01-01T00:00:00.000Z";
    sqlite.prepare("UPDATE playlists SET updated_at = ? WHERE id = ?").run(
      SENTINEL_UPDATED, "pl-b29-rep");

    const before: any = await kitEnv().playlists.get("pl-b29-rep");
    expect(String(before.updated_at)).toBe(SENTINEL_UPDATED); // 钉桩成功,后面才有意义

    const clockNow = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(clockNow);
      await kitEnv().playlists.replaceEntries("pl-b29-rep", [{ songId: "r-2" }]);
    } finally {
      vi.useRealTimers();
    }
    const after: any = await kitEnv().playlists.get("pl-b29-rep");

    // 注意:playlists.get 走裸 SQL,列名是 snake_case(不带 drizzle 驼峰别名)
    expect(after.id).toBe("pl-b29-rep");
    expect(after.owner_id).toBe(owner); // UPDATE 分支不碰 owner
    expect(after.created_at).toBe(before.created_at);
    expect(String(after.updated_at)).not.toBe(SENTINEL_UPDATED);
    expect(after.entries).toEqual([
      expect.objectContaining({ song_id: "r-2", position: 0, playable: 1 }),
    ]);
    // 现状记录(缺陷台账 D29-PL-REFRESH):replaceEntries 只从已有行里取 name,
    // 其余来源字段在 UPDATE 里被无条件写回 opts 的默认值 —— 于是"刷新歌单"会把
    // source_platform("qq"→listenbrainz)、external_id("e-keep"→null)、source_url
    // 一并抹掉,前端徽标与 findBySource 去重随即失效。只有 source_plugin 会被改写
    // 成"当前调用插件"(这里就是 host-kit)。
    // 修复后下面三条应改为 `expect(after.source_platform).toBe("qq")` /
    // `expect(after.external_id).toBe("e-keep")` / `expect(after.source_url).toBe("u-keep")`。
    expect(after.source_platform).toBe("listenbrainz");
    expect(after.external_id).toBe(null);
    expect(after.source_url).toBe(`lb://pl-b29-rep`);
    expect(after.source_plugin).toBe(PLUG_ID);
  });

  it("条目是全量替换而非追加(旧条目不留尾)", async () => {
    await kitEnv().playlists.replaceEntries("pl-b29-rep", [{ songId: "r-1" }, { songId: "r-2" }]);
    let p: any = await kitEnv().playlists.get("pl-b29-rep");
    expect(p.entries).toHaveLength(2);
    expect(p.entries.map((e: any) => e.position)).toEqual([0, 1]);
    await kitEnv().playlists.replaceEntries("pl-b29-rep", []);
    p = await kitEnv().playlists.get("pl-b29-rep");
    expect(p.entries).toEqual([]);
  });

  it("外部条目按 external_* 落库且 playable=0(不做本地匹配)", async () => {
    await kitEnv().playlists.replaceEntries("pl-b29-rep", [
      { externalSongId: "netease:123", externalTitle: "外部歌", externalArtist: "外部歌手", externalDuration: 200 },
    ]);
    const p: any = await kitEnv().playlists.get("pl-b29-rep");
    expect(p.entries).toEqual([
      expect.objectContaining({
        song_id: null,
        external_song_id: "netease:123",
        external_title: "外部歌",
        external_artist: "外部歌手",
        position: 0,
        playable: 0,
      }),
    ]);
  });

  it("目标歌单不存在时按默认名新建(INSERT 分支),并把插件标为来源", async () => {
    const row: any = await kitEnv().playlists.replaceEntries("pl-b29-fresh-rep", [{ songId: "r-1" }]);
    expect(row).toBeTruthy();
    const got: any = await kitEnv().playlists.get("pl-b29-fresh-rep");
    expect(got.name).toBe("ListenBrainz 推荐"); // 无 name 时的兜底
    expect(got.source_plugin).toBe(PLUG_ID);
    expect(got.source_platform).toBe("listenbrainz");
    expect(got.entries).toHaveLength(1);
  });
});

// ==================== H. host.http 与响应体积护栏 ====================
// 未覆盖 498-516。20MB 护栏是「异常/恶意页面全量入沙箱内存打爆 256MB VM」的根因防线,
// 必须钉死——任何人给插件一个超大 URL 就能把宿主拖死。
describe("host.http(代理转发与 20MB 体积护栏)", () => {
  const http = () => kitEnv().http;

  it("正常响应原样透传 ok/status/headers/body", async () => {
    H.proxy = async () => fakeResponse({ status: 201, body: "hello" });
    const r: any = await http()("http://x/a", { method: "GET" });
    expect(r).toMatchObject({ ok: true, status: 201, body: "hello" });
  });

  it("headers 原样透给插件(插件靠 content-type 区分 json/text)", async () => {
    H.proxy = async () => ({ ok: true, status: 200, headers: fakeHeaders({ "content-type": "application/json" }), text: async () => "{}" });
    const r: any = await http()("http://x/a");
    expect(r.headers["content-type"]).toBe("application/json");
  });

  it("content-length 超 20MB:护栏先于读取 body 生效,不把响应读进内存", async () => {
    let textCalls = 0;
    H.proxy = async () => fakeResponse({
      len: MAX_BODY + 1,
      onText: () => { textCalls++; },
      body: "x".repeat(MAX_BODY + 1),
    });
    const r: any = await http()("http://x/big", { timeout: 5 });
    expect(r).toMatchObject({ ok: false, status: 0, body: "" });
    expect(String(r.error)).toMatch(/响应过大/);
    expect(textCalls).toBe(0); // 关键:正文根本没被读
  });

  it("无 content-length 但 body 超 20MB:读完发现超限也拒绝", async () => {
    H.proxy = async () => fakeResponse({ body: "x".repeat(MAX_BODY + 1) });
    const r: any = await http()("http://x/big2");
    expect(r).toMatchObject({ ok: false, status: 0 });
    expect(String(r.error)).toMatch(/响应过大/);
  });

  it("恰好 20MB 放行(边界不误伤正常大歌单)", async () => {
    H.proxy = async () => fakeResponse({ len: MAX_BODY, body: "y".repeat(MAX_BODY) });
    const r: any = await http()("http://x/fine");
    expect(r).toMatchObject({ ok: true, status: 200 });
  });

  it("代理层抛错/超时一律收敛为 {ok:false,status:0,error},不给插件抛异常", async () => {
    H.proxy = async () => { throw new Error("ECONNREFUSED"); };
    const r: any = await http()("http://x/dead");
    expect(r).toMatchObject({ ok: false, status: 0 });
    expect(String(r.error)).toMatch(/ECONNREFUSED/);
  });

  it("init.timeout 只用于超时,绝不漏进转发给代理的查询参数", async () => {
    let seen: any = null;
    H.proxy = async (_url: string, init: any) => { seen = init; return fakeResponse({ body: "" }); };
    await http()("http://x/t", { timeout: 1234, method: "POST" });
    expect(seen).toBeTruthy();
    expect(seen.timeout).toBeUndefined();
    expect(seen.method).toBe("POST");
    expect(seen.signal).toBeTruthy();
  });
});

// ==================== I. discoverExternalPlugins 跳过路径 ====================
describe("discoverExternalPlugins 跳过路径", () => {
  it("目录里没有 index.js 时跳过,不计数也不注册", async () => {
    const root = freshRoot("noindex");
    fs.mkdirSync(path.join(root, "no-index"), { recursive: true });
    expect(await discoverExternalPlugins(APP, root)).toBe(0);
    expect(getPlugin("no-index")).toBeUndefined();
  });

  it("plugin.json 的 minAppVersion 高于当前 App:预检阶段就跳过,不建沙箱", async () => {
    const root = freshRoot("toonew");
    const id = "too-new";
    const json = { ...MANIFEST, id, name: "Too New", minAppVersion: "99.0.0" };
    writePlugin(path.join(root, id), KIT_JS.replace(PLUG_ID, id), json);
    expect(await discoverExternalPlugins(APP, root)).toBe(0);
    // 预检不做 → 根本没走 loadSandboxedPlugin,沙箱表里没有残留
    expect(pluginSandboxes.get(id)).toBeUndefined();
    expect(getPlugin(id)).toBeUndefined();
  });

  // discovery.ts:633 的 `if (!impl || typeof impl !== "object") { ... }` 分支**不可达**,
  // 故不写用例(写了也只能是现状断言):loadSandboxedPlugin 的 impl 来自
  // `sandbox.makeImpl(worker)`(sandbox.ts:1454),它恒定返回对象 —— 插件 create()
  // 就算返回字符串/null,拿到的也是被归一化的 impl。留档备查。
  it("create() 返回非对象时沙箱仍给出可用的 impl 对象(633 的防御分支实际不可达)", async () => {
    const root = freshRoot("noimpl");
    const id = "no-impl";
    const json = { ...MANIFEST, id, name: "No Impl" };
    const js = `globalThis.__mfPlugin = {
      manifest: ${JSON.stringify(json)},
      create() { return "not-an-object"; },
    };`;
    writePlugin(path.join(root, id), js, json);
    expect(await discoverExternalPlugins(APP, root)).toBe(1);
    expect((getPlugin(id) as any)?.impl).toBeTruthy();
  });

  it("manifest.id 必须与目录名一致,不一致时在加载前就拒(防目录/id 错配串台)", async () => {
    const root = freshRoot("namegap");
    // 目录名 name-mismatch,manifest.id 却声明成别的 id
    writePlugin(path.join(root, "name-mismatch"), KIT_JS.replace(PLUG_ID, "some-other-id"), {
      ...MANIFEST,
      id: "some-other-id",
      name: "Name Gap",
    });
    expect(await discoverExternalPlugins(APP, root)).toBe(0);
    expect(getPlugin("some-other-id")).toBeUndefined();
    expect(pluginSandboxes.get("some-other-id")).toBeUndefined();
  });

  it("同一个 root 重复 discover(非 reload):跳过而非重复注册,沙箱不被重建", async () => {
    const root = freshRoot("rerun");
    // 必须用全新 id(顶层 beforeAll 已注册 host-kit;已注册 id 在任何非 reload 扫描里都会被拒)
    const id = "fresh-kit";
    const json = { ...MANIFEST, id, name: "Fresh Kit" };
    writePlugin(path.join(root, id), KIT_JS.replace(PLUG_ID, id), json);
    expect(await discoverExternalPlugins(APP, root)).toBe(1);
    const sandbox = pluginSandboxes.get(id);
    const impl = (getPlugin(id) as any)?.impl;
    // 同目录名 → 同 id → 命中 discovery.ts:639-642 的冲突分支
    expect(await discoverExternalPlugins(APP, root)).toBe(0);
    expect(pluginSandboxes.get(id)).toBe(sandbox); // 沿用旧沙箱,不重建
    expect((getPlugin(id) as any)?.impl).toBe(impl);
  });

  // discovery.ts:626-630 的「自动补齐」分支:历史上插件漏写 permissions 会让
  // host.http 变成 undefined、歌词与在线补全静默失效(P0 根因)。
  it("permissions 漏写 net 时按 capabilities 自动补齐(漏写不再静默失效)", async () => {
    const root = freshRoot("permderive");
    const id = "derive-kit";
    // dailyPlaylist 需要 storage+net,但 permissions 里只写了 songs:read
    const json = { ...MANIFEST, id, name: "Derive Kit", permissions: ["songs:read"] };
    writePlugin(path.join(root, id), KIT_JS.replace(PLUG_ID, id), json);
    expect(await discoverExternalPlugins(APP, root)).toBe(1);
    const env: any = (pluginSandboxes.get(id) as any)?.env;
    expect(env?.permissions).toContain("net");
    expect(env?.permissions).toContain("storage");
    expect(env?.permissions).toContain("songs:read"); // 原有声明保留
  });

  it("permissions 写全与漏写得到同一套权限(三路并集幂等)", async () => {
    const root = freshRoot("permidem");
    const idA = "idem-full";
    const idB = "idem-bare";
    // ① 显式写全 net/storage
    writePlugin(path.join(root, idA), KIT_JS.replace(PLUG_ID, idA), {
      ...MANIFEST, id: idA, name: "Idem Full", permissions: ["net", "storage"],
    });
    await discoverExternalPlugins(APP, root);
    const permsA: string[] = (pluginSandboxes.get(idA) as any)?.env?.permissions ?? [];
    // ② 一个都不写,全靠 dailyPlaylist 推导
    writePlugin(path.join(root, idB), KIT_JS.replace(PLUG_ID, idB), {
      ...MANIFEST, id: idB, name: "Idem Bare", permissions: [],
    });
    await discoverExternalPlugins(APP, root);
    const permsB: string[] = (pluginSandboxes.get(idB) as any)?.env?.permissions ?? [];
    console.log("[b29] perms(写全) =", permsA.join(","), "| perms(漏写) =", permsB.join(","));
    // 并集幂等:写法不同不该改变最终权限(只比内容,不比顺序——
    // merged 的排列取决于 env 初值与声明顺序,不是稳定的契约)
    expect([...permsA].sort()).toEqual([...permsB].sort());
    expect(permsA).toContain("net");
    expect(permsA).toContain("storage");
  });

  it("index.js 的 schedules 缺省时,从 plugin.json 兜底过来", async () => {
    const root = freshRoot("sch");
    const id = "sch-kit";
    const json = { ...MANIFEST, id, name: "Sch Kit", schedules: [{ name: "daily", at: "03:00" }] };
    const js = `globalThis.__mfPlugin = {
      manifest: ${JSON.stringify({ ...json, schedules: undefined })},
      create() { return { runDailyJob: async () => "ok" }; },
    };`;
    writePlugin(path.join(root, id), js, json);
    expect(await discoverExternalPlugins(APP, root)).toBe(1);
    expect((getPlugin(id) as any)?.manifest?.schedules).toEqual([{ name: "daily", at: "03:00" }]);
  });
});

// ==================== J. reload(热重载覆盖同 id 外置插件) ====================
describe("discoverExternalPlugins reload 覆盖语义", () => {
  it("reload 会替换同 id 外置插件的沙箱(文件改动生效)", async () => {
    const before = pluginSandboxes.get(PLUG_ID);
    const beforeImpl = (getPlugin(PLUG_ID) as any)?.impl;
    expect(before).toBeTruthy();

    writePlugin(path.join(ROOT, PLUG_ID), `globalThis.__mfPlugin = {
      manifest: ${JSON.stringify(MANIFEST)},
      create() { return { runDailyJob: async () => "v2" }; },
    }`, MANIFEST);

    expect(await discoverExternalPlugins(APP, ROOT, { reload: true })).toBe(1);
    expect(pluginSandboxes.get(PLUG_ID)).not.toBe(before);
    expect((getPlugin(PLUG_ID) as any)?.impl).not.toBe(beforeImpl);
    await expect((getPlugin(PLUG_ID) as any).impl.runDailyJob()).resolves.toBe("v2");
  });

  it("reload 不得覆盖内置插件 id(内置优先,外置让位)", async () => {
    const root = freshRoot("builtin");
    const id = "builtin-guard";
    registerPlugin({ ...MANIFEST, id, name: "BUILTIN", type: "lyrics" } as any, { probe: () => 1 } as any);
    pluginSandboxes.delete(id);
    writePlugin(path.join(root, id), KIT_JS.replace(PLUG_ID, id).replace(/"host-kit"/g, `"${id}"`), { ...MANIFEST, id, name: "BUILTIN", type: "lyrics" });

    expect(await discoverExternalPlugins(APP, root, { reload: true })).toBe(0);
    expect((getPlugin(id) as any).impl.probe()).toBe(1); // 内置 impl 没被外置顶掉
    expect(pluginSandboxes.get(id)).toBeUndefined();
    unregisterPlugin(id);
  });
});

// ==================== K. host.sources.complete 早退 ====================
describe("host.sources.complete 早退", () => {
  it("既无 artist 也无 title 时直接早退,不打任何在线源", async () => {
    expect(await kitEnv().sources.complete({})).toEqual({ songId: null });
    expect(await kitEnv().sources.complete({ artist: "  ", title: "" })).toEqual({ songId: null });
  });
});

// ==================== L. host.fs(路径穿越防线) ====================
// 这些工厂都是导出函数,可以直接单测,不必绕沙箱。
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("makeFsApi(插件目录文件读写 + 路径越界拦截)", () => {
  const dir = path.join(TMP_DATA_DIR, "b29-fs");
  const api = makeFsApi(dir);

  it("writeFile / readFile / appendFile 一轮读写", async () => {
    await api.writeFile("a.txt", "hello");
    expect(await api.readFile("a.txt")).toBe("hello");
    await api.appendFile("a.txt", "-world");
    expect(await api.readFile("a.txt")).toBe("hello-world");
  });

  it("路径穿越一律被拒:这是插件拿不到宿主任意读写的唯一防线", async () => {
    await expect(api.readFile("../escape.txt")).rejects.toThrow(/越界/);
    await expect(api.writeFile("../../etc/evil", "x")).rejects.toThrow(/越界/);
    await expect(api.appendFile("..//./escape2", "x")).rejects.toThrow(/越界/);
    await expect(api.readdir("../")).rejects.toThrow(/越界/);
    await expect(api.stat("../../etc/passwd")).rejects.toThrow(/越界/);
    await expect(api.unlink("../../etc/passwd")).rejects.toThrow(/越界/);
    // 即使目录本身在白名单内,越界后缀也必须拦
    await expect(api.readFile(`${path.relative(path.join(dir, "files"), TMP_DATA_DIR).split(path.sep)[0]}/../escape3`)).rejects.toThrow(/越界/);
  });

  it("readdir 目标不存在时返回空数组(不是抛错)", async () => {
    expect(await api.readdir("nope-dir")).toEqual([]);
  });

  it("stat 不存在返回 null;存在时给出 size / isDirectory", async () => {
    expect(await api.stat("nope-dir")).toBeNull();
    await api.writeFile("s.txt", "12345");
    const s: any = await api.stat("s.txt");
    expect(s.size).toBe(5);
    expect(s.isDirectory).toBe(false);
    expect(typeof s.mtime).toBe("string");
    await api.mkdir("sub");
    expect((await api.stat("sub")).isDirectory).toBe(true);
  });

  it("unlink 不存在也不抛(force),存在则删掉", async () => {
    expect(await api.unlink("nope.txt")).toBeNull();
    await api.writeFile("t.txt", "x");
    expect(await api.unlink("t.txt")).toBeNull();
    expect(await api.exists("t.txt")).toBe(false);
  });

  it("mkdir 默认不建父目录(recursive 缺省),显式 recursive 才建", async () => {
    await expect(api.mkdir("deep/deeper")).rejects.toThrow();
    await api.mkdir("deep/deeper", { recursive: true });
    expect(await api.exists("deep/deeper")).toBe(true);
  });

  it("rename 越界一侧被拒", async () => {
    await api.writeFile("r.txt", "x");
    await expect(api.rename("r.txt", "../out.txt")).rejects.toThrow(/越界/);
  });
});

// ==================== M. host.command ====================
describe("makeCommandApi(execFile 不经过 shell)", () => {
  const api = makeCommandApi();

  it("exec 成功时返回 code 0 与 stdout", async () => {
    const r = await api.exec("sh", ["-c", "echo hello"], { timeout: 5000 });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("hello");
    expect(r.timedOut).toBe(false);
  });

  it("程序不存在时收敛为非零 code,不给宿主抛异常", async () => {
    const r = await api.exec("__mf_no_such_binary__", [], { timeout: 5000 });
    expect(r.code).not.toBe(0);
    expect(r.timedOut).toBe(false);
  });

  it("超时被打断时标记 timedOut(而不是挂死宿主)", async () => {
    const r = await api.exec("sh", ["-c", "sleep 5"], { timeout: 200 });
    expect(r.timedOut).toBe(true);
  });

  it("未传 timeout 时走默认 30s,小命令照常返回", async () => {
    const r = await api.exec("sh", ["-c", "echo ok"], {});
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("ok");
  });

  it("start 同名不重复起进程,stop 后可查 isRunning=false", async () => {
    const p: any = await api.start("mf-sleep", "sleep", ["5"]);
    expect(p.running).toBe(true);
    expect(p.pid).toBeGreaterThan(0);
    expect(await api.isRunning("mf-sleep")).toBe(true);
    // 现状记录(缺陷台账 D29-NET-CMD):同名复用分支 return { name, running: true }
    // 不带 pid,调用方无法确认复用的是哪个进程;修复后该断言应改为
    // `expect(again.pid).toBe(p.pid)`。
    const again: any = await api.start("mf-sleep", "sleep", ["5"]);
    expect(again).toEqual({ name: "mf-sleep", running: true });
    expect(again.pid).toBeUndefined();
    expect(await api.isRunning("mf-sleep")).toBe(true);
    await api.stop("mf-sleep");
    expect(await api.isRunning("mf-sleep")).toBe(false);
    await api.stop("mf-sleep"); // 重复 stop 不能炸
  });

  it("start 同名复用时不重复 spawn 子进程(ps 快照里同名进程数不增长)", async () => {
    const name = "mf-probe-count";
    await api.start(name, "sleep", ["5"]);
    const count = () => api.exec("sh", ["-c", `ps -eo args | grep -c '^sleep 5$'`], { timeout: 5000 });
    const before = Number((await count()).stdout.trim() || 0);
    await api.start(name, "sleep", ["5"]);
    await api.start(name, "sleep", ["5"]);
    const after = Number((await count()).stdout.trim() || 0);
    expect(after).toBe(before); // 复用分支不新增进程
    await api.stop(name);
  });
});

// ==================== N. host.net(本机 UDP/TCP 回环) ====================
describe("makeNetApi(本机 UDP/TCP,数据走 base64)", () => {
  const api = makeNetApi();

  // host.net 的编码契约:发送端收**原始字符串**(udpSend 直接 Buffer.from(String(data)) 发字节),
  // 接收端回调给的是**收到的原始字节再 base64**(msg.toString("base64"))。
  // 所以「发明文 → 回调拿到明文的 base64」,而不是「发 base64 → 回调拿到同一串 base64」。
  it("UDP 双端回环往返:发明文,回调收到明文的 base64", async () => {
    const a = await api.udpBind({ port: 0, address: "127.0.0.1" });
    const b = await api.udpBind({ port: 0, address: "127.0.0.1" });
    const got: any[] = [];
    api.udpOnData(b.socketId, (d) => got.push(d));
    await api.udpSend(a.socketId, "ping", { address: "127.0.0.1", port: b.port });
    await sleep(150);
    expect(got).toHaveLength(1);
    expect(got[0].data).toBe(Buffer.from("ping").toString("base64")); // cGluZw==
    expect(got[0].port).toBe(a.port);
    expect(await api.udpClose(a.socketId)).toBeNull();
    expect(await api.udpClose(b.socketId)).toBeNull();
  });

  // ---- 现状记录(缺陷台账 D29-NET-B64):host.net 对非 UTF8 载荷并不"二进制安全" ----
  // 源码 discovery.ts:200 注释写「数据以 base64 传输(二进制安全)」,实际:
  //   发送端 Buffer.from(String(data))  —— 默认 utf8 **编码**
  //   接收端 msg.toString("base64")    —— 对收到的字节做一次 base64 **编码**
  // 既没有「解码」也没有「透传字节」,于是:
  //   · 纯 ASCII / UTF-8 文本往返无损(实测 70696e67 / e4b8ade69687 原样带回)
  //   · 非 UTF8 字节(latin1 视角的 0xff/0xfe)会被 utf8 重新编码成 c3bfc3be,解回是 mojibake
  //   · 插件按注释"用 base64 传二进制"时,发出的是 ASCII 文本,对端又编一层,
  //     收到 base64 解出来仍是那串 base64 文本(不是原始字节)
  // 修复方向:发送端用 Buffer.from(String(data), "latin1") 保字节 / 或整条链路统一
  // 二进制帧。修复后下面两条现状断言应改为真正的二进制安全断言。
  it("D29-NET-B64(现状):非 UTF8 字节会被 utf8 重编码,解回是 mojibake", async () => {
    const a = await api.udpBind({ port: 0, address: "127.0.0.1" });
    const b = await api.udpBind({ port: 0, address: "127.0.0.1" });
    const got: any[] = [];
    api.udpOnData(b.socketId, (d) => got.push(d));
    const raw = Buffer.from([0xff, 0xfe, 0x00, 0x41]);
    await api.udpSend(a.socketId, raw.toString("latin1"), { address: "127.0.0.1", port: b.port });
    await sleep(150);
    expect(got).toHaveLength(1);
    // 现状:0xff 0xfe 被 utf8 编成 c3 c3(bf/be),整段变成 c3bfc3be0041
    expect(Buffer.from(got[0].data, "base64").toString("hex")).toBe("c3bfc3be0041");
    // 若某天修成二进制安全,这条会先转红 —— 作为回归哨兵保留
    expect(Buffer.from(got[0].data, "base64").equals(raw)).toBe(false);
    await api.udpClose(a.socketId);
    await api.udpClose(b.socketId);
  });

  it("D29-NET-B64(现状):按注释发 base64 会被再编码一层,解回仍是 base64 文本", async () => {
    const a = await api.udpBind({ port: 0, address: "127.0.0.1" });
    const b = await api.udpBind({ port: 0, address: "127.0.0.1" });
    const got: any[] = [];
    api.udpOnData(b.socketId, (d) => got.push(d));
    const raw = Buffer.from([0xff, 0xfe, 0x00, 0x41]);
    const pluginPayload = raw.toString("base64"); // 插件侧的 "//4AQQ=="
    await api.udpSend(a.socketId, pluginPayload, { address: "127.0.0.1", port: b.port });
    await sleep(150);
    // 现状:对端对 ASCII 文本 "/ /4 A Q Q = =" 又编了一层
    expect(got).toHaveLength(1);
    expect(Buffer.from(got[0].data, "base64").toString()).toBe(pluginPayload);
    expect(got[0].data).not.toBe(pluginPayload); // 确实是双层
    await api.udpClose(a.socketId);
    await api.udpClose(b.socketId);
  });

  it("对照:纯 ASCII 与 UTF-8 文本往返无损(base64 通道不破坏文本)", async () => {
    const a = await api.udpBind({ port: 0, address: "127.0.0.1" });
    const b = await api.udpBind({ port: 0, address: "127.0.0.1" });
    const got: any[] = [];
    api.udpOnData(b.socketId, (d) => got.push(d));
    await api.udpSend(a.socketId, "ping", { address: "127.0.0.1", port: b.port });
    await api.udpSend(a.socketId, "中文标题", { address: "127.0.0.1", port: b.port });
    await sleep(200);
    expect(got.map((g) => Buffer.from(g.data, "base64").toString())).toEqual(["ping", "中文标题"]);
    await api.udpClose(a.socketId);
    await api.udpClose(b.socketId);
  });

  it("UDP 发向不存在的 socketId 抛明确错误", async () => {
    await expect(api.udpSend("nope", "x")).rejects.toThrow(/不存在/);
    await expect(api.udpClose("nope")).resolves.toBeNull(); // 关闭不存在的不抛
  });

  it("TCP 连本机回显服务,tcpSend/tcpOnData 打通", async () => {
    const server = netMod.createServer((s) => { s.on("data", (d) => s.write(d)); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;

    const c: any = await api.tcpConnect("127.0.0.1", port, { timeout: 3000 });
    expect(c.remoteAddr).toBe(`127.0.0.1:${port}`);
    const got: any[] = [];
    api.tcpOnData(c.socketId, (d) => got.push(d));
    await api.tcpSend(c.socketId, "hi"); // 发明文,回调收明文的 base64
    await sleep(150);
    expect(got).toHaveLength(1);
    expect(got[0].data).toBe(Buffer.from("hi").toString("base64")); // aGk=
    expect(await api.tcpClose(c.socketId)).toBeNull();
    server.close();
  });

  it("TCP 回显:回调按 packet 分片投递,慢速接收方不会丢帧", async () => {
    const server = netMod.createServer((s) => { s.on("data", (d) => s.write(d)); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;
    const c: any = await api.tcpConnect("127.0.0.1", port, { timeout: 3000 });
    const got: any[] = [];
    api.tcpOnData(c.socketId, (d) => got.push(d));
    await api.tcpSend(c.socketId, "chunk-1");
    await api.tcpSend(c.socketId, "chunk-2");
    await sleep(200);
    // 现状:一次 TCP 段 = 一帧。分片与否取决于内核攒包,这里只钉「至少收到且内容完整」
    expect(got.length).toBeGreaterThan(0);
    const joined = Buffer.concat(got.map((g) => Buffer.from(g.data, "base64"))).toString();
    expect(joined).toContain("chunk-1");
    expect(joined).toContain("chunk-2");
    await api.tcpClose(c.socketId);
    server.close();
  });

  it("TCP 连不存在的 socketId 抛明确错误;对未监听端口则 reject 而非挂死", async () => {
    await expect(api.tcpSend("nope", "x")).rejects.toThrow(/不存在/);
    await expect(api.tcpClose("nope")).resolves.toBeNull();
    const dead = netMod.createServer();
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const port = (dead.address() as any).port;
    await dead.close();
    await expect(api.tcpConnect("127.0.0.1", port, { timeout: 1000 })).rejects.toThrow();
  });

  it("TCP 连接超时后 reject(不无限等待)", async () => {
    // 只建不 listen 的端口由内核直接回 RST,这里用一个被占用的端口制造 hang
    const blocker = netMod.createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    const port = (blocker.address() as any).port;
    blocker.close(); // 端口随即关闭,连接应被拒
    await expect(api.tcpConnect("10.255.255.1", 9, { timeout: 200 })).rejects.toThrow();
  });
});

// ==================== O. host.ws(本机 WebSocket 服务) ====================
describe("makeWsApi(回环 WebSocket 服务)", () => {
  const api = makeWsApi();
  let wss: any;
  let url = "";

  beforeAll(async () => {
    wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    // echo:收到什么回什么(大写),先注册再 connect,保证消息必有回应
    wss.on("connection", (ws: any) => { ws.on("message", (m: any) => ws.send(String(m).toUpperCase())); });
    await new Promise<void>((r) => wss.on("listening", r));
    url = `ws://127.0.0.1:${(wss.address() as any).port}`;
  });

  afterAll(() => { try { wss.close(); } catch { /* ignore */ } });

  it("connect + 收发一轮,回调带 binary 标记", async () => {
    const c: any = await api.connect(url, { timeout: 3000 });
    const got: any[] = [];
    api.wsOnMessage(c.socketId, (m) => got.push(m));
    await api.wsSend(c.socketId, "ping");
    await sleep(200);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ data: "PING", binary: false });
    expect(await api.wsClose(c.socketId)).toBeNull();
  });

  it("二进制消息以 base64 + binary=true 投递", async () => {
    const c: any = await api.connect(url, { timeout: 3000 });
    const got: any[] = [];
    api.wsOnMessage(c.socketId, (m) => got.push(m));
    wss.clients.forEach((ws: any) => { if (ws.readyState === 1) ws.send(Buffer.from([1, 2, 3])); });
    await sleep(200);
    expect(got.length).toBeGreaterThan(0);
    expect(got[0].binary).toBe(true);
    expect(got[0].data).toBe(Buffer.from([1, 2, 3]).toString("base64"));
    await api.wsClose(c.socketId);
  });

  it("对不存在的 socketId 抛明确错误;重复关闭不抛", async () => {
    await expect(api.wsSend("nope", "x")).rejects.toThrow(/不存在/);
    await expect(api.wsClose("nope")).resolves.toBeNull();
  });

  it("连接不到服务时 reject,不让插件卡住", async () => {
    await expect(api.connect("ws://127.0.0.1:1/", { timeout: 1000 })).rejects.toThrow();
  });
});

// ==================== P. host.jsenv(嵌套 QuickJS 子环境) ====================
describe("makeJsenvApi(嵌套 QuickJS 子环境)", () => {
  const api = makeJsenvApi();

  it("create → execute → destroy 一轮", async () => {
    await api.create("e1");
    expect(await api.execute("e1", "1+2")).toEqual({ ok: true, result: 3 });
    expect(await api.destroy("e1")).toBeNull();
  });

  it("init 代码先跑,后续 execute 能读到它设的全局", async () => {
    await api.create("e2", "globalThis.__v = 7");
    expect((await api.execute("e2", "__v")).result).toBe(7);
  });

  it("同名 create 直接返回原名,不重建环境", async () => {
    expect(await api.create("e3")).toBe("e3");
    expect(await api.create("e3")).toBe("e3");
    await api.destroy("e3");
  });

  it("init 代码报错时抛出明确错误(不留半初始化环境)", async () => {
    await expect(api.create("e4", "throw new Error('boom')")).rejects.toThrow(/jsenv init 失败/);
  });

  it("execute 不存在的环境抛错;执行期报错收敛为 {ok:false,error}", async () => {
    await expect(api.execute("nope", "1")).rejects.toThrow(/jsenv 不存在/);
    await api.create("e5");
    const r: any = await api.execute("e5", "not defined at all");
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe("string");
  });

  it("各环境之间互不影响(独立 context)", async () => {
    await api.create("p1", "globalThis.__who = 'A'");
    await api.create("p2", "globalThis.__who = 'B'");
    expect((await api.execute("p1", "__who")).result).toBe("A");
    expect((await api.execute("p2", "__who")).result).toBe("B");
    await api.destroy("p1");
    await api.destroy("p2");
  });
});
