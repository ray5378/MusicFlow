// 本地/WebDAV 扫描路径归组(upsertSong / resolveLocalGroup):
// - 新增本地行并入已有 web 组(来源无关:组 key 只由内容决定,不看来源插件)
// - 时长超容差 → 保守新建独立组
// - 未知时长(0)不并入已有组 → 新建组
// - 插件关闭 → group_id 恒 NULL(平铺)
// - 历史 NULL 组行(插件关闭期/归组启用前扫入)在元数据更新(updated)时补组
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { initDatabase, sqlite } from "../../src/db/index.js";
import { registerBuiltinPlugins } from "../../src/plugins/builtins.js";
import { upsertSong } from "../../src/services/source/scanner.js";
import { groupKeyForConfig, SONG_GROUP_PLUGIN_ID } from "../../src/services/plugin/core/songGroup.js";

function setEnabled(id: string, enabled: 0 | 1) {
  sqlite.prepare("UPDATE plugins SET enabled = ? WHERE name = ?").run(enabled, id);
}

function metaOf(title: string, artist: string, album: string, duration: number) {
  return {
    title, artist, album, duration,
    bitRate: 320, genre: "", year: 2020, track: 1, discNumber: 1,
    contentType: "audio/flac", suffix: "flac", size: 1024 * 1024,
  };
}

function insertWebRow(id: string, title: string, artist: string, album: string, duration: number, groupId: string | null) {
  const key = groupKeyForConfig(title, artist, album);
  const now = new Date().toISOString();
  sqlite.prepare(
    `INSERT INTO songs (id, title, artist, album, duration, path, type, group_id, group_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'web', ?, ?, ?, ?)`
  ).run(id, title, artist, album, duration, `web:test-plugin:${title}`, groupId, groupId ? key : null, now, now);
}

function groupOf(path: string): any {
  return sqlite.prepare("SELECT group_id, group_key FROM songs WHERE path = ?").get(path);
}

beforeAll(() => {
  registerBuiltinPlugins();
  initDatabase(); // 幂等;触发 db-ready hook 播种插件行(core-song-group 默认 enabled=1)
});

afterEach(() => {
  setEnabled(SONG_GROUP_PLUGIN_ID, 1); // 防插件关闭用例泄漏状态
});

describe("本地/WebDAV 扫描归组(upsertSong)", () => {
  it("新增本地行并入已有 web 组(来源无关)", () => {
    insertWebRow("w1", "Song A", "Artist X", "Album Y", 200, "g-test-1");
    const res = upsertSong("l:src1:/music/a.flac", metaOf("Song A", "Artist X", "Album Y", 200), "src1");
    expect(res).toBe("added");
    const row = groupOf("l:src1:/music/a.flac");
    expect(row.group_id).toBe("g-test-1");
    expect(row.group_key).toBe(groupKeyForConfig("Song A", "Artist X", "Album Y"));
  });

  it("时长超容差 → 保守新建独立组", () => {
    insertWebRow("w2", "Song B", "Artist Y", "Album Z", 200, "g-test-2");
    const res = upsertSong("l:src1:/music/b.flac", metaOf("Song B", "Artist Y", "Album Z", 250), "src1");
    expect(res).toBe("added");
    const row = groupOf("l:src1:/music/b.flac");
    expect(row.group_id).toBeTruthy();
    expect(row.group_id).not.toBe("g-test-2");
  });

  it("未知时长(0)不并入已有组,保守新建组", () => {
    insertWebRow("w3", "Song C", "Artist Z", "Album A", 180, "g-test-3");
    upsertSong("l:src1:/music/c.flac", metaOf("Song C", "Artist Z", "Album A", 0), "src1");
    const row = groupOf("l:src1:/music/c.flac");
    expect(row.group_id).toBeTruthy();
    expect(row.group_id).not.toBe("g-test-3");
  });

  it("插件关闭时不归组(NULL,平铺)", () => {
    setEnabled(SONG_GROUP_PLUGIN_ID, 0);
    insertWebRow("w4", "Song D", "Artist W", "Album V", 190, "g-test-4");
    const res = upsertSong("l:src1:/music/d.flac", metaOf("Song D", "Artist W", "Album V", 190), "src1");
    expect(res).toBe("added");
    const row = groupOf("l:src1:/music/d.flac");
    expect(row.group_id).toBeNull();
    expect(row.group_key).toBeNull();
  });

  it("历史 NULL 组行在元数据更新(updated)时补组", () => {
    // 插件关闭期扫入的本地行:NULL 组
    setEnabled(SONG_GROUP_PLUGIN_ID, 0);
    upsertSong("l:src1:/music/e.flac", metaOf("Song E", "Artist Q", "Album P", 195), "src1");
    setEnabled(SONG_GROUP_PLUGIN_ID, 1);
    const before = groupOf("l:src1:/music/e.flac");
    expect(before.group_id).toBeNull();
    // 同内容 web 组随后出现
    insertWebRow("w5", "Song E", "Artist Q", "Album P", 195, "g-test-5");
    // 文件元数据变化(时长 195→196,容差内)触发 updated → 补组
    const res = upsertSong("l:src1:/music/e.flac", metaOf("Song E", "Artist Q", "Album P", 196), "src1");
    expect(res).toBe("updated");
    const after = groupOf("l:src1:/music/e.flac");
    expect(after.group_id).toBe("g-test-5");
  });

  it("已分组行更新时保持组不变(不重算)", () => {
    insertWebRow("w6", "Song F", "Artist R", "Album O", 210, "g-test-6");
    const res1 = upsertSong("l:src1:/music/f.flac", metaOf("Song F", "Artist R", "Album O", 210), "src1");
    expect(res1).toBe("added");
    const first = groupOf("l:src1:/music/f.flac");
    expect(first.group_id).toBe("g-test-6");
    // 更新(容差内时长变化)后组 id 不变
    const res2 = upsertSong("l:src1:/music/f.flac", metaOf("Song F", "Artist R", "Album O", 211), "src1");
    expect(res2).toBe("updated");
    const second = groupOf("l:src1:/music/f.flac");
    expect(second.group_id).toBe("g-test-6");
  });
});
