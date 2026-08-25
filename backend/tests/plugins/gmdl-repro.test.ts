// 临时复现测试:加载真实 go-music-dl v1.2.39 插件,走 worker 通道执行
// runDailyJob({ keywordOnly: true }),确认关键词搜索入库是否抛 "not a function"。
import "../plugins/_env.js";

import { describe, it, expect } from "vitest";
import fs from "fs";
import { loadSandboxedPlugin } from "../../src/plugins/sandbox.js";
import type { SandboxHostEnv } from "../../src/plugins/sandbox.js";

const PLUGIN_CODE = fs.readFileSync("/workspace/MusicFlow-plugins/plugins/go-music-dl/index.js", "utf8");

// go-music-dl 服务返回的 HTML 片段
const PLAYLIST_HTML = `<div class="playlist-card" onclick="navigateTo('/music/playlist?source=netease&amp;id=111&amp;name=%E6%8A%96%E9%9F%B3&amp;creator=abc&amp;track_count=50')"></div>`;
const SONGS_HTML = `<li class="song-card" data-id="s1" data-source="netease" data-name="\u6b4c\u540d" data-artist="\u6b4c\u624b" data-album="\u4e13\u8f91" data-duration="240"></li>`;

const logs: string[] = [];
let findBySourceCalls = 0;
let upsertCalls = 0;

function makeEnv(): SandboxHostEnv {
  return {
    version: "1.7.66",
    getConfig: () => ({
      baseUrl: "http://gmdl:18080",
      keywords: "\u6296\u97f3\n\u70ed\u95e8",
      minSongs: "30",
      importMyPlaylists: false,
    }),
    permissions: ["net", "storage", "songs:read", "songs:write", "playlists:read", "playlists:write"],
    http: async (input: any) => {
      const u = String(input);
      if (u.includes("/music/search")) return { ok: true, status: 200, headers: {}, body: PLAYLIST_HTML };
      if (u.includes("/music/playlist") || u.includes("/music/album")) return { ok: true, status: 200, headers: {}, body: SONGS_HTML };
      return { ok: false, status: 404, headers: {}, body: "", error: { message: "not found: " + u } };
    },
    storage: { get: async () => null, set: async () => {}, delete: async () => {}, keys: async () => [] },
    log: (...a: any[]) => { logs.push(a.join(" ")); },
    comm: { send: () => {}, broadcast: () => {}, on: () => {}, off: () => {} },
    songs: { list: async () => [], search: async () => [], getById: async () => null },
    plugin: { getHostUrl: async () => "http://host:46400", getNetworkAddresses: async () => ["127.0.0.1"] },
    playlists: {
      upsert: async (id: string, o: any) => { upsertCalls++; return { ok: true, id, ...o }; },
      get: async () => null,
      list: async () => [],
      replaceEntries: async () => ({ ok: true }),
      updateCover: async () => ({ ok: true }),
      findBySource: async () => { findBySourceCalls++; return null; },
      delete: async () => true,
    },
    sources: { complete: async (o: any) => ({ ok: true, songId: "so-new", opts: o }) },
    crypto: { md5: (s: string) => s },
  };
}

describe("go-music-dl 关键词搜索入库(真实沙箱 worker 通道)", () => {
  it("runDailyJob keywordOnly 不应抛 not a function", async () => {
    logs.length = 0; findBySourceCalls = 0; upsertCalls = 0;
    const env = makeEnv();
    const { sandbox, impl } = await loadSandboxedPlugin("go-music-dl", PLUGIN_CODE, env);
    try {
      expect(typeof impl.runDailyJob).toBe("function");
      const ret = await impl.runDailyJob({ keywordOnly: true });
      console.log("runDailyJob 返回:", JSON.stringify(ret));
      console.log("findBySource 调用:", findBySourceCalls, "upsert 调用:", upsertCalls);
      console.log("插件日志:", JSON.stringify(logs, null, 2));
      const err = logs.find((l) => l.includes("\u5173\u952e\u8bcd\u641c\u7d22\u5165\u5e93\u5931\u8d25"));
      expect(err).toBeUndefined();
    } finally {
      sandbox.dispose();
    }
  });
});
