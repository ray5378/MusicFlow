// 真实外置插件(go-music-dl / listenbrainz)在 QuickJS 沙箱里的端到端验证。
// mock host.http 按 URL 路由返回伪 go-music-dl HTML,验证解析与上报逻辑。
// 插件源码来自 sibling 仓库 MusicFlow-plugins(不存在则跳过)。

import "../plugins/_env.js";

import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { loadSandboxedPlugin } from "../../src/plugins/sandbox.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGINS_ROOT = path.resolve(HERE, "../../../../MusicFlow-plugins/plugins");
const hasPluginRepo = fs.existsSync(PLUGINS_ROOT);
const skip = (fn: () => any) => (hasPluginRepo ? fn() : undefined);

const SONG_CARDS = `
<li class="song-card" data-id="so-1" data-source="netease" data-name="晴天" data-artist="周杰伦" data-album="叶惠美" data-duration="269" data-cover="http://c1/x.jpg"></li>
<li class="song-card" data-id="so-2" data-source="qq" data-name="七里香" data-artist="周杰伦" data-album="七里香" data-duration="301"></li>`;

function httpRoutes(records: any[]) {
  return async (input: string, init?: any) => {
    const u = String(input);
    records.push({ url: u, method: init?.method || "GET", body: init?.body });
    if (u.includes("/1/submit-listens")) return { ok: true, status: 200, headers: {}, body: "{}" };
    if (u.includes("/music/recommend")) {
      return { ok: true, status: 200, headers: {}, body: `
        <button class="category-source-tab" data-target="recommend-netease"><span class="category-source-tab-name">网易云</span><span class="category-source-tab-count">3</span></button>
        <div class="playlist-card" onclick="navigateTo('/music/playlist?source=netease&id=pl-1&name=%E7%83%AD%E6%AD%8C%E6%A6%9C')"></div>` };
    }
    if (u.includes("/music/playlist?")) return { ok: true, status: 200, headers: {}, body: `<div data-total-count="2"></div>${SONG_CARDS}` };
    if (u.includes("/music/search")) return { ok: true, status: 200, headers: {}, body: SONG_CARDS };
    if (u.includes("/music/download_lrc")) return { ok: true, status: 200, headers: {}, body: "[00:01.00]晴天" };
    if (u.includes("/music/")) return { ok: true, status: 200, headers: {}, body: "<html><title>go-music-dl 聚合搜索</title></html>" };
    return { ok: false, status: 404, headers: {}, body: "not found" };
  };
}

let gmImpl: any;
let lbImpl: any;
let gmConfig = { baseUrl: "http://gm:18080", sources: ["netease"] };
const requests: any[] = [];

beforeAll(async () => {
  if (!hasPluginRepo) return;
  const gmCode = fs.readFileSync(path.join(PLUGINS_ROOT, "go-music-dl/index.js"), "utf8");
  const gmJson = JSON.parse(fs.readFileSync(path.join(PLUGINS_ROOT, "go-music-dl/plugin.json"), "utf8"));
  const gm = await loadSandboxedPlugin("go-music-dl", gmCode, {
    version: "1.3.0",
    getConfig: () => gmConfig,
    permissions: gmJson.permissions || [],
    http: httpRoutes(requests),
    storage: { get: async () => null, set: async () => {}, delete: async () => {}, keys: async () => [] },
    log: () => {},
    comm: { send: () => {}, broadcast: () => {}, on: () => {} },
  }, gmJson);
  gmImpl = gm.impl;

  const lbCode = fs.readFileSync(path.join(PLUGINS_ROOT, "listenbrainz/index.js"), "utf8");
  const lbJson = JSON.parse(fs.readFileSync(path.join(PLUGINS_ROOT, "listenbrainz/plugin.json"), "utf8"));
  let lbCfg = { userToken: "tok-123", apiUrl: "", submitPlayingNow: true, minDuration: 30 };
  const lb = await loadSandboxedPlugin("listenbrainz", lbCode, {
    version: "1.3.0",
    getConfig: () => lbCfg,
    permissions: lbJson.permissions || [],
    http: httpRoutes(requests),
    storage: { get: async () => null, set: async () => {}, delete: async () => {}, keys: async () => [] },
    log: () => {},
    comm: { send: () => {}, broadcast: () => {}, on: () => {} },
  }, lbJson);
  lbImpl = lb.impl;
}, 30000);

const base = { baseUrl: "http://gm:18080", sources: ["netease"] };

describe("真实外置插件 · go-music-dl(沙箱)", () => {
  it("test 连接探测", () => skip(async () => {
    const r = await gmImpl.test({ ...base });
    expect(r.success).toBe(true);
  }));

  it("search 解析 song-card(含中文)", () => skip(async () => {
    const r = await gmImpl.search({ ...base }, { query: "周杰伦", sources: ["netease", "qq"] });
    expect(r.songs.length).toBe(2);
    expect(r.songs[0].name).toBe("晴天");
    expect(r.songs[0].artist).toBe("周杰伦");
  }));

  it("recommend 解析平台 tab + 歌单卡片", () => skip(async () => {
    const r = await gmImpl.recommend({ ...base });
    const netease = r.channels.find((c: any) => c.source === "netease");
    expect(netease).toBeTruthy();
    expect(netease.playlists[0].id).toBe("pl-1");
  }));

  it("playlistSongs 分页拉取", () => skip(async () => {
    const r = await gmImpl.playlistSongs({ ...base }, "netease", "pl-1");
    expect(r.songs.length).toBe(2);
  }));

  it("streamUrl 同步返回可播地址,且 host.config 实时刷新", () => skip(async () => {
    const song = { id: "so-1", source: "netease", name: "晴天", artist: "周杰伦", album: "叶惠美" };
    const url1 = gmImpl.streamUrl({ ...base }, song);
    expect(url1).toContain("/music/download?");
    expect(url1).toContain("stream=1");
    gmConfig = { ...base, baseUrl: "http://gm2:18081" };
    const url2 = gmImpl.streamUrl({ ...base, baseUrl: "http://gm2:18081" }, song);
    expect(url2.startsWith("http://gm2:18081/music/download?")).toBe(true);
  }));

  it("lyricProvider:由流地址推导 lrc 地址并取回歌词", () => skip(async () => {
    const song = { id: "so-1", url: "http://gm:18080/music/download?id=so-1&stream=1", duration: 269 };
    const r = await gmImpl.searchLyrics({}, song);
    expect(r && r.lrc).toContain("晴天");
  }));
});

describe("真实外置插件 · listenbrainz(沙箱)", () => {
  it("onPlay 上报 playing_now(不带 listened_at)", () => skip(async () => {
    await lbImpl.onPlay({}, { artist: "周杰伦", title: "晴天", album: "叶惠美", duration: 269 });
    const call = requests[requests.length - 1];
    expect(call.url).toContain("/1/submit-listens");
    const body = JSON.parse(call.body);
    expect(body.listen_type).toBe("playing_now");
    expect(body.payload[0].listened_at).toBeUndefined();
    expect(body.payload[0].track_metadata.artist_name).toBe("周杰伦");
    expect(body.payload[0].track_metadata.additional_info.duration_ms).toBe(269000);
  }));

  it("onScrobble 上报 single + listened_at(Unix 秒)", () => skip(async () => {
    await lbImpl.onScrobble({}, { artist: "周杰伦", title: "七里香", duration: 301, playedAt: "2026-08-12T08:00:00Z" });
    const body = JSON.parse(requests[requests.length - 1].body);
    expect(body.listen_type).toBe("single");
    expect(body.payload[0].listened_at).toBe(Math.floor(Date.parse("2026-08-12T08:00:00Z") / 1000));
  }));

  it("短曲目(小于 minDuration)跳过正式上报", () => skip(async () => {
    const before = requests.length;
    await lbImpl.onScrobble({}, { artist: "A", title: "B", duration: 10 });
    expect(requests.length).toBe(before);
  }));
});
