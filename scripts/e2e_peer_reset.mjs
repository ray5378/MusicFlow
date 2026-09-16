// 后端直连 L0 实测:播放端「彻底重置」全链路。
//
// 场景复刻用户反馈:流转播放把 A 拖到 B / 回收站销毁 A 之后,源端 A 仍被
// GET /status 报成「在播某一首」。本脚本对**真实起在 46400 的服务端**跑一遍:
//   注册 A → 灌队列 → 上报 PLAYING(+songId) → 断言确实「在播」
//   → POST /reset → 断言队列空 / 运行态清 / playMode 保留 / peer 保留 / 幂等 / 非法 id 400
//
// 用法(服务端已用隔离 DATA_DIR 起在 46400):
//   node tool/e2e_peer_reset.mjs
const BASE = process.env.MF_BASE || "http://127.0.0.1:46400";
const CLIENT_A = "e2e-src-aaaa";
const CLIENT_B = "e2e-dst-bbbb";

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${extra ? ` -> ${JSON.stringify(extra)}` : ""}`);
  }
}

async function call(method, path, { token, clientId, body } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (clientId) headers["x-mf-client-id"] = clientId;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, body: json };
}

const pe = (id) => encodeURIComponent(id);
const item = (id, title) => ({ songId: id, title, mime: "audio/mpeg", duration: 100 });

async function main() {
  console.log(`== MusicFlow 后端 L0 实测 @ ${BASE} ==`);

  // 1. 登录(隔离 DATA_DIR 里是默认的 admin/admin)
  const login = await call("POST", "/rest/api/v1/auth/login", {
    body: { username: "admin", password: "admin" },
  });
  const token = login.body?.token || login.body?.accessToken;
  ok("登录拿到 token", !!token, { status: login.status, body: login.body });
  if (!token) process.exit(1);

  // 2. 注册源端 A
  const reg = await call("POST", "/rest/api/v1/peers/register", {
    token,
    clientId: CLIENT_A,
    body: { clientId: CLIENT_A },
  });
  const peerA = reg.body?.peer?.peerId;
  ok("注册源端 A", !!peerA && String(peerA).startsWith("local:"), reg.body);
  if (!peerA) process.exit(1);
  console.log(`  [A] peerId = ${peerA}`);

  // 3. A 灌队列 + 设置 playMode(用户设定,后面的断言要它活下来)
  const q = await call("POST", `/rest/api/v1/peers/${pe(peerA)}/queue/play`, {
    token,
    clientId: CLIENT_A,
    body: { items: [item("s1", "一"), item("s2", "二")], startIndex: 1 },
  });
  // 注意:`queue/play` 只回 {"success":true},不带 items —— 必须用 GET /queue 复查,
  // 否则「灌队列」这一步的断言会假失败(实测踩过)。
  const qBefore = await call("GET", `/rest/api/v1/peers/${pe(peerA)}/queue`, {
    token,
    clientId: CLIENT_A,
  });
  ok("A 灌入 2 首队列", (qBefore.body?.items || []).length === 2, qBefore.body);
  ok("重置前 A 游标 = 1", qBefore.body?.currentIndex === 1, qBefore.body);

  await call("POST", `/rest/api/v1/peers/${pe(peerA)}/play-mode`, {
    token,
    clientId: CLIENT_A,
    body: { mode: "shuffle" },
  });

  // 4. A 上报「在播」(客户端 4s 周期的 /local-status)
  await call("POST", `/rest/api/v1/peers/${pe(peerA)}/local-status`, {
    token,
    clientId: CLIENT_A,
    body: { state: "PLAYING", position: 33, duration: 200, volume: 50, songId: "s2" },
  });

  // 5. 重置前:确认「脏」确实存在 —— 这是 bug 的现场
  const before = await call("GET", `/rest/api/v1/peers/${pe(peerA)}/status`, {
    token,
    clientId: CLIENT_A,
  });
  ok("重置前 A 被报成在播", before.body?.state === "PLAYING", before.body);
  ok("重置前 A 带 songId", before.body?.media?.songId === "s2", before.body?.media);

  // 6. 关键一步:彻底重置
  const rst = await call("POST", `/rest/api/v1/peers/${pe(peerA)}/reset`, {
    token,
    clientId: CLIENT_A,
  });
  ok("POST /reset 返回 200", rst.status === 200, rst.body);
  ok("POST /reset success", rst.body?.success === true, rst.body);

  // 7. 队列实体清空
  const afterQ = await call("GET", `/rest/api/v1/peers/${pe(peerA)}/queue`, {
    token,
    clientId: CLIENT_A,
  });
  ok("重置后队列 items 为空", (afterQ.body?.items || []).length === 0, afterQ.body);
  ok("重置后游标 currentIndex = -1", afterQ.body?.currentIndex === -1, afterQ.body);
  ok("重置后 isActive = false", afterQ.body?.isActive === false, afterQ.body);

  // 8. 运行态清空 —— 本次修复的核心
  const afterS = await call("GET", `/rest/api/v1/peers/${pe(peerA)}/status`, {
    token,
    clientId: CLIENT_A,
  });
  ok("重置后 /status 无 state(不再被报成在播)", afterS.body?.state === undefined, afterS.body);
  ok("重置后 /status 无 media/songId", afterS.body?.media === undefined, afterS.body);

  // 9. 客户端照常 4s 上报 STOPPED,不能把旧 songId 带回来
  await call("POST", `/rest/api/v1/peers/${pe(peerA)}/local-status`, {
    token,
    clientId: CLIENT_A,
    body: { state: "STOPPED", position: 0 },
  });
  const afterStop = await call("GET", `/rest/api/v1/peers/${pe(peerA)}/status`, {
    token,
    clientId: CLIENT_A,
  });
  ok("STOPPED 上报后不回魂 songId", afterStop.body?.media === undefined, afterStop.body);

  // 10. 保留项:playMode 与 peer 注册
  ok("playMode 保留为 shuffle", afterQ.body?.playMode === "shuffle", afterQ.body?.playMode);
  const stillThere = await call("GET", `/rest/api/v1/peers/${pe(peerA)}`, {
    token,
    clientId: CLIENT_A,
  });
  ok("peer 注册仍在(销毁不注销)", stillThere.status === 200 && !!stillThere.body?.peer, {
    status: stillThere.status,
  });

  // 11. 幂等 + 参数边界
  const again = await call("POST", `/rest/api/v1/peers/${pe(peerA)}/reset`, {
    token,
    clientId: CLIENT_A,
  });
  ok("重复重置幂等(仍 200)", again.status === 200, again.body);
  const bad = await call("POST", "/rest/api/v1/peers/not-a-valid-peer-id/reset", {
    token,
    clientId: CLIENT_A,
  });
  ok("非法 peerId → 400", bad.status === 400, { status: bad.status, body: bad.body });

  // 12. 目标端 B 不受影响(重置只针对源端)
  const regB = await call("POST", "/rest/api/v1/peers/register", {
    token,
    clientId: CLIENT_B,
    body: { clientId: CLIENT_B },
  });
  const peerB = regB.body?.peer?.peerId;
  await call("POST", `/rest/api/v1/peers/${pe(peerB)}/queue/play`, {
    token,
    clientId: CLIENT_B,
    body: { items: [item("s9", "目标端曲")], startIndex: 0 },
  });
  await call("POST", `/rest/api/v1/peers/${pe(peerA)}/reset`, { token, clientId: CLIENT_A });
  const bAfter = await call("GET", `/rest/api/v1/peers/${pe(peerB)}/queue`, {
    token,
    clientId: CLIENT_B,
  });
  ok("重置 A 不会误伤 B 的队列", (bAfter.body?.items || []).length === 1, bAfter.body);

  console.log(`\n== 结果:${pass} 通过 / ${fail} 失败 ==`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("E2E 脚本异常:", e);
  process.exit(1);
});
