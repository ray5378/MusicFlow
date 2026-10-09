// QQ 扫码改版(ptlogin2 通道,go-music-dl 蓝本)+ 前端弹窗接线的源码级守卫测试。
// 前端无单测运行器(SPEC §九1 禁新增 devDependency),组件行为用「源码接线断言 +
// check-frontend-no-qr 守卫 + npm run build」组合覆盖(T05 qrAction 同款模式)。
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
// 插件仓与主仓分仓:主仓 CI 不检出插件仓,文件缺失时跳过断言(230 联调机全量跑)。
const readSibling = (rel: string) => {
  try {
    return readFileSync(join(ROOT, "..", "MusicFlow-plugins", rel), "utf8");
  } catch {
    return "";
  }
};

describe("QrLoginDialog v4.3.2 接线(params 透传 + 状态回显 + 成功昵称)", () => {
  const dialog = read("frontend/src/components/QrLoginDialog.vue");
  const index = read("frontend/src/views/admin/Plugins/index.vue");

  it("弹窗声明 params prop 并在 start/poll/cancel 全程合并透传", () => {
    expect(dialog).toContain("params?: Record<string, unknown> | null");
    // actionParams 统一合并(args 在前、sessionKey 不可被覆盖),三个调用点都要走它
    expect(dialog).toContain("function actionParams(");
    expect(dialog).toContain("callAction(props.method, actionParams())");
    expect(dialog).toContain('callAction("pollBind", actionParams({ sessionKey }))');
    expect(dialog).toContain('callAction("cancelBind", actionParams({ sessionKey }))');
  });

  it("绑定状态行:boundAccount/authValid 直显,null 不给判定(探测失败≠失效)", () => {
    expect(dialog).toContain("payload.boundAccount");
    expect(dialog).toContain("authValid !== null");
    expect(dialog).toContain("qrBoundAccount");
    expect(dialog).toContain("qrAuthInvalid");
  });

  it("800 成功显示登录昵称(qrSuccessAs)后自动关弹窗", () => {
    expect(dialog).toContain("qrSuccessAs");
    expect(dialog).toContain("successTimer = setTimeout(");
  });

  it("配置页把 manifest action 字段的 args 传给弹窗", () => {
    expect(index).toContain('qrParams.value = f.args && typeof f.args === "object" ? { ...f.args } : null');
    expect(index).toContain(':params="qrParams"');
  });

  it("零 QR 编码逻辑仍成立(不出现编码器导入/dataURL 自拼)", () => {
    expect(dialog).not.toMatch(/qrToSvg|qrcode\.js|data:image\/svg\+xml/);
  });
});

describe("ptlogin2 通道配套机制", () => {
  it("types.ts ConfigField 增加可选 args 注记", () => {
    expect(read("backend/src/plugins/types.ts")).toContain("args?: Record<string, string>");
  });

  it("discovery.ts pluginHttp 支持 base64 二进制 opt-in(PNG 通道,latin1 会被沙箱桥 U+0000 截断)", () => {
    expect(read("backend/src/plugins/discovery.ts")).toContain('encoding === "base64"');
    expect(read("backend/src/plugins/discovery.ts")).not.toContain('encoding === "latin1"');
  });

  it("pluginHttp 多条 Set-Cookie 不可覆盖(逐条追加合并)", () => {
    const disc = read("backend/src/plugins/discovery.ts");
    expect(disc).toContain('headers[k] = headers[k] ? headers[k] + ", " + v : v;');
  });
});

describe("status 第四方法(配置页常驻绑定状态块)", () => {
  const index = read("frontend/src/views/admin/Plugins/index.vue");
  it("qrAction 白名单扩为 4 方法(含 status)", () => {
    expect(read("backend/src/plugins/qrAction.ts")).toContain(
      'export const QR_ACTION_METHODS = ["startBind", "pollBind", "cancelBind", "status"] as const;'
    );
  });

  it("sandbox CAP_METHODS.qrLogin 与白名单同步(含 status)", () => {
    expect(read("backend/src/plugins/sandbox.ts")).toContain(
      'qrLogin: ["startBind", "pollBind", "cancelBind", "status"],'
    );
  });

  it("配置页渲染常驻状态块并调 status(qrLogin 能力 + action 字段才显示)", () => {
    expect(index).toContain("qrStatusBlockVisible");
    expect(index).toContain('(m.capabilities || []).includes("qrLogin")');
    expect(index).toContain('{ method: "status", params: {} }');
    expect(index).toContain("qrStatusInvalid");
    expect(index).toContain("qrStatusUnbound");
  });

  it("status 失败静默显示「状态未知」", () => {
    expect(index).toContain("qrStatusFailed.value = true; // status 失败静默显示「状态未知」");
  });

  it("插件实现 status() 并返回 platforms(逐平台 bound/nickname/valid,绝不抛错)", () => {
    const plugin = readSibling("plugins/daily-rec-platform/index.js");
    if (!plugin) return; // 插件仓未检出(主仓 CI)时跳过
    expect(plugin).toContain("status: function () {");
    expect(plugin).toContain("return { platforms: platforms }");
    expect(plugin).toContain("valid: null");
  });

  it("插件仓 check.mjs 方法白名单同步(含 status)", () => {
    expect(readSibling("scripts/check.mjs")).toContain(
      'qrLogin: ["startBind", "pollBind", "cancelBind", "status"],'
    );
  });

  it("网易云修复:authProbe 对齐 go 蓝本 + 8821 过期收口 + body cookie 优先", () => {
    const plugin = readSibling("plugins/daily-rec-platform/index.js");
    if (!plugin) return; // 插件仓未检出(主仓 CI)时跳过
    expect(plugin).toContain('authProbe: "/nuser/account/get"');
    expect(plugin).toContain('if (code === 8821) return errOf("QR_EXPIRED"');
    expect(plugin).toContain("checkRes.json.cookie");
  });

  it("QQ 修复:删除型 Set-Cookie 不覆盖有效值(p_skey)", () => {
    const plugin = readSibling("plugins/daily-rec-platform/index.js");
    if (!plugin) return; // 插件仓未检出(主仓 CI)时跳过
    expect(plugin).toContain("val !== \"\"");
  });
});
