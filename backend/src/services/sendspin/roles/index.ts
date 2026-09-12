// ==================== roles registry 装配(导入副作用) ====================
//
// 导入本模块即注册全部角色工厂。server.ts / 测试经 `import "./roles/index.js"` 触发。
import { registerRole } from "./registry.js";
import { createPlayerRole } from "./player.js";
import { createControllerRole } from "./controller.js";
import { createMetadataRole } from "./metadata.js";
import { createArtworkRole } from "./artwork.js";
import { createVisualizerRole } from "./visualizer.js";
import { createSourceRole } from "./source.js";
import { createColorRole } from "./color.js";

export function registerAllRoles(): void {
  registerRole("player@v1", createPlayerRole, false);
  registerRole("controller@v1", createControllerRole, false);
  // metadata/artwork/visualizer/color 需要配对才在其上下行(策略: requirePairing)
  registerRole("metadata@v1", createMetadataRole, true);
  registerRole("artwork@v1", createArtworkRole, true);
  registerRole("visualizer@v1", createVisualizerRole, true);
  registerRole("color@v1", createColorRole, true);
  registerRole("source@v1", createSourceRole, false);
}

registerAllRoles();