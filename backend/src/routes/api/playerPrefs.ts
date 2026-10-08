// 自动生成 —— 由 index.ts 物理拆分而来（playerPrefs 域，7 条路由）。零逻辑改动。
import type { Hono } from "hono";
import {
  BITS_OPTIONS,
  BusinessErrorCode,
  DEFAULT_TARGET_RATE,
  PERM,
  RATE_OPTIONS,
  apiError,
  canControlPeer,
  decodePeerId,
  getHiddenPeerIds,
  getNameOverrides,
  getPeerNameOverride,
  getPlayerDspConfig,
  getPlayerRateConfig,
  isPeerHidden,
  listPlayerDspConfigs,
  listPlayerRateConfigs,
  normalizeTargetBits,
  normalizeTargetRate,
  permMiddleware,
  resolveTargetBits,
  resolveTargetSampleRate,
  setPeerHidden,
  setPeerNameOverride,
  setPlayerDspConfig,
  setPlayerRate,
} from "./shared.js";

export function registerPlayerPrefs(app: Hono): void {
app.get("/v1/player-prefs/hidden", (c) => {
  const userId = c.get("user")?.id || "";
  return c.json({ peerIds: Array.from(getHiddenPeerIds(userId)) });
});
// PUT:设置/取消对某 peer 的隐藏。Body: { peerId: string, hidden: boolean }。

app.put("/v1/player-prefs/hidden", async (c) => {
  const userId = c.get("user")?.id || "";
  const body = await c.req.json().catch(() => ({} as any));
  const peerId = typeof body?.peerId === "string" ? body.peerId.trim() : "";
  if (!peerId) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.peerIdRequired"), 400);
  setPeerHidden(userId, peerId, body?.hidden === true);
  return c.json({ ok: true, hidden: isPeerHidden(userId, peerId) });
});

// ===== 播放器「按用户级」显示名覆盖 =====
// 每个用户可给自己视角下的 DLNA/AirPlay 设备/群组(peerId)起显示名,只影响本人
// 界面与播放器切换器,他人各自改名互不影响,设备原始名(alias/name)保持不变。
// 需要 renderer.use(普通用户被授予播放器使用能力后可改名,无需管理权限)。
// GET:返回我的全部改名覆盖 { {peerId}: displayName }。

app.get("/v1/player-prefs/names", permMiddleware(PERM.RENDERER_USE), (c) => {
  const userId = c.get("user")?.id || "";
  return c.json({ names: Object.fromEntries(getNameOverrides(userId)) });
});
// PUT:设置/清除我对某 peer 的显示名。Body: { peerId: string, name?: string } — name 空串清除。

app.put("/v1/player-prefs/names", permMiddleware(PERM.RENDERER_USE), async (c) => {
  const userId = c.get("user")?.id || "";
  const body = await c.req.json().catch(() => ({} as any));
  const peerId = typeof body?.peerId === "string" ? body.peerId.trim() : "";
  if (!peerId) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.peerIdRequired"), 400);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (name.length > 50) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.common.nameTooLong"), 400);
  setPeerNameOverride(userId, peerId, name);
  return c.json({ ok: true, displayName: getPeerNameOverride(userId, peerId) });
});

// ===== per-player DSP 配置（③ 段，P4-2）=====
// 音色是**设备属性**（书架箱 / 耳机各自的补偿曲线），故不按用户分：任何账号改完都落
// 同一行，谁进来看到的都是同一套 EQ（与 sendspin_device_state 的音量同理）。
// 权限：**设备级** —— `RENDERER_USE` 只说明"能播放"，不能说明"能动别人的音色"，
// 故再收一层 `canControlPeer`（非 admin：自己的本机播放器 + 被授权的设备/群组），
// 与 `/v1/peers/*` 同一口径。不收紧的话，任何被授予 renderer.use 的账号都能改
// 全服务器每台设备的 EQ —— 那是**别人的听感**，属越权。
// 生效时机：**下一次起播**（出流侧在起流时一次性算定 af 链，见 P3-4 的 pin）。
// 成组的成员设备即使有配置也不会生效（`playerDspFilters` 里按 MA 规则禁用），
// 但这里**不拦保存** —— 用户可能先存后组，拦了反而丢配置。
// GET:返回全部非空配置 { {peerId}: DspConfig }（设置面板一次拿全，省 N 次请求）。

app.get("/v1/player-prefs/dsp", permMiddleware(PERM.RENDERER_USE), (c) => {
  const user = c.get("user");
  const all = listPlayerDspConfigs();
  if (user?.isAdmin) return c.json({ configs: all });
  // 非 admin：按"能控制谁"过滤（不是拒绝 —— 全量视图对普通用户只是"我这些设备"）。
  const configs = Object.fromEntries(
    Object.entries(all).filter(([peerId]) => canControlPeer(user?.id ?? "", false, peerId)),
  );
  return c.json({ configs });
});
// GET:单台设备的配置（无配置回 null，前端据此显示"未启用"）。
// ⚠️ **DB 键用原始参数、权限判定用解析后的 id**，两者刻意不同：
//   - 键的形式是"设置面板"与"出流侧 `?peerId=` 自报"共用的历史约定，改掉会让
//     已经设过音色的客户端（本机 `local:` 实例）突然不生效；
//   - 权限判定必须解析——掩码 `local:<uid>:<instanceKey>` 要认出"这是我自己的本机播放器"
//     （`canControlPeer` 的 `isOwnLocalPeer` 两种形式都认，但走 `decodePeerId` 与
//     `/v1/play` 同一套纪律，免得以后有人只照着这里抄出个不解析的版本）。

app.get("/v1/player-prefs/dsp/:peerId", permMiddleware(PERM.RENDERER_USE), (c) => {
  const raw = c.req.param("peerId") || "";
  if (!raw) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.peerIdRequired"), 400);
  const user = c.get("user");
  if (!canControlPeer(user?.id ?? "", !!user?.isAdmin, decodePeerId(c))) {
    return c.json(apiError(BusinessErrorCode.FORBIDDEN, "errors.renderer.operationForbidden"), 403);
  }
  return c.json({ peerId: raw, config: getPlayerDspConfig(raw) });
});
// PUT:设置单台设备的配置。Body 即 DspConfig（任意形状，服务端归一化）。
// 归一化后"没活可干"（全 0 / 空段）→ 删行并回 null —— 前端表单可直接用返回值纠正显示。

app.put("/v1/player-prefs/dsp/:peerId", permMiddleware(PERM.RENDERER_USE), async (c) => {
  const raw = c.req.param("peerId") || "";
  if (!raw) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.peerIdRequired"), 400);
  const user = c.get("user");
  if (!canControlPeer(user?.id ?? "", !!user?.isAdmin, decodePeerId(c))) {
    return c.json(apiError(BusinessErrorCode.FORBIDDEN, "errors.renderer.operationForbidden"), 403);
  }
  const body = await c.req.json().catch(() => null);
  try {
    const config = setPlayerDspConfig(raw, body);
    return c.json({ ok: true, peerId: raw, config });
  } catch {
    return c.json(apiError(BusinessErrorCode.INTERNAL, "errors.dsp.saveFailed"), 500);
  }
});

// ===== per-player 输出格式：目标采样率 + 位深（batch48 采样率 / batch49 位深）=====
// 采样率与音色同为**设备属性**（设备硬件能力，不跟账号走），故同样按 `peerId` 全设备级
// 存储、同一套 `canControlPeer` 权限口径（非 admin：自己的本机播放器 + 被授权的设备/组）。
// 三来源优先级：**手动 > 设备 hello 自动宣告 > 缺省 48000**（见 services/playerRate.ts）。
//   - 自动宣告：Sendspin 设备在 `client/hello` 里逐条上报 sample_rate（真机实测），
//     服务端取最大值落 probedRate —— DLNA **协议不报采样率**，只有手动 + 缺省。
// 生效时机：**下一次起播**（出流侧起流时一次算定 af 链，与 DSP 同一 pin 语义）。
// 成组的成员设备取**组内最低值**（组内必须同率，否则同步/连续流会变速），
// 故回显里同时给"最终生效值"，前端不必自己算组。
//
// batch49 位深：与采样率**同一条路由、同一张表**（都是「输出格式」= 设备属性）。
// 位深只有手动一档，`null` = 自动 = **跟随源位深**（16 源出 16 / 24 源出 24）；
// 没有设备上报来源，理由见 services/playerRate.ts 文件头。
// GET:一次返回全部配置 + 可选档位 + 缺省值（面板一次渲染完，省 N 次请求）。

app.get("/v1/player-prefs/rate", permMiddleware(PERM.RENDERER_USE), (c) => {
  const user = c.get("user");
  const all = listPlayerRateConfigs();
  // 非 admin：按"能控制谁"过滤（不是拒绝 —— 全量视图对普通用户只是"我这些设备"）。
  const configs = user?.isAdmin
    ? all
    : Object.fromEntries(
        Object.entries(all).filter(([peerId]) => canControlPeer(user?.id ?? "", false, peerId)),
      );
  return c.json({
    options: RATE_OPTIONS,
    defaultRate: DEFAULT_TARGET_RATE,
    bitsOptions: BITS_OPTIONS,
    configs,
  });
});
// GET:单台设备（含 effectiveRate —— 成组时是组内最低值，前端直接回显它）。
// ⚠️ 与 DSP 同一纪律：**DB 键用原始参数、权限判定用解析后的 id**。

app.get("/v1/player-prefs/rate/:peerId", permMiddleware(PERM.RENDERER_USE), (c) => {
  const raw = c.req.param("peerId") || "";
  if (!raw) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.peerIdRequired"), 400);
  const user = c.get("user");
  if (!canControlPeer(user?.id ?? "", !!user?.isAdmin, decodePeerId(c))) {
    return c.json(apiError(BusinessErrorCode.FORBIDDEN, "errors.renderer.operationForbidden"), 403);
  }
  return c.json({
    peerId: raw,
    options: RATE_OPTIONS,
    defaultRate: DEFAULT_TARGET_RATE,
    bitsOptions: BITS_OPTIONS,
    config: getPlayerRateConfig(raw),
    effectiveRate: resolveTargetSampleRate(raw),
    /** null = 自动（跟随源位深）。 */
    effectiveBits: resolveTargetBits(raw),
  });
});
// PUT:设置/清除手动档位。Body: { rate?: number|null, bits?: 16|24|null }。
// 两个键**各自独立**：缺席 = 不动（只改采样率不会把位深冲掉），显式 null = 清除。
// 归一化后为 null（清除）时**只清手动值、保留设备自动宣告值**；
// 返回归一化后的实际生效值，前端表单据此纠正显示（与 DSP 的返回值语义一致）。

app.put("/v1/player-prefs/rate/:peerId", permMiddleware(PERM.RENDERER_USE), async (c) => {
  const raw = c.req.param("peerId") || "";
  if (!raw) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.peerIdRequired"), 400);
  const user = c.get("user");
  if (!canControlPeer(user?.id ?? "", !!user?.isAdmin, decodePeerId(c))) {
    return c.json(apiError(BusinessErrorCode.FORBIDDEN, "errors.renderer.operationForbidden"), 403);
  }
  const body = await c.req.json().catch(() => ({} as any));
  // 显式给了**非法档位** → 400。下拉只可能给出白名单值，非法值只可能来自手改 API；
  // 静默当成"清除手动设置"会把"传错了"伪装成"设置成功"。
  // 显式 null / 缺省 / 空串 → 清除手动值（**保留**设备自动宣告值）。
  const rawRate = body?.rate;
  if (rawRate !== null && rawRate !== undefined && rawRate !== "" && normalizeTargetRate(rawRate) === null) {
    return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.rate.invalidRate"), 400);
  }
  const rawBits = body?.bits;
  if (rawBits !== null && rawBits !== undefined && rawBits !== "" && normalizeTargetBits(rawBits) === null) {
    return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.rate.invalidBits"), 400);
  }
  try {
    const config = setPlayerRate(raw, body);
    return c.json({
      ok: true,
      peerId: raw,
      config,
      effectiveRate: resolveTargetSampleRate(raw),
      effectiveBits: resolveTargetBits(raw),
    });
  } catch {
    return c.json(apiError(BusinessErrorCode.INTERNAL, "errors.dsp.saveFailed"), 500);
  }
});

// ===== 音频管道开关（P5-1）+ DLNA 单设备回退（P5-2）+ 响度归一化 =====
// 语义照 D9：**关闭 = 该段滤镜链为空（+ 不再拼交叉淡入流），仍走管道** —— 不是恢复直透。
// 全是服务端全局播放行为，故一律 admin（与 /v1/settings、/v1/proxy 一致）。
// GET 一次给全：开关 + 交叉淡入配置 + DLNA 设备回退表 + ② 段归一化（面板一次渲染完，省 N 次请求）。
}
