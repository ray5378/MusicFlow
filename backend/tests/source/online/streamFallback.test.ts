// Unit tests for services/source/online/streamFallback.ts — 换源兜底挂导入门禁
// (passesImportGate:标题+歌手强制 + 专辑一致 + 时长容差,v2.3.4 起)。
//   - 同歌名同歌手同专辑同时长 → 换源命中(按 sourcePreference 排序、排除失败源)
//   - 同歌名不同歌手 / 专辑不符 / 时长超容差 / 候选缺字段 → 不换源(null)
//   - 歌名有后缀(Live/演唱会版/伴奏)只能配带相同后缀,无后缀只能配无后缀
//   - 期望曲无歌手/无专辑/无时长 → 对应维度跳过(向后兼容)
//   - 「恋人-李荣浩」事故回归:元数据冒名候选(李荣浩-、Montagem)不得换源
//   - ensurePlayableStream:原 URL 探测失败 → 换源并把替换 URL 写回 songs.url
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../../plugins/_env.js";

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { initDatabase, db, sqlite } from "../../../src/db/index.js";
import { songs } from "../../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { registerPlugin, unregisterPlugin } from "../../../src/plugins/registry.js";
import {
  findFallbackStream,
  ensurePlayableStream,
  clearStreamFallbackCache,
} from "../../../src/services/source/online/streamFallback.js";

const PROVIDER = "gmdl-fb-test";

const manifestOf = {
  id: PROVIDER,
  name: PROVIDER,
  version: "1.0.0",
  type: "source",
  capabilities: ["search", "stream"],
  platforms: ["netease", "kugou", "qq"],
  configSchema: [],
  permissions: ["net"],
  sourcePreference: ["kugou", "netease", "qq"],
} as const;

const fakeConfig = { baseUrl: "http://gm:18080" };

const streamUrl = (_config: any, song: any) =>
  `http://gm:18080/music/download?id=${song.id}&source=${song.source}&name=${encodeURIComponent(song.name)}`;

// 探测 stub:orig 原 URL 一律 404(触发换源),其余候选 URL 一律 206(可播)。
vi.stubGlobal(
  "fetch",
  async (url: string) =>
    String(url).includes("orig")
      ? new Response("not found", { status: 404 })
      : new Response("stream-bytes", { status: 206 }),
);

function enableProvider(cands: any[]) {
  const searchCalls: string[] = [];
  const provider = {
    id: PROVIDER,
    manifest: manifestOf,
    search: async (_config: any, params: any) => {
      searchCalls.push(params.query || "");
      return { songs: cands };
    },
    streamUrl,
  };
  registerPlugin(manifestOf as any, provider);
  sqlite.prepare(`
    INSERT INTO plugins (id, name, version, description, manifest, enabled, config, created_at, updated_at)
    VALUES (?, ?, '1.0.0', '', ?, 1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET enabled = 1, config = excluded.config, manifest = excluded.manifest
  `).run(PROVIDER, PROVIDER, JSON.stringify(manifestOf), JSON.stringify(fakeConfig), new Date().toISOString(), new Date().toISOString());
  return { searchCalls, provider };
}

function seedSong(id: string, opts: { url: string; title?: string | null; artist?: string | null; sourceData?: string | null }) {
  db.insert(songs).values({
    id,
    title: opts.title ?? null,
    artist: opts.artist ?? null,
    album: null,
    coverArt: null,
    duration: 218,
    path: "web:gmdl-fb-test:qq",
    contentType: "audio/mpeg",
    suffix: "mp3",
    discNumber: 1,
    track: 0,
    genre: "",
    size: 0,
    playCount: 0,
    url: opts.url,
    fingerprint: `fp-${id}`,
    type: "web",
    pluginEntry: PROVIDER,
    sourceData: opts.sourceData ?? null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();
}

beforeAll(() => {
  initDatabase();
});

afterEach(() => {
  clearStreamFallbackCache();
  sqlite.prepare("DELETE FROM songs WHERE plugin_entry = ?").run(PROVIDER);
  sqlite.prepare("DELETE FROM plugins WHERE id = ?").run(PROVIDER);
  // core-stream-fallback 配置行也清掉(用例随机顺序,不能让开关/覆写泄漏到其它用例)。
  sqlite.prepare("DELETE FROM plugins WHERE id = 'core-stream-fallback'").run();
  unregisterPlugin(PROVIDER);
});

afterAll(() => {
  sqlite.prepare("DELETE FROM songs WHERE plugin_entry = ?").run(PROVIDER);
  sqlite.prepare("DELETE FROM plugins WHERE id = ?").run(PROVIDER);
  unregisterPlugin(PROVIDER);
});

describe("findFallbackStream — 换源兜底挂导入门禁", () => {
  it("同歌名同歌手同专辑同时长:换源到偏好源,排除失败源与同名异歌手候选", async () => {
    const { searchCalls } = enableProvider([
      { id: "k1", name: "七里香", artist: "周杰伦", album: "七里香", duration: 240, source: "kugou" },
      { id: "n1", name: "七里香", artist: "周杰伦", album: "七里香", duration: 240, source: "netease" },
      { id: "q1", name: "七里香", artist: "周杰伦", album: "七里香", duration: 240, source: "qq" }, // 失败源,应排除
      { id: "wrong", name: "七里香", artist: "王俊凯", album: "七里香", duration: 240, source: "kugou" }, // 同名异歌手,应排除
    ]);

    const fb = await findFallbackStream("s-ok", "七里香", "周杰伦", "七里香", 240, PROVIDER, "qq");

    expect(searchCalls[0]).toBe("七里香 周杰伦");
    expect(fb).toBeTruthy();
    expect(fb!.source).toBe("kugou"); // sourcePreference 优先 kugou
    expect(fb!.url).toContain("id=k1");
  });

  it("同歌名不同歌手 → 不换源(防点七里香播别首)", async () => {
    enableProvider([
      { id: "n1", name: "七里香", artist: "王俊凯", album: "七里香", duration: 240, source: "netease" },
    ]);

    const fb = await findFallbackStream("s-wrong", "七里香", "周杰伦", "七里香", 240, PROVIDER, "qq");

    expect(fb).toBeNull();
  });

  it("期望曲无歌手/无专辑/无时长 → 仍按歌名换源(对应维度跳过,向后兼容)", async () => {
    enableProvider([
      { id: "n1", name: "七里香", artist: "周杰伦", album: "", duration: 0, source: "netease" },
    ]);

    const fb = await findFallbackStream("s-noartist", "七里香", "", "", 0, PROVIDER, "qq");

    expect(fb).toBeTruthy();
    expect(fb!.url).toContain("id=n1");
  });

  it("多歌手候选(合作)与期望歌手一致且专辑/时长命中 → 可换源", async () => {
    enableProvider([
      { id: "n1", name: "珊瑚海", artist: "周杰伦、温岚、吴宗宪", album: "八度空间", duration: 283, source: "netease" },
    ]);

    const fb = await findFallbackStream("s-coop", "珊瑚海", "周杰伦", "八度空间", 283, PROVIDER, "qq");

    expect(fb).toBeTruthy();
    expect(fb!.url).toContain("id=n1");
  });

  // ---- v2.3.4 门禁维度回归(此前兜底只有歌名+歌手两维,冒名候选漏网) ----

  it("专辑不符 → 不换源(恋人事故:黑马专辑的《恋人》被换成冒名候选的《恋人》专辑)", async () => {
    enableProvider([
      // 元数据冒名:歌名相等、歌手 token 含「李荣浩」(normalize 剥掉尾部 -),
      // 旧两维过滤全部放行——现被专辑维度拦下。
      { id: "fake1", name: "恋人", artist: "李荣浩-、Montagem", album: "恋人", duration: 180, source: "netease" },
    ]);

    const fb = await findFallbackStream("s-lianren", "恋人", "李荣浩", "黑马", 275, PROVIDER, "qq");

    expect(fb).toBeNull();
  });

  it("时长超容差 → 不换源(即使标题/歌手/专辑全对)", async () => {
    enableProvider([
      { id: "dur1", name: "恋人", artist: "李荣浩", album: "黑马", duration: 180, source: "netease" },
    ]);

    const fb = await findFallbackStream("s-dur", "恋人", "李荣浩", "黑马", 275, PROVIDER, "qq");

    expect(fb).toBeNull();
  });

  it("候选缺专辑(期望有专辑)→ 不换源(无法核实即拒绝)", async () => {
    enableProvider([
      { id: "noalb", name: "恋人", artist: "李荣浩", album: "", duration: 275, source: "netease" },
    ]);

    const fb = await findFallbackStream("s-noalb", "恋人", "李荣浩", "黑马", 275, PROVIDER, "qq");

    expect(fb).toBeNull();
  });

  it("候选缺时长(期望有时长)→ 不换源(无法核实即拒绝)", async () => {
    enableProvider([
      { id: "nodur", name: "恋人", artist: "李荣浩", album: "黑马", duration: 0, source: "netease" },
    ]);

    const fb = await findFallbackStream("s-nodur", "恋人", "李荣浩", "黑马", 275, PROVIDER, "qq");

    expect(fb).toBeNull();
  });

  // ---- core-stream-fallback 配置插件(v2.3.5):开关 + 时长容差覆写 ----

  /** 在测试 DB 里播种/更新 core-stream-fallback 行(免注册,配置纯 DB 驱动)。 */
  function setFallbackConfig(cfg: Record<string, any>) {
    const now = new Date().toISOString();
    sqlite.prepare(`
      INSERT INTO plugins (id, name, version, description, manifest, enabled, config, created_at, updated_at)
      VALUES ('core-stream-fallback', 'core-stream-fallback', '1.0.0', '', '{}', 1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET enabled = 1, config = excluded.config
    `).run(JSON.stringify(cfg), now, now);
  }

  it("总开关关闭(enabled=false)→ 不换源且不发搜索请求", async () => {
    const { searchCalls } = enableProvider([
      { id: "n1", name: "恋人", artist: "李荣浩", album: "黑马", duration: 275, source: "netease" },
    ]);
    setFallbackConfig({ enabled: false });

    const fb = await findFallbackStream("s-disabled", "恋人", "李荣浩", "黑马", 275, PROVIDER, "qq");

    expect(fb).toBeNull();
    expect(searchCalls.length).toBe(0);
  });

  it("时长容差覆写:默认容差拒掉的候选,覆写放宽后可换源(仅时长维度)", async () => {
    // 15s 差:导入门禁默认容差 1s 必拒;覆写 20s 后放行。
    enableProvider([
      { id: "tol1", name: "恋人", artist: "李荣浩", album: "黑马", duration: 290, source: "netease" },
    ]);
    setFallbackConfig({ enabled: true, durationTolerance: 20 });

    const fb = await findFallbackStream("s-tol", "恋人", "李荣浩", "黑马", 275, PROVIDER, "qq");

    expect(fb).toBeTruthy();
    expect(fb!.url).toContain("id=tol1");
  });

  it("时长容差覆写不放宽标题/歌手/专辑:冒名候选仍被拦", async () => {
    enableProvider([
      { id: "fake2", name: "恋人", artist: "李荣浩-、Montagem", album: "恋人", duration: 275, source: "netease" },
    ]);
    setFallbackConfig({ enabled: true, durationTolerance: 20 });

    const fb = await findFallbackStream("s-tol2", "恋人", "李荣浩", "黑马", 275, PROVIDER, "qq");

    expect(fb).toBeNull();
  });

  it("期望曲无专辑时,候选专辑任意 → 按标题/歌手换源(专辑维度跳过)", async () => {
    enableProvider([
      { id: "anyalb", name: "恋人", artist: "李荣浩", album: "别的专辑", duration: 275, source: "netease" },
    ]);

    const fb = await findFallbackStream("s-anyalb", "恋人", "李荣浩", "", 275, PROVIDER, "qq");

    expect(fb).toBeTruthy();
    expect(fb!.url).toContain("id=anyalb");
  });

  it("期望曲无时长时,候选时长任意 → 按标题/歌手/专辑换源(时长维度跳过)", async () => {
    enableProvider([
      { id: "anydur", name: "恋人", artist: "李荣浩", album: "黑马", duration: 999, source: "netease" },
    ]);

    const fb = await findFallbackStream("s-anydur", "恋人", "李荣浩", "黑马", 0, PROVIDER, "qq");

    expect(fb).toBeTruthy();
    expect(fb!.url).toContain("id=anydur");
  });

  it("期望无后缀 + 候选带(Live)后缀 → 不换源(严格全串对齐)", async () => {
    enableProvider([
      { id: "live1", name: "听妈妈的话(Live)", artist: "周杰伦", album: "", duration: 0, source: "kuwo" },
    ]);

    const fb = await findFallbackStream("s-suf1", "听妈妈的话", "周杰伦", "", 0, PROVIDER, "qq");

    expect(fb).toBeNull();
  });

  it("期望无后缀 + 候选带「演唱会版」后缀 → 不换源", async () => {
    enableProvider([
      { id: "live2", name: "听妈妈的话-演唱会版", artist: "周杰伦", album: "", duration: 0, source: "netease" },
    ]);

    const fb = await findFallbackStream("s-suf2", "听妈妈的话", "周杰伦", "", 0, PROVIDER, "qq");

    expect(fb).toBeNull();
  });

  it("期望带(Live) + 候选带相同后缀(大小写/空格/括号差异) → 换源", async () => {
    enableProvider([
      { id: "live3", name: "听妈妈的话 (LIVE)", artist: "周杰伦", album: "", duration: 0, source: "kuwo" },
    ]);

    const fb = await findFallbackStream("s-suf3", "听妈妈的话(Live)", "周杰伦", "", 0, PROVIDER, "qq");

    expect(fb).toBeTruthy();
    expect(fb!.url).toContain("id=live3");
  });

  it("期望带(Live)但候选无后缀 → 不换源", async () => {
    enableProvider([
      { id: "plain1", name: "听妈妈的话", artist: "周杰伦", album: "", duration: 0, source: "netease" },
    ]);

    const fb = await findFallbackStream("s-suf4", "听妈妈的话(Live)", "周杰伦", "", 0, PROVIDER, "qq");

    expect(fb).toBeNull();
  });
});

describe("ensurePlayableStream — 原 URL 失败换源并写回", () => {
  it("原 URL 404 → 严格匹配的候选换源并把替换 URL 持久化到 songs.url", async () => {
    enableProvider([
      // 库内时长 218s(seedSong),候选须命中时长容差
      { id: "n1", name: "七里香", artist: "周杰伦", album: "", duration: 218, source: "netease" },
      { id: "wrong", name: "七里香", artist: "王俊凯", album: "", duration: 218, source: "netease" },
    ]);
    await seedSong("fb-s1", {
      url: "http://orig/broken.mp3",
      title: "",
      artist: "",
      sourceData: JSON.stringify({ title: "七里香", artist: "周杰伦", source: "qq" }),
    });
    const songRow = db.select().from(songs).where(eq(songs.id, "fb-s1")).get() as any;

    const url = await ensurePlayableStream(songRow);

    // 仅同歌名同歌手的候选被采纳
    expect(url).toContain("id=n1");
    const row = db.select().from(songs).where(eq(songs.id, "fb-s1")).get() as any;
    expect(row.url).toContain("id=n1");
  });

  it("搜不到歌手一致的候选时,不换源也不覆盖原 URL", async () => {
    enableProvider([
      { id: "wrong", name: "七里香", artist: "王俊凯", album: "", duration: 218, source: "netease" },
    ]);
    seedSong("fb-s2", {
      url: "http://orig/broken.mp3",
      title: "七里香",
      artist: "周杰伦",
      sourceData: JSON.stringify({ source: "qq" }),
    });
    const songRow = db.select().from(songs).where(eq(songs.id, "fb-s2")).get() as any;

    const url = await ensurePlayableStream(songRow);

    expect(url).toBeNull();
    const row = db.select().from(songs).where(eq(songs.id, "fb-s2")).get() as any;
    expect(row.url).toBe("http://orig/broken.mp3");
  });
});