// 统一音源裁决:各链路同口径(快缓存 → 本行探测 → 优选换行 → 本行复核)。
// 回归:周深小美满案——歌单引用无 url 本地行,旧 judge 探失败即判死,
// 不看组内 web 兄弟;现应换行播出。
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { sqlite } from "../../src/db/index.js";
import { registerBuiltinPlugins } from "../../src/plugins/builtins.js";
import { resolvePlayableRow, fetchRowBytes } from "../../src/services/source/resolveAudio.js";

const G = "g-resolve-1";
let wavPath = "";
let wavBytes: Buffer;
const realFetch = globalThis.fetch;

function makeWav(): Buffer {
  const rate = 48000;
  const n = Math.floor(rate * 0.5);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(Math.floor(28000 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + data.length, 4); head.write("WAVE", 8);
  head.write("fmt ", 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22); head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

describe("resolvePlayableRow", () => {
  let tmpDir: string;

  beforeAll(() => {
    if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
    registerBuiltinPlugins();
    sqlite.prepare("INSERT INTO plugins (id, name, enabled, config) VALUES ('core-play-preference', 'core-play-preference', 1, '{\"preferLocal\":true,\"fallbackToWeb\":true}') ON CONFLICT(id) DO UPDATE SET enabled=1, config=excluded.config").run();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-audio-"));
    wavPath = path.join(tmpDir, "t.wav");
    wavBytes = makeWav();
    fs.writeFileSync(wavPath, wavBytes);
    vi.stubGlobal("fetch", (async (url: any, init: any) => {
      const u = String(url);
      if (u.includes("127.0.0.1:9/dead")) return new Response("nope", { status: 404 });
      if (u.includes("127.0.0.1:9/alive")) return new Response(wavBytes as any, { status: 200, headers: { "Content-Type": "audio/wav" } });
      return realFetch(url, init);
    }) as any);
    sqlite.prepare("INSERT INTO songs (id, title, artist, type, url, plugin_entry, group_id, path, suffix) VALUES " +
      "('ra-web','T1','A','web','http://127.0.0.1:9/dead.mp3','go-music-dl','" + G + "','', 'mp3')," +
      "('ra-local','T1','A','local','','','" + G + "','l:src:" + wavPath.replace(/'/g, "''") + "', 'wav')," +
      "('ra-dead','T9','Z','web','http://127.0.0.1:9/dead.mp3','go-music-dl','g-resolve-dead','','mp3')").run();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("死链 web 行 → 换组内本地行(优选),reason 标记", async () => {
    const r = await resolvePlayableRow("ra-web");
    expect(r.row?.id).toBe("ra-local");
    expect(r.reason).toBe("preferred-swap");
    const bytes = await fetchRowBytes(r.row!);
    expect(bytes!.length).toBeGreaterThan(1000);
  }, 30000);

  it("本地行直取", async () => {
    const r = await resolvePlayableRow("ra-local");
    expect(r.row?.id).toBe("ra-local");
  }, 30000);

  it("全死返回 null + reason", async () => {
    const r = await resolvePlayableRow("ra-dead");
    expect(r.row).toBeNull();
    expect(typeof r.reason).toBe("string");
  }, 60000);

  it("查无此歌返回 null", async () => {
    const r = await resolvePlayableRow("no-such-song");
    expect(r.row).toBeNull();
    expect(r.reason).toBe("no-row");
  });
});
