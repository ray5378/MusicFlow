// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { db, initDatabase } from "../../src/db/index.js";
import { setSetting } from "../../src/services/settings.js";
import {
  normalizeProxyUrl,
  getProxyConfig,
  testProxyConnection,
  __setProxyTestTargets,
} from "../../src/services/proxy.js";

// 自签证书用于本地 HTTPS 目标(模拟 GitHub raw)。测试环境关闭证书校验。
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

let certDir: string;
let keyPem: string;
let certPem: string;
let targetPort = 0;
let httpsTarget: https.Server;
let connectProxyPort = 0;
let connectProxy: http.Server;
let socksPort = 0;
let socksServer: net.Server;

function startHttpsTarget(): Promise<void> {
  return new Promise((resolve) => {
    httpsTarget = https.createServer({ key: keyPem, cert: certPem }, (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ plugins: [] }));
    });
    httpsTarget.listen(0, "127.0.0.1", () => {
      targetPort = (httpsTarget.address() as any).port;
      resolve();
    });
  });
}

// 真实 HTTP CONNECT 代理(Node http.Server 的 CONNECT 走 'connect' 事件)
function startConnectProxy(): Promise<void> {
  return new Promise((resolve) => {
    connectProxy = http.createServer();
    connectProxy.on("connect", (req, clientSocket) => {
      const [host, port] = (req.url || "").split(":");
      const upstream = net.connect(Number(port), host, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on("error", () => clientSocket.destroy());
      clientSocket.on("error", () => upstream.destroy());
    });
    connectProxy.listen(0, "127.0.0.1", () => {
      connectProxyPort = (connectProxy.address() as any).port;
      resolve();
    });
  });
}

// 极简 SOCKS5 代理(仅实现无鉴权 CONNECT)，用于验证 Socks5ProxyAgent 整链。
function startSocks5Proxy(): Promise<void> {
  return new Promise((resolve) => {
    socksServer = net.createServer((client) => {
      client.once("data", () => {
        client.write(Buffer.from([0x05, 0x00])); // 无需鉴权
        client.once("data", (reqBuf) => {
          const atyp = reqBuf[3];
          let host = "";
          let offset = 4;
          if (atyp === 0x01) {
            host = `${reqBuf[4]}.${reqBuf[5]}.${reqBuf[6]}.${reqBuf[7]}`;
            offset = 8;
          } else if (atyp === 0x03) {
            const len = reqBuf[4];
            host = reqBuf.slice(5, 5 + len).toString();
            offset = 5 + len;
          }
          const port = reqBuf.readUInt16BE(offset);
          const upstream = net.connect(port, host, () => {
            client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            upstream.pipe(client);
            client.pipe(upstream);
          });
          upstream.on("error", () => client.destroy());
          client.on("error", () => upstream.destroy());
        });
      });
    });
    socksServer.listen(0, "127.0.0.1", () => {
      socksPort = (socksServer.address() as any).port;
      resolve();
    });
  });
}

beforeAll(async () => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();

  // 生成自签证书
  certDir = fs.mkdtempSync(path.join(os.tmpdir(), "mf-proxy-"));
  const k = path.join(certDir, "k.pem");
  const c = path.join(certDir, "c.pem");
  execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout "${k}" -out "${c}" -days 365 -subj "/CN=localhost"`, {
    stdio: "ignore",
  });
  keyPem = fs.readFileSync(k, "utf8");
  certPem = fs.readFileSync(c, "utf8");

  await startHttpsTarget();
  await startConnectProxy();
  await startSocks5Proxy();

  // 让 testProxyConnection 探测本地目标，而非真实 GitHub(离线可复现)
  __setProxyTestTargets(`https://127.0.0.1:${targetPort}/registry.json`);
}, 30_000);

afterAll(() => {
  httpsTarget?.close();
  connectProxy?.close();
  socksServer?.close();
  if (certDir) fs.rmSync(certDir, { recursive: true, force: true });
});

describe("normalizeProxyUrl / getProxyConfig", () => {
  it("getProxyConfig: 合法 http 地址 → enabled true", () => {
    setSetting("proxy_enabled", "true");
    setSetting("proxy_url", "http://127.0.0.1:7890");
    expect(getProxyConfig()).toEqual({ enabled: true, url: "http://127.0.0.1:7890" });
  });
  it("getProxyConfig: socks5 地址 → enabled true(此前被拒,导致测试恒失败)", () => {
    setSetting("proxy_enabled", "true");
    setSetting("proxy_url", "socks5://127.0.0.1:1080");
    expect(getProxyConfig()).toEqual({ enabled: true, url: "socks5://127.0.0.1:1080" });
  });
});

describe("testProxyConnection 完整链路(经真实代理)", () => {
  it("HTTP 代理: 经本地 CONNECT 代理访问本地 HTTPS 目标 → success", async () => {
    setSetting("proxy_enabled", "true");
    setSetting("proxy_url", `http://127.0.0.1:${connectProxyPort}`);
    const r = await testProxyConnection();
    expect(r.success).toBe(true);
    expect(r.githubReachable).toBe(true);
    expect(r.probes[0].ok).toBe(true);
    expect(r.probes[0].url).toBe(`https://127.0.0.1:${targetPort}/registry.json`);
  });

  it("SOCKS5 代理: 经本地 SOCKS5 代理访问本地 HTTPS 目标 → success", async () => {
    setSetting("proxy_enabled", "true");
    setSetting("proxy_url", `socks5://127.0.0.1:${socksPort}`);
    const r = await testProxyConnection();
    expect(r.success).toBe(true);
    expect(r.githubReachable).toBe(true);
  });

  it("代理未启用 → success false 且提示未配置", async () => {
    setSetting("proxy_enabled", "false");
    setSetting("proxy_url", "");
    const r = await testProxyConnection();
    expect(r.success).toBe(false);
    expect(r.githubReachable).toBeNull();
    expect(r.message).toContain("未启用");
  });

  it("代理地址指向死亡端口 → success false 且提示连接失败", async () => {
    setSetting("proxy_enabled", "true");
    setSetting("proxy_url", "http://127.0.0.1:1"); // 极不可能有服务
    const r = await testProxyConnection();
    expect(r.success).toBe(false);
    expect(r.message).toContain("代理服务器连接失败");
  });
});
