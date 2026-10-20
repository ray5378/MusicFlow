// `/rest/*` 全局鉴权豁免清单(src/middleware/restExempt.ts)的行为锁定。
//
// 为什么单独立测:这份清单是**安全白名单** —— 放宽一条(多加一个 marker,或把判定改成
// 恒真)就等于静默绕过整个 `/rest` 面的鉴权,而现有任何动态用例都不会因此变红。
// 反向同理:漏一条就是 2026-10-20 实测事故 —— 清单漏了 `/airplay/stream/`,本机 ffmpeg
// 回环拉取被自家鉴权拦成 401,设备全程收不到 RTP(用户可见症状:「AirPlay 连不上设备」)。
// 所以「该在的在、不该在的不在」两头都要钉死。
import { describe, it, expect } from "vitest";
import {
  REST_AUTH_EXEMPT_MARKERS,
  isRestAuthExemptPath,
} from "../../src/middleware/restExempt.js";

// 路径段占位符:刻意用低熵值、且名字不带 token/secret 类关键词 ——
// 否则会被 gitleaks 的 generic-api-key 规则误判成密钥(2026-10-20 实测)。
const PATH_SLUG = "sample-path-segment";

describe("isRestAuthExemptPath —— `/rest/*` 鉴权豁免清单", () => {
  it("清单恰好是三条取流端(内容与顺序都钉死;增删必须同步改守卫与本用例)", () => {
    expect([...REST_AUTH_EXEMPT_MARKERS]).toEqual([
      "/dlna/stream/",
      "/airplay/stream/",
      "/membuf/",
    ]);
  });

  it("三条取流端在真实路径形态下全部放行(含 /rest 前缀)", () => {
    expect(isRestAuthExemptPath(`/rest/dlna/stream/${PATH_SLUG}`)).toBe(true);
    expect(isRestAuthExemptPath(`/rest/airplay/stream/${PATH_SLUG}`)).toBe(true);
    expect(isRestAuthExemptPath(`/rest/membuf/${PATH_SLUG}`)).toBe(true);
  });

  it("回归锚点:AirPlay 取流端必须放行 —— 漏了它 = 401 = 设备收不到 RTP(HiVi H5MKII 实测)", () => {
    expect(isRestAuthExemptPath(`/rest/airplay/stream/${PATH_SLUG}`)).toBe(true);
  });

  it("真实取流形态(带查询串)同样放行:AirPlay 的 timeOffset 与 DLNA raw 流", () => {
    expect(isRestAuthExemptPath(`/rest/airplay/stream/${PATH_SLUG}?timeOffset=30`)).toBe(true);
    expect(isRestAuthExemptPath(`/rest/dlna/stream/${PATH_SLUG}?raw=1`)).toBe(true);
  });

  it("普通业务路径一律不放行(豁免只覆盖取流端,不是整个 /rest 面)", () => {
    const mustBeGated = [
      "/rest/stream",
      "/rest/stream.view",
      "/rest/getCoverArt",
      "/rest/download",
      "/rest/ping",
      "/rest/auth/login",
      "/rest/api/v1/playlists",
      "/rest/api/v1/sources",
      "/api/v1/peers",
    ];
    for (const p of mustBeGated) {
      expect(isRestAuthExemptPath(p), p).toBe(false);
    }
  });

  it("裸 /rest、空串、根路径都不得放行(否则等于整面开闸)", () => {
    expect(isRestAuthExemptPath("/rest")).toBe(false);
    expect(isRestAuthExemptPath("/rest/")).toBe(false);
    expect(isRestAuthExemptPath("/")).toBe(false);
    expect(isRestAuthExemptPath("")).toBe(false);
  });

  it("前缀必须带尾斜杠:同名的集合路径不放行(避免 /streams 被当成 /stream/)", () => {
    expect(isRestAuthExemptPath("/rest/airplay/streams/abc")).toBe(false);
    expect(isRestAuthExemptPath("/rest/dlna/streams/abc")).toBe(false);
    expect(isRestAuthExemptPath("/rest/membufs/abc")).toBe(false);
  });
});
