// 自动生成 —— 由 index.ts 物理拆分而来（pipeline 域，6 条路由）。零逻辑改动。
import type { Hono } from "hono";
import {
  BusinessErrorCode,
  CROSSFADE_DURATION_KEY,
  CROSSFADE_MODE_KEY,
  FADE_MAX_SEC,
  FADE_MIN_SEC,
  FLOW_ENABLED_KEY,
  adminMiddleware,
  apiError,
  canControlPeer,
  getCachedDevices,
  getMeasureStatus,
  getSetting,
  isDlnaFallback,
  readNormalizationSettings,
  readPipelineSwitches,
  resolveFlowSettings,
  setDlnaFallback,
  setOfflineMeasureEnabled,
  setSetting,
  startOfflineMeasure,
  updateNormalizationSettings,
  updatePipelineSwitches,
} from "./shared.js";

export function registerPipeline(app: Hono): void {
app.get("/v1/pipeline/switches", adminMiddleware, (c) => {
  const flow = resolveFlowSettings((k, d) => getSetting(k, d));
  return c.json({
    switches: readPipelineSwitches(),
    flow: { enabled: flow.enabled, mode: flow.mode, crossfade: flow.crossfade, durationSec: flow.fade.durationSec },
    normalization: readNormalizationSettings(),
    devices: getCachedDevices().map((d) => ({
      deviceId: d.id,
      name: d.name || d.id,
      fallback: isDlnaFallback(d.id),
    })),
  });
});
// PUT：部分更新。
// `{switches:{enabled,channels:{...}}, flow:{enabled,mode,durationSec}, normalization:{enabled,targetLufs}}`。
// 未传的字段保持不动；非法值忽略（逐项提交，不该一条手抖把整次保存打回）。

app.put("/v1/pipeline/switches", adminMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  updatePipelineSwitches(body?.switches ?? body);
  const flow = body?.flow;
  if (flow && typeof flow === "object") {
    if (typeof flow.enabled === "boolean") setSetting(FLOW_ENABLED_KEY, flow.enabled ? "1" : "0");
    if (flow.mode === "standard" || flow.mode === "disabled") setSetting(CROSSFADE_MODE_KEY, flow.mode);
    const dur = Number(flow.durationSec);
    // 落库前就按 MA 的区间夹（`CONF_ENTRY_CROSSFADE_DURATION` range=(1,15)），
    // 别把 30 存进库再靠读取端兜 —— 库里留个读不出来的值是最难查的那种"配置没生效"。
    if (Number.isFinite(dur) && dur > 0) {
      setSetting(CROSSFADE_DURATION_KEY, String(Math.min(FADE_MAX_SEC, Math.max(FADE_MIN_SEC, Math.round(dur)))));
    }
  }
  // ② 段归一化（目标响度区间 -30…-5 LUFS）。与上面同套纪律：夹在写入口。
  if (body?.normalization && typeof body.normalization === "object") {
    updateNormalizationSettings(body.normalization);
  }
  const resolved = resolveFlowSettings((k, d) => getSetting(k, d));
  return c.json({
    ok: true,
    switches: readPipelineSwitches(),
    flow: { enabled: resolved.enabled, mode: resolved.mode, crossfade: resolved.crossfade, durationSec: resolved.fade.durationSec },
    normalization: readNormalizationSettings(),
  });
});
// PUT：某台 DLNA 设备的单独回退（D5 配套兜底）。Body: { fallback: boolean }。
// 只作用于这台设备：其它 DLNA 设备与该设备的其它行为（音量/队列/解绑）都不受影响。

app.put("/v1/pipeline/dlna/:deviceId", adminMiddleware, async (c) => {
  const deviceId = c.req.param("deviceId") || "";
  if (!deviceId) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.common.paramsRequired"), 400);
  const body = await c.req.json().catch(() => ({} as any));
  setDlnaFallback(deviceId, body?.fallback === true);
  return c.json({ ok: true, deviceId, fallback: isDlnaFallback(deviceId) });
});

// ===== 离线预测量（P5-3，可选优化层，默认关）=====
// 只对 **local** 行做事：预跑 loudnorm 把集成响度/真峰值落进 audio_analysis，
// 之后起播走静态增益（省掉实时分析）。web 源永不测（D8：字节不保证一致）。
// 与上面的管道开关同理，属服务端全局行为 ⇒ 一律 admin。

app.get("/v1/pipeline/measure", adminMiddleware, (c) => {
  return c.json(getMeasureStatus());
});
// PUT：只切开关。开启/关闭都不影响已有测量值（关掉只是不再新增）。

app.put("/v1/pipeline/measure", adminMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  if (typeof body?.enabled === "boolean") setOfflineMeasureEnabled(body.enabled);
  return c.json(getMeasureStatus());
});
// POST：手动触发一批（异步跑，立即返回），前端轮询 GET 看 running/progress。
// 开关没开、或已有一批在跑时返回 started:false + reason，不静默吞掉。

app.post("/v1/pipeline/measure/run", adminMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const r = startOfflineMeasure(body?.limit);
  return c.json({ ...r, ...getMeasureStatus() });
});

// 非 admin 只能控制/查询「自己的本机播放器 + 被授权的设备/群组」。
// 与 /v1/peers 列表过滤一致(canControlPeer 含 local:<userId> 永远放行),
// 防止普通用户看到或遥控别人的播放器/群组。
//
// ⚠️ 路径隔离(2026-09-26 实测定位):Hono 的 `:peerId/*` 通配会**吞掉字面量子路径** ——
// 最小复现(backend 内跑 Hono 4.13.5):
//   POST /v1/peers/register → MW 命中且 `peerId === "register"`
// 于是 `canControlPeer(userId, false, "register")` 恒 false,普通账号注册自己被 403
// 拦下(管理员因 isAdmin 短路才通过)。这是「非管理员在客户端看不到自己本机播放器」
// 的**根因** —— 注册失败 ⇒ peer 从未建立 ⇒ 列表里既没有自己那行、self 也无从谈起。
// 故此处显式放行下面的**字面量保留段**(它们不是 peerId):
//   register —— 注册本端(自身校验在路由内)
// 注意用**精确等值**而非前缀匹配,避免把真实 peerId(如 dlna:register-xxx)误放。
}
