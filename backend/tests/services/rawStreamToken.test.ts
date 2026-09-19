// raw-stream 回环取流凭证(见 src/services/dlna/control.ts)。
// 回归锚点(2026-09-19 事故):注册表曾用进程内存 Map —— Sendspin 生产 fork 模式下
// 子进程 mint、主进程 resolve,Map 跨进程不可见,ffmpeg 恒收 403。
// 改为 SQLite 落表后,任意进程写、任意进程读(本测试以独立 sqlite 连接视角验证落盘)。
import { describe, it, expect, beforeAll } from "vitest";
import Database from "better-sqlite3";
import path from "node:path";
import {
  mintRawStreamToken,
  resolveRawStreamToken,
} from "../../src/services/dlna/control.js";

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
});

describe("raw stream token registry (DB-backed, cross-process)", () => {
  it("mint → resolve roundtrip 保留 url 与 headers", () => {
    const token = mintRawStreamToken("http://192.168.10.240:5444/dav/共享/天翼网盘/a.flac", {
      Authorization: "Basic dXNlcjpwYXNz",
    });
    const resolved = resolveRawStreamToken(token);
    expect(resolved).not.toBeNull();
    expect(resolved!.url).toBe("http://192.168.10.240:5444/dav/共享/天翼网盘/a.flac");
    expect(resolved!.headers?.Authorization).toBe("Basic dXNlcjpwYXNz");
  });

  it("无 headers 的 mint → resolve 返回 headers=undefined", () => {
    const token = mintRawStreamToken("http://127.0.0.1/x.mp3");
    const resolved = resolveRawStreamToken(token);
    expect(resolved).not.toBeNull();
    expect(resolved!.headers).toBeUndefined();
  });

  it("未知 token 返回 null(而非 403 的 cast-token 兜底)", () => {
    expect(resolveRawStreamToken("does-not-exist")).toBeNull();
  });

  it("过期 token 返回 null 并被清理", () => {
    const token = mintRawStreamToken("http://127.0.0.1/x.mp3");
    // 直接把 exp 改到过去,模拟 30 分钟 TTL 到期
    const raw = new Database(path.join(process.env.DATA_DIR || "/tmp", "musicflow.db"));
    raw.prepare("UPDATE raw_stream_tokens SET exp = ? WHERE token = ?").run(Date.now() - 1, token);
    raw.close();
    expect(resolveRawStreamToken(token)).toBeNull();
  });

  it("另一独立连接也能读到(跨进程共享的本质:数据在 DB 不在内存)", () => {
    const token = mintRawStreamToken("http://127.0.0.1/other.mp3", { Range: "bytes=0-" });
    // 模拟"另一个进程"(独立 sqlite 连接)直接读表 —— 与主进程路由读法一致
    const other = new Database(path.join(process.env.DATA_DIR || "/tmp", "musicflow.db"), { readonly: true });
    const row = other.prepare("SELECT url, headers_json FROM raw_stream_tokens WHERE token = ?").get(token) as any;
    other.close();
    expect(row.url).toBe("http://127.0.0.1/other.mp3");
    expect(JSON.parse(row.headers_json).Range).toBe("bytes=0-");
  });
});
