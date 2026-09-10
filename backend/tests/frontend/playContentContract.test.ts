// 守卫测试：Web 前端投屏起播「主通道优先」契约（2026-09-10 拍板）。
//
// 前端没有单测框架（只有 playwright e2e），而 player.ts 的起播通道选择是纯前端
// 行为，后端测试覆盖不到。这里用**源码契约扫描**钉死决策，防止回归。
//
// 背景（为什么这是「可用性」而不是「优化」）：
//   投屏起播有两条通道 ——
//     主通道 POST /rest/api/v1/play {peerId, type, id, songId}   几百字节
//     兜底通道 POST /v1/peers/:id/queue/play {items, startIndex} 整队，MB 级
//   公网入口经 Lucky WAF，对 /queue/play 的大 JSON 数组有体积闸门
//   （≈90KB ≈ 300 首即 403，响应体 `<title>403 - Lucky WAF</title>`，反代拒绝）。
//   大歌单整队推送 → 403 → 起播直接失败。所以歌单/专辑/艺人整份内容点播**必须**
//   走主通道；兜底通道只保留给服务端无从解析的队列。
//
// 历史坑（本守卫要防的回归形态）：
//   - 前端曾经**只有** pushCastQueueToBackend（整队推送），从不调 /v1/play；
//   - 起播若只传 startIndex（行号）而非 songId（身份），两侧排序不同源会静默播错歌。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const playerSrc = readFileSync(
  fileURLToPath(new URL("../../../frontend/src/stores/player.ts", import.meta.url)),
  "utf8",
);
const usePlayContentSrc = readFileSync(
  fileURLToPath(new URL("../../../frontend/src/composables/usePlayContent.ts", import.meta.url)),
  "utf8",
);

/** 截取 `function name(` / `async function name(` 起、到下一个顶格 `  }` 为止的函数体。 */
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return "";
  const end = src.indexOf("\n  }", start);
  return end < 0 ? src.slice(start) : src.slice(start, end);
}

/**
 * 截取 `api.post("<url>", { ... })` 的**请求体对象字面量**。
 *
 * 为什么不直接对整段函数做 toContain("songId")：那是字面包含断言，只要函数里
 * 还残留一句 `const startSongId = ...`（哪怕请求体里已经把它换成了 startIndex）
 * 断言就照样通过 → 守卫形同虚设。必须只检查**真正下发的 payload**。
 */
function requestBody(src: string, url: string): string {
  const at = src.indexOf(`"${url}"`);
  if (at < 0) return "";
  const braceStart = src.indexOf("{", at);
  if (braceStart < 0) return "";
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(braceStart, i + 1);
    }
  }
  return "";
}

describe("Web 前端投屏起播:主通道优先", () => {
  it("起播必须走主通道 /rest/api/v1/play", () => {
    const body = fnBody(playerSrc, "startCastPlaybackMainChannelFirst");
    expect(body, "找不到 startCastPlaybackMainChannelFirst").not.toBe("");
    expect(body, "整份内容点播必须调主通道 /rest/api/v1/play").toContain("/rest/api/v1/play");
    // 只检查真正下发的 payload，不看函数里残留的局部变量 ——
    // 否则「请求体已改成 startIndex，但 startSongId 变量还在」会漏检。
    const payload = requestBody(playerSrc, "/rest/api/v1/play");
    expect(payload, "找不到主通道请求体").not.toBe("");
    expect(payload, "主通道必须下发 songId(身份定位,不是 startIndex 行号)").toMatch(/\bsongId\s*:/);
    expect(payload, "主通道不得下发 startIndex 行号(两侧排序不同源会静默播错歌)").not.toMatch(
      /\bstartIndex\s*:/,
    );
    expect(payload, "主通道必须下发 type(服务端据此 resolveContentSongs)").toMatch(/\btype\s*:/);
    expect(payload, "主通道必须下发 id").toMatch(/\bid\s*:/);
    expect(payload, "主通道必须下发 peerId").toMatch(/\bpeerId\s*:/);
    // 主通道**不得**携带整队 items —— 那是兜底通道的形态，一旦混入就退回 MB 级
    // payload，重新落进 WAF 闸门。（客户端侧对称断言见 MusicFlow-client 的
    // cast_peer_provider_test.dart「no slot verification round-trip」用例。）
    expect(payload, "主通道 payload 不得包含整队 items(MB 级会撞 WAF 闸门)").not.toMatch(
      /\bitems\s*:/,
    );
  });

  it("主通道优先:先试主通道,失败才回落整队推送", () => {
    const body = fnBody(playerSrc, "startCastPlaybackMainChannelFirst");
    // 兜底通道必须存在（用户明确要求保留）——
    // 首页随机 / 搜索结果快照 / 本地任意队列 / 离线缓存列表 都靠它。
    expect(body, "必须保留兜底整队推送").toContain("pushCastQueueToBackend");
    const mainAt = body.indexOf("/rest/api/v1/play");
    const fallbackAt = body.indexOf("pushCastQueueToBackend(");
    expect(mainAt, "主通道调用必须存在").toBeGreaterThanOrEqual(0);
    expect(fallbackAt, "兜底调用必须存在").toBeGreaterThanOrEqual(0);
    // 排除函数自身声明处（签名里出现 pushCastQueueToBackend 的话），要求调用序正确。
    expect(mainAt, "主通道必须先于兜底整队推送").toBeLessThan(fallbackAt);
  });

  it("startCastPlayback 接到主通道优先实现(不得回退成直接整队推送)", () => {
    const body = fnBody(playerSrc, "startCastPlayback");
    expect(body, "找不到 startCastPlayback").not.toBe("");
    expect(body, "startCastPlayback 必须委派给主通道优先实现").toContain(
      "startCastPlaybackMainChannelFirst",
    );
  });

  it("整份内容点播必须声明队列来源,否则主通道不会被触发", () => {
    // 声明来源的plumbing断了 → contentOrigin 恒为 null → 永远走兜底通道 → 大歌单 403。
    for (const [name, marker] of [
      ["playPlaylist", '"playlist"'],
      ["playAlbum", '"album"'],
      ["playArtist", '"artist"'],
    ] as const) {
      const body = fnBody(usePlayContentSrc, name);
      expect(body, `usePlayContent.${name} 必须声明来源`).toContain("playWholeContent");
      expect(body, `${name} 的 type 必须是 ${marker}`).toContain(marker);
    }
    expect(usePlayContentSrc, "playWholeContent 必须调 setContentOrigin").toContain(
      "setContentOrigin",
    );
  });

  it("单曲/远程歌队列必须清空来源(服务端解析不出这些队列)", () => {
    // 单曲点播：服务端按 (type,id) 解析出的是整份内容，传 songId 只在其中定位，
    // 与「单曲队列」不是一回事 → 必须清空来源走兜底通道。
    const playSongBody = fnBody(playerSrc, "playSong");
    expect(playSongBody, "playSong 必须清空 contentOrigin").toContain("contentOrigin = null");

    // 队列里混入未入库的远程歌 → 服务端解析不出 → 清空来源。
    const playQueueBody = fnBody(playerSrc, "playQueue");
    expect(playQueueBody, "playQueue 遇远程歌必须清空 contentOrigin").toContain(
      "contentOrigin = null",
    );
  });

  it("WAF 闸门的判断依据必须留在源码里(闸门可被临时关闭,不能凭 200 判定不存在)", () => {
    expect(
      playerSrc,
      "主通道优先的理由(WAF 体积闸门)必须留在注释里,防止后人当成「可选优化」删掉",
    ).toContain("Lucky WAF");
    expect(
      playerSrc,
      "必须记录判据是响应体而非 HTTP 状态码",
    ).toContain("403 - Lucky WAF");
  });
});
