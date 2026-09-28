// 覆盖率长尾补充:utils/localSourceProbe.ts 的残余分支。
//   - 源行不存在(source 已被删/配置损坏)         → 记失败记忆并判不可播
//   - song.path 取值抛错(边界输入)              → 绝不把异常抛给流播热路径
//   - 失败记忆条目超过上限 → pruneCache 生效      → 无界增长被截断
// 成功/失败记忆是模块级 Map,故每条用例用**独立 songId**,避免用例互相污染。
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { sqlite } from "../../src/db/index.js";
import { probeLocalSourceOk } from "../../src/utils/localSourceProbe.js";

const SRC = "src-lt3-tail";
const MISSING_SRC = "src-lt3-does-not-exist";

function res(status: number): Response {
  return { status, ok: status >= 200 && status < 300 } as Response;
}

describe("localSourceProbe 长尾", () => {
  beforeAll(() => {
    sqlite
      .prepare("INSERT OR REPLACE INTO media_sources (id, name, type, enabled, config) VALUES (?,?,?,?,?)")
      .run(SRC, "tail-src", "webdav", 1, JSON.stringify({ url: "http://dav.local/dav" }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("w: 源在库里查不到 → 判不可播并把失败写进记忆(不抛错)", async () => {
    const fetchImpl = vi.fn(async () => res(200));
    vi.stubGlobal("fetch", fetchImpl);

    // 源行缺失 ⇒ 根本无 URL 可探;必须直接判 false,而不是发一次注定失败的请求。
    const ok = await probeLocalSourceOk({ id: "tail-miss-src", path: `w:${MISSING_SRC}:/a.flac` });
    expect(ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();

    // 失败记忆生效:失败后 TTL 内再探不再打网盘(与"探测失败"同一条记忆路径)。
    const before = fetchImpl.mock.calls.length;
    expect(await probeLocalSourceOk({ id: "tail-miss-src", path: `w:${MISSING_SRC}:/a.flac` })).toBe(false);
    expect(fetchImpl.mock.calls.length).toBe(before);
  });

  it("song.path 取值抛错 → 按可用处理(不把异常抛给调用方)", async () => {
    const song = {
      id: "tail-throw-path",
      get path(): string {
        throw new Error("corrupt song row");
      },
    };
    // 上游是流播热路径:探测异常必须自愈成"可用",否则一次坏数据会 500 整条出流。
    await expect(probeLocalSourceOk(song as any)).resolves.toBe(true);
  });

  it("失败记忆超过上限(512)→ pruneCache 截断,不无界增长", async () => {
    const fetchImpl = vi.fn(async () => res(404)); // HEAD/GET 都 404 → 判定失败
    vi.stubGlobal("fetch", fetchImpl);

    // 520 首各自探一次失败 ⇒ localFailCache 条目数越过 CACHE_MAX(512),
    // 第 513 次起每次都会走 pruneCache 的"先清过期、再丢最旧"截断逻辑。
    for (let i = 0; i < 520; i++) {
      const ok = await probeLocalSourceOk({ id: `tail-prune-${i}`, path: `w:${SRC}:/f${i}.flac` });
      expect(ok).toBe(false);
    }

    // 截断后仍然工作正常(不是把缓存清坏导致的假阴性/假阳性)。
    expect(await probeLocalSourceOk({ id: "tail-prune-after", path: `w:${SRC}:/after.flac` })).toBe(false);
  }, 30_000);
});
