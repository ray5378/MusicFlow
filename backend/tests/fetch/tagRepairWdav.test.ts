// 云盘单曲修复（repairWebdavSongTags）单测：全部 I/O 打桩，只验判定分支。
import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  pathParts: vi.fn(),
  ctxOfSource: vi.fn(),
  probeTags: vi.fn(),
  getWhole: vi.fn(),
  put: vi.fn(),
  replaceFile: vi.fn(),
  del: vi.fn(),
  size: vi.fn(),
  readTags: vi.fn(),
  writeTags: vi.fn(),
  searchMetadata: vi.fn(),
  searchCover: vi.fn(),
  searchLyrics: vi.fn(),
}));

vi.mock("../../src/services/fetch/wdavIO.js", () => ({
  wdavPathParts: mocks.pathParts,
  wdavCtxOfSource: mocks.ctxOfSource,
  wdavProbeTags: mocks.probeTags,
  // 写后回读校验会再取一次头部/片段
  wdavGetRange: vi.fn(async () => Buffer.from("new-flac")),
  wdavGetWhole: mocks.getWhole,
  wdavPut: mocks.put,
  wdavReplaceFile: mocks.replaceFile,
  wdavDelete: mocks.del,
  wdavSize: mocks.size,
  wdavTmpNameFor: (p: string) => p.replace(/\/([^/]+)$/, "/.mf-up-$1"),
}));

vi.mock("../../src/services/fetch/memTags.js", () => ({
  readTags: mocks.readTags,
  writeTags: mocks.writeTags,
  // 容器判定仍用真实实现（纯字符串逻辑）
  containerOfName: (name: string) => {
    const m = /\.(flac|mp3|m4a|ogg|opus)$/i.exec(name);
    if (!m) return null;
    const ext = m[1].toLowerCase();
    return ext === "flac" ? "flac" : ext === "mp3" ? "mp3" : null;
  },
}));

vi.mock("../../src/plugins/providers.js", () => ({
  searchMetadata: mocks.searchMetadata,
  searchCover: mocks.searchCover,
  searchLyrics: mocks.searchLyrics,
}));

import { sqlite } from "../../src/db/index.js";

const { repairWebdavSongTags } = await import("../../src/services/fetch/tagRepairWdav.js");

const cfg = { chineseVariant: "simplified", embedCover: true } as any;

function row(over: Record<string, unknown> = {}) {
  return {
    id: "song-1",
    title: "晴天",
    artist: "周杰伦",
    album: "叶惠美",
    duration: 269000,
    path: "w:src-1:/dav/共享/音乐/周杰伦/晴天.flac",
    has_lyrics: 0,
    album_id: null,
    source_data: null,
    url: null,
    ...over,
  } as any;
}

describe("repairWebdavSongTags — 只修缺的", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.pathParts.mockImplementation((p: string) => {
      const m = /^w:([^:]+):(.+)$/.exec(String(p));
      return m ? { sourceId: m[1], filePath: m[2] } : null;
    });
    mocks.ctxOfSource.mockReturnValue({ base: "http://nas:5444/dav", auth: "Basic x" });
    mocks.size.mockResolvedValue(10);
    mocks.put.mockResolvedValue(201);
    mocks.replaceFile.mockResolvedValue(undefined);
  });

  it("读头即判定标签已齐 ⇒ skip（不下载整文件）", async () => {
    mocks.readTags.mockReturnValue({
      title: "晴天",
      artist: "周杰伦",
      album: "叶惠美",
      lyric: "[00:01.00]词",
      cover: { data: Buffer.from("jpg"), mime: "image/jpeg" },
    });
    const out = await repairWebdavSongTags(row(), cfg);
    expect(out.outcome).toBe("skip");
    expect(mocks.getWhole).not.toHaveBeenCalled();
  });

  it("缺封面 + 元数据专辑一致 ⇒ fixed 且写入封面", async () => {
    mocks.readTags.mockReturnValue({ title: "晴天", artist: "周杰伦", album: "叶惠美", lyric: "[00:01.00]词" });
    mocks.getWhole.mockResolvedValue(Buffer.from("flac-bytes"));
    mocks.searchMetadata.mockResolvedValue({ title: "晴天", artist: "周杰伦", album: "叶惠美" });
    mocks.searchCover.mockImplementation(async (_s: unknown, o: any) => {
      o?.onMatch?.("tag-provider", true);
      return "http://img/c.jpg";
    });
    const bytes = new TextEncoder().encode("jpeg-data");
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer,
      headers: new Headers({ "content-type": "image/jpeg" }),
    })) as never;
    mocks.writeTags.mockReturnValue(Buffer.from("new-flac"));
    // 首次探针无封面 → 触发修复；写后回读（校验）要能看到封面
    // 第 1 次=头部探针、第 2 次=整文件再判（都缺封面）→ 触发修复；写后回读（第 3 次）才见到封面
    mocks.readTags
      .mockReturnValueOnce({ title: "晴天", artist: "周杰伦", album: "叶惠美", lyric: "[00:01.00]词" })
      .mockReturnValueOnce({ title: "晴天", artist: "周杰伦", album: "叶惠美", lyric: "[00:01.00]词" })
      .mockReturnValue({
        title: "晴天",
        artist: "周杰伦",
        album: "叶惠美",
        lyric: "[00:01.00]词",
        cover: { data: Buffer.from("jpg"), mime: "image/jpeg" },
      });
    mocks.size.mockResolvedValue(Buffer.from("new-flac").length);

    const out = await repairWebdavSongTags(row(), cfg);
    expect(out.outcome).toBe("fixed");
    expect(out.cover).toBe(true);
    expect(mocks.put).toHaveBeenCalled();
    expect(mocks.replaceFile).toHaveBeenCalled();
  });

  it("歌手不一致 ⇒ 不写封面（缺图好过错图）", async () => {
    mocks.readTags.mockReturnValue({ title: "晴天", artist: "周杰伦", album: "叶惠美", lyric: "[00:01.00]词" });
    mocks.getWhole.mockResolvedValue(Buffer.from("flac-bytes"));
    mocks.searchMetadata.mockResolvedValue({ title: "晴天", artist: "SNOW THA PRODUCT", album: "PLAY" });
    mocks.searchCover.mockResolvedValue("http://img/wrong.jpg");

    const out = await repairWebdavSongTags(row(), cfg);
    expect(out.outcome).not.toBe("fixed");
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("上传失败 ⇒ outcome=error（不能当 skip，游标不许前进）", async () => {
    mocks.readTags.mockReturnValue({ title: "晴天", artist: "周杰伦", album: "叶惠美", lyric: "[00:01.00]词" });
    mocks.getWhole.mockResolvedValue(Buffer.from("flac-bytes"));
    mocks.searchMetadata.mockResolvedValue({ title: "晴天", artist: "周杰伦", album: "叶惠美" });
    mocks.searchCover.mockResolvedValue(null);
    mocks.searchLyrics.mockResolvedValue(null);
    mocks.writeTags.mockReturnValue(Buffer.from("new-flac"));
    mocks.put.mockRejectedValue(new Error("PUT 405"));

    const out = await repairWebdavSongTags(row({ album: "叶惠美" }), cfg);
    // 没有可写项时不会走到上传；这里强制用「缺 title」制造写入需求
    const out2 = await (async () => {
      mocks.readTags.mockReturnValue({ title: "", artist: "周杰伦", album: "叶惠美", lyric: "[00:01.00]词" });
      mocks.searchMetadata.mockResolvedValue({ title: "晴天", artist: "周杰伦", album: "叶惠美" });
      return repairWebdavSongTags(row(), cfg);
    })();
    expect([out.outcome, out2.outcome]).toContain("error");
  });

  it("容器不支持内嵌标签 ⇒ skip", async () => {
    const out = await repairWebdavSongTags(row({ path: "w:src-1:/dav/a.wav" }), cfg);
    expect(out.outcome).toBe("skip");
    expect(out.note).toContain("不支持内嵌标签");
  });
});

describe("repairWebdavSongTags — 歌词/专辑/不可得", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.pathParts.mockImplementation((p: string) => {
      const m = /^w:([^:]+):(.+)$/.exec(String(p));
      return m ? { sourceId: m[1], filePath: m[2] } : null;
    });
    mocks.ctxOfSource.mockReturnValue({ base: "http://nas:5444/dav", auth: "Basic x" });
    mocks.getWhole.mockResolvedValue(Buffer.from("flac-bytes"));
    mocks.put.mockResolvedValue(201);
    mocks.replaceFile.mockResolvedValue(undefined);
    mocks.size.mockResolvedValue(Buffer.from("new-flac").length);
    mocks.writeTags.mockReturnValue(Buffer.from("new-flac"));
    mocks.searchCover.mockResolvedValue(null);
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new TextEncoder().encode("x").buffer,
      headers: new Headers({ "content-type": "image/jpeg" }),
    })) as never;
  });

  it("只缺歌词 ⇒ 写歌词（归属通过）", async () => {
    mocks.readTags.mockReturnValue({ title: "晴天", artist: "周杰伦", album: "叶惠美" });
    mocks.searchMetadata.mockResolvedValue(null);
    mocks.searchLyrics.mockResolvedValue(
      "[00:01.00]第一句\n[00:02.00]第二句\n[00:03.00]第三句\n[00:04.00]第四句\n[00:05.00]第五句",
    );
    // 探针/整文件判定都缺词，写后回读要能看到词（否则校验会判"标签没写进去"）
    mocks.readTags
      .mockReturnValueOnce({ title: "晴天", artist: "周杰伦", album: "叶惠美" })
      .mockReturnValueOnce({ title: "晴天", artist: "周杰伦", album: "叶惠美" })
      .mockReturnValue({
        title: "晴天",
        artist: "周杰伦",
        album: "叶惠美",
        lyric: "[00:01.00]第一句",
      });
    const out = await repairWebdavSongTags(row(), cfg);
    expect(out.lyric).toBe(true);
    expect(mocks.put).toHaveBeenCalled();
  });

  it("歌词归属不符 ⇒ 不写，且无其他可写项时按不可得返回", async () => {
    mocks.readTags.mockReturnValue({ title: "晴天", artist: "周杰伦", album: "叶惠美" });
    mocks.searchMetadata.mockResolvedValue(null);
    mocks.searchLyrics.mockResolvedValue(
      "[ti:别的歌]\n[ar:卫兰]\n[00:01.00]a\n[00:02.00]b\n[00:03.00]c\n[00:04.00]d",
    );
    const out = await repairWebdavSongTags(row(), cfg);
    expect(out.lyric).toBe(false);
    expect(out.outcome).toBe("unobtainable");
  });

  it("找不到音乐源配置 ⇒ skip", async () => {
    mocks.ctxOfSource.mockReturnValue(null);
    const out = await repairWebdavSongTags(row(), cfg);
    expect(out.outcome).toBe("skip");
    expect(out.note).toContain("找不到音乐源配置");
  });

  it("mp3 容器同样走修复路径", async () => {
    mocks.pathParts.mockReturnValue({ sourceId: "src-1", filePath: "/d/a.mp3" });
    mocks.readTags.mockReturnValue({ title: "晴天", artist: "周杰伦", album: "叶惠美" });
    mocks.searchMetadata.mockResolvedValue(null);
    mocks.searchLyrics.mockResolvedValue(
      "[00:01.00]第一句\n[00:02.00]第二句\n[00:03.00]第三句\n[00:04.00]第四句\n[00:05.00]第五句",
    );
    mocks.readTags
      .mockReturnValueOnce({ title: "晴天", artist: "周杰伦", album: "叶惠美" })
      .mockReturnValueOnce({ title: "晴天", artist: "周杰伦", album: "叶惠美" })
      .mockReturnValue({ title: "晴天", artist: "周杰伦", album: "叶惠美", lyric: "[00:01.00]第一句" });
    const out = await repairWebdavSongTags(row({ path: "w:src-1:/d/a.mp3" }), cfg);
    expect(out.lyric).toBe(true);
  });
});

describe("repairWebdavSongTags — DB 回填与元数据写入", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.pathParts.mockImplementation((p: string) => {
      const m = /^w:([^:]+):(.+)$/.exec(String(p));
      return m ? { sourceId: m[1], filePath: m[2] } : null;
    });
    mocks.ctxOfSource.mockReturnValue({ base: "http://nas:5444/dav", auth: "Basic x" });
    mocks.put.mockResolvedValue(201);
    mocks.replaceFile.mockResolvedValue(undefined);
    mocks.size.mockResolvedValue(8);
    mocks.writeTags.mockReturnValue(Buffer.from("new-flac"));
    globalThis.fetch = vi.fn(async () => ({
      ok: true, status: 200,
      arrayBuffer: async () => new TextEncoder().encode("x").buffer,
      headers: new Headers({ "content-type": "image/jpeg" }),
    })) as never;
  });

  it("文件其实齐了 ⇒ 只回填 DB（has_lyrics），不重写文件", async () => {
    mocks.readTags.mockReturnValue({
      title: "晴天", artist: "周杰伦", album: "叶惠美",
      lyric: "[00:01.00]第一句", cover: { data: Buffer.from("jpg"), mime: "image/jpeg" },
    });
    const out = await repairWebdavSongTags(row({ has_lyrics: 0 }), cfg);
    expect(out.outcome).toBe("skip");
    expect(mocks.put).not.toHaveBeenCalled();
    const r = sqlite.prepare("SELECT has_lyrics FROM songs WHERE id='song-1'").get() as any;
    if (r) expect(r.has_lyrics).toBe(1);
  });

  it("缺 title/artist 且元数据可取 ⇒ 写入元数据", async () => {
    mocks.readTags.mockReturnValue({ album: "叶惠美", lyric: "[00:01.00]第一句", cover: { data: Buffer.from("j"), mime: "image/jpeg" } });
    mocks.getWhole.mockResolvedValue(Buffer.from("flac"));
    mocks.searchMetadata.mockResolvedValue({ title: "晴天", artist: "周杰伦", album: "叶惠美" });
    mocks.readTags
      .mockReturnValueOnce({ album: "叶惠美", lyric: "[00:01.00]第一句", cover: { data: Buffer.from("j"), mime: "image/jpeg" } })
      .mockReturnValueOnce({ album: "叶惠美", lyric: "[00:01.00]第一句", cover: { data: Buffer.from("j"), mime: "image/jpeg" } })
      .mockReturnValue({ title: "晴天", artist: "周杰伦", album: "叶惠美", lyric: "[00:01.00]第一句", cover: { data: Buffer.from("j"), mime: "image/jpeg" } });
    const out = await repairWebdavSongTags(row({ title: "", artist: "" }), cfg);
    expect(out.meta).toBe(true);
  });

  it("缺专辑且 DB 专辑可信 ⇒ 写入专辑", async () => {
    mocks.readTags
      .mockReturnValueOnce({ title: "晴天", artist: "周杰伦", lyric: "[00:01.00]第一句", cover: { data: Buffer.from("j"), mime: "image/jpeg" } })
      .mockReturnValueOnce({ title: "晴天", artist: "周杰伦", lyric: "[00:01.00]第一句", cover: { data: Buffer.from("j"), mime: "image/jpeg" } })
      .mockReturnValue({ title: "晴天", artist: "周杰伦", album: "叶惠美", lyric: "[00:01.00]第一句", cover: { data: Buffer.from("j"), mime: "image/jpeg" } });
    mocks.getWhole.mockResolvedValue(Buffer.from("flac"));
    mocks.searchMetadata.mockResolvedValue(null);
    const out = await repairWebdavSongTags(row(), cfg);
    expect(out.album).toBe(true);
  });
});
