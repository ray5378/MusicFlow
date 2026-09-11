// Unit tests for services/source/online/groupRescue.ts — 组级换源救援(2026-09-12):
// 当前行自身(含其多源兜底)确认无可用直链时,在同一首歌的同曲多源组里
// 按 local > webdav > web 找兄弟行顶上,避免「库里有、只是这一行死链」被判死。
//   - local 兄弟行可直接出流 → 返回 /rest/stream?id=<兄弟id> 绝对地址
//   - web 兄弟行(别的平台)可播 → 递归解析后返回它的直链
//   - 无组 / 组内只有自己 / 分组插件关闭 → null(保持原行为)
//   - 救援命中**不回写**原行的 url / sourceData(参与去重指纹,改写会污染曲库)
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../../plugins/_env.js";

process.env.DLNA_BASE_URL = "http://rescue-base:46400";

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { initDatabase, db, sqlite } from "../../../src/db/index.js";
import { songs } from "../../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { registerBuiltinPlugins } from "../../../src/plugins/builtins.js";
import { SONG_GROUP_PLUGIN_ID } from "../../../src/services/plugin/core/songGroup.js";
import {
  ensurePlayableStream,
  clearStreamFallbackCache,
} from "../../../src/services/source/online/streamFallback.js";

const DEAD = "http://dead.example/x.mp3";
const SIBLING_OK = "http://ok.example/y.mp3";

function setGroupEnabled(enabled: 0 | 1) {
  sqlite.prepare("UPDATE plugins SET enabled = ? WHERE name = ?").run(enabled, SONG_GROUP_PLUGIN_ID);
}

function insertRow(opts: {
  id: string; type: "local" | "webdav" | "web"; url?: string;
  groupId?: string | null; title?: string;
}) {
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO songs (id, title, artist, album, duration, path, type, url, group_id, group_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.id,
      opts.title || "同一首歌",
      "某歌手",
      "某专辑",
      200,
      opts.type === "web" ? "" : `/music/${opts.id}.flac`,
      opts.type,
      opts.url ?? null,
      opts.groupId ?? null,
      opts.groupId ? `k:${opts.groupId}` : null,
      now,
      now,
    );
}

// 探测 stub:原链(DEAD)404 → gone;兄弟 web 行(SIBLING_OK)206 → ok;
// 其余一律 500 → transient(不得据此判死,也不得当成可播)。
vi.stubGlobal("fetch", async (url: string) => {
  const s = String(url);
  if (s.startsWith(DEAD)) return { status: 404, body: { cancel: async () => {} } } as any;
  if (s.startsWith(SIBLING_OK)) return { status: 206, body: { cancel: async () => {} } } as any;
  return { status: 500, body: { cancel: async () => {} } } as any;
});

beforeAll(() => {
  initDatabase();
  registerBuiltinPlugins();
});

afterEach(() => {
  sqlite.prepare("DELETE FROM songs").run();
  clearStreamFallbackCache();
  setGroupEnabled(1);
});

describe("组级换源救援(groupRescue)", () => {
  it("本行死链 + 组内 local 兄弟行 → 救援到 /rest/stream?id=<兄弟id>", async () => {
    setGroupEnabled(1);
    insertRow({ id: "row-web-dead", type: "web", url: DEAD, groupId: "g1" });
    insertRow({ id: "row-local", type: "local", groupId: "g1" });

    const url = await ensurePlayableStream({ id: "row-web-dead", url: DEAD, pluginEntry: "none-provider" });
    expect(url).toBe("http://rescue-base:46400/rest/stream?id=row-local");

    // 不回写原行:url/sourceData 参与去重指纹,改写会污染曲库。
    const row = db.select().from(songs).where(eq(songs.id, "row-web-dead")).get();
    expect(row?.url).toBe(DEAD);
  });

  it("本行死链 + 组内 web 兄弟行可播 → 递归救援返回兄弟直链", async () => {
    setGroupEnabled(1);
    insertRow({ id: "row-web-dead2", type: "web", url: DEAD, groupId: "g2" });
    insertRow({ id: "row-web-ok", type: "web", url: SIBLING_OK, groupId: "g2" });

    const url = await ensurePlayableStream({ id: "row-web-dead2", url: DEAD, pluginEntry: "none-provider" });
    expect(url).toBe(SIBLING_OK);
  });

  it("无组(单行) → null,行为与修复前一致", async () => {
    setGroupEnabled(1);
    insertRow({ id: "solo-dead", type: "web", url: DEAD, groupId: null });
    expect(await ensurePlayableStream({ id: "solo-dead", url: DEAD, pluginEntry: "none-provider" })).toBeNull();
  });

  it("组内兄弟行也全是死链 → null", async () => {
    setGroupEnabled(1);
    insertRow({ id: "dead-a", type: "web", url: DEAD, groupId: "g3" });
    insertRow({ id: "dead-b", type: "web", url: DEAD, groupId: "g3" });
    expect(await ensurePlayableStream({ id: "dead-a", url: DEAD, pluginEntry: "none-provider" })).toBeNull();
  });

  it("同曲多源分组插件关闭 → 不救援(null)", async () => {
    setGroupEnabled(0);
    insertRow({ id: "off-web", type: "web", url: DEAD, groupId: "g4" });
    insertRow({ id: "off-local", type: "local", groupId: "g4" });
    expect(await ensurePlayableStream({ id: "off-web", url: DEAD, pluginEntry: "none-provider" })).toBeNull();
  });

  it("救援命中后写内存缓存:二次调用不再重复探测兄弟行", async () => {
    setGroupEnabled(1);
    insertRow({ id: "cache-web", type: "web", url: DEAD, groupId: "g5" });
    insertRow({ id: "cache-local", type: "local", groupId: "g5" });

    const first = await ensurePlayableStream({ id: "cache-web", url: DEAD, pluginEntry: "none-provider" });
    expect(first).toBe("http://rescue-base:46400/rest/stream?id=cache-local");

    // 兄弟行删掉后仍能出同一结果 → 证明走了缓存而不是重新扫组。
    sqlite.prepare("DELETE FROM songs WHERE id = ?").run("cache-local");
    const second = await ensurePlayableStream({ id: "cache-web", url: DEAD, pluginEntry: "none-provider" });
    expect(second).toBe(first);
  });
});
