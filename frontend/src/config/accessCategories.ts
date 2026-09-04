/**
 * 访问控制的功能权限分类。
 * category 使用英文稳定 id(library/playlist/interaction/recommend/player/system),
 * 展示文案经 i18n(admin.users.access.category.<id>)翻译;后端 access catalog
 * 的 category 取值与 id 应保持一致。
 */
export const ACCESS_CATEGORIES: string[] = ["library", "playlist", "interaction", "recommend", "player", "system"];

export const ACCESS_CATEGORY_LABEL_KEYS: Record<string, string> = {
  library: "admin.users.access.category.library",
  playlist: "admin.users.access.category.playlist",
  interaction: "admin.users.access.category.interaction",
  recommend: "admin.users.access.category.recommend",
  player: "admin.users.access.category.player",
  system: "admin.users.access.category.system",
};