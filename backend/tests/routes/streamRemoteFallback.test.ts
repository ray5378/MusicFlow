// Route tests for /rest/stream-remote 多源换源(本机播放未入库远程歌)。
// 背景:DLNA 投屏先导入再走 /rest/stream,原平台 404 时经 serveWebSongStream 换源;
// 本机「搜索即播」走 /rest/stream-remote,修复前虚拟歌不带 pluginEntry/sourceData,
// 无法换源 → QQ 版权/VIP 轨道在本机直接 404。本测试验证补齐字段后:

//   - 原平台 404 → 严格「歌名-歌手」换到其它平台候选并回 206(同 DLNA 行为)
//   - 无歌手一致的候选 → 维持原 404(不误绑同名异曲)
//   - 歌名后缀严格对齐(Live/演唱会版):有后缀只能配带相同后缀,无后缀只能配无后缀
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { initDatabase, db, sqlite } from "../../src/db/index.js";
import { registerPlugin, unregisterPlugin } from "../../src/plugins/registry.js";
import { restRoutes } from "../../src/routes/rest/index.js";
import { clearStreamFallbackCache } from "../../src/services/source/online/streamFallback.js";

const app = new Hono();
app.route("/rest", restRoutes);

const PROVIDER = "remote-fb-routes";

const manifestOf = {
  id: PROVIDER,
  name: PROVIDER,
  version: "1.0.0",
  type: "source",
  capabilities: ["search", "stream"],
  platforms: ["qq", "kuwo", "netease"],
  configSchema: [],
  permissions: ["net"],
  sourcePreference: ["kuwo", "netease", "qq"],
} as const;

// fetch stub:原平台 id(dead*)一律 404("Failed to get URL"),候选一直 206。
const fetchMock = vi.fn(async (url: string) => {
  const u = String(url);
  if (u.includes("id=dead")) return new Response("Failed to get URL", { status: 404, headers: { "content-type": "text/plain" } });
  return new Response("audio-bytes", { status: 206, headers: { "content-type": "audio/mpeg" } });
});
vi.stubGlobal("fetch", fetchMock);

const streamUrl = (_config: any, s: any) =>
  `http://gm.test/download?id=${s.id}&source=${s.source}&name=${encodeURIComponent(s.name)}`;

function enableProvider(cands: any[]) {
  const provider = {
    id: PROVIDER,
    manifest: manifestOf,
    streamUrl,
    search: async (_config: any, params: any) => ({ songs: cands }),
  };
  registerPlugin(manifestOf as any, provider);
  sqlite.prepare(`
    INSERT INTO plugins (id, name, version, description, manifest, enabled, config, created_at, updated_at)
    VALUES (?, ?, '1.0.0', '', ?, 1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET enabled = 1, config = excluded.config, manifest = excluded.manifest
  `).run(PROVIDER, PROVIDER, JSON.stringify(manifestOf), JSON.stringify({}), new Date().toISOString(), new Date().toISOString());
}

function remoteUrl(rid: string, title: string, artist: string) {
  return `/rest/stream-remote?provider=${PROVIDER}&source=qq&id=${rid}&title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}`;
}

beforeAll(() => {
  initDatabase();
});

afterEach(() => {
  clearStreamFallbackCache();
  fetchMock.mockClear();
  sqlite.prepare("DELETE FROM plugins WHERE id = ?").run(PROVIDER);
  unregisterPlugin(PROVIDER);
});

describe("/rest/stream-remote 多源换源", () => {
  it("原平台 404 → 严格「歌名-歌手」换源到 kuwo 候选并回 206(与 DLNA 一致)", async () => {
    enableProvider([
      { id: "alt1", source: "kuwo", name: "听妈妈的话", artist: "周杰伦", album: "", duration: 0, cover: "" },
      { id: "alt2", source: "netease", name: "听妈妈的话", artist: "别人", album: "", duration: 0, cover: "" },
    ]);
    const res = await app.request(remoteUrl("dead123", "听妈妈的话", "周杰伦"), { method: "GET", headers: { Range: "bytes=0-20000" } });

    expect(res.status).toBe(206);
    expect(res.headers.get("content-type")?.split(";")[0]).toBe("audio/mpeg");
    // 换源候选确被拉取(alt1,而非歌名撞车的 alt2)
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("id=alt1"))).toBe(true);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("id=alt2"))).toBe(false);
  });

  it("无歌手一致的候选 → 维持原 404(不加多源搜索误绑同名异曲)", async () => {
    enableProvider([
      { id: "alt2", source: "netease", name: "听妈妈的话", artist: "别人", album: "", duration: 0, cover: "" },
    ]);
    const res = await app.request(remoteUrl("dead456", "听妈妈的话", "周杰伦"), { method: "GET", headers: { Range: "bytes=0-20000" } });

    expect(res.status).toBe(404);
    // 未触发对歌名撞车候选的流式拉取
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("id=alt2"))).toBe(false);
  });

  it("期望无后缀 + 只搜到带(Live)后缀候选 → 维持原 404(有后缀只能配带相同后缀)", async () => {
    enableProvider([
      { id: "alt3", source: "kuwo", name: "听妈妈的话(Live)", artist: "周杰伦", album: "", duration: 0, cover: "" },
    ]);
    const res = await app.request(remoteUrl("dead789", "听妈妈的话", "周杰伦"), { method: "GET", headers: { Range: "bytes=0-20000" } });

    expect(res.status).toBe(404);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("id=alt3"))).toBe(false);
  });

  it("期望带(Live) + 候选带相同后缀(大小写/空格差异) → 换源回 206", async () => {
    enableProvider([
      { id: "alt4", source: "kuwo", name: "听妈妈的话 (LIVE)", artist: "周杰伦", album: "", duration: 0, cover: "" },
    ]);
    const res = await app.request(remoteUrl("dead1011", "听妈妈的话(Live)", "周杰伦"), { method: "GET", headers: { Range: "bytes=0-20000" } });

    expect(res.status).toBe(206);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("id=alt4"))).toBe(true);
  });
});