// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "./_env.js";

import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import { initDatabase, sqlite } from "../../src/db/index.js";

// ---- 被 mock 的依赖:dlna/airplay 的传输层 + 音频管线 + 过期标记 ----
// 这两个 renderer 插件本身是「薄适配器」:把 services/dlna|airplay 的既有能力
// 包装成 RendererPlugin 契约。真正的 SSDP/mDNS/RTSP 都在被 mock 的模块里,
// 所以这里只验「适配层的映射与错误语义」。
const h = vi.hoisted(() => ({
  // dlna/control
  cachedDevices: [] as any[],
  effectiveBaseUrl: "http://192.168.1.5:46400" as string | null,
  castToDevice: vi.fn(),
  deviceDisplayName: vi.fn((d: any) => `disp:${d.id}`),
  // dlna/discovery
  markStaleDevices: vi.fn((list: any[]) => list),
  // airplay/control
  airplayDevices: [] as any[],
  castToAirPlayDevice: vi.fn(),
  pauseAirPlay: vi.fn(),
  resumeAirPlay: vi.fn(),
  stopAirPlay: vi.fn(),
  seekAirPlay: vi.fn(),
  setAirPlayVolume: vi.fn(),
  setAirPlayMuted: vi.fn(),
  // dlna/control 的动态 import 面
  playDevice: vi.fn(),
  pauseDevice: vi.fn(),
  stopDevice: vi.fn(),
  seekDevice: vi.fn(),
  setDeviceVolume: vi.fn(),
  // audio/pipeline
  resolveDlnaOutput: vi.fn((suffix: string | null) => ({ mime: `mime:${suffix}` })),
}));

vi.mock("../../src/services/dlna/control.js", () => ({
  getCachedDevices: () => h.cachedDevices,
  getEffectiveBaseUrl: () => h.effectiveBaseUrl,
  castToDevice: h.castToDevice,
  deviceDisplayName: h.deviceDisplayName,
  playDevice: h.playDevice,
  pauseDevice: h.pauseDevice,
  stopDevice: h.stopDevice,
  seekDevice: h.seekDevice,
  setDeviceVolume: h.setDeviceVolume,
}));

vi.mock("../../src/services/dlna/discovery.js", () => ({
  markStaleDevices: h.markStaleDevices,
}));

vi.mock("../../src/services/airplay/control.js", () => ({
  listAirPlayDevices: () => h.airplayDevices,
  castToAirPlayDevice: h.castToAirPlayDevice,
  pauseAirPlay: h.pauseAirPlay,
  resumeAirPlay: h.resumeAirPlay,
  stopAirPlay: h.stopAirPlay,
  seekAirPlay: h.seekAirPlay,
  setAirPlayVolume: h.setAirPlayVolume,
  setAirPlayMuted: h.setAirPlayMuted,
}));

vi.mock("../../src/services/audio/pipeline.js", () => ({
  resolveDlnaOutput: h.resolveDlnaOutput,
}));

import { dlnaRendererPlugin, dlnaRendererManifest, DLNA_RENDERER_ID } from "../../src/services/plugin/renderers/dlna.js";
import { airplayRendererPlugin, airplayRendererManifest, AIRPLAY_RENDERER_ID } from "../../src/services/plugin/renderers/airplay.js";

const iso = () => new Date().toISOString();

function seedSong(id: string, over: Record<string, any> = {}) {
  sqlite
    .prepare(
      `INSERT INTO songs (id, title, artist, album, duration, path, suffix, type, cover_art, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      over.title ?? `T ${id}`,
      over.artist ?? "A",
      over.album ?? "Al",
      over.duration === undefined ? 200 : over.duration,
      `l:src:/tmp/${id}.mp3`,
      over.suffix ?? "mp3",
      "local",
      over.coverArt ?? null,
      iso(),
    );
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
});

beforeEach(() => {
  vi.clearAllMocks();
  h.cachedDevices = [];
  h.airplayDevices = [];
  h.effectiveBaseUrl = "http://192.168.1.5:46400";
  h.markStaleDevices.mockImplementation((list: any[]) => list);
  h.deviceDisplayName.mockImplementation((d: any) => `disp:${d.id}`);
  h.resolveDlnaOutput.mockImplementation((suffix: string | null) => ({ mime: `mime:${suffix}` }));
  sqlite.prepare("DELETE FROM songs").run();
});

describe("DLNA 渲染器插件 manifest(适配层契约,不是设备实现)", () => {
  it("id/type/capabilities 与「默认开启、零配置」约定", () => {
    expect(DLNA_RENDERER_ID).toBe("dlna-renderer");
    expect(dlnaRendererManifest.id).toBe("dlna-renderer");
    expect(dlnaRendererManifest.type).toBe("renderer");
    expect(dlnaRendererManifest.capabilities).toEqual(["renderer"]);
    expect(dlnaRendererManifest.defaultEnabled).toBe(true);
    expect(dlnaRendererManifest.configSchema).toEqual([]);
    expect(dlnaRendererPlugin.manifest).toBe(dlnaRendererManifest);
  });

  it("插件侧 i18n 只补 en(中文即默认文案),且 en 有 name/description/documentation", () => {
    expect(Object.keys(dlnaRendererManifest.i18n || {})).toEqual(["en"]);
    const en = (dlnaRendererManifest.i18n as any).en;
    expect(en.name).toBe("DLNA Renderer");
    expect(typeof en.description).toBe("string");
    expect(en.documentation).toContain("### Features");
  });
});

describe("DLNA 渲染器 discover:设备投影", () => {
  it("先 markStaleDevices(getCachedDevices()) 再投影,字段一一对齐", async () => {
    h.cachedDevices = [
      { id: "d1", available: true, manufacturer: "HiVi", model: "H5", renderingControlUrl: "http://x/rc", alias: "主卧" },
      { id: "d2", available: false, manufacturer: "", model: "", renderingControlUrl: "", alias: "" },
    ];
    const list = await dlnaRendererPlugin.discover();
    expect(h.markStaleDevices).toHaveBeenCalledTimes(1);
    expect(h.markStaleDevices).toHaveBeenCalledWith(h.cachedDevices);
    expect(list).toEqual([
      {
        id: "d1",
        name: "disp:d1",
        type: "dlna",
        available: true,
        meta: { manufacturer: "HiVi", model: "H5", hasVolumeControl: true, alias: "主卧" },
      },
      {
        id: "d2",
        name: "disp:d2",
        type: "dlna",
        available: false,
        meta: { manufacturer: "", model: "", hasVolumeControl: false, alias: "" },
      },
    ]);
    // hasVolumeControl 是「有没有 RenderingControl 端点」的布尔投影,不是字符串
    expect(list[1].meta!.hasVolumeControl).toBe(false);
  });

  it("空设备表 → 空数组(不抛)", async () => {
    await expect(dlnaRendererPlugin.discover()).resolves.toEqual([]);
  });
});

describe("DLNA 渲染器 cast:守卫 + 元数据映射", () => {
  it("拿不到出流基址 → 直接抛(提示先投屏或配 DLNA_BASE_URL)", async () => {
    h.effectiveBaseUrl = null;
    await expect(dlnaRendererPlugin.cast("d1", "s1")).rejects.toThrow(/未确定 DLNA 流地址/);
    expect(h.castToDevice).not.toHaveBeenCalled();
  });

  it("歌曲不存在 → 抛『歌曲不存在』,不调用底层投屏", async () => {
    await expect(dlnaRendererPlugin.cast("d1", "nope")).rejects.toThrow("歌曲不存在");
    expect(h.castToDevice).not.toHaveBeenCalled();
  });

  it("成功:title/artist/album 空值回落, mime 走 resolveDlnaOutput(suffix), coverArt 透传, baseUrl 用生效值", async () => {
    seedSong("s1", { title: "真歌名", artist: "", album: "", coverArt: null, suffix: "flac" });
    h.castToDevice.mockResolvedValue({ mediaUri: "session-1" });
    const r = await dlnaRendererPlugin.cast("d1", "s1");
    expect(r).toEqual({ mediaUri: "session-1" });
    expect(h.resolveDlnaOutput).toHaveBeenCalledWith("flac");
    expect(h.castToDevice).toHaveBeenCalledWith({
      deviceId: "d1",
      songId: "s1",
      title: "真歌名",
      artist: undefined,
      album: undefined,
      mime: "mime:flac",
      baseUrl: "http://192.168.1.5:46400",
      coverArt: undefined,
    });
  });

  it("title 缺失 → 回落「未知」;专辑/艺人非空则透传;coverArt 非空则透传", async () => {
    seedSong("s2", { title: "", artist: "艺", album: "辑", coverArt: "al-1", suffix: "ogg" });
    h.castToDevice.mockResolvedValue({ mediaUri: "" });
    await dlnaRendererPlugin.cast("d2", "s2");
    const arg = h.castToDevice.mock.calls[0][0];
    expect(arg.title).toBe("未知");
    expect(arg.artist).toBe("艺");
    expect(arg.album).toBe("辑");
    expect(arg.coverArt).toBe("al-1");
    expect(arg.mime).toBe("mime:ogg");
  });

  it("底层投屏抛错 → 原样冒泡(适配层不加额外包装)", async () => {
    seedSong("s3");
    h.castToDevice.mockRejectedValue(new Error("SOAP 500"));
    await expect(dlnaRendererPlugin.cast("d3", "s3")).rejects.toThrow("SOAP 500");
  });
});

describe("DLNA 渲染器 control:action 路由(动态 import 同一个 control 模块)", () => {
  beforeEach(() => {
    h.playDevice.mockResolvedValue("ok-play");
    h.pauseDevice.mockResolvedValue("ok-pause");
    h.stopDevice.mockResolvedValue("ok-stop");
    h.seekDevice.mockResolvedValue("ok-seek");
    h.setDeviceVolume.mockResolvedValue("ok-vol");
  });

  it("play/pause/stop 分别打到 playDevice/pauseDevice/stopDevice", async () => {
    await expect(dlnaRendererPlugin.control!("d1", "play")).resolves.toBe("ok-play");
    await expect(dlnaRendererPlugin.control!("d1", "pause")).resolves.toBe("ok-pause");
    await expect(dlnaRendererPlugin.control!("d1", "stop")).resolves.toBe("ok-stop");
    expect(h.playDevice).toHaveBeenCalledWith("d1");
    expect(h.pauseDevice).toHaveBeenCalledWith("d1");
    expect(h.stopDevice).toHaveBeenCalledWith("d1");
  });

  it("seek 取 payload.seconds,缺省 0", async () => {
    await dlnaRendererPlugin.control!("d1", "seek", { seconds: 42 });
    await dlnaRendererPlugin.control!("d1", "seek");
    expect(h.seekDevice).toHaveBeenNthCalledWith(1, "d1", 42);
    expect(h.seekDevice).toHaveBeenNthCalledWith(2, "d1", 0);
  });

  it("volume 取 payload.volume,缺省 0", async () => {
    await dlnaRendererPlugin.control!("d1", "volume", { volume: 17 });
    await dlnaRendererPlugin.control!("d1", "volume");
    expect(h.setDeviceVolume).toHaveBeenNthCalledWith(1, "d1", 17);
    expect(h.setDeviceVolume).toHaveBeenNthCalledWith(2, "d1", 0);
  });

  it("未知 action → 抛『不支持的渲染器操作』并带上动作名", async () => {
    await expect(dlnaRendererPlugin.control!("d1", "next")).rejects.toThrow("不支持的渲染器操作: next");
    expect(h.playDevice).not.toHaveBeenCalled();
  });
});

describe("AirPlay 渲染器插件 manifest(默认关闭:零常驻资源)", () => {
  it("id/type/capabilities 与「默认关闭、零配置」约定", () => {
    expect(AIRPLAY_RENDERER_ID).toBe("airplay-renderer");
    expect(airplayRendererManifest.id).toBe("airplay-renderer");
    expect(airplayRendererManifest.type).toBe("renderer");
    expect(airplayRendererManifest.capabilities).toEqual(["renderer"]);
    // 这条是本插件与 DLNA 渲染器唯一的语义差别:mDNS 常驻监听有开销,故默认关
    expect(airplayRendererManifest.defaultEnabled).toBe(false);
    expect(airplayRendererManifest.configSchema).toEqual([]);
    expect(airplayRendererPlugin.manifest).toBe(airplayRendererManifest);
  });

  it("插件侧 i18n 只补 en,且 en.documentation 说明不支持 AirPlay 2", () => {
    expect(Object.keys(airplayRendererManifest.i18n || {})).toEqual(["en"]);
    const en = (airplayRendererManifest.i18n as any).en;
    expect(en.name).toBe("AirPlay Renderer");
    expect(airplayRendererManifest.documentation).toContain("不支持 AirPlay 2");
  });
});

describe("AirPlay 渲染器 discover:am 字段双用 + RSA 能力透传", () => {
  it("manufacturer/model 都取 d.am(缺失回落 AirPlay/RAOP),hasVolumeControl 恒 true", async () => {
    h.airplayDevices = [
      { id: "a1", name: "客厅", available: true, am: "阿音 WR320", supportsRsa: true },
      { id: "a2", name: "卧室", available: false, am: undefined, supportsRsa: false },
    ];
    await expect(airplayRendererPlugin.discover()).resolves.toEqual([
      {
        id: "a1",
        name: "客厅",
        type: "airplay",
        available: true,
        meta: { manufacturer: "阿音 WR320", model: "阿音 WR320", hasVolumeControl: true, supportsRsa: true },
      },
      {
        id: "a2",
        name: "卧室",
        type: "airplay",
        available: false,
        meta: { manufacturer: "AirPlay", model: "RAOP", hasVolumeControl: true, supportsRsa: false },
      },
    ]);
  });

  it("空设备表 → 空数组", async () => {
    await expect(airplayRendererPlugin.discover()).resolves.toEqual([]);
  });
});

describe("AirPlay 渲染器 cast:守卫 + durationSec 只在真数字时下发", () => {
  it("拿不到出流基址 → 抛(文案落在 DLNA_BASE_URL 上)", async () => {
    h.effectiveBaseUrl = null;
    await expect(airplayRendererPlugin.cast("a1", "s1")).rejects.toThrow(/DLNA_BASE_URL/);
    expect(h.castToAirPlayDevice).not.toHaveBeenCalled();
  });

  it("歌曲不存在 → 抛『歌曲不存在』", async () => {
    h.effectiveBaseUrl = "http://h:1";
    await expect(airplayRendererPlugin.cast("a1", "ghost")).rejects.toThrow("歌曲不存在");
    expect(h.castToAirPlayDevice).not.toHaveBeenCalled();
  });

  it("成功:返回空 mediaUri(AirPlay 由设备自行拉流,无服务端媒体 URL)", async () => {
    seedSong("s1", { title: "曲", artist: "人", album: "辑", duration: 321 });
    h.castToAirPlayDevice.mockResolvedValue(undefined);
    const r = await airplayRendererPlugin.cast("a1", "s1");
    expect(r).toEqual({ mediaUri: "" });
    expect(h.castToAirPlayDevice).toHaveBeenCalledWith({
      deviceId: "a1",
      songId: "s1",
      title: "曲",
      artist: "人",
      album: "辑",
      durationSec: 321,
      baseUrl: "http://192.168.1.5:46400",
    });
  });

  it("duration 不是数字 → durationSec 为 undefined(不塞 NaN/字符串给 RAOP)", async () => {
    seedSong("s2", { title: "", artist: "", album: "", duration: null });
    h.castToAirPlayDevice.mockResolvedValue(undefined);
    await airplayRendererPlugin.cast("a2", "s2");
    const arg = h.castToAirPlayDevice.mock.calls[0][0];
    expect(arg.title).toBe("未知");
    expect(arg.artist).toBeUndefined();
    expect(arg.album).toBeUndefined();
    expect(arg.durationSec).toBeUndefined();
  });
});

describe("AirPlay 渲染器 control:action 路由 + mute 布尔强转", () => {
  beforeEach(() => {
    h.resumeAirPlay.mockResolvedValue("r");
    h.pauseAirPlay.mockResolvedValue("p");
    h.stopAirPlay.mockResolvedValue("s");
    h.seekAirPlay.mockResolvedValue("k");
    h.setAirPlayVolume.mockResolvedValue("v");
    h.setAirPlayMuted.mockResolvedValue("m");
  });

  it("play→resumeAirPlay(不是 playAirPlay:RAOP 语义是「继续」)", async () => {
    await expect(airplayRendererPlugin.control!("a1", "play")).resolves.toBe("r");
    expect(h.resumeAirPlay).toHaveBeenCalledWith("a1");
  });

  it("pause/stop 分别打到 pauseAirPlay/stopAirPlay", async () => {
    await airplayRendererPlugin.control!("a1", "pause");
    await airplayRendererPlugin.control!("a1", "stop");
    expect(h.pauseAirPlay).toHaveBeenCalledWith("a1");
    expect(h.stopAirPlay).toHaveBeenCalledWith("a1");
  });

  it("seek 取 payload.seconds,缺省 0", async () => {
    await airplayRendererPlugin.control!("a1", "seek", { seconds: 9 });
    await airplayRendererPlugin.control!("a1", "seek");
    expect(h.seekAirPlay).toHaveBeenNthCalledWith(1, "a1", 9);
    expect(h.seekAirPlay).toHaveBeenNthCalledWith(2, "a1", 0);
  });

  it("volume 取 payload.volume,缺省 0", async () => {
    await airplayRendererPlugin.control!("a1", "volume", { volume: 3 });
    await airplayRendererPlugin.control!("a1", "volume");
    expect(h.setAirPlayVolume).toHaveBeenNthCalledWith(1, "a1", 3);
    expect(h.setAirPlayVolume).toHaveBeenNthCalledWith(2, "a1", 0);
  });

  it("mute 用 !!payload.muted 强转(truthy 都算静音,缺省 false)", async () => {
    await airplayRendererPlugin.control!("a1", "mute", { muted: 1 });
    await airplayRendererPlugin.control!("a1", "mute", { muted: "" });
    await airplayRendererPlugin.control!("a1", "mute");
    expect(h.setAirPlayMuted).toHaveBeenNthCalledWith(1, "a1", true);
    expect(h.setAirPlayMuted).toHaveBeenNthCalledWith(2, "a1", false);
    expect(h.setAirPlayMuted).toHaveBeenNthCalledWith(3, "a1", false);
  });

  it("未知 action → 抛『不支持的渲染器操作』", async () => {
    await expect(airplayRendererPlugin.control!("a1", "eject")).rejects.toThrow("不支持的渲染器操作: eject");
    expect(h.resumeAirPlay).not.toHaveBeenCalled();
  });
});
