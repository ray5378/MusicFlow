// 自动生成 —— 由 index.ts 物理拆分而来（sendspin 域，18 条路由）。零逻辑改动。
import type { Hono } from "hono";
import {
  BusinessErrorCode,
  PERM,
  adminMiddleware,
  apiError,
  getCachedDevices,
  getEventManager,
  hasPerm,
  permMiddleware,
  sendspinServerOr404,
} from "./shared.js";

export function registerSendspin(app: Hono): void {
app.get("/v1/sendspin/clients", async (c) => {
  const srv = sendspinServerOr404(c);
  if (!srv) return c.json({ clients: [], enabled: false });
  const store = srv.pairingStore;
  const { getDeviceDisabled, listDisabledDeviceIds, listEsphomeCreds } = await import("../../services/sendspin/deviceState.js");
  // 6053 是每台设备各连各的:按 clientId 建「已填密钥 → 端口」索引,按 host 建桥接
  // 快照索引(remoteHost 是连接派生的,前端拿不到,所以由后端在这里替前端对齐)。
  const esphomePortByClient = new Map<string, number>(
    (listEsphomeCreds() ?? []).map((c) => [c.clientId, Number(c.port) || 6053]),
  );
  const esphomeByHost = new Map<string, any>();
  try {
    const { sendspinEsphomeStatus } = await import("../../services/sendspin/index.js");
    const st = await sendspinEsphomeStatus();
    for (const d of (st?.devices ?? []) as any[]) {
      if (d?.host) esphomeByHost.set(String(d.host), d);
    }
  } catch { /* 读不到就当都没连上,不影响设备行本身 */ }
  const live = new Set<string>();
  const clients = [...srv.clients.values()]
    .filter((conn) => !!conn.clientId)
    .map((conn) => {
      const clientId = conn.clientId!;
      live.add(clientId);
      const rec = store?.getRecord(clientId);
      return {
        clientId,
        name: conn.name || clientId,
        roles: conn.roles,
        legacy: conn.legacy,
        paired: !!rec,
        pairedAt: rec?.createdAt ?? null,
        lastUsedAt: rec?.lastUsedAt ?? null,
        approved: store?.isApproved(clientId) ?? false,
        // 与 DLNA 设备行同款:用户手动禁用(持久化),行置灰 + 「已禁用」标签。
        disabled: getDeviceDisabled(clientId),
        // 拨号来源(前端合并「已记住的播放器」列表时去重用):dialed=true 表示本连接
        // 由服务端主动拨出,host/port 即已记住的拨号目标。
        dialed: !!conn.dialed,
        host: conn.dialed ? conn.dialHost : "",
        port: conn.dialed ? conn.dialPort : 0,
        pairing: srv.pairing?.getAttempt(clientId) ?? null,
        // ESPHome 6053(设备自身音量):前端据此决定音量按钮是可用还是置灰提示。
        // ⚠️ 只回报「是否填了密钥 / 连没连上 / 设备侧真值音量」,绝不回显 PSK。
        esphome: (() => {
          const eh = esphomeByHost.get(String(conn.remoteHost || ""));
          const p0 = eh?.players?.[0];
          return {
            pskConfigured: esphomePortByClient.has(clientId),
            port: esphomePortByClient.get(clientId) ?? 6053,
            connected: !!eh?.connected,
            volume: typeof p0?.volume === "number" ? Math.round(p0.volume * 100) : null,
            muted: !!p0?.muted,
          };
        })(),
      };
    });
  // 已禁用但当前离线的设备补回列表:否则禁用(会断连接)后该设备从列表消失,
  // 用户再无入口把它启用回来。与 DLNA loadPersistedDevices 恢复禁用设备同效。
  for (const clientId of listDisabledDeviceIds()) {
    if (live.has(clientId)) continue;
    clients.push({
      clientId,
      name: clientId,
      roles: [],
      legacy: false,
      paired: !!store?.getRecord(clientId),
      pairedAt: store?.getRecord(clientId)?.createdAt ?? null,
      lastUsedAt: store?.getRecord(clientId)?.lastUsedAt ?? null,
      approved: store?.isApproved(clientId) ?? false,
      disabled: true,
      dialed: false,
      host: "",
      port: 0,
      pairing: null,
      offline: true, // 前端据此渲染为离线行(变暗 + 不显示在线专属按钮)
    } as any);
  }
  return c.json({ clients, enabled: true, port: srv.port });
});

// 禁用/启用某 Sendspin 设备(对齐 DLNA /v1/dlna/devices/:id/disabled 语义):
// 禁用 = 设备级持久偏好 → 断连接 + 停播清队列 + 移出所有群组 + 从 peer 层移除,
// 不出现在任何流转播放入口(切换器 / Flows / HA 卡片)。启用只写状态,等设备重连。

app.put("/v1/sendspin/devices/:clientId/disabled", permMiddleware(PERM.RENDERER_MANAGE), async (c) => {
  const clientId = c.req.param("clientId")!;
  if (!clientId) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.sendspin.needsClientId"), 400);
  const body = await c.req.json().catch(() => ({} as any));
  const disabled = !!body?.disabled;
  const { sendspinSetDisabled } = await import("../../services/sendspin/index.js");
  const ok = await sendspinSetDisabled(clientId, disabled);
  if (!ok) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.renderer.deviceNotFound"), 404);
  // 广播设备列表变化(WS → 卡片 / Web 刷新),与 DLNA 端点同款。
  try { getEventManager().emitDeviceListChanged(getCachedDevices().length); } catch { /* ignore */ }
  return c.json({ success: true, disabled });
});

// ==================== ESPHome 6053(每台设备各自一把密钥)====================
//
// 背景:ESPHome 每台设备的 `api.encryption.key` 都是各自生成的,一把全局密钥只能
// 连上一台;早期版本还把「测试连接」实现成取「任意一台已连设备的 IP」,于是填 A 的
// 密钥却拿 B 的门去试,必然 auth 失败。现全部下放到**设备行**:
//  - 前端只认 clientId(host 会随 DHCP 变,不该由前端持有);
//  - host 由后端从当前连接派生(resolveEsphomeHost);
//  - 密钥/端口按 clientId 落库(sendspin_device_state)。
//
// 作用有两个:①读设备侧 media_player 真值(「推的流有没有真的在播」的独立判据
// + 音量回显);②写**设备自身**音量(speaker 硬件输出)。注意这与音乐采样增益
// (Sendspin group volume,见 POST /v1/peers/:peerId/volume)是**两个旋钮**,
// 实际响度 = 两者相乘,所以 UI 上分开,不要合并。

/** 某一台设备的 6053 状态 + 已保存的密钥(供弹窗回显、便于核对与复制)。
 *
 *  🔐 回显分级:明文 `psk` **只回给有 RENDERER_MANAGE 的账号**(管理员恒有),
 *  其余账号只拿到 `pskConfigured` 布尔值、`psk` 为 null。
 *  理由:这把密钥等价于设备的第二把钥匙(拿到即可直连 6053 控制设备),
 *  而普通账号本来就没有管理权限、弹窗里密钥框也是禁用的 —— 没必要给它明文。
 *
 *  设备列表端点(/v1/sendspin/clients)**始终不回显** —— 一次列表就把所有设备的
 *  密钥全吐出去毫无必要,弹窗按需单取一台即可。 */

app.get("/v1/sendspin/devices/:clientId/esphome", async (c) => {
  const clientId = c.req.param("clientId")!;
  if (!clientId) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.sendspin.needsClientId"), 400);
  const { getDeviceEsphome } = await import("../../services/sendspin/deviceState.js");
  const { sendspinGetEsphomeVolume } = await import("../../services/sendspin/index.js");
  const creds = getDeviceEsphome(clientId);
  const v = await sendspinGetEsphomeVolume(clientId);
  const user = c.get("user");
  const canReadKey = hasPerm(user?.id ?? "", !!user?.isAdmin, PERM.RENDERER_MANAGE);
  return c.json({
    pskConfigured: !!creds.psk,
    psk: canReadKey ? creds.psk : null,
    port: creds.port || 6053,
    connected: !!v,
    volume: v?.volume ?? null,
    muted: v?.muted ?? false,
  });
});

/** 保存某台设备的 6053 密钥/端口。
 *  psk 传空串 = 撤销这一台(断开并停止保活),不影响其它设备。 */

app.put("/v1/sendspin/devices/:clientId/esphome", permMiddleware(PERM.RENDERER_MANAGE), async (c) => {
  const clientId = c.req.param("clientId")!;
  if (!clientId) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.sendspin.needsClientId"), 400);
  const body = await c.req.json().catch(() => ({} as any));
  const psk = typeof body?.psk === "string" ? body.psk.trim() : "";
  const portRaw = Number(body?.port);
  const port = Number.isInteger(portRaw) && portRaw >= 1 && portRaw <= 65535 ? portRaw : 0;
  const { sendspinSaveEsphomeCreds } = await import("../../services/sendspin/index.js");
  const r = await sendspinSaveEsphomeCreds(clientId, psk, port);
  // host 为空 = 设备当前离线:密钥已落库,等它下次重连时 registerServerPlayer 自动带上。
  return c.json({ success: true, host: r.host, online: !!r.host });
});

/** 一次性握手探针:用**这台设备此刻填的**密钥立即验证。
 *  刻意不落库、也不复用常驻桥接 —— 测试不该改变常态连接,失败了也不留残余。
 *  body.psk 传空串(显式清空未保存就走测试)⇒ 按 no_psk 失败,不回落库里的旧密钥。 */

app.post("/v1/sendspin/devices/:clientId/esphome/test", permMiddleware(PERM.RENDERER_MANAGE), async (c) => {
  const clientId = c.req.param("clientId")!;
  if (!clientId) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.sendspin.needsClientId"), 400);
  const body = await c.req.json().catch(() => ({} as any));
  const { getDeviceEsphome } = await import("../../services/sendspin/deviceState.js");
  const { resolveEsphomeHost } = await import("../../services/sendspin/index.js");
  const { probeEsphome, ESPHOME_API_PORT } = await import("../../services/sendspin/esphomeBridge.js");
  const creds = getDeviceEsphome(clientId);
  const psk = typeof body?.psk === "string" ? body.psk.trim() : creds.psk;
  const portRaw = Number(body?.port);
  const port = Number.isInteger(portRaw) && portRaw >= 1 && portRaw <= 65535
    ? portRaw
    : (creds.port || ESPHOME_API_PORT);
  // host 由连接派生:设备离线时是空串,探针会以 no_host 失败(而不是去试别人的 IP)。
  const host = resolveEsphomeHost(clientId);
  const r = await probeEsphome(host, psk, port, 10_000);
  // 失败不 5xx:这是「测试」语义,把原因交给前端展示。
  return c.json(r);
});

/** 写**设备自身**音量(0..100,speaker 硬件输出)。
 *  失败不 5xx:返回机器可读 code(no-bridge / not-connected / no-entity /
 *  send-failed),由前端映射提示文案 —— 后端不写死语言。 */

app.put("/v1/sendspin/devices/:clientId/esphome/volume", async (c) => {
  const clientId = c.req.param("clientId")!;
  if (!clientId) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.sendspin.needsClientId"), 400);
  const { volume } = await c.req.json().catch(() => ({} as any));
  if (typeof volume !== "number" || !Number.isFinite(volume)) {
    return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.needsVolume"), 400);
  }
  const v = Math.min(100, Math.max(0, Math.round(volume)));
  const { sendspinSetEsphomeVolume } = await import("../../services/sendspin/index.js");
  const r = await sendspinSetEsphomeVolume(clientId, v);
  return c.json({ success: r.ok, code: r.code, sent: r.sent, volume: v });
});

/** 写**设备自身**静音(同上)。 */

app.put("/v1/sendspin/devices/:clientId/esphome/muted", async (c) => {
  const clientId = c.req.param("clientId")!;
  if (!clientId) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.sendspin.needsClientId"), 400);
  const { muted } = await c.req.json().catch(() => ({} as any));
  if (typeof muted !== "boolean") {
    return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.needsMuted"), 400);
  }
  const { sendspinSetEsphomeMuted } = await import("../../services/sendspin/index.js");
  const r = await sendspinSetEsphomeMuted(clientId, muted);
  return c.json({ success: r.ok, code: r.code, sent: r.sent, muted });
});

/** 聚合快照(排障用):每台**填了密钥**的设备各自的桥接状态。
 *  ⚠️ 无全局开关/密钥 —— 填了密钥就连,没填就不连。 */

app.get("/v1/sendspin/esphome", async (c) => {
  const { sendspinEsphomeStatus } = await import("../../services/sendspin/index.js");
  const st = await sendspinEsphomeStatus();
  return c.json({ devices: st.devices });
});

app.get("/v1/sendspin/pairing/attempts", adminMiddleware, async (c) => {
  const srv = sendspinServerOr404(c);
  if (!srv) return c.json({ attempts: [], enabled: false });
  return c.json({ attempts: srv.pairing?.listAttempts() ?? [], enabled: true });
});

app.post("/v1/sendspin/pairing/start", adminMiddleware, async (c) => {
  const srv = sendspinServerOr404(c);
  if (!srv?.pairing) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.sendspin.notEnabled"), 404);
  const body = await c.req.json().catch(() => ({} as any));
  const { clientId, method, format } = body;
  if (typeof clientId !== "string" || !clientId) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.sendspin.needsClientId"), 400);
  if (format !== undefined && format !== "digits" && format !== "qr_code") {
    return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.sendspin.badFormat"), 400);
  }
  try {
    await srv.pairing.start(clientId, method, format ?? "digits");
    return c.json({ success: true });
  } catch (e: any) {
    return c.json(apiError(BusinessErrorCode.UPSTREAM_ERROR, e.message || "errors.sendspin.pairStartFailed"), 500);
  }
});

app.post("/v1/sendspin/pairing/code", adminMiddleware, async (c) => {
  const srv = sendspinServerOr404(c);
  if (!srv?.pairing) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.sendspin.notEnabled"), 404);
  const body = await c.req.json().catch(() => ({} as any));
  const { clientId, code } = body;
  if (typeof clientId !== "string" || !clientId || typeof code !== "string" || !code) {
    return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.sendspin.needsClientIdAndCode"), 400);
  }
  try {
    await srv.pairing.enterCode(clientId, code);
    return c.json({ success: true });
  } catch (e: any) {
    return c.json(apiError(BusinessErrorCode.UPSTREAM_ERROR, e.message || "errors.sendspin.codeFailed"), 500);
  }
});

app.post("/v1/sendspin/pairing/token", adminMiddleware, async (c) => {
  const srv = sendspinServerOr404(c);
  if (!srv?.pairing) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.sendspin.notEnabled"), 404);
  const body = await c.req.json().catch(() => ({} as any));
  const { clientId, token } = body;
  if (typeof clientId !== "string" || !clientId || typeof token !== "string" || !token) {
    return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.sendspin.needsClientIdAndToken"), 400);
  }
  try {
    await srv.pairing.pairWithToken(clientId, token);
    return c.json({ success: true });
  } catch (e: any) {
    return c.json(apiError(BusinessErrorCode.UPSTREAM_ERROR, e.message || "errors.sendspin.tokenFailed"), 500);
  }
});

app.post("/v1/sendspin/pairing/cancel", adminMiddleware, async (c) => {
  const srv = sendspinServerOr404(c);
  if (!srv?.pairing) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.sendspin.notEnabled"), 404);
  const body = await c.req.json().catch(() => ({} as any));
  const { clientId } = body;
  if (typeof clientId !== "string" || !clientId) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.sendspin.needsClientId"), 400);
  srv.pairing.cancel(clientId);
  return c.json({ success: true });
});

app.post("/v1/sendspin/approve", adminMiddleware, async (c) => {
  const srv = sendspinServerOr404(c);
  if (!srv?.pairingStore) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.sendspin.notEnabled"), 404);
  const body = await c.req.json().catch(() => ({} as any));
  const { clientId, approved } = body;
  if (typeof clientId !== "string" || !clientId) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.sendspin.needsClientId"), 400);
  await srv.pairingStore.setApproved(clientId, approved !== false);
  return c.json({ success: true });
});

// 服务端主动拨号:给监听中的播放器(:8928)打过去(见 spec server-initiated)。
// Body: { host: "192.168.1.50", port?: 8928 }。走完全套 Noise+激活,成功即注册 peer。

app.post("/v1/sendspin/dial", adminMiddleware, async (c) => {
  const srv = sendspinServerOr404(c);
  if (!srv) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.sendspin.notEnabled"), 404);
  const body = await c.req.json().catch(() => ({} as any));
  const host = typeof body.host === "string" ? body.host.trim() : "";
  const port = body.port === undefined ? 8928 : Number(body.port);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.sendspin.badDialTarget"), 400);
  }
  if (/[^a-zA-Z0-9.\-_:]/.test(host)) {
    return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.sendspin.badDialTarget"), 400);
  }
  try {
    const conn = await srv.dialPlayer(`ws://${host}:${port}/sendspin`);
    // 手动拨号 = 运营商明确意图:清除自动重拨抑制(another_server 等拒绝过)。
    srv.clearNoRedial(host, port);
    try {
      const { rememberDialTarget } = await import("../../services/sendspin/index.js");
      await rememberDialTarget(host, port);
    } catch { /* 记住失败不影响已建连接 */ }
    return c.json({ success: true, clientId: conn.clientId, name: conn.name });
  } catch (e: any) {
    return c.json(apiError(BusinessErrorCode.UPSTREAM_ERROR, e.message || "errors.sendspin.dialFailed"), 500);
  }
});

// 记住的拨号目标:重启/掉线自动重拨。GET 带在线状态;DELETE 忘记(在线则一并断开)。

app.get("/v1/sendspin/dial-targets", adminMiddleware, async (c) => {
  const srv = sendspinServerOr404(c);
  if (!srv) return c.json({ targets: [], enabled: false });
  const { listDialTargets } = await import("../../services/sendspin/index.js");
  const online = new Set(
    [...srv.clients.values()]
      .filter((conn) => conn.dialed && conn.clientId)
      .map((conn) => `${conn.dialHost}:${conn.dialPort}`),
  );
  return c.json({
    enabled: true,
    targets: (await listDialTargets()).map((t) => ({ ...t, online: online.has(`${t.host}:${t.port}`) })),
  });
});

app.delete("/v1/sendspin/dial-targets", adminMiddleware, async (c) => {
  const srv = sendspinServerOr404(c);
  if (!srv) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.sendspin.notEnabled"), 404);
  const body = await c.req.json().catch(() => ({} as any));
  const { host, port } = body;
  if (typeof host !== "string" || !host || !Number.isInteger(port)) {
    return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.sendspin.badDialTarget"), 400);
  }
  const { forgetDialTarget } = await import("../../services/sendspin/index.js");
  const ok = await forgetDialTarget(host, port);
  if (!ok) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.sendspin.noSuchTarget"), 404);
  return c.json({ success: true });
});

app.post("/v1/sendspin/unpair", adminMiddleware, async (c) => {
  const srv = sendspinServerOr404(c);
  if (!srv?.pairingStore) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.sendspin.notEnabled"), 404);
  const body = await c.req.json().catch(() => ({} as any));
  const { clientId } = body;
  if (typeof clientId !== "string" || !clientId) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.sendspin.needsClientId"), 400);
  // 解绑即断开该客户端现存连接(连接归 sendspin 子进程管,fork 模式经 RPC 一并处理)。
  const { sendspinUnpair } = await import("../../services/sendspin/index.js");
  await sendspinUnpair(clientId);
  return c.json({ success: true });
});

// Set the play mode (order | one | all | shuffle) for a device's queue.
// Body: { mode: PlayMode }
}
