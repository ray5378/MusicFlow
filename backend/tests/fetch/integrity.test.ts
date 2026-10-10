import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveFfmpeg } from "../../src/services/transcode.js";
import { sniffMagic, verifyIntegrity } from "../../src/services/fetch/integrity.js";

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
  it("HTML 错误页被拒(200 但内容是网页)", async () => {
    const f = join(DIR, "err.html");
    writeFileSync(f, "<html><body>502 Bad Gateway</body></html>");
    const r = await verifyIntegrity(f, "magic");
    expect(r.ok).toBe(false);
    expect(r.code).toBe("INTEGRITY_FAILED");
    expect(r.detail.sniff).toBe("text");
    expect(r.warnings.join("|")).toContain("错误页");
  });

  it("JSON 错误响应被拒", async () => {
    const f = join(DIR, "err.json");
    writeFileSync(f, '{"error":"file not found","code":404}');
    const r = await verifyIntegrity(f, "magic");
    expect(r.ok).toBe(false);
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
  it("时长偏差超容差 → 失败", async () => {
    const r = await verifyIntegrity({ file: MP3, expect: { durationSec: 60, durationToleranceSec: 3 } }, "probe");
    expect(r.ok).toBe(false);
    expect(r.level).toBe("probe");
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
