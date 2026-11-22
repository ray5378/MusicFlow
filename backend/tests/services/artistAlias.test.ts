import { describe, expect, it, beforeEach } from "vitest";
import { sqlite } from "../../src/db/index.js";
import { aliasNorm, aliasRelated, artistAliasMatch } from "../../src/services/artistAlias.js";

/** 直接往 alias 表塞数据，验证"实体别名/成员"这类场景能被认出来。 */
function put(alias: string, canonical: string, kind = "alias") {
  const n = aliasNorm;
  sqlite
    .prepare(
      "INSERT INTO artist_alias (alias, alias_norm, canonical, canonical_norm, kind, source, updated_at) VALUES (?,?,?,?,?,'test','')",
    )
    .run(alias, n(alias), canonical, n(canonical), kind);
}

describe("artistAlias — 别名/成员关系", () => {
  beforeEach(() => {
    sqlite.prepare("DELETE FROM artist_alias").run();
    put("黄丽玲", "A-Lin");
    put("黃家駒", "Beyond", "member_of");
    put("Beyond", "黃家駒", "member_of");
    put("叶倩文", "叶蒨文");
  });

  it("艺名 ↔ 本名：A-Lin 与 黄丽玲 视为同一人", () => {
    expect(aliasRelated("A-Lin", "黄丽玲")).toBe(true);
    expect(artistAliasMatch("A-Lin", "黄丽玲")).toBe(true);
  });

  it("乐队 ↔ 成员：BEYOND 与 黄家驹 视为同一组", () => {
    expect(artistAliasMatch("BEYOND", "黄家驹")).toBe(true);
  });

  it("异体字别名也能命中（叶蒨文/叶倩文）", () => {
    expect(artistAliasMatch("叶蒨文", "叶倩文")).toBe(true);
  });

  it("表里没有的两个名字 → 不命中（不误判）", () => {
    expect(aliasRelated("周杰伦", "卫兰")).toBe(false);
    expect(aliasRelated("Billy Cate", "卫兰")).toBe(false);
  });
});
