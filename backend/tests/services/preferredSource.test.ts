// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import { initDatabase, sqlite } from "../../src/db/index.js";

// 被 mock 的依赖:源可用性探测(真实实现要摸文件系统 / 发 HEAD)、插件开关读取
// (真实实现走插件注册表)、日志(要断言「继续下一个」与否的分支)。
const h = vi.hoisted(() => ({
  probeOk: vi.fn(async (_song: any) => true),
  active: true,
  preferLocal: true,
  fallbackToWeb: true,
  logs: { info: [] as any[], warn: [] as any[], error: [] as any[] },
}));

vi.mock("../../src/utils/localSourceProbe.js", () => ({
  probeLocalSourceOk: (song: any) => h.probeOk(song),
}));

vi.mock("../../src/services/plugin/core/playPreference.js", () => ({
  playPreferenceActive: () => h.active,
  preferLocalEnabled: () => h.preferLocal,
  fallbackToWebEnabled: () => h.fallbackToWeb,
}));

vi.mock("../../src/utils/logger.js", () => ({
  createLogger: () => ({
    info: (msg: string, meta?: any) => h.logs.info.push([msg, meta]),
    warn: (msg: string, meta?: any) => h.logs.warn.push([msg, meta]),
    error: (msg: string, meta?: any) => h.logs.error.push([msg, meta]),
  }),
}));

import { resolvePreferredSong } from "../../src/services/source/preferredSource.js";

/**
 * ⚠️ 单位**秒**(不是毫秒)。
 *
 * 早先写成 `Date.now() + n`(毫秒):相邻两条 seed 之间实际相隔常常不足 1ms,一旦
 * 第二次 `Date.now()` 正跨过整毫秒边界,它拿到的基准就 **等于或大于** 第一次的,
 * 于是两条 `created_at` **打平(tie)** —— 而 `resolvePreferredSong` 用的是
 * `orderBy(songs.createdAt)` + `limit 1`,SQL 在排序键平局时的返回顺序**未定义**。
 * 结果就是「按 createdAt 取最早那条」的用例会偶发拿到 createdAt 更晚的那条
 * (实测 5 轮里 flaky 1 次,期望 w2 却拿到 w9)。
 *
 * 改成秒后两条 seed 至少相差 1000ms,远大于时钟漂移,彻底消除平局。
 */
const iso = (sec = 0) => new Date(Date.now() + sec * 1000).toISOString();

function seedSong(id: string, type: string | null, groupId: string | null, over: Record<string, any> = {}) {
  sqlite
    .prepare(
      `INSERT INTO songs (id, title, artist, album, path, suffix, type, group_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      over.title ?? `T-${id}`,
      "A",
      "Al",
      over.path ?? `${type === "web" ? "w" : "l"}:src:/tmp/${id}.mp3`,
      "mp3",
      type,
      groupId,
      over.createdAt ?? iso(),
    );
}

/** 从库里回读一行,拿到与真实调用方一致的 drizzle 行对象。 */
function readSong(id: string): any {
  const row = sqlite.prepare("SELECT * FROM songs WHERE id = ?").get(id) as any;
  // preferredSource 通过 drizzle 的类型推断访问 camelCase 属性;这里手工补齐
  return { ...row, groupId: row.group_id, coverArt: row.cover_art };
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
});

beforeEach(() => {
  vi.clearAllMocks();
  h.probeOk.mockImplementation(async () => true);
  h.active = true;
  h.preferLocal = true;
  h.fallbackToWeb = true;
  h.logs.info.length = 0;
  h.logs.warn.length = 0;
  h.logs.error.length = 0;
  sqlite.prepare("DELETE FROM songs").run();
});

describe("resolvePreferredSong:方向 1 web → 组内 local/webdav 优选", () => {
  it("组内有可用的 local 源 → 切到 local(local 优先于 webdav,与插入顺序无关)", async () => {
    seedSong("w1", "web", "g1", { createdAt: iso(0) });
    seedSong("v1", "webdav", "g1", { createdAt: iso(1) }); // 先插入 webdav
    seedSong("l1", "local", "g1", { createdAt: iso(2) });
    const out = await resolvePreferredSong(readSong("w1"));
    expect(out.id).toBe("l1");
    expect(h.logs.info.some(([m]) => m === "播放优选:web 歌曲切换到核心曲库源")).toBe(true);
    // 全程只探测过 local 这一条(webdav 根本没轮到)
    expect(h.probeOk).toHaveBeenCalledTimes(1);
    expect(h.probeOk.mock.calls[0][0].id).toBe("l1");
  });

  it("local 探测不可用 → 记日志并继续下一个,最终落到 webdav", async () => {
    seedSong("w1", "web", "g1");
    seedSong("l1", "local", "g1");
    seedSong("v1", "webdav", "g1");
    h.probeOk.mockImplementation(async (song: any) => song.id !== "l1");
    const out = await resolvePreferredSong(readSong("w1"));
    expect(out.id).toBe("v1");
    // 两条日志:先「候选源不可用,继续下一个」,后「切换到核心曲库源」
    expect(h.logs.info.map(([m]) => m)).toEqual([
      "播放优选:候选源不可用,继续下一个",
      "播放优选:web 歌曲切换到核心曲库源",
    ]);
    expect(h.logs.info[0][1]).toMatchObject({ webId: "w1", altId: "l1", type: "local" });
    expect(h.logs.info[1][1]).toMatchObject({ webId: "w1", localId: "v1", type: "webdav" });
  });

  it("组内 local/webdav 全部不可用 → 原样返回 web 行(不改源)", async () => {
    seedSong("w1", "web", "g1");
    seedSong("l1", "local", "g1");
    h.probeOk.mockImplementation(async () => false);
    const out = await resolvePreferredSong(readSong("w1"));
    expect(out.id).toBe("w1");
    expect(h.logs.info.every(([m]) => m !== "播放优选:web 歌曲切换到核心曲库源")).toBe(true);
  });

  it("组内没有任何 local/webdav 兄弟行 → 原样返回", async () => {
    seedSong("w1", "web", "g1");
    seedSong("w2", "web", "g1");
    const out = await resolvePreferredSong(readSong("w1"));
    expect(out.id).toBe("w1");
    expect(h.probeOk).not.toHaveBeenCalled();
  });

  it("web 行没有 groupId → 不进方向 1(即使插件开着)", async () => {
    seedSong("w1", "web", null);
    seedSong("l1", "local", "g1");
    const out = await resolvePreferredSong(readSong("w1"));
    expect(out.id).toBe("w1");
    expect(h.probeOk).not.toHaveBeenCalled();
  });

  it("优选子开关关闭 → 不换源(web 行原样返回)", async () => {
    seedSong("w1", "web", "g1");
    seedSong("l1", "local", "g1");
    h.preferLocal = false;
    const out = await resolvePreferredSong(readSong("w1"));
    expect(out.id).toBe("w1");
    expect(h.probeOk).not.toHaveBeenCalled();
    expect(h.logs.warn).toEqual([]);
  });

  it("插件总开关关闭 → 两条方向都不走,原样返回", async () => {
    seedSong("w1", "web", "g1");
    seedSong("l1", "local", "g1");
    h.active = false;
    expect((await resolvePreferredSong(readSong("w1"))).id).toBe("w1");
    expect(h.probeOk).not.toHaveBeenCalled();
  });

  it("查询抛错 → log.warn 后按原源播放(不把异常冒给调用方)", async () => {
    seedSong("w1", "web", "g1");
    const song = readSong("w1"); // 先读出,再让 prepare 抛(否则读行也会被拦)
    const spy = vi.spyOn(sqlite, "prepare").mockImplementation(() => {
      throw new Error("库挂了");
    });
    const out = await resolvePreferredSong(song);
    spy.mockRestore();
    expect(out.id).toBe("w1");
    expect(h.logs.warn).toHaveLength(1);
    expect(h.logs.warn[0][0]).toBe("播放优选查询失败,按原源播放");
    expect(h.logs.warn[0][1]).toMatchObject({ id: "w1", err: "库挂了" });
  });
});

describe("resolvePreferredSong:方向 2 local/webdav 不可用 → 组内 web 回退", () => {
  it("local 探测失败且组内有 web 源 → 切到 web(按 createdAt 取最早那条)", async () => {
    seedSong("w9", "web", "g1", { createdAt: iso(2) });
    seedSong("w2", "web", "g1", { createdAt: iso(1) });
    seedSong("l1", "local", "g1");
    h.probeOk.mockImplementation(async (song: any) => song.type === "web");
    const out = await resolvePreferredSong(readSong("l1"));
    expect(out.id).toBe("w2"); // createdAt 更早
    expect(h.logs.info.some(([m]) => m === "流回退:核心曲库源不可用,切组内 web 源")).toBe(true);
    expect(h.logs.info[0][1]).toMatchObject({ localId: "l1", webId: "w2" });
  });

  it("local 探测成功 → 不查兄弟行,原样返回", async () => {
    seedSong("l1", "local", "g1");
    seedSong("w1", "web", "g1");
    const out = await resolvePreferredSong(readSong("l1"));
    expect(out.id).toBe("l1");
    expect(h.logs.info).toEqual([]);
  });

  it("探测失败但组内没有 web 源 → 原样返回(宁可不换,也不换成空的)", async () => {
    seedSong("l1", "local", "g1");
    seedSong("l2", "local", "g1");
    h.probeOk.mockImplementation(async () => false);
    const out = await resolvePreferredSong(readSong("l1"));
    expect(out.id).toBe("l1");
    expect(h.logs.info).toEqual([]);
  });

  it("type 为空(库里存 NULL)→ 按 local 处理,同样走回退", async () => {
    seedSong("l1", null, "g1");
    seedSong("w1", "web", "g1");
    h.probeOk.mockImplementation(async (song: any) => song.type === "web");
    const out = await resolvePreferredSong(readSong("l1"));
    expect(out.id).toBe("w1");
  });

  it("webdav 源不可用也走回退(方向 2 覆盖 local 与 webdav 两类核心曲库源)", async () => {
    seedSong("v1", "webdav", "g1");
    seedSong("w1", "web", "g1");
    h.probeOk.mockImplementation(async (song: any) => song.type === "web");
    expect((await resolvePreferredSong(readSong("v1"))).id).toBe("w1");
  });

  it("回退子开关关闭 → 不可用也不换源", async () => {
    seedSong("l1", "local", "g1");
    seedSong("w1", "web", "g1");
    h.probeOk.mockImplementation(async () => false);
    h.fallbackToWeb = false;
    const out = await resolvePreferredSong(readSong("l1"));
    expect(out.id).toBe("l1");
    expect(h.logs.info).toEqual([]);
  });

  it("local 行没有 groupId → 不进方向 2", async () => {
    seedSong("l1", "local", null);
    seedSong("w1", "web", "g1");
    h.probeOk.mockImplementation(async () => false);
    expect((await resolvePreferredSong(readSong("l1"))).id).toBe("l1");
  });

  it("回退查询抛错 → log.warn 后按原源播放", async () => {
    seedSong("l1", "local", "g1");
    h.probeOk.mockImplementation(async () => false);
    const song = readSong("l1"); // 先读出,再让 prepare 抛
    const spy = vi.spyOn(sqlite, "prepare").mockImplementation(() => {
      throw new Error("回退查询炸了");
    });
    const out = await resolvePreferredSong(song);
    spy.mockRestore();
    expect(out.id).toBe("l1");
    expect(h.logs.warn).toHaveLength(1);
    expect(h.logs.warn[0][0]).toBe("流回退查询失败,按原源播放");
    expect(h.logs.warn[0][1]).toMatchObject({ id: "l1", err: "回退查询炸了" });
  });

  it("探测函数抛错 → 异常冒给调用方(探测失败与探测异常是两回事)", async () => {
    seedSong("l1", "local", "g1");
    h.probeOk.mockImplementation(async () => {
      throw new Error("probe boom");
    });
    await expect(resolvePreferredSong(readSong("l1"))).rejects.toThrow("probe boom");
  });
});
