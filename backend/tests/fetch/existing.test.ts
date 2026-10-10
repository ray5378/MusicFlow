import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, sqlite } from "../../src/db/index.js";
import { mediaSources, songs } from "../../src/db/schema.js";
import {
  escapeLikePattern,
  findExistingPlayable,
  findExistingPlayableBatch,
  normalizeArtist,
  normalizeTitle,
  type ExistingRow,
} from "../../src/services/fetch/existing.js";
import { ensureDownloadSource, findDownloadSource } from "../../src/services/fetch/source.js";

// ==================== 工具 ====================

function R(o: Partial<ExistingRow> & { id: string; title: string; path: string }): ExistingRow {
  return { artist: "", album: "", duration: 0, bitRate: 0, suffix: "mp3", type: "local", ...o };
}

function insertSong(row: {
  id: string;
  title: string;
  path: string;
  artist?: string;
  album?: string;
  duration?: number;
  bitRate?: number;
  suffix?: string;
  type?: string;
}): void {
  db.insert(songs)
    .values({
      id: row.id,
      title: row.title,
      path: row.path,
      artist: row.artist ?? "",
      album: row.album ?? "",
      duration: row.duration ?? 0,
      bitRate: row.bitRate ?? 0,
      suffix: row.suffix ?? "mp3",
      type: row.type ?? "local",
    })
    .run();
}

afterAll(() => {
  sqlite.prepare("DELETE FROM songs WHERE id LIKE 'exs-%'").run();
  sqlite.prepare("DELETE FROM media_sources WHERE id LIKE 'exm-%' OR config LIKE '%__ex_%'").run();
});

// ==================== 纯匹配逻辑（注入行） ====================

describe("findExistingPlayable（注入行）", () => {
  it("l: 行命中，返回 kind=local", () => {
    const rows = [
      R({ id: "s1", title: "夜曲", path: "l:src:/a/夜曲.mp3", artist: "周杰伦", duration: 226, bitRate: 320 }),
    ];
    const hit = findExistingPlayable({ title: "夜曲", artist: "周杰伦", durationSec: 226 }, 3, rows);
    expect(hit?.songId).toBe("s1");
    expect(hit?.kind).toBe("local");
    expect(hit?.bitRate).toBe(320);
  });

  it("w: 行命中，返回 kind=webdav", () => {
    const rows = [R({ id: "w1", title: "夜曲", path: "w:src:/a/夜曲.flac", suffix: "flac" })];
    expect(findExistingPlayable({ title: "夜曲" }, 3, rows)?.kind).toBe("webdav");
  });

  it("只有 type='web' 的在线行 → 不算命中（关键守卫）", () => {
    const rows = [
      R({ id: "web1", title: "夜曲", path: "https://cdn.example/x.mp3", type: "web" }),
      R({ id: "web2", title: "夜曲", path: "web:src:remote", type: "web" }),
    ];
    expect(findExistingPlayable({ title: "夜曲" }, 3, rows)).toBeNull();
  });

  it("标题归一化：全角/大小写/空格/括号/feat.", () => {
    const rows = [R({ id: "s2", title: "Ｈｅｌｌｏ　Ｗｏｒｌｄ", path: "l:s:/b.mp3" })];
    expect(findExistingPlayable({ title: "hello world" }, 3, rows)?.songId).toBe("s2");

    const rows2 = [R({ id: "s3", title: "夜曲", path: "l:s:/c.mp3" })];
    expect(findExistingPlayable({ title: "夜曲 (Live)" }, 3, rows2)?.songId).toBe("s3");
    expect(findExistingPlayable({ title: "夜曲【现场版】" }, 3, rows2)?.songId).toBe("s3");
    expect(findExistingPlayable({ title: "夜曲 feat. 方文山" }, 3, rows2)?.songId).toBe("s3");
    expect(findExistingPlayable({ title: "夜  曲" }, 3, rows2)?.songId).toBe("s3");
  });

  it("时长：容差内命中、超出不命中；任一方时长缺失则跳过该判据", () => {
    const rows = [R({ id: "s4", title: "X", path: "l:s:/d.mp3", duration: 200 })];
    expect(findExistingPlayable({ title: "X", durationSec: 202 }, 3, rows)?.songId).toBe("s4");
    expect(findExistingPlayable({ title: "X", durationSec: 210 }, 3, rows)).toBeNull();
    expect(findExistingPlayable({ title: "X" }, 3, rows)?.songId).toBe("s4"); // 查询无时长
  });

  it("歌手：一方为空不算不匹配；都给出时按包含/切分交集判", () => {
    const rows = [R({ id: "s5", title: "Y", path: "l:s:/e.mp3", artist: "周杰伦 & 方文山" })];
    expect(findExistingPlayable({ title: "Y" }, 3, rows)?.songId).toBe("s5");
    expect(findExistingPlayable({ title: "Y", artist: "周杰伦" }, 3, rows)?.songId).toBe("s5");
    expect(findExistingPlayable({ title: "Y", artist: "林俊杰" }, 3, rows)).toBeNull();

    const rows2 = [R({ id: "s6", title: "Z", path: "l:s:/f.mp3" })];
    expect(findExistingPlayable({ title: "Z", artist: "任何人" }, 3, rows2)?.songId).toBe("s6"); // 行无 artist
  });

  it("同曲多条：local 优先于 webdav，再比 bitRate 大", () => {
    const rows = [
      R({ id: "w-high", title: "Q", path: "w:s:/q.flac", bitRate: 1411 }),
      R({ id: "l-low", title: "Q", path: "l:s:/q.mp3", bitRate: 320 }),
    ];
    expect(findExistingPlayable({ title: "Q" }, 3, rows)?.songId).toBe("l-low");

    const rows2 = [
      R({ id: "l-128", title: "Q2", path: "l:s:/q2a.mp3", bitRate: 128 }),
      R({ id: "l-320", title: "Q2", path: "l:s:/q2b.mp3", bitRate: 320 }),
    ];
    expect(findExistingPlayable({ title: "Q2" }, 3, rows2)?.songId).toBe("l-320");
  });

  it("批量版（注入行）：多首一次给出结果映射", () => {
    const rows = [
      R({ id: "b1", title: "A", path: "l:s:/1.mp3" }),
      R({ id: "b2", title: "B", path: "w:s:/2.mp3" }),
    ];
    const m = findExistingPlayableBatch(
      [
        { id: "q1", title: "A" },
        { id: "q2", title: "B" },
        { id: "q3", title: "C" },
      ],
      3,
      rows,
    );
    expect(m.get("q1")?.songId).toBe("b1");
    expect(m.get("q2")?.songId).toBe("b2");
    expect(m.get("q3")).toBeNull();
  });

  it("无命中返回 null，不抛异常", () => {
    expect(findExistingPlayable({ title: "" }, 3, [])).toBeNull();
    expect(findExistingPlayable({ title: "不存在" }, 3, [])).toBeNull();
  });
});

describe("归一化 / LIKE 转义（纯函数）", () => {
  it("normalizeTitle", () => {
    expect(normalizeTitle("  夜曲  (Live) ")).toBe("夜曲");
    expect(normalizeTitle("Hello, World!")).toBe("helloworld");
    expect(normalizeTitle("Ａ-Ｂ")).toBe("ab");
    expect(normalizeTitle("song ft. artist")).toBe("song");
  });

  it("normalizeArtist：小写化但保留分隔符", () => {
    expect(normalizeArtist("周杰伦 & 方文山")).toBe("周杰伦 & 方文山");
    expect(normalizeArtist("Ａ　Ｂ")).toBe("a b");
  });

  it("escapeLikePattern 转义 % _ \\", () => {
    expect(escapeLikePattern("100%_a\\b")).toBe("100\\%\\_a\\\\b");
    expect(escapeLikePattern("plain")).toBe("plain");
  });
});

// ==================== 真实 sqlite 查询路径 ====================

describe("findExistingPlayable（真实 sqlite）", () => {
  it("插入 l: 行可命中；只剩同标题的 web 行时不算命中", () => {
    insertSong({ id: "exs-l1", title: "真实曲", path: "l:src:/x/真实曲.mp3", artist: "张三", duration: 180, bitRate: 320 });
    insertSong({ id: "exs-w1", title: "真实曲", path: "https://x/y.mp3", type: "web" });

    const hit = findExistingPlayable({ title: "真实曲", artist: "张三", durationSec: 180 });
    expect(hit?.songId).toBe("exs-l1");
    expect(hit?.kind).toBe("local");

    // 删掉物理行后，只剩 web 行 → 必须判为「没有」。
    db.delete(songs).where(eq(songs.id, "exs-l1")).run();
    expect(findExistingPlayable({ title: "真实曲" })).toBeNull();
  });

  it("% / _ 不作为通配符（ESCAPE 生效）", () => {
    insertSong({ id: "exs-p1", title: "a%c", path: "l:src:/p1.mp3", bitRate: 320 });
    insertSong({ id: "exs-p2", title: "a_c", path: "l:src:/p2.mp3", bitRate: 999 });

    // 若 % 未转义：粗筛会把 a_c 也捞进来，且 JS 归一后 a%c 与 a_c 都等「ac」，
    // 于是会误选高码率的 a_c(999)。转义后粗筛只命中 a%c → 结果必为 p1。
    const hit = findExistingPlayable({ title: "a%c" });
    expect(hit?.songId).toBe("exs-p1");
  });

  it("批量版走单条 DB 查询也能正确分发", () => {
    insertSong({ id: "exs-b1", title: "批甲", path: "l:src:/b1.mp3" });
    insertSong({ id: "exs-b2", title: "批乙", path: "w:src:/b2.flac" });

    const m = findExistingPlayableBatch([
      { id: "q1", title: "批甲" },
      { id: "q2", title: "批乙" },
      { id: "q3", title: "批丙" },
    ]);
    expect(m.get("q1")?.songId).toBe("exs-b1");
    expect(m.get("q2")?.kind).toBe("webdav");
    expect(m.get("q3")).toBeNull();
  });
});

// ==================== media source 注册（同库） ====================

describe("ensureDownloadSource / findDownloadSource", () => {
  it("三级幂等：首次建、二次复用同 id，enabled 为数字 1", () => {
    const root = "/MUSIC/__ex_dl_a__";
    const a = ensureDownloadSource(root);
    expect(a.created).toBe(true);
    expect(a.reusedExisting).toBe(false);
    expect(a.ancestorSourceId).toBeNull();

    const b = ensureDownloadSource(root);
    expect(b.created).toBe(false);
    expect(b.reusedExisting).toBe(true);
    expect(b.sourceId).toBe(a.sourceId);
    expect(findDownloadSource(root)).toBe(a.sourceId);

    const row = db.select().from(mediaSources).where(eq(mediaSources.id, a.sourceId)).get();
    expect(typeof row?.enabled).toBe("number");
    expect(row?.enabled).toBe(1);
    expect(row?.type).toBe("local");
  });

  it("已有祖先 local 源 → ancestorSourceId 命中", () => {
    db.insert(mediaSources)
      .values({
        id: "exm-anc",
        name: "anc",
        type: "local",
        enabled: 1,
        config: JSON.stringify({ path: "/MUSIC/__ex_anc__" }),
      })
      .run();
    const r = ensureDownloadSource("/MUSIC/__ex_anc__/DOWNLOAD");
    expect(r.ancestorSourceId).toBe("exm-anc");
  });

  it("既有同路径 local 源 → 复用且不篡改 name", () => {
    db.insert(mediaSources)
      .values({
        id: "exm-manual",
        name: "用户手工源",
        type: "local",
        enabled: 0,
        config: JSON.stringify({ path: "/MUSIC/__ex_manual__" }),
      })
      .run();
    const r = ensureDownloadSource("/MUSIC/__ex_manual__");
    expect(r.sourceId).toBe("exm-manual");
    expect(r.reusedExisting).toBe(true);
    expect(r.created).toBe(false);
    const row = db.select().from(mediaSources).where(eq(mediaSources.id, "exm-manual")).get();
    expect(row?.name).toBe("用户手工源");
    expect(row?.enabled).toBe(0); // 原样保留
  });
});
