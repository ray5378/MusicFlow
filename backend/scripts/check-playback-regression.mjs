#!/usr/bin/env node
// ==================== 播放链路 2026-11-14~16 修复回归守卫 ====================
//
// 钉住四个「静默退化体质」的播放修复——它们被改坏后不报错、不崩,只表现为
// 「重投从头播 / 进度领先声音 / 进度冻住 / 推荐卡三端不一致」,真机才能发现:
//
//   R1 组倍速重投保留起点(e9895a3f):组 playMedia 的 startMs 必须透传给
//      三条扇出路径(sendspin 组泵 / DLNA 成员 / solo AirPlay),且组内不得再
//      出现硬编码 0 的 playMedia 起点。
//   R2 组状态位置口径(00def316 → 2026-11-20 **反转**,旧结论保留在此):
//      00def316 当时在 getGroupStatus 里再扣一次桥 lead(bridgeLeadContentSec,写入未出声 ×
//      倍速折算内容秒)。后来 streamEngine.audiblePositionMs 的 positionMs 已经是「设备此刻
//      正在响」的位置(depthMs 已扣),再扣一次让对外进度恒落后 ~2.05s:歌没播完 UI 到不了
//      终点、seek 落点少 2s(240 实测:同源分支自然播完 pos==dur 15/15,扣减分支少 2~3s)。
//      ⇒ 现在两条 sendspin 分支统一 `displayPositionMs ?? positionMs` 并钳 0,
//      bridgeLeadContentSec **不得回流**。
//   R3 DLNA RelTime 判死(e9895a3f):设备**真报正 RelTime**才允许把本次采样
//      当可信基线(MUZO/Linkplay 转码流恒回 0,castContentOffsetSec 不算读数);
//      无基线就地播种时以偏移为锚(pos = max(0, state.position)),否则重投后
//      进度冻在偏移值上。
//   R4 playlist_songs 复合索引(4a7d20a5):idx_playlist_songs_playlist_pos
//      (playlist_id, position)必须在建表 SQL 里(首页逐盘探测消除的前提)。
//   R5 首页推荐服务端组装(v4.14.9):/v1/home/recommend-section 路由与权限
//      接线必须在(客户端/HA 卡片都以此端点为真源,路由被摘 = 三端集体回落)。
//   R6 组装纯计算的门槛/快照校验字面量:随机位门槛 30、快照条数必须等于
//      want(修「fixed 变少 ⇒ 补不满张数」的彻底修法)。
//
// 零依赖 node 脚本(与 check-audio-default-flac.mjs 同款),挂 ci.yml 守卫 job。
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./lib/strip-comments.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => stripComments(readFileSync(join(root, rel), "utf8"));

const GROUP_PLAYER = "backend/src/services/group/protocolPlayer.ts";
const DLNA_CONTROL = "backend/src/services/dlna/control.ts";
const DB_INDEX = "backend/src/db/index.ts";
const HOME_PRELOAD = "backend/src/routes/api/homePreload.ts";
const HOME_SECTION = "backend/src/routes/api/homeRecommendSection.ts";

const failures = [];
let checks = 0;
function check(name, ok, detail) {
  checks += 1;
  if (ok) {
    console.log("  ✓ " + name);
  } else {
    failures.push(name + (detail ? " —— " + detail : ""));
    console.log("  ✗ " + name + (detail ? " —— " + detail : ""));
  }
}

/** 非空行数组(已剥注释,保留行结构)。 */
const lines = (code) => code.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
/** 从第 from 行开始找第一条含 needle 的行,返回其**后**紧跟的非空行(可指定 offset)。 */
function lineAfter(ls, needle, skip = 0) {
  const i = ls.findIndex((l) => l.includes(needle));
  if (i < 0) return null;
  return ls[i + 1 + skip] ?? null;
}

const gp = read(GROUP_PLAYER);
const gpLines = lines(gp);
const dlna = read(DLNA_CONTROL);
const dlnaLines = lines(dlna);
const dbi = read(DB_INDEX);
const hp = read(HOME_PRELOAD);
const hs = read(HOME_SECTION);

// ---------------------------------------------------------------------------
console.log("R1 组倍速重投保留起点(group/protocolPlayer.ts)");
// ---------------------------------------------------------------------------
check("R1a 组泵起推带 startMs(sendspin 组泵透传)",
  lineAfter(gpLines, "return createSendspinGroupPlayer(groupId).playMedia(")?.startsWith("item, baseUrl, startMs,") === true,
  "组泵 playMedia 的起点实参必须是 startMs 变量");
check("R1b DLNA 成员扇出带 startMs + 组倍速",
  gpLines.some((l) => l.includes("createDlnaProtocolPlayer(d).playMedia(item, baseUrl, startMs, undefined, { speed: groupSpeed })")),
  "DLNA 成员起点不得回到硬编码 0");
check("R1c solo AirPlay 扇出带 startMs",
  gpLines.some((l) => l.includes("createAirPlayPlayerForDevice(d).playMedia(item, baseUrl, startMs)")),
  "legacy 回滚路径起点不得回到硬编码 0");
check("R1d 组内不存在硬编码 0 起点的 playMedia 调用",
  !gpLines.some((l) => l.includes("playMedia(item, baseUrl, 0,")),
  "发现 item, baseUrl, 0 的组播放调用 —— 重投会从头播");

// ---------------------------------------------------------------------------
console.log("R2 组状态扣除桥成员 lead(group/protocolPlayer.ts)");
// ---------------------------------------------------------------------------
check("R2a bridgeLeadContentSec 不得回流(二次扣 lead ⇒ 进度恒落后 2.05s)",
  !gpLines.some((l) => l.includes("bridgeLeadContentSec")),
  "回流即复发「歌没播完 UI 到不了终点 / seek 少 2s」——扣减已收口在 audiblePositionMs 一处");
check("R2b 共享组泵分支 position 取显示位置并钳 0",
  gpLines.some((l) => l.includes("position: Math.max(0, toDecisecond((st as any).displayPositionMs ?? st.positionMs))")),
  "st 分支必须 displayPositionMs ?? positionMs(且 Math.max(0, …)),不再减 lead");
check("R2c 组轮询分支 position 取显示位置并钳 0",
  gpLines.some((l) => l.includes("position: Math.max(0, toDecisecond((gst as any).displayPositionMs ?? gst.positionMs))")),
  "gst 分支必须 displayPositionMs ?? positionMs(且 Math.max(0, …)),不再减 lead");
check("R2d 两条 sendspin 分支口径一致(不得只剩一条带 displayPositionMs)",
  gpLines.filter((l) => l.includes("displayPositionMs ?? ")).length >= 2,
  "只改一条 ⇒ 另一条又退回真实位置,两台设备进度不一致");

// ---------------------------------------------------------------------------
console.log("R3 DLNA RelTime 判死(dlna/control.ts)");
// ---------------------------------------------------------------------------
check("R3a devicePosReported 标志位在(仅真报正 RelTime 才置真)",
  dlnaLines.some((l) => l.includes("if (rawStreamPos > 0) devicePosReported = true;")),
  "MUZO/Linkplay 恒回 0 的转码流必须被判不可信");
check("R3b 可信基线采样必须先过 devicePosReported 门",
  dlnaLines.some((l) => l.includes("if (devicePosReported && state.position > 0) {")),
  "丢了标志位门 ⇒ castContentOffsetSec 被当读数,进度冻住");
check("R3c 无基线就地播种以偏移为锚(重投后不冻在偏移值)",
  dlnaLines.some((l) => l.includes("positionEstimates.set(deviceId, { pos: Math.max(0, state.position), at: sampledAt")),
  "播种回到 pos: 0 ⇒ 重投/seek 后进度从 0 重新外推");

// ---------------------------------------------------------------------------
console.log("R4 playlist_songs 复合索引(db/index.ts)");
// ---------------------------------------------------------------------------
check("R4a idx_playlist_songs_playlist_pos(playlist_id, position)在建表 SQL 里",
  dbi.includes("CREATE INDEX IF NOT EXISTS idx_playlist_songs_playlist_pos ON playlist_songs(playlist_id, position);"),
  "复合索引被删 ⇒ 首页逐盘探测回归(请求内 9.4~18.2s)");

// ---------------------------------------------------------------------------
console.log("R5 首页推荐服务端组装路由(homePreload.ts)");
// ---------------------------------------------------------------------------
check("R5a GET /v1/home/recommend-section 路由在",
  hp.includes('app.get("/v1/home/recommend-section"'),
  "路由被摘 ⇒ 三端集体回落本地组装(三套卡片回归)");
check("R5b 路由挂 PLAYLIST_VIEW 权限中间件",
  hp.includes('app.use("/v1/home/recommend-section", permMiddleware(PERM.PLAYLIST_VIEW))'),
  "权限接线缺失 ⇒ 未登录可读歌单池");

// ---------------------------------------------------------------------------
console.log("R6 组装纯计算门槛/快照校验(homeRecommendSection.ts)");
// ---------------------------------------------------------------------------
check("R6a 随机位门槛常量 30 在",
  hs.includes("export const RANDOM_CARD_MIN_SONG_COUNT = 30;"),
  "门槛常量被改/删 ⇒ 空歌单进随机位");
check("R6b 随机池按门槛过滤",
  hs.includes("p.songCount >= RANDOM_CARD_MIN_SONG_COUNT"),
  "过滤式丢了 ⇒ 小歌单补位");
check("R6c 快照采纳必须条数恰等 want(修「fixed 变少 ⇒ 补不满」)",
  hs.includes("frozenIds.length === want"),
  "条数校验丢了 ⇒ 配置变更后该补的张数补不满");

// ---------------------------------------------------------------------------
if (failures.length > 0) {
  console.error(`\n✗ check-playback-regression: ${failures.length}/${checks} 项不通过:`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`\n✓ check-playback-regression: ${checks} 项全部通过`);
