// pump 取源兜底:与 /rest/stream 同口径(优选换行 + 本行直取)。
//
// 回归:歌单引用无 url 本地行 / 死链 web 行时,pump 以前直接抛
// "no playable stream"(DLNA 靠设备拉流晚绑定能播,sendspin 必跳)。
// determinism:自制 WAV + stub fetch,不碰外网。
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { sqlite } from "../../src/db/index.js";
import { registerBuiltinPlugins } from "../../src/plugins/builtins.js";
import { GroupPump, overridePumpSource } from "../../src/services/sendspin/streamEngine.js";

const G = "g-pumpfallback-1";
let wavPath = "";
let wavBytes: Buffer;
const realFetch = globalThis.fetch;

/** 0.5s 440Hz 正弦 16bit 单声道 WAV(48k)。 */
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

function stubGroup() {
  const frames: bigint[] = [];
  const group: any = {
    positionMs: 0,
    timelineBaseUs: 0n,
    current: null,
    // 时间线锚点用(与帧头同源;见 group.ts computeCommonSendAhead)。
    commonSendAheadUs: () => 800_000,
    async pushFrame(ts: bigint, _pcm: Float32Array) {
      frames.push(ts);
    },
  };
  return { group, frames };
}

async function waitInactive(pump: GroupPump, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (!pump.active) return;
    if (Date.now() - t0 > ms) throw new Error(`pump 未结束: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("pump 取源兜底(/rest/stream 同口径)", () => {
  let tmpDir: string;

  beforeAll(() => {
    if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
    registerBuiltinPlugins();
    sqlite.prepare("INSERT INTO plugins (id, name, enabled, config) VALUES ('core-play-preference', 'core-play-preference', 1, '{\"preferLocal\":true,\"fallbackToWeb\":true}') ON CONFLICT(id) DO UPDATE SET enabled=1, config=excluded.config").run();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpfallback-"));
    wavPath = path.join(tmpDir, "t.wav");
    wavBytes = makeWav();
    fs.writeFileSync(wavPath, wavBytes);
    // stub fetch: sidecar 死链一律 404;webdav 文件给 wav;其余走真实 fetch。
    vi.stubGlobal("fetch", (async (url: any, init: any) => {
      const u = String(url);
      if (u.includes("127.0.0.1:9/dead")) return new Response("nope", { status: 404 });
      if (u.includes("127.0.0.1:18777/")) return new Response(wavBytes as any, { status: 200, headers: { "Content-Type": "audio/wav" } });
      return realFetch(url, init);
    }) as any);
    // web 行(死链) + 本地 l: 行(真 wav)+ webdav w: 行,同组
    sqlite.prepare("INSERT INTO songs (id, title, artist, type, url, plugin_entry, group_id, path, suffix) VALUES " +
      "('pf-web','T1','A','web','http://127.0.0.1:9/dead.mp3','go-music-dl','" + G + "','', 'mp3')," +
      "('pf-local','T1','A','local','','','" + G + "','l:src:" + wavPath.replace(/'/g, "''") + "', 'wav')," +
      "('pf-dav','T1','A','local','','','" + G + "','w:davsrc:/dav/t.wav', 'wav')").run();
    sqlite.prepare("INSERT INTO media_sources (id, name, type, config) VALUES ('davsrc','dav','webdav','{\"url\":\"http://127.0.0.1:18777/dav\",\"username\":\"u\",\"password\":\"p\"}') ON CONFLICT(id) DO NOTHING").run();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    overridePumpSource(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("死链 web 行 → 优选换本地兄弟行播出", async () => {
    const { group, frames } = stubGroup();
    const pump = new GroupPump({} as any, group);
    await pump.play("pf-web");
    await waitInactive(pump, 15000, "优选换行");
    expect(group.current).toBeNull();
    expect(frames.length).toBeGreaterThan(0);
  }, 30000);

  it("无 url 本地行直取 path 播出", async () => {
    const { group, frames } = stubGroup();
    const pump = new GroupPump({} as any, group);
    await pump.play("pf-local");
    await waitInactive(pump, 15000, "本行直取");
    expect(group.current).toBeNull();
    expect(frames.length).toBeGreaterThan(0);
  }, 30000);

  it("webdav 行经源鉴权取流播出", async () => {
    const { group, frames } = stubGroup();
    const pump = new GroupPump({} as any, group);
    await pump.play("pf-dav");
    await waitInactive(pump, 15000, "webdav 直取");
    expect(group.current).toBeNull();
    expect(frames.length).toBeGreaterThan(0);
  }, 30000);
});
