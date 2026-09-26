// 自动生成 —— 由 index.ts 物理拆分而来（plugins 域，14 条路由）。零逻辑改动。
import type { Hono } from "hono";
import {
  BusinessErrorCode,
  MAX_PROBE_BATCH,
  addRegistry,
  adminMiddleware,
  apiError,
  collectRegistryGroups,
  db,
  discoverRenderers,
  ensurePlayableStream,
  eq,
  fs,
  getCachedPlayability,
  getDataDir,
  getPluginJobState,
  getPluginManifest,
  getRendererPlugins,
  getScrobblerPlugins,
  getSendspinFront,
  homePositionConflictForSave,
  installPlugin,
  isBatchCapable,
  isBuiltinRow,
  isCoreRow,
  listMarketplace,
  listRegistries,
  log,
  path,
  pingAllHealth,
  pluginSandboxes,
  plugins,
  registerBatchWorker,
  removeRegistry,
  startAirPlayService,
  startSendspinService,
  stopAirPlayService,
  stopSendspinService,
  unregisterBatchWorker,
  unregisterPlugin,
  uuidv4,
} from "./shared.js";

export function registerPlugins(app: Hono): void {
app.get("/v1/plugins", adminMiddleware, (c) => {
  const rows = db.select().from(plugins).all() as any[];
  return c.json(rows.map((r) => {
    const builtin = isBuiltinRow(r);
    // manifest/version 以注册表内存为准:DB 可能是升级前的旧快照(缺新增配置项
    // 或版本停留旧值),这里统一覆盖返回;已卸载/不再注册的插件行回退 DB 数据。
    let manifest = r.manifest;
    let version = r.version;
    const m = getPluginManifest(r.name);
    if (m) {
      manifest = JSON.stringify(m);
      version = m.version;
    }
    return { ...r, manifest, version, builtin };
  }));
});

app.post("/v1/plugins", adminMiddleware, async (c) => { const body = await c.req.json(); const id = uuidv4(); db.insert(plugins).values({ id, name: body.name, version: body.version || "", description: body.description || "", manifest: JSON.stringify(body.manifest || {}), enabled: body.enabled ? 1 : 0, config: JSON.stringify(body.config || {}) }).run(); return c.json({ id }); });

app.put("/v1/plugins/:id", adminMiddleware, async (c) => {
  const p = db.select().from(plugins).where(eq(plugins.id, c.req.param("id")!)).get();
  if (!p) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.plugin.notFound"), 404);
  const body = await c.req.json().catch(() => ({}));
  const builtin = isBuiltinRow(p);
  // 首页位次冲突预检:推荐插件保存 showOnHome/homePosition 时,与其它「显示在首页」
  // 的插件位次重复则拒绝保存(自己占自己位次不算冲突)。
  if (body.config !== undefined) {
    const conflict = homePositionConflictForSave(p.id, body.config);
    if (conflict) return c.json({ error: conflict }, 400);
  }
  db.update(plugins).set({
    config: body.config !== undefined ? JSON.stringify(body.config) : p.config,
    // 内置核心插件强制启用,忽略停用请求(可更新配置/描述,不可停用)。
    enabled: builtin ? 1 : (body.enabled !== undefined ? (body.enabled ? 1 : 0) : p.enabled),
    description: typeof body.description === "string" ? body.description : p.description,
    version: typeof body.version === "string" ? body.version : p.version,
    name: typeof body.name === "string" ? body.name : p.name,
    updatedAt: new Date().toISOString(),
  }).where(eq(plugins.id, p.id)).run();
  // 并行开关实时联动:该插件参与批量任务队列 && 「允许并行执行」切换
  // → 同步批量并发上限(register/unregisterBatchWorker 幂等,无需重启,重复保存不重复计)。
  // 内置与外置、声明与否 longRunning 一律按批量能力(isBatchCapable)纳入。
  if (body.config !== undefined && isBatchCapable(getPluginManifest(p.name))) {
    let oldCfg: any = {};
    try { oldCfg = p.config ? JSON.parse(p.config) : {}; } catch { /* keep {} */ }
    const oldOn = oldCfg?.batchParallel === true;
    const newOn = body.config?.batchParallel === true;
    if (!oldOn && newOn) registerBatchWorker(p.id);
    else if (oldOn && !newOn) unregisterBatchWorker(p.id);
  }
  // sendspin legacy 开关热更新:运行时直接改 server 标志,已连会话不受影响,
  // 新连按新值执行(无需重启插件)。
  if (body.config !== undefined && (p.id === "sendspin-renderer" || p.name === "sendspin-renderer")) {
    // 配置热更新(codec/legacy/6053 桥接)统一入口:sendspin 运行时已 fork 到子进程,
    // 这里经 RPC 把整份配置下发给子进程自应用(in-proc 模式直接改 server 字段)。
    try {
      const { applySendspinConfigHotUpdate } = await import("../../services/sendspin/index.js");
      await applySendspinConfigHotUpdate();
    } catch { /* 服务未运行时忽略,下次启动读配置 */ }
    // 端口变更需重启监听才生效:杀子进程重建(已连客户端断开后按记住目标重拨)。
    try {
      const cfg = (body.config as any) || {};
      const { getSendspinFront, stopSendspinService, startSendspinService } =
        await import("../../services/sendspin/index.js");
      const srv = getSendspinFront();
      if (srv && cfg.port !== undefined) {
        const want = Number(cfg.port);
        if (Number.isInteger(want) && want >= 1 && want <= 65535 && want !== srv.port) {
          await stopSendspinService();
          await startSendspinService(want);
        }
      }
    } catch { /* 重启失败忽略,下次切开关时按配置启动 */ }
  }
  return c.json({ success: true });
});

app.put("/v1/plugins/:id/toggle", adminMiddleware, (c) => {
  const p = db.select().from(plugins).where(eq(plugins.id, c.req.param("id")!)).get();
  if (!p) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.plugin.notFound"), 404);
  // core 内置行为插件(同曲多源组 / 播放优选)也可通过状态开关整体停用:
  // 总开关(列表)关 = 整个功能关闭(能力查询 isCapabilityEnabled 返回 false,
  // 不再归组 / 不再优选,恢复按原源播放);配置弹窗中的功能子开关(多源组匹配
  // 规则 / preferLocal、fallbackToWeb)保留,形成「总开关 + 子开关」两层控制。
  // 注意:core 插件无首页位次,跳过下面的启用冲突检查。
  if (!isCoreRow(p)) {
    // 启用插件时若其已配置首页显示位次,与其它插件位次冲突则拒绝启用。
    if (!p.enabled) {
      let cfg: any = {};
      try { cfg = p.config ? JSON.parse(p.config) : {}; } catch {}
      const conflict = homePositionConflictForSave(p.id, cfg);
      if (conflict) return c.json({ error: conflict }, 400);
    }
  }
  const nextEnabled = p.enabled ? 0 : 1;
  db.update(plugins).set({ enabled: nextEnabled }).where(eq(plugins.id, p.id)).run();
  // 内置插件的服务生命周期联动:airplay-renderer / sendspin-renderer 开关 → 启动/停止服务
  // (开启才启动监听/mDNS;关闭时停全部会话 + 清 peer/player + 释放 socket,零常驻资源)。
  if (p.id === "airplay-renderer" || p.name === "airplay-renderer") {
    if (nextEnabled) startAirPlayService();
    else void stopAirPlayService();
  }
  if (p.id === "sendspin-renderer" || p.name === "sendspin-renderer") {
    if (nextEnabled) startSendspinService().catch((e: any) => console.error("[sendspin] toggle start failed", e));
    else void stopSendspinService();
  }
  return c.json({ success: true });
});
// 删除插件(仅外置插件;内置核心插件不可删除)。删除目录 + 释放沙箱 + 反注册 + 删 DB 行。

app.delete("/v1/plugins/:id", adminMiddleware, (c) => {
  const id = c.req.param("id")!;
  const p = db.select().from(plugins).where(eq(plugins.id, id)).get() as any;
  if (!p) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.plugin.notFound"), 404);
  if (isBuiltinRow(p)) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.common.builtinPluginProtected"), 400);
  const sandbox = pluginSandboxes.get(p.id) || pluginSandboxes.get(p.name);
  if (sandbox) {
    try { sandbox.dispose(); } catch { /* ignore */ }
    pluginSandboxes.delete(p.id);
    pluginSandboxes.delete(p.name);
  }
  unregisterPlugin(p.id);
  unregisterPlugin(p.name);
  const dir = path.join(getDataDir(), "plugins", p.id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  db.delete(plugins).where(eq(plugins.id, p.id)).run();
  log.info(`[PLUGIN] 已删除插件 ${p.id} (${p.name || ""})`);
  return c.json({ success: true });
});

// Plugin health:主动 ping(实现了 health() 的插件自检,带缓存) + 被动观测记录 + none。
// — see plugins/health.ts.

app.get("/v1/plugins/health", adminMiddleware, async (c) => c.json({ health: await pingAllHealth() }));

// Renderer plugins (device-casting capability).

app.get("/v1/plugins/renderers", adminMiddleware, (c) => c.json({ renderers: getRendererPlugins() }));

app.get("/v1/plugins/renderers/devices", adminMiddleware, async (c) => {
  try { return c.json({ devices: await discoverRenderers() }); }
  catch (e: any) { return c.json(apiError(BusinessErrorCode.UPSTREAM_ERROR, e.message || "errors.discovery.deviceFailed"), 500); }
});

// Scrobbler plugins (playback reporting).

app.get("/v1/plugins/scrobblers", adminMiddleware, (c) => c.json({ scrobblers: getScrobblerPlugins() }));

// ==================== Plugin marketplace (distribution registry) ====================

app.get("/v1/plugins/registry", adminMiddleware, async (c) => {
  try {
    const [sources, marketplace, groups] = await Promise.all([
      Promise.resolve(listRegistries()),
      listMarketplace(),
      collectRegistryGroups(),
    ]);
    // 注册表来源:把本次拉取的错误状态(enrich)回传给前端,让"加载失败"的注册表显式可见,
    // 而不是像以前那样整组静默消失。前端据此在市场分组里给出网络/可达性提示。
    const regError = new Map(groups.map((g) => [g.registryUrl, g.error]));
    const registries = sources.map((r) => ({ ...r, error: regError.get(r.url) || null }));
    // 市场 = 注册表插件(官方内置核心插件不在此列出,只在「已安装」tab 展示)。
    const installedRows = db.select().from(plugins).all() as any[];
    const stateById = new Map(installedRows.map((p) => [p.id, p]));
    const merged = marketplace.map((m) => {
      const row = stateById.get(m.id);
      return { ...m, installed: !!row, installedVersion: row?.version, enabled: row?.enabled ?? 0 };
    });
    return c.json({ registries, plugins: merged });
  } catch (e: any) {
    return c.json(apiError(BusinessErrorCode.UPSTREAM_ERROR, e.message || "errors.plugin.registryFetchFailed"), 500);
  }
});

app.post("/v1/plugins/registry", adminMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!body?.url) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.common.registryUrlRequired"), 400);
  try { return c.json({ id: addRegistry(body.url) }); }
  catch (e: any) { return c.json(apiError(BusinessErrorCode.UPSTREAM_ERROR, e.message || "errors.plugin.addFailed"), 400); }
});

app.delete("/v1/plugins/registry/:id", adminMiddleware, (c) => {
  removeRegistry(c.req.param("id")!);
  return c.json({ success: true });
});

app.post("/v1/plugins/registry/install", adminMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!body?.downloadUrl) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.common.downloadUrlRequired"), 400);
  try {
    const r = await installPlugin(body.downloadUrl);
    return c.json({ success: true, ...r });
  } catch (e: any) {
    return c.json(apiError(BusinessErrorCode.UPSTREAM_ERROR, e.message || "errors.plugin.installFailed"), 500);
  }
});

// ==================== Wish ====================
// ==================== Wish (paginated) ====================

app.get("/v1/plugins/:id/job", adminMiddleware, (c) => {
  const id = c.req.param("id");
  if (!id) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.plugin.idRequired"), 400);
  const state = getPluginJobState(id);
  if (!state) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.plugin.noTask"), 404);
  return c.json({ success: true, pluginId: id, running: state.running, job: state });
});

// 外部音源预探测(播放前):批量检查歌曲是否有可用音源,供播放器在切歌前
// 提前确认下一首可播(含随机播放)。本地歌曲直接 ok(不探测);web 歌曲经
// ensurePlayableStream 探测原源(Range bytes=0-20000,失败自动换源并写回 DB),
// 结果按 songId 内存缓存(playableCache/fallbackCache),短时间内不重复探测。
//   POST /v1/stream/probe  body: { songIds: string[] }(≤MAX_PROBE_BATCH=20)
//   -> { success, results: [{ songId, ok, local?, fallback?, verdict, reason? }] }
//
// `verdict` 为四态(2026-09-11 新增,与预探测调度器同一套 `getCachedPlayability` 判据):
//   playable | unplayable | transient | unknown
// 客户端**只应在 verdict==="unplayable" 时预跳**;transient(网络抖动)/unknown(未探过)
// 必须照常播放,由播放失败兜底。`ok` 字段保留(向后兼容旧客户端)。
}
