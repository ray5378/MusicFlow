import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveFfmpeg } from "../../src/services/transcode.js";
import {
  isDecodable,
  sha256Of,
  sniffMagic,
  verifyIntegrity,
} from "../../src/services/fetch/integrity.js";

const DIR = mkdtempSync(join(tmpdir(), "mf-integrity-"));
const TMO = { timeout: 90_000 };
let MP3 = "";
let FLAC = "";

function ff(args: string[]): void {
  execFileSync(resolveFfmpeg(), args, { stdio: ["ignore", "ignore", "pipe"] });
}

beforeAll(() => {
  MP3 = join(DIR, "ok.mp3");
  FLAC = join(DIR, "ok.flac");
  ff(["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:a", "libmp3lame", "-b:a", "320k", MP3]);
  ff(["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:a", "flac", FLAC]);
}, TMO.timeout);

afterAll(() => rmSync(DIR, { recursive: true, force: true }));

describe("verifyIntegrity — length 档", () => {
  it("字节数不符 → INTEGRITY_FAILED", async () => {
    const r = await verifyIntegrity({ file: MP3, expect: { bytes: statSync(MP3).size + 1 } }, "length");
    expect(r.ok).toBe(false);
    expect(r.code).toBe("INTEGRITY_FAILED");
    expect(r.level).toBe("length");
  });

  it("字节数与 sha256 都对 → ok", async () => {
    const buf = readFileSync(MP3);
    const sha = createHash("sha256").update(buf).digest("hex");
    const r = await verifyIntegrity({ file: MP3, expect: { bytes: buf.length, sha256: sha } }, "length");
    expect(r.ok).toBe(true);
    expect(r.detail.sha256).toBe(sha);
  }, TMO.timeout);

  it("sha256 不符 → INTEGRITY_FAILED(即使字节数一致)", async () => {
    const r = await verifyIntegrity(
      { file: MP3, expect: { bytes: statSync(MP3).size, sha256: "00".repeat(32) } },
      "length",
    );
    expect(r.ok).toBe(false);
    expect(r.warnings.join("|")).toContain("sha256");
  }, TMO.timeout);
});

describe("verifyIntegrity — magic 档(挡服务端假成功)", () => {
  it("HTML 错误页被拒(200 但内容是网页) → SOURCE_INVALID", async () => {
    const f = join(DIR, "err.html");
    writeFileSync(f, "<html><body>502 Bad Gateway</body></html>");
    const r = await verifyIntegrity(f, "magic");
    expect(r.ok).toBe(false);
    // 非音频响应体是**源侧**问题（错误页/失败文本），不是「文件坏了」：
    // 用 INTEGRITY_FAILED 会被 attempts.ts 的永久失效白名单收进去 → 源站偶发挂掉
    // 被算成「这首歌死了」，连续两次就被 deadSongPurge 移出曲库。
    expect(r.code).toBe("SOURCE_INVALID");
    expect(r.code).not.toBe("INTEGRITY_FAILED");
    expect(r.detail.sniff).toBe("text");
    expect(r.warnings.join("|")).toContain("错误页");
  });

  it("JSON 错误响应被拒 → SOURCE_INVALID", async () => {
    const f = join(DIR, "err.json");
    writeFileSync(f, '{"error":"file not found","code":404}');
    const r = await verifyIntegrity(f, "magic");
    expect(r.ok).toBe(false);
    expect(r.code).toBe("SOURCE_INVALID");
    expect(r.detail.sniff).toBe("text");
  });

  it("无扩展名但内容是真音频 → 通过", async () => {
    const f = join(DIR, "noext");
    writeFileSync(f, readFileSync(MP3));
    const r = await verifyIntegrity(f, "magic");
    expect(r.ok).toBe(true);
    expect(r.detail.sniff).toBe("mp3");
  });

  it("sniffMagic 单元:能认 flac / 裸帧 mp3 / 拒绝未知", () => {
    expect(sniffMagic(Buffer.from("fLaC" + "x".repeat(40))).kind).toBe("flac");
    expect(sniffMagic(Buffer.from([0xff, 0xfb, 0x90, 0x00])).audio).toBe(true);
    expect(sniffMagic(Buffer.from([0x00, 0x01, 0x02])).audio).toBe(false);
  });
});

describe("verifyIntegrity — probe 档", () => {
  it("时长偏差超容差 → 失败，且必须是 DURATION_MISMATCH（不得冒充 INTEGRITY_FAILED）", async () => {
    const r = await verifyIntegrity({ file: MP3, expect: { durationSec: 60, durationToleranceSec: 3 } }, "probe");
    expect(r.ok).toBe(false);
    expect(r.level).toBe("probe");
    // 拿到的是另一个版本 ≠ 文件残缺：用 INTEGRITY_FAILED 会被永久失效白名单收进去，
    // 于是「歌还在、还能在线播放」的条目会被判死链移出曲库（2026-10-11 生产实测）。
    expect(r.code).toBe("DURATION_MISMATCH");
    expect(r.warnings.join("|")).toContain("时长");
  }, TMO.timeout);

  it("时长在容差内 + 可解析 → ok,并回带容器与时长", async () => {
    const r = await verifyIntegrity({ file: MP3, expect: { durationSec: 3, durationToleranceSec: 1 } }, "probe");
    expect(r.ok).toBe(true);
    expect(r.detail.container).toBe("mp3");
    expect(r.detail.durationSec).toBeGreaterThan(2.9);
  }, TMO.timeout);

  it("ID3 头 + 垃圾内容:magic 与 probe 都放过,只有 decodable 能抓(档位分工实证)", async () => {
    // 构造「文件头合法但内容不是音频」。实测:magic 认 ID3 头放行;music-metadata
    // 也认 ID3 头就算解析成功(probe 放行);只有全解码会报
    // "Failed to find two consecutive MPEG audio frames"。
    // 这条用例钉住「内容级损坏必须靠 decodable」—— 别指望 probe 能兜。
    const f = join(DIR, "fakeid3.mp3");
    writeFileSync(f, Buffer.concat([Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00", "latin1"), Buffer.alloc(2048, 7)]));
    const magic = await verifyIntegrity(f, "magic");
    expect(magic.ok).toBe(true);
    expect(magic.detail.sniff).toBe("mp3");
    const probe = await verifyIntegrity(f, "probe");
    expect(probe.ok).toBe(true);
    const dec = await verifyIntegrity(f, "decodable");
    expect(dec.ok).toBe(false);
    expect(dec.level).toBe("decodable");
    expect(dec.code).toBe("INTEGRITY_FAILED");
  }, TMO.timeout);

  it("截断文件:probe 档可能仍通过(ID3 头带时长),必须靠 decodable 兜", async () => {
    // 这是档位存在的理由:截断到 600 字节的 mp3 头信息完整,probe 看不出问题。
    const f = join(DIR, "trunc.mp3");
    execFileSync("cp", [MP3, f]);
    execFileSync("truncate", ["-s", "600", f]);
    const probe = await verifyIntegrity(f, "probe");
    const dec = await verifyIntegrity(f, "decodable");
    expect(dec.ok).toBe(false);
    expect(dec.level).toBe("decodable");
    // 记录 probe 的真实行为(可能通过),避免后人误以为 probe 能抓截断
    expect(typeof probe.ok).toBe("boolean");
  }, TMO.timeout);
});

describe("verifyIntegrity — decodable 档", () => {
  it("正常文件全解码通过(stderr 为空)", async () => {
    const r = await verifyIntegrity(FLAC, "decodable");
    expect(r.ok).toBe(true);
    expect(r.detail.decodable).toBe(true);
  }, TMO.timeout);

  it("截断文件全解码失败 → INTEGRITY_FAILED", async () => {
    const f = join(DIR, "trunc2.mp3");
    execFileSync("cp", [MP3, f]);
    execFileSync("truncate", ["-s", "500", f]);
    const r = await verifyIntegrity(f, "decodable");
    expect(r.ok).toBe(false);
    expect(r.level).toBe("decodable");
    expect(r.code).toBe("INTEGRITY_FAILED");
  }, TMO.timeout);

  it("档位累加:magic 就失败的文件不会白跑 ffmpeg(decodable 也停在 magic)", async () => {
    const f = join(DIR, "page2.html");
    writeFileSync(f, "<!doctype html><html>error</html>");
    const r = await verifyIntegrity(f, "decodable");
    expect(r.ok).toBe(false);
    expect(r.level).toBe("magic");
    expect(r.detail.decodable).toBeUndefined();
  });
});

// 补充：IO 失败 / 解析异常 / 默认容差等早退与异常分支。
describe("verifyIntegrity — IO 与解析异常分支", () => {
  it("文件不存在(statSync 失败) → INTEGRITY_FAILED，bytes 归零", async () => {
    const r = await verifyIntegrity(join(DIR, "definitely-missing.mp3"), "length");
    expect(r.ok).toBe(false);
    expect(r.level).toBe("length");
    expect(r.code).toBe("INTEGRITY_FAILED");
    expect(r.detail.bytes).toBe(0);
  });

  it("期望字节数为负 → 跳过长度校验（边界早退）", async () => {
    const r = await verifyIntegrity({ file: MP3, expect: { bytes: -1 } }, "length");
    expect(r.ok).toBe(true);
    expect(r.detail.bytes).toBe(statSync(MP3).size);
  }, TMO.timeout);

  it("sha256 计算失败(传目录) → INTEGRITY_FAILED，带失败 warning", async () => {
    const r = await verifyIntegrity({ file: DIR, expect: { sha256: "00".repeat(32) } }, "length");
    expect(r.ok).toBe(false);
    expect(r.level).toBe("length");
    expect(r.code).toBe("INTEGRITY_FAILED");
    expect(r.warnings.join("|")).toContain("sha256 计算失败");
  });

  it("读取文件头失败(传目录) → magic 档失败，带失败 warning", async () => {
    const r = await verifyIntegrity(DIR, "magic");
    expect(r.ok).toBe(false);
    expect(r.level).toBe("magic");
    expect(r.code).toBe("INTEGRITY_FAILED");
    expect(r.warnings.join("|")).toContain("读取文件头失败");
  });

  it("头部合法(嗅探 flac)但内容不可解析 → probe 抛错被捕获(回带解析错误码)", async () => {
    const f = join(DIR, "bogus-magic");
    writeFileSync(f, Buffer.concat([Buffer.from("fLaC", "latin1"), Buffer.alloc(2048, 7)]));
    const r = await verifyIntegrity(f, "probe");
    expect(r.ok).toBe(false);
    expect(r.level).toBe("probe");
    expect(r.code).toBe("INTEGRITY_FAILED");
    expect(r.warnings.length).toBeGreaterThan(0);
  }, TMO.timeout);

  it("给了期望时长但未给容差 → 采用默认容差并通过", async () => {
    const r = await verifyIntegrity({ file: MP3, expect: { durationSec: 3 } }, "probe");
    expect(r.ok).toBe(true);
    expect(r.detail.durationSec).toBeGreaterThan(2.9);
  }, TMO.timeout);
});

describe("sha256Of / isDecodable 单元", () => {
  it("sha256Of 的结果与 node:crypto 一致", async () => {
    const sha = await sha256Of(MP3);
    expect(sha).toBe(createHash("sha256").update(readFileSync(MP3)).digest("hex"));
  }, TMO.timeout);

  it("isDecodable 正常文件 → ok 且未超时", async () => {
    const r = await isDecodable(MP3, 30_000);
    expect(r.ok).toBe(true);
    expect(r.timedOut).toBe(false);
  }, TMO.timeout);

  it("isDecodable 超时(timeout=0) → timedOut=true 且 ok=false", async () => {
    const r = await isDecodable(MP3, 0);
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
  }, TMO.timeout);
});
