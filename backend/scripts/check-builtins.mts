// ==================== 内置插件规范校验（CI 用） ====================
//
// 用法：cd backend && DATA_DIR=<临时目录> npx tsx scripts/check-builtins.mts
// （DATA_DIR 指向可写临时目录：部分内置插件模块 import db，加载时需可创建 SQLite 文件）
//
// 校验 7 个官方内置插件的 manifest 是否符合插件开发规范：
//   1. validateManifest（与 plugins/discovery.ts 同规则：字段/类型/能力/权限白名单）
//   2. documentation 字段必填（插件详情页「功能介绍 + 处理逻辑」）
//   3. capabilities 全部在 VALID_CAPS 白名单内
//   4. 每项 capability 在 CAP_METHODS 中有方法映射（即能力被核心消费，声明不会静默失效）
//
// 外置插件契约校验（含方法存在性）由 MusicFlow-plugins 仓库的 scripts/check.mjs 负责，
// 插件仓库 CI 每次 push 自动执行。

import fs from "fs";
import os from "os";
import path from "path";

// 必须在 import 插件模块之前设置：部分内置插件顶层 import db，会打开 SQLite 文件。
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mf-check-builtins-"));

// ---- 与 backend/src/plugins/discovery.ts 保持一致 ----
const VALID_TYPES = ["source", "importer", "recommender", "sync", "lyrics", "cover", "renderer", "scrobbler", "artist"];
const VALID_CAPS = [
  "search", "recommend", "playlistSongs", "stream", "lyrics", "webRotation",
  "playlistImport", "playlistFile", "dailyPlaylist", "localPlaylist",
  "playlistSync", "autoMatch",
  "lyricProvider", "coverProvider", "renderer", "scrobbler",
  "artistInfo",
];
// 与 backend/src/plugins/sandbox.ts 的 CAP_METHODS 保持一致（能力 → 方法映射）。
const CAP_METHODS: Record<string, string[]> = {
  search: ["search"],
  recommend: ["recommend"],
  playlistSongs: ["playlistSongs"],
  stream: ["streamUrl"],
  lyrics: ["lyricUrl"],
  lyricProvider: ["searchLyrics"],
  coverProvider: ["searchCover"],
  renderer: ["discover"],
  autoMatch: ["search"],
  scrobbler: ["onPlay", "onScrobble"],
  artistInfo: ["fetchArtistInfo"],
  playlistImport: ["canHandle", "fetchPlaylist"],
  playlistFile: ["canHandleFile", "parseFile"],
  dailyPlaylist: ["runDailyJob"],
  localPlaylist: ["runDailyJob"],
  playlistSync: ["runSyncJob"],
};
// 与 backend/src/plugins/host.ts 的 KNOWN_PERMISSIONS 保持一致。
const KNOWN_PERMISSIONS = [
  "log", "storage", "net", "command", "fs", "fs:music", "fs:external",
  "websocket", "jsenv",
  "songs:read", "songs:write", "playlists:read", "playlists:write", "inter-plugin",
];

function validateManifest(m: any): string | null {
  if (!m || typeof m !== "object") return "manifest 必须是对象";
  if (typeof m.id !== "string" || !m.id) return "manifest.id 缺失";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(m.id)) return "manifest.id 只能含字母/数字/连字符,且不以连字符开头";
  if (typeof m.name !== "string" || !m.name) return "manifest.name 缺失";
  if (typeof m.version !== "string" || !m.version) return "manifest.version 缺失";
  if (!VALID_TYPES.includes(m.type)) return `manifest.type 非法: ${String(m.type)}`;
  if (!Array.isArray(m.capabilities) || m.capabilities.length === 0) return "manifest.capabilities 必须是非空数组";
  for (const c of m.capabilities) if (!VALID_CAPS.includes(c)) return `manifest.capabilities 含非法能力: ${String(c)}`;
  if (!Array.isArray(m.configSchema)) return "manifest.configSchema 必须是数组";
  if (Array.isArray(m.permissions)) {
    for (const p of m.permissions) {
      if (p === "*") continue;
      const base = p.includes(":") ? p.split(":")[0] + ".*" : p;
      if (!KNOWN_PERMISSIONS.includes(p) && !KNOWN_PERMISSIONS.includes(base)) {
        return `manifest.permissions 含未知权限: ${p}`;
      }
    }
  }
  return null;
}

// id → 模块路径 + manifest 导出名
const BUILTINS: Array<{ id: string; file: string; exportName: string }> = [
  { id: "qq-playlist-importer", file: "../src/services/plugin/importers/qq.js", exportName: "qqImporterManifest" },
  { id: "netease-playlist-importer", file: "../src/services/plugin/importers/netease.js", exportName: "neteaseImporterManifest" },
  { id: "musicflow-file-importer", file: "../src/services/plugin/importers/native.js", exportName: "nativeImporterManifest" },
  { id: "daily-recommend", file: "../src/services/plugin/dailyRecommend.js", exportName: "dailyRecommendManifest" },
  { id: "local-recommend", file: "../src/services/plugin/localRecommend.js", exportName: "localRecommendManifest" },
  { id: "playlist-sync", file: "../src/services/plugin/playlistSync.js", exportName: "playlistSyncManifest" },
  { id: "dlna-renderer", file: "../src/services/plugin/renderers/dlna.js", exportName: "dlnaRendererManifest" },
  { id: "artist-info", file: "../src/services/plugin/artistInfo.js", exportName: "artistInfoManifest" },
];

const errors: string[] = [];
let ok = 0;

for (const { id, file, exportName } of BUILTINS) {
  try {
    const mod: any = await import(file);
    const m = mod[exportName];
    if (!m) { errors.push(`[${id}] 模块未导出 ${exportName}`); continue; }

    const reason = validateManifest(m);
    if (reason) { errors.push(`[${id}] manifest 不合规: ${reason}`); continue; }

    if (typeof m.documentation !== "string" || m.documentation.trim().length < 20) {
      errors.push(`[${id}] documentation 字段缺失或过短(需 ≥20 字符的「功能介绍 + 处理逻辑」)`);
      continue;
    }

    // 每项能力必须在 CAP_METHODS 有映射（否则声明不被核心消费 = 静默失效）
    for (const cap of m.capabilities) {
      if (!CAP_METHODS[cap]) {
        errors.push(`[${id}] 能力 ${cap} 不在 CAP_METHODS 映射表中(核心不会调用它)`);
      }
    }

    ok++;
    console.log(`  ✓ ${id} (${m.type}, ${m.capabilities.join("/")}) · documentation ${m.documentation.length} 字`);
  } catch (e: any) {
    errors.push(`[${id}] 模块加载失败: ${e?.message || e}`);
  }
}

console.log(`\n内置插件校验: ${ok}/${BUILTINS.length} 通过`);
if (errors.length > 0) {
  console.error("\n校验失败:");
  for (const e of errors) console.error("  ✗ " + e);
  process.exit(1);
}
