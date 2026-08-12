// ============================================================================
//  MusicFlow-V2 外置插件示例：一个最简「歌单链接导入」插件
// ----------------------------------------------------------------------------
//  安装：把整个 hello-importer/ 目录复制到 <data>/plugins/ 下即可：
//      backend/data/plugins/hello-importer/index.js   (= 本文件)
//  重启后端（或等热重载），插件会出现在「插件」管理页，启用后即可在「导入歌单」中使用。
//
//  沙箱契约（QuickJS VM 内运行，拿不到 Node 能力）：
//    - 纯 JS 脚本，无 import/export；定义 globalThis.__mfPlugin
//    - manifest 必须与 plugin.json（若有）的 id/version/capabilities 一致
//    - 网络走 host.http(url, { timeout })，配置实时读 host.config
// ============================================================================

globalThis.__mfPlugin = {
  /** 插件自描述。核心只读 manifest，绝不读具体实现。 */
  manifest: {
    id: "hello-importer",
    name: "示例：Hello 歌单导入",
    version: "1.0.0",
    type: "importer",
    description: "演示用：识别 https://example.com/playlist?id= 并回退为占位曲目",
    capabilities: ["playlistImport"],
    platforms: ["example"],
    defaultEnabled: false, // 外置插件默认关，用户在插件页手动开启
    minAppVersion: "1.3.0", // 沙箱运行时自 v1.3.0 起
    configSchema: [
      // 这些字段会自动渲染成插件页的配置表单
      { key: "token", label: "访问令牌", type: "text", required: false },
    ],
  },

  create(host) {
    return {
      /** 是否认得这个分享链接（同步方法）。 */
      canHandle(url) {
        return /example\.com\/playlist/i.test(url.trim());
      },

      /** 解析远程歌单。返回核心约定的 track 列表。 */
      async fetchPlaylist(url) {
        const id = (url.match(/[?&]id=(\w+)/) || [])[1] || "demo";
        // 真实插件这里会 host.http 请求远端 API 并映射成 ImportedTrackShape[]。
        // const res = await host.http("https://api.example.com/playlist?id=" + id, { timeout: 8000 });
        return {
          name: `示例歌单 ${id}`,
          platform: "example",
          tracks: [
            { externalId: "1", title: "示例歌曲 A", artist: "示例艺人" },
            { externalId: "2", title: "示例歌曲 B", artist: "示例艺人" },
          ],
        };
      },
    };
  },
};
