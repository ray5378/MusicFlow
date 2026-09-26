// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { initDatabase } from "../../src/db/index.js";
import {
  isRoutableHostname,
  isPrivateLanHostname,
  recordBaseUrl,
  getEffectiveBaseUrl,
  notePeerActivity,
  peerActiveWithin,
  deviceDisplayName,
  getCachedDevices,
  isDeviceDisabled,
  deleteDeviceRecord,
  loadPersistedDevices,
  createCastSession,
  resolveCastToken,
  resolveCastSession,
  mintRawStreamToken,
  resolveRawStreamToken,
  setRuntimePort,
  loopbackBase,
  loopbackRawStreamUrl,
  getCurrentMedia,
  clearCurrentMedia,
  SeekSupersededError,
} from "../../src/services/dlna/control.js";

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("DLNA 主机可达性判定", () => {
  it("isRoutableHostname: 空/回环/单标签名 一律不可达", () => {
    expect(isRoutableHostname("")).toBe(false);
    expect(isRoutableHostname("localhost")).toBe(false);
    expect(isRoutableHostname("127.0.0.1")).toBe(false);
    expect(isRoutableHostname("[::1]")).toBe(false);
    expect(isRoutableHostname("server")).toBe(false); // 无点号,设备无法解析
    expect(isRoutableHostname("   ")).toBe(false);
  });

  it("isRoutableHostname: 带点号的主机可达", () => {
    expect(isRoutableHostname("192.168.1.5")).toBe(true);
    expect(isRoutableHostname("music.example.com")).toBe(true);
  });

  it("isPrivateLanHostname: 私有 IPv4 段", () => {
    expect(isPrivateLanHostname("10.0.0.1")).toBe(true);
    expect(isPrivateLanHostname("192.168.31.9")).toBe(true);
    expect(isPrivateLanHostname("172.16.0.1")).toBe(true);
    expect(isPrivateLanHostname("172.31.255.255")).toBe(true);
    expect(isPrivateLanHostname("169.254.12.34")).toBe(true);
  });

  it("isPrivateLanHostname: 172.32 / 公网 IP / 公网域名 不算局域网", () => {
    expect(isPrivateLanHostname("172.32.0.1")).toBe(false);
    expect(isPrivateLanHostname("8.8.8.8")).toBe(false);
    expect(isPrivateLanHostname("music.example.com")).toBe(false);
    expect(isPrivateLanHostname("")).toBe(false);
    expect(isPrivateLanHostname("127.0.0.1")).toBe(false);
  });

  it("isPrivateLanHostname: IPv6 ULA / 链路本地 / mDNS", () => {
    expect(isPrivateLanHostname("fc00::1")).toBe(true);
    expect(isPrivateLanHostname("fd12:3456::1")).toBe(true);
    expect(isPrivateLanHostname("fe80::1")).toBe(true);
    expect(isPrivateLanHostname("speaker.local")).toBe(true);
    expect(isPrivateLanHostname("SPEAKER.LOCAL")).toBe(true);
  });
});

describe("DLNA base URL 选择", () => {
  it("只缓存局域网可达地址;公网域名不毒害 lastSeenBaseUrl", () => {
    const prev = process.env.DLNA_BASE_URL;
    delete process.env.DLNA_BASE_URL;

    recordBaseUrl("http://192.168.1.5:46400/");
    expect(getEffectiveBaseUrl()).toBe("http://192.168.1.5:46400"); // 末尾斜杠被去掉

    // 公网域名必须被丢弃:设备拉不到流
    recordBaseUrl("http://music.example.com:46400");
    expect(getEffectiveBaseUrl()).toBe("http://192.168.1.5:46400");

    // 空值不记
    recordBaseUrl("");
    expect(getEffectiveBaseUrl()).toBe("http://192.168.1.5:46400");

    if (prev !== undefined) process.env.DLNA_BASE_URL = prev;
  });

  it("DLNA_BASE_URL 环境变量优先级最高", () => {
    const prev = process.env.DLNA_BASE_URL;
    process.env.DLNA_BASE_URL = "http://10.0.0.9:1234/";
    expect(getEffectiveBaseUrl()).toBe("http://10.0.0.9:1234");
    if (prev === undefined) delete process.env.DLNA_BASE_URL;
    else process.env.DLNA_BASE_URL = prev;
  });
});

describe("DLNA 设备记录与显示", () => {
  it("deviceDisplayName: alias > name > id", () => {
    expect(deviceDisplayName({ id: "d1", name: "Kitchen", alias: "厨房" } as any)).toBe("厨房");
    expect(deviceDisplayName({ id: "d1", name: "Kitchen" } as any)).toBe("Kitchen");
    expect(deviceDisplayName({ id: "d1" } as any)).toBe("d1");
  });

  it("未知设备:isDeviceDisabled false / deleteDeviceRecord false", () => {
    expect(isDeviceDisabled("no-such-device-" + Date.now())).toBe(false);
    expect(deleteDeviceRecord("no-such-device-" + Date.now())).toBe(false);
  });

  it("loadPersistedDevices 幂等且 getCachedDevices 返回数组", () => {
    loadPersistedDevices();
    const first = getCachedDevices().length;
    loadPersistedDevices();
    expect(getCachedDevices().length).toBe(first);
    expect(Array.isArray(getCachedDevices())).toBe(true);
  });
});

describe("DLNA cast 会话凭证", () => {
  it("同 song+device 复用同一 token 并续期;不同 device 另发", () => {
    const a = createCastSession("song-1", "dev-A", "http://192.168.1.5:46400");
    expect(a.streamUrl).toBe("http://192.168.1.5:46400/rest/dlna/stream/" + a.token);
    const b = createCastSession("song-1", "dev-A", "http://192.168.1.5:46400");
    expect(b.token).toBe(a.token);
    expect(b.expiresAt).toBeGreaterThanOrEqual(a.expiresAt);
    const c = createCastSession("song-1", "dev-B", "http://192.168.1.5:46400");
    expect(c.token).not.toBe(a.token);

    expect(resolveCastToken(a.token)).toBe("song-1");
    expect(resolveCastSession(a.token)).toEqual({ songId: "song-1", deviceId: "dev-A" });
  });

  it("未知 token 解析为 null;过期会话作废", () => {
    expect(resolveCastToken("no-such-token")).toBeNull();
    expect(resolveCastSession("no-such-token")).toBeNull();

    const s = createCastSession("song-exp", "dev-exp", "http://192.168.1.5:46400");
    expect(resolveCastSession(s.token)).not.toBeNull();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)); // 前进 7d,必定超出 TTL
    expect(resolveCastSession(s.token)).toBeNull();
    expect(resolveCastToken(s.token)).toBeNull();
  });
});

describe("DLNA 回环取流凭证", () => {
  it("mint → resolve 回原 url;带 headers 可解析回", () => {
    const t1 = mintRawStreamToken("https://cdn.example.com/a.flac");
    expect(typeof t1).toBe("string");
    expect(resolveRawStreamToken(t1)).toEqual({ url: "https://cdn.example.com/a.flac", headers: undefined });

    const t2 = mintRawStreamToken("https://cdn.example.com/b.flac", { Authorization: "Bearer x" });
    expect(resolveRawStreamToken(t2)).toEqual({
      url: "https://cdn.example.com/b.flac",
      headers: { Authorization: "Bearer x" },
    });
  });

  it("未知 token / 过期 token 解析为 null", () => {
    expect(resolveRawStreamToken("no-such")).toBeNull();
    const t = mintRawStreamToken("https://cdn.example.com/c.flac");
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)); // 前进 7d > 30min TTL
    expect(resolveRawStreamToken(t)).toBeNull();
  });

  it("loopbackBase 跟随运行时端口;loopbackRawStreamUrl 可回解出原 url", () => {
    setRuntimePort(45671);
    expect(loopbackBase()).toBe("http://127.0.0.1:45671");
    const url = loopbackRawStreamUrl("https://cdn.example.com/d.flac", { Cookie: "k=v" });
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:45671\/rest\/dlna\/stream\/[0-9a-f]{32}\?raw=1$/);
    const token = url.split("/").pop()!.split("?")[0];
    expect(resolveRawStreamToken(token)).toEqual({
      url: "https://cdn.example.com/d.flac",
      headers: { Cookie: "k=v" },
    });
    setRuntimePort(Number(process.env.PORT || 46400));
  });
});

describe("DLNA 杂项状态", () => {
  it("notePeerActivity / peerActiveWithin 反映活跃窗口", () => {
    const peer = "peer-" + Date.now();
    notePeerActivity(peer, Date.now());
    expect(peerActiveWithin(peer, 60_000)).toBe(true);
    notePeerActivity(peer, Date.now() - 10 * 60_000);
    expect(peerActiveWithin(peer, 60_000)).toBe(false);
  });

  it("getCurrentMedia 未知设备为 undefined;clearCurrentMedia 不抛", () => {
    expect(getCurrentMedia("no-such-device")).toBeUndefined();
    expect(() => clearCurrentMedia("no-such-device")).not.toThrow();
  });

  it("SeekSupersededError 可被识别", () => {
    const e = new SeekSupersededError("superseded");
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toContain("superseded");
    expect(e instanceof SeekSupersededError).toBe(true);
  });
});
