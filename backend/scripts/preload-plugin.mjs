// ==================== 构建期预装外置插件拉取脚本 ====================
//
// 用途:镜像构建时把「官方外置插件」固定版本的源码拉进镜像(预装种子),
//       供 entrypoint.sh 在容器首次启动时落盘到 data/plugins/。
//
// 为什么放仓库里而不是内联在 Dockerfile:内联 node -e 脚本难维护、难测试;
// 独立 .mjs 脚本可用 node 直接跑(零依赖,node 22 内置 fetch/fs)。
//
// 设计约束:
//   - 只拉「固定版本」:URL 用插件仓库的 release tag(`<id>-v<版本>`),不用 master,
//     保证镜像内预装版本确定、可追溯;升级预装版本 = 改 Dockerfile 的 ARG 后重构建。
//   - 插件代码不进主仓库:文件直接从插件仓库(MusicFlow-plugins)拉取,
//     主仓库只维护这份「构建工具脚本」,不复制插件代码(核心/插件代码隔离边界)。
//   - 双源:GitHub raw 优先,失败切 Gitee raw(与官方注册表分发链路一致)。
//   - 失败即退出非 0:构建失败要显式可见,禁止静默跳过导致镜像里没有预装插件。
//
// 用法: node scripts/preload-plugin.mjs <pluginId> <version> <outDir>
//   例: node scripts/preload-plugin.mjs go-music-dl 1.2.39 /app/preloaded
//   → 输出 /app/preloaded/go-music-dl/{index.js,plugin.json,package.json}
//
// 说明:插件仓库目录结构为 plugins/<id>/{index.js,plugin.json,package.json};
//       若某插件包文件结构不同,在此脚本的 FILE_NAMES 扩展即可。

const [pluginId, version, outDir] = process.argv.slice(2);
if (!pluginId || !version || !outDir) {
  console.error("用法: node scripts/preload-plugin.mjs <pluginId> <version> <outDir>");
  process.exit(2);
}

const OWNER = "ray5378";
const REPO = "MusicFlow-plugins";
const GITEE_REPO = "music-flow-plugins";
const FILE_NAMES = ["index.js", "plugin.json", "package.json"];
const tag = `${pluginId}-v${version}`;

const githubBase = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${tag}/plugins/${pluginId}`;
const giteeBase = `https://gitee.com/${OWNER}/${GITEE_REPO}/raw/${tag}/plugins/${pluginId}`;

/** 依次尝试多个源,返回第一个成功的 Response;全部失败抛错。 */
async function fetchFirst(urls, label) {
  let lastErr = null;
  for (const u of urls) {
    try {
      const res = await fetch(u, { signal: AbortSignal.timeout(20000) });
      if (res.ok) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`${label} 拉取失败: ${lastErr?.message || lastErr}`);
}

async function main() {
  const destDir = `${outDir}/${pluginId}`;
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(destDir, { recursive: true });

  for (const f of FILE_NAMES) {
    const res = await fetchFirst(
      [`${githubBase}/${f}`, `${giteeBase}/${f}`],
      `${pluginId}@${version} ${f}`,
    );
    const text = await res.text();
    if (!text || text.length < 4) throw new Error(`${f} 内容为空`);
    writeFileSync(`${destDir}/${f}`, text);
    console.log(`[PRELOAD] ${pluginId}@${version} ${f} (${text.length} bytes)`);
  }
  console.log(`[PRELOAD] 完成: ${destDir} (tag=${tag})`);
}

main().catch((e) => {
  console.error(`[PRELOAD] 预装插件拉取失败: ${e?.message || e}`);
  process.exit(1);
});
