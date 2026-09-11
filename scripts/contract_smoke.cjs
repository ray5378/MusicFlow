// 播放端契约冒烟(CI 门禁用,与 MusicFlow-client 的 Dart 契约测试配对)。
// 锁定「临时端 ID 只在服务端 + 各端只见自己 + 队列按实例隔离 + 心跳复活 + 老端兼容」。
// 用法:先起一个隔离实例(DATA_DIR 指向临时目录),再跑本脚本:
//   DATA_DIR=$(mktemp -d) PORT=46999 node dist/index.js &
//   MF_BASE=http://127.0.0.1:46999 node scripts/contract_smoke.cjs
const BASE = process.env.MF_BASE || "http://127.0.0.1:46999";

let failures = 0;
const assert = (cond, msg) => {
  if (cond) console.log("  PASS  " + msg);
  else { failures++; console.error("  FAIL  " + msg); }
};

async function call(path, { token, clientId, method = "GET", body } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = "Bearer " + token;
  if (clientId) headers["x-mf-client-id"] = clientId;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

const item = (id, title) => ({ songId: id, title, artist: "test", duration: 180, mime: "audio/mpeg" });

(async () => {
  console.log(`\n== MusicFlow 播放端隔离冒烟 @ ${BASE} ==\n`);

  // --- 登录 ---
  const login = await call("/rest/api/v1/auth/login", {
    method: "POST",
    body: { username: process.env.MF_USER || "admin", password: process.env.MF_PASS || "admin" },
  });
  const token = login.body?.token || login.body?.accessToken || login.body?.data?.token;
  if (!token) {
    console.error("登录失败,响应:", login.status, JSON.stringify(login.body).slice(0, 400));
    process.exit(2);
  }
  console.log("登录成功,token 已获取\n");

  const A = "web-aaaaaa";
  const B = "web-bbbbbb";

  // --- 1. 两个客户端实例各自注册 ---
  console.log("[1] 注册两个客户端实例");
  const regA = await call("/rest/api/v1/peers/register", { token, clientId: A, method: "POST", body: { name: "webA" } });
  const regB = await call("/rest/api/v1/peers/register", { token, clientId: B, method: "POST", body: { name: "webB" } });
  assert(regA.status === 200 && regB.status === 200, "两端注册均 200");
  const pidA = regA.body?.peer?.peerId;
  const pidB = regB.body?.peer?.peerId;
  assert(typeof pidA === "string" && pidA.startsWith("local:"), `A 返回 peerId = ${pidA}`);
  assert(typeof pidB === "string" && pidB.startsWith("local:"), `B 返回 peerId = ${pidB}`);
  // 关键:响应里绝不能出现临时端 ID。
  const noTempId = !String(pidA).includes(A) && !String(pidB).includes(B)
    && !String(pidA).includes(B) && !String(pidB).includes(A);
  assert(noTempId, `响应 peerId 已打码,不含临时端 ID(${pidA} / ${pidB})`);
  assert(pidA === pidB, "两端拿到的对外 peerId 完全一致(对客户端透明)");

  // --- 2. 两端各自灌入不同队列 ---
  console.log("\n[2] 两端灌入不同队列(旧行为:后写覆盖前写)");
  await call(`/rest/api/v1/peers/${encodeURIComponent(pidA)}/queue/play`, {
    token, clientId: A, method: "POST",
    body: { items: [item("songA1", "A-one"), item("songA2", "A-two")], startIndex: 1 },
  });
  await call(`/rest/api/v1/peers/${encodeURIComponent(pidB)}/queue/play`, {
    token, clientId: B, method: "POST",
    body: { items: [item("songB1", "B-one")], startIndex: 0 },
  });
  await call(`/rest/api/v1/peers/${encodeURIComponent(pidA)}/play-mode`, { token, clientId: A, method: "POST", body: { mode: "shuffle" } });

  // --- 3. 各端只看到自己那条 ---
  console.log("\n[3] /v1/peers 只回自己那一条本机播放器");
  const peersA = await call("/rest/api/v1/peers", { token, clientId: A });
  const peersB = await call("/rest/api/v1/peers", { token, clientId: B });
  const localsA = (peersA.body?.peers || []).filter((p) => p.kind === "local");
  const localsB = (peersB.body?.peers || []).filter((p) => p.kind === "local");
  assert(localsA.length === 1, `A 看到 ${localsA.length} 个本机播放器(应为 1)`);
  assert(localsB.length === 1, `B 看到 ${localsB.length} 个本机播放器(应为 1)`);

  // --- 4. 队列互不覆盖(核心诉求) ---
  console.log("\n[4] 队列按端隔离(互不覆盖)");
  const qA = await call(`/rest/api/v1/peers/${encodeURIComponent(pidA)}/queue`, { token, clientId: A });
  const qB = await call(`/rest/api/v1/peers/${encodeURIComponent(pidB)}/queue`, { token, clientId: B });
  const aTitles = (qA.body?.items || []).map((i) => i.title);
  const bTitles = (qB.body?.items || []).map((i) => i.title);
  assert(JSON.stringify(aTitles) === JSON.stringify(["A-one", "A-two"]), `A 队列 = ${JSON.stringify(aTitles)}`);
  assert(JSON.stringify(bTitles) === JSON.stringify(["B-one"]), `B 队列 = ${JSON.stringify(bTitles)}`);
  assert(qA.body?.currentIndex === 1 && qB.body?.currentIndex === 0, "两端游标各自独立");
  assert(qA.body?.playMode === "shuffle", `A 的播放模式保留 = ${qA.body?.playMode}`);

  // --- 5. 心跳就地复活(服务端重启后客户端无需手动重注册) ---
  console.log("\n[5] 心跳可达(服务端重启后的自动复活路径)");
  const hb = await call(`/rest/api/v1/peers/${encodeURIComponent(pidA)}/heartbeat`, { token, clientId: A, method: "POST" });
  assert(hb.status === 200 && hb.body?.success === true, `心跳返回 success=${hb.body?.success}`);

  // --- 6. 不带临时端 ID 的老客户端 → 只看旧格式,看不到新端的行 ---
  console.log("\n[6] 老客户端(不带临时端 ID)行为");
  const peersLegacy = await call("/rest/api/v1/peers", { token });
  const localsLegacy = (peersLegacy.body?.peers || []).filter((p) => p.kind === "local");
  assert(localsLegacy.length === 0, `老客户端看不到新格式的端(${localsLegacy.length} 个,应为 0)`);

  console.log(`\n== 结果:${failures === 0 ? "全部通过" : failures + " 项失败"} ==\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error("脚本异常:", e); process.exit(3); });
