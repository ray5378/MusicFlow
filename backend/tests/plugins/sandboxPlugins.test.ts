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

// —— listenbrainz 推荐功能测试用状态 ——
let lbCfg: any;
const playlistCalls: any[] = [];
const lbStorage: Record<string, any> = {};
// 本地曲库:标题→songId 的可控映射(测试时可改)
const localLibrary: Record<string, string> = {};
// 在线源补全:artist+title → songId(测试时可改),返回 null 表示补全失败
const onlineCompletions: Record<string, string | null> = {};

function lbHttpRoutes() {
  return async (input: string, init?: any) => {
    const u = String(input);
    requests.push({ url: u, method: init?.method || "GET", body: init?.body });
    // 协同过滤推荐:返回两个 MBID
    if (u.includes("/1/cf/recommendation/user/")) {
      return { ok: true, status: 200, headers: {}, body: JSON.stringify({
        payload: { mbids: [
          { recording_mbid: "m1", score: 9.5 },
          { recording_mbid: "m2", score: 8.1 },
        ] },
      }) };
    }
    // 元数据:换名 + 艺人 + 专辑 + 时长(ms)。1.5.3 起 LB 换出名的条目直接用 LB 结果,
    // 不再经 MusicBrainz 覆盖 artist/album,故此处带 release_name。
    if (u.includes("/1/metadata/recording")) {
      return { ok: true, status: 200, headers: {}, body: JSON.stringify({
        m1: { recording: { name: "Song One", rels: [{ artist_name: "Artist A", type: "vocal" }], release_name: "Album One", length: 200000 } },
        m2: { recording: { name: "Song Two", rels: [{ artist_name: "Artist B", type: "lead vocals" }], release_name: "Album Two", length: 180000 } },
      }) };
    }
    // MusicBrainz:仅对 LB 换不出名的推荐 MBID 兜底(本测试两首都换出名,不触发)
    if (u.includes("/ws/2/recording/")) {
      const mbid = decodeURIComponent(u.split("/ws/2/recording/")[1].split("?")[0]);
      const map: Record<string, any> = {
        m1: { artist: "Artist A", album: "Album One" },
        m2: { artist: "Artist B", album: "Album Two" },
      };
      const info = map[mbid] || {};
      return { ok: true, status: 200, headers: {}, body: JSON.stringify({
        "artist-credit": info.artist ? [{ name: info.artist, artist: { name: info.artist } }] : [],
        releases: info.album ? [{ title: info.album, status: "official", "primary-type": "Album" }] : [],
      }) };
    }
    if (u.includes("/1/submit-listens")) return { ok: true, status: 200, headers: {}, body: "{}" };
    return { ok: false, status: 404, headers: {}, body: "not found" };
  };
}

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
  lbCfg = { userToken: "tok-123", apiUrl: "", submitPlayingNow: true, minDuration: 30, username: "testuser", playlistModes: ["top", "similar"], perModeCount: 25, refreshIntervalDays: 1 };
  const lb = await loadSandboxedPlugin("listenbrainz", lbCode, {
    version: "1.3.0",
    getConfig: () => lbCfg,
    permissions: lbJson.permissions || [],
    http: lbHttpRoutes(),
    storage: {
      get: async (k: string) => (k in lbStorage ? lbStorage[k] : null),
      set: async (k: string, v: any) => { lbStorage[k] = v; },
      delete: async (k: string) => { delete lbStorage[k]; },
      keys: async () => Object.keys(lbStorage),
    },
    songs: {
      list: async () => [],
      search: async (q: string) => {
        // 标题出现在本地库映射里 → 返回对应 songId
        for (const [title, id] of Object.entries(localLibrary)) {
          if (String(q || "").includes(title)) return [{ id, title, artist: "本地艺人", album: "本地专辑", duration: 200, coverArt: "so-x" }];
        }
        return [];
      },
      getById: async () => null,
    },
    sources: {
      complete: async (opts: any) => {
        const key = `${opts.artist}|${opts.title}`;
        return { songId: key in onlineCompletions ? onlineCompletions[key] : `online-${opts.title}` };
      },
    },
    playlists: {
      upsert: async (id: string, opts: any) => { playlistCalls.push({ id, opts }); return { id, ...opts }; },
      get: async () => null,
      replaceEntries: async () => ({}),
      updateCover: async () => ({}),
    },
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

describe("真实外置插件 · listenbrainz 推荐(runDailyJob,沙箱)", () => {
  it("force 刷新:拉推荐→换名→在线补全→upsert 固定歌单", () => skip(async () => {
    playlistCalls.length = 0;
    lbStorage.lastRun = 0;
    const r = await lbImpl.runDailyJob({ force: true });
    expect(r).toContain("ListenBrainz");
    expect(playlistCalls.length).toBe(1);
    const call = playlistCalls[0];
    expect(call.id).toBe("pl-lb-recommend");
    expect(call.opts.name).toBe("ListenBrainz");
    // 两首都走在线补全 → 都成为可播 songId 条目
    expect(call.opts.entries.length).toBe(2);
    expect(call.opts.entries.every((e: any) => e.songId)).toBe(true);
    // 封面取第一个有匹配的 songId
    expect(call.opts.coverSongId).toBeTruthy();
    // lastRun 已更新
    expect(lbStorage.lastRun).toBeGreaterThan(0);
  }));

  it("间隔闸门:非 force 且未到期时跳过(返回 null)", () => skip(async () => {
    playlistCalls.length = 0;
    lbStorage.lastRun = Date.now(); // 刚生成过
    const r = await lbImpl.runDailyJob({});
    expect(r).toBeNull();
    expect(playlistCalls.length).toBe(0);
  }));

  it("本地曲库命中:优先用本地 songId 而非在线补全", () => skip(async () => {
    playlistCalls.length = 0;
    lbStorage.lastRun = 0;
    localLibrary["Song One"] = "local-so-1"; // m1 命中本地
    const r = await lbImpl.runDailyJob({ force: true });
    expect(r).toContain("ListenBrainz");
    const entries = playlistCalls[0].opts.entries;
    // 第一首来自本地,第二首来自在线补全
    expect(entries[0].songId).toBe("local-so-1");
    expect(entries[1].songId).toBe("online-Song Two");
    delete localLibrary["Song One"];
  }));

  it("在线补全也失败:退化为外部不可播占位条目", () => skip(async () => {
    playlistCalls.length = 0;
    lbStorage.lastRun = 0;
    // 让两首都补全失败
    onlineCompletions["Artist A|Song One"] = null;
    onlineCompletions["Artist B|Song Two"] = null;
    const r = await lbImpl.runDailyJob({ force: true });
    expect(r).toContain("ListenBrainz");
    const entries = playlistCalls[0].opts.entries;
    expect(entries.length).toBe(2);
    // 全为外部占位:有 externalTitle、playable 由宿主侧置 0、且 duration 透传(ms)
    expect(entries.every((e: any) => e.externalTitle && !e.songId)).toBe(true);
    expect(entries[0].externalDuration).toBe(200000);
    // 艺人/专辑来自 LB metadata(1.5.3 起 named 条目直接用 LB 结果):外部条目也带完整信息
    expect(entries[0].externalArtist).toBe("Artist A");
    expect(entries[0].externalAlbum).toBe("Album One");
    expect(entries[1].externalArtist).toBe("Artist B");
    delete onlineCompletions["Artist A|Song One"];
    delete onlineCompletions["Artist B|Song Two"];
  }));

  it("未配置 username:跳过生成不报错", () => skip(async () => {
    playlistCalls.length = 0;
    lbStorage.lastRun = 0;
    const saved = lbCfg.username;
    lbCfg.username = "";
    const r = await lbImpl.runDailyJob({ force: true });
    expect(r).toBeNull();
    expect(playlistCalls.length).toBe(0);
    lbCfg.username = saved;
  }));
});

// ==================== last.fm(双功能:签名上报 + Top/Loved/相似艺人推荐) ====================
import { createHash } from "node:crypto";

let lfImpl: any;
let lfCfg: any;
const lfWrites: any[] = [];
const lfPlaylistCalls: any[] = [];
const lfStorage: Record<string, any> = {};
const lfLocal: Record<string, string> = {};
// 在线补全覆盖:key=artist|title → songId 或 null(失败);默认成功返回 online-<title>
const lfCompletions: Record<string, string | null> = {};

function lfHttpRoutes() {
  return async (input: string, init?: any) => {
    const u = String(input);
    const q = new URLSearchParams((u.split("?")[1] || ""));
    const method = q.get("method") || "";
    // 写接口:捕获 form body 供签名断言
    if (init?.method === "POST") {
      lfWrites.push({ url: u, body: init?.body || "" });
      return { ok: true, status: 200, headers: {}, body: "{}" };
    }
    if (method === "user.getTopTracks") {
      return { ok: true, status: 200, headers: {}, body: JSON.stringify({
        toptracks: { track: [
          { name: "Top One", artist: { name: "Artist T" }, playcount: 120, mbid: "t1" },
          { name: "Top Two", artist: { name: "Artist T" }, playcount: 90 },
        ] },
      }) };
    }
    if (method === "user.getLovedTracks") {
      return { ok: true, status: 200, headers: {}, body: JSON.stringify({
        lovedtracks: { track: [
          { name: "Loved One", artist: { name: "Artist L" }, playcount: 5 },
        ] },
      }) };
    }
    if (method === "user.getInfo") {
      return { ok: true, status: 200, headers: {}, body: JSON.stringify({ user: { name: "testuser" } }) };
    }
    return { ok: false, status: 404, headers: {}, body: "not found" };
  };
}

describe("lastfm 外置插件(沙箱)", () => {
  beforeAll(async () => {
    if (!hasPluginRepo) return;
    const lfCode = fs.readFileSync(path.join(PLUGINS_ROOT, "lastfm/index.js"), "utf8");
    const lfJson = JSON.parse(fs.readFileSync(path.join(PLUGINS_ROOT, "lastfm/plugin.json"), "utf8"));
    lfCfg = { username: "testuser", apiKey: "k-1", apiSecret: "sec-123", sessionKey: "sk-1", submitPlayingNow: true, minDuration: 30, periods: ["overall"], includeLoved: true, includeSimilar: false, perPeriodCount: 25, refreshIntervalDays: 1 };
    const lf = await loadSandboxedPlugin("lastfm", lfCode, {
      version: "1.7.34",
      getConfig: () => lfCfg,
      permissions: lfJson.permissions || [],
      http: lfHttpRoutes(),
      crypto: { md5: (s: string) => createHash("md5").update(String(s)).digest("hex") },
      storage: {
        get: async (k: string) => (k in lfStorage ? lfStorage[k] : null),
        set: async (k: string, v: any) => { lfStorage[k] = v; },
        delete: async (k: string) => { delete lfStorage[k]; },
        keys: async () => Object.keys(lfStorage),
      },
      songs: {
        list: async () => [],
        search: async (q: string) => {
          for (const [title, id] of Object.entries(lfLocal)) {
            if (String(q || "").includes(title)) return [{ id, title, artist: "本地艺人", duration: 200 }];
          }
          return [];
        },
        getById: async () => null,
      },
      sources: {
        complete: async (opts: any) => {
          const key = `${opts.artist}|${opts.title}`;
          if (key in lfCompletions) return { songId: lfCompletions[key] };
          return { songId: `online-${opts.title}` };
        },
      },
      playlists: {
        upsert: async (id: string, opts: any) => { lfPlaylistCalls.push({ id, opts }); return { ok: true }; },
        get: async () => null,
        replaceEntries: async () => ({ ok: true }),
        updateCover: async () => ({ ok: true }),
      },
      log: () => {},
      comm: { send: () => {}, broadcast: () => {}, on: () => {} },
    }, lfJson);
    lfImpl = lf.impl;
  });

  it("runDailyJob:Top(overall) + Loved 合并去重组装歌单,本地命中优先,其余在线补全", () => skip(async () => {
    lfPlaylistCalls.length = 0;
    lfStorage.lastRun = 0;
    lfLocal["Top One"] = "local-top-1";
    const r = await lfImpl.runDailyJob({ force: true });
    expect(String(r)).toContain("Last.fm 推荐");
    expect(lfPlaylistCalls.length).toBe(1);
    const call = lfPlaylistCalls[0];
    expect(call.id).toBe("pl-lf-recommend");
    expect(call.opts.name).toBe("Last.fm 推荐");
    const entries = call.opts.entries;
    // Top One(本地命中) + Top Two(在线补全) + Loved One(在线补全)
    expect(entries.length).toBe(3);
    expect(entries[0].songId).toBe("local-top-1");
    expect(entries.find((e: any) => e.songId === "online-Top Two")).toBeTruthy();
    expect(entries.find((e: any) => e.songId === "online-Loved One")).toBeTruthy();
    expect(entries.every((e: any) => e.songId)).toBe(true); // 无外部占位
    delete lfLocal["Top One"];
  }));

  it("runDailyJob:全链路失败退外部占位条目(带艺人/专辑)", () => skip(async () => {
    lfPlaylistCalls.length = 0;
    lfStorage.lastRun = 0;
    delete lfLocal["Top One"]; // 防止前序用例残留
    lfCfg.includeLoved = false; // 只剩 Top(2 首),来源可预期
    lfCompletions["Artist T|Top One"] = null;
    lfCompletions["Artist T|Top Two"] = null;
    const r = await lfImpl.runDailyJob({ force: true });
    expect(String(r)).toContain("Last.fm 推荐");
    const entries = lfPlaylistCalls[0].opts.entries;
    // 本地/在线都失败 → 外部占位,但保留 artist/title
    expect(entries.every((e: any) => e.externalTitle && !e.songId)).toBe(true);
    expect(entries[0].externalArtist).toBe("Artist T");
    lfCfg.includeLoved = true;
    delete lfCompletions["Artist T|Top One"];
    delete lfCompletions["Artist T|Top Two"];
  }));

  it("onScrobble:上报请求带正确 api_sig(MD5 排序签名)与 timestamp", () => skip(async () => {
    lfWrites.length = 0;
    // 核心按 (host, event) 调用,沙箱剥离首参 → 测试传一个占位 host
    await lfImpl.onScrobble({}, { artist: "Queen", title: "Bohemian Rhapsody", album: "A Night at the Opera", duration: 355, playedAt: "2026-08-14T10:00:00Z" });
    expect(lfWrites.length).toBe(1);
    const params = new URLSearchParams(lfWrites[0].body);
    expect(params.get("method")).toBe("track.scrobble");
    expect(params.get("artist")).toBe("Queen");
    expect(params.get("track")).toBe("Bohemian Rhapsody");
    expect(params.get("album")).toBe("A Night at the Opera");
    expect(Number(params.get("timestamp"))).toBeGreaterThan(0);
    const sig = params.get("api_sig") || "";
    expect(sig.length).toBe(32); // MD5 hex
    // 用同一规范重算:除 format/api_sig 外所有参数按 key 字母序 k+v 拼接 + secret
    const keys: string[] = [];
    for (const [k] of params) if (k !== "format" && k !== "api_sig") keys.push(k);
    keys.sort();
    const str = keys.map((k) => k + String(params.get(k))).join("") + "sec-123";
    expect(createHash("md5").update(str).digest("hex")).toBe(sig);
  }));

  it("onPlay:上报 track.updateNowPlaying(带签名)", () => skip(async () => {
    lfWrites.length = 0;
    await lfImpl.onPlay({}, { artist: "Queen", title: "Bohemian Rhapsody", duration: 355 });
    expect(lfWrites.length).toBe(1);
    const params = new URLSearchParams(lfWrites[0].body);
    expect(params.get("method")).toBe("track.updateNowPlaying");
    expect(params.get("artist")).toBe("Queen");
    expect(params.get("api_sig")?.length).toBe(32);
  }));

  it("health():配置齐全且 API 可达 → ok;缺 sessionKey → degraded", () => skip(async () => {
    const ok = await lfImpl.health();
    expect(ok.status).toBe("ok");
    const saved = lfCfg.sessionKey;
    lfCfg.sessionKey = "";
    const degraded = await lfImpl.health();
    expect(degraded.status).toBe("degraded");
    lfCfg.sessionKey = saved;
  }));
});
