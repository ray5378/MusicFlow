# 播放换源(多源自动替换)匹配规则

当原始平台(如 QQ 音乐)解析不出某首歌(404 / VIP / 403 地区版权封锁 / 5xx)时,
MusicFlow 会**自动搜索同一插件提供的可播平台候选**,把这首歌换到能播的源上。
本机播放、DLNA 投屏、专辑/歌单远程曲、auto-match 导入共用同一套严格的
「歌名 + 歌手」匹配规则。

## 触发条件

以下播放链路在原源失败(`404` / `403` / `>=500`)时触发换源:

| 链路 | 入口 | 说明 |
|---|---|---|
| 本机播放(已入库 web 歌) | `GET /rest/stream` | 经 `serveWebSongStream` |
| 本机播放(未入库远程歌,搜索即播) | `GET /rest/stream-remote` | 经 `serveWebSongStream`,本次补齐字段后与入库歌行为一致 |
| DLNA 投屏 | `GET /dlna/stream/:token` | 导入后经 `serveWebSongStream` |
| 预探测/投屏前置检查 | `ensurePlayableStream` | `/v1/stream/probe` 等使用 |

换源结果按歌曲(合成 key,含 `remote:` 前缀隔离缓存)伺服内存缓存,不重复搜索。

## 歌名匹配规则:严格全串对齐(后缀保留)

判定方法 `normalizeTitleStrict`(见 `backend/src/services/plugin/shared.ts`):

1. 全角拉丁字母/数字 → 半角(如 `ＬＩＶＥ` → `LIVE`);
2. 转小写;
3. **只保留中文字与英文字母数字下划线** `[a-z0-9_\u4e00-\u9fa5]`,其余符号、空格、
   括号、点号、分隔线全部丢弃。

相等才算歌名匹配。因为 "Live / 演唱会 / 版 / 伴奏 / Taylor's Version" 等后缀
都由中英文字符构成、必然保留,**有后缀的名字只能匹配带相同后缀的名字,
无后缀的名字只能匹配无后缀的名字**,仅大小写、符号、空白、全角/半角被放宽。

### 示例

| 期望曲(要播的歌) | 换源候选 | 归一化结果 | 判定 |
|---|---|---|---|
| 听妈妈的话 | 听妈妈的话 | 听妈妈的话 = 听妈妈的话 | 匹配 |
| 听妈妈的话 | 听妈妈的话(Live) | 听妈妈的话 ≠ 听妈妈的话live | 不换源 |
| 听妈妈的话 | 听妈妈的话-演唱会版 | 听妈妈的话 ≠ 听妈妈的话演唱会版 | 不换源 |
| 听妈妈的话(Live) | 听妈妈的话 (LIVE) | 听妈妈的话live = 听妈妈的话live | 换源 |
| 听妈妈的话(Live) | 听妈妈的话 | 听妈妈的话live ≠ 听妈妈的话 | 不换源 |
| 依然范特西 | 依然范特西(专辑版) | 依然范特西 ≠ 依然范特西专辑版 | 不换源 |
| 依然范特西 | 依然范特西周杰伦 | 依然范特西 ≠ 依然范特西周杰伦 | 不换源 |
| Cube (Taylor's Version) | Cube (Taylor's Version) | cubetaylorsversion = cubetaylorsversion | 匹配 |

> 注意:候选歌名里带艺人名(如 `依然范特西 · 周杰伦` / `- 周杰伦`)仍然**不换源**——
> 艺人用下面的歌手匹配单独判定,歌名不为此单开例外。

## 歌手匹配规则

- 期望曲不带歌手 → 仅按歌名匹配(向后兼容);
- 期望曲带歌手 → 候选歌手按分隔符(`/` `、` `&` `,` `；` `;` `feat.` `ft.` 等)拆成
  艺人集,**只要包含期望的首位歌手**(大小写不敏感,子串相等)即通过;
- 同歌名但歌手不一致 → 判定为「同名异曲」,不换源(防止点七里香实际播到别首)。

## 候选排序与探测

候选按插件声明的 `manifest.sourcePreference`(平台偏好顺序)排序,依次 Range 探测:
任一首返回 `200`/`206` 即采用;全部失败则该歌不换源,原失败响应原样透传
(不会把已锁定的 body 重新发出去造成 `200` 误响应)。

## 代码位置

- 匹配核心:`backend/src/services/plugin/shared.ts` — `normalizeTitleStrict`
- 换源逻辑:`backend/src/services/source/online/streamFallback.ts` — `findFallbackStream` / `ensurePlayableStream`
- auto-match 导入:`backend/src/services/source/online/match.ts` — `scoreCandidate` / `searchBestMatch`
- 播放代理:`backend/src/routes/rest/index.ts` — `serveWebSongStream`(含 `/rest/stream-remote`)
- 插件端 go-music-dl `matchInPool` 使用同款「只保留中英文」规则,无需额外改动。

## 测试

- `backend/tests/source/online/streamFallback.test.ts` — 换源匹配(后缀/歌手多个用例)
- `backend/tests/source/online/match.test.ts` — searchBestMatch 后缀对齐用例
- `backend/tests/routes/streamRemoteFallback.test.ts` — `/rest/stream-remote` 路由层换源