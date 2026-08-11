// ============================================================================
//  MusicFlow-V2 外置插件示例：一个最简「歌单链接导入」插件
// ----------------------------------------------------------------------------
//  安装：把整个 hello-importer/ 目录复制到 <data>/plugins/ 下即可：
//      backend/data/plugins/hello-importer/index.js   (= 本文件)
//  重启后端，插件会出现在「插件」管理页，启用后即可在「导入歌单」中使用。
//
//  约定：
//    - 必须是 ESM（export const manifest / export const impl）
//    - 只能放 <data>/plugins/<your-id>/index.js，不能逃逸该目录
//    - manifest.id 全局唯一，若与已注册插件重名会被跳过
//    - 仅声明的能力会被核心调用；未实现的方法不会被调用
// ============================================================================

/** 插件自描述。核心只读 manifest，绝不读具体实现。 */
export const manifest = {
  id: "hello-importer",
  name: "示例：Hello 歌单导入",
  version: "1.0.0",
  type: "importer",
  description: "演示用：识别 https://example.com/playlist?id= 并回退为占位曲目",
  capabilities: ["playlistImport"],
  platforms: ["example"],
  defaultEnabled: false, // 外置插件默认关，用户在插件页手动开启
  urlPatterns: ["example.com/**playlist**"],
  minAppVersion: "1.0.0", // 要求 App 至少 1.0.0；dev 构建不受限
  configSchema: [
    // 这些字段会自动渲染成插件页的配置表单
    { key: "token", label: "访问令牌", type: "text", required: false },
  ],
};

/** 插件实现。核心按 manifest.capabilities 找到本插件后调用对应方法。 */
export const impl = {
  /** 是否认得这个分享链接。 */
  canHandle(url) {
    return /example\.com\/playlist/i.test(url.trim());
  },

  /** 解析远程歌单。返回核心约定的 track 列表。 */
  async fetchPlaylist(url) {
    const id = (url.match(/[?&]id=(\w+)/) || [])[1] || "demo";
    // 真实插件这里会请求远端 API 并映射成 ImportedTrackShape[]。
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
