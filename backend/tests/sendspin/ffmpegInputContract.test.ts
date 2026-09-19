// ffmpeg 输入硬契约回归锁(见 src/services/sendspin/streamEngine.ts::resolveFfmpegInput
// 与 SPEC §1.8)。事故链:①静态 ffmpeg 在 Alpine 解析不了域名(System error);
// ②ffmpeg 跟 302 把 Authorization 头带给 CDN(OBS 400 InvalidAuthType);
// ③回环 token 注册表曾是主进程内存 Map,子进程 mint / 主进程 resolve 不可见(恒 403)。
// 契约:**http(s) 输入必须包成回环 token URL(raw_stream_tokens 表);本地路径原样放行。**
import { describe, it, expect, beforeAll } from "vitest";
import { resolveFfmpegInput } from "../../src/services/sendspin/streamEngine.js";

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
});

const LOOPBACK_RE = /^http:\/\/127\.0\.0\.1:\d+\/rest\/dlna\/stream\/[0-9a-f]{32}\?raw=1$/;

describe("ffmpeg input contract (SPEC §1.8): http input must be loopback-wrapped", () => {
  it("web 直链 → 回环 token URL,不再携带原始 url", async () => {
    const out = await resolveFfmpegInput({ input: "https://cdn.example.com/song.flac" });
    expect(out.input).toMatch(LOOPBACK_RE);
  });

  it("WebDAV 直链 + Basic 源鉴权头 → 回环 token URL,headers 进注册表", async () => {
    const out = await resolveFfmpegInput({
      input: "http://192.168.10.240:5444/dav/共享/天翼网盘/音乐/a.flac",
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(out.input).toMatch(LOOPBACK_RE);
    expect(out.input).not.toContain("192.168.10.240");
    // 注册表行应已落库且带原 headers(resolveRawStreamToken 反查)
    const token = out.input.match(/stream\/([0-9a-f]{32})/)![1];
    const { resolveRawStreamToken } = await import("../../src/services/dlna/control.js");
    const entry = resolveRawStreamToken(token);
    expect(entry?.url).toBe("http://192.168.10.240:5444/dav/共享/天翼网盘/音乐/a.flac");
    expect(entry?.headers?.Authorization).toBe("Basic dXNlcjpwYXNz");
  });

  it("本地文件路径原样放行(不包 token)", async () => {
    const out = await resolveFfmpegInput({ input: "/data/music/a.flac" });
    expect(out.input).toBe("/data/music/a.flac");
    expect(out.headers).toBeUndefined();
  });
});

describe("pipeline 输入合规门(P1-1b):resolvePipelineInput 与 decodeArgs 联动", () => {
  it("IP 字面量 http + 鉴权头同样包回环,原始 IP 不进参数", async () => {
    const { resolvePipelineInput, decodeArgs } = await import("../../src/services/audio/pipeline.js");
    const out = await resolvePipelineInput({
      input: "http://192.168.10.240:5444/dav/a.flac",
      headers: { Authorization: "Basic eDp5" },
    });
    expect(out.input).toMatch(LOOPBACK_RE);
    expect(out.input).not.toContain("192.168.10.240");
    const args = decodeArgs({ input: out.input });
    const joined = args.join(" ");
    expect(joined).not.toContain("192.168.10.240");
    expect(joined).toContain("127.0.0.1");
  });

  it("大写 HTTPS scheme 同样被包", async () => {
    const { resolvePipelineInput } = await import("../../src/services/audio/pipeline.js");
    const out = await resolvePipelineInput({ input: "HTTPS://cdn.example.com/x.mp3" });
    expect(out.input).toMatch(LOOPBACK_RE);
  });

  it("空输入直接抛错(不等 ffmpeg 报)", async () => {
    const { resolvePipelineInput } = await import("../../src/services/audio/pipeline.js");
    await expect(resolvePipelineInput({ input: "" })).rejects.toThrow();
  });

  it("相对路径本地文件原样放行", async () => {
    const { resolvePipelineInput } = await import("../../src/services/audio/pipeline.js");
    const out = await resolvePipelineInput({ input: "music/a.flac" });
    expect(out.input).toBe("music/a.flac");
  });
});
