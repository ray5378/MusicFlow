// sniff.ts 专项测试：按字节嗅探容器魔数、kind → 容器/MIME 映射、扩展名同族判定，
// 以及 readHead 头部读取与 MF_SNIFF_DEBUG 调试日志两条分支。
//
// 纯本地：魔数用内存 Buffer 直接喂 sniffMagic；readHead 用 os.tmpdir 下的临时文件。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import {
  SNIFF_BYTES,
  describeSniffMismatch,
  extMatchesSniff,
  readHead,
  sniffContainer,
  sniffMagic,
  sniffMimeType,
} from "../../src/services/fetch/sniff.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mf-sniff-"));
afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** 构造「音频」期望值。 */
const audio = (kind: string) => ({ kind, audio: true });
/** 构造「非音频」期望值。 */
const notAudio = (kind: string) => ({ kind, audio: false });

describe("sniffMagic 容器识别", () => {
  it("空缓冲与缺失缓冲 → empty", () => {
    expect(sniffMagic(Buffer.alloc(0))).toEqual(notAudio("empty"));
    expect(sniffMagic(null as unknown as Buffer)).toEqual(notAudio("empty"));
  });

  it("各容器魔数逐一识别", () => {
    expect(sniffMagic(Buffer.from("fLaC\0\0\0\0"))).toEqual(audio("flac"));
    expect(sniffMagic(Buffer.from("OggS\0\0\0\0"))).toEqual(audio("ogg"));
    expect(sniffMagic(Buffer.from("ID3\x03\x00\x00"))).toEqual(audio("mp3"));
    expect(sniffMagic(Buffer.from("MAC \0\0\0\0"))).toEqual(audio("ape"));
    expect(sniffMagic(Buffer.from("RIFF\x00\x00\x00\x00WAVE"))).toEqual(audio("wav"));
    expect(sniffMagic(Buffer.from("FORM\x00\x00\x00\x00AIFF"))).toEqual(audio("aiff"));
    expect(
      sniffMagic(Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypM4A ")])).kind,
    ).toBe("mp4");
  });

  it("RIFF / FORM 但子类型不符 → 落到 unknown", () => {
    expect(sniffMagic(Buffer.from("RIFF\x00\x00\x00\x00XXXX"))).toEqual(notAudio("unknown"));
    expect(sniffMagic(Buffer.from("FORM\x00\x00\x00\x00ABCD"))).toEqual(notAudio("unknown"));
  });

  it("MPEG 裸帧同步字：命中、字节为 0xff 但不构成同步、缓冲过短", () => {
    expect(sniffMagic(Buffer.from([0xff, 0xfb, 0x90, 0x00]))).toEqual(audio("mp3"));
    // 0xff 后跟 0x3f（高 3 位不全 1）→ 内层条件为假
    expect(sniffMagic(Buffer.from([0x01, 0xff, 0x3f, 0x00]))).toEqual(notAudio("unknown"));
    // 单字节：循环体一次都不进
    expect(sniffMagic(Buffer.from([0xff]))).toEqual(notAudio("unknown"));
  });

  it("超长缓冲（>64）在前 64 字节内无同步字 → 未知", () => {
    expect(sniffMagic(Buffer.alloc(100, 0x41))).toEqual(notAudio("unknown"));
  });

  it("假成功识别：HTML / JSON / 数组与普通文本", () => {
    expect(sniffMagic(Buffer.from("<html></html>"))).toEqual(notAudio("text"));
    expect(sniffMagic(Buffer.from('{"err":1}'))).toEqual(notAudio("text"));
    expect(sniffMagic(Buffer.from("[1,2,3]"))).toEqual(notAudio("text"));
    expect(sniffMagic(Buffer.from("plain text body"))).toEqual(notAudio("unknown"));
  });
});

describe("kind → 容器 / MIME 映射", () => {
  it("已识别 kind 全有映射，且 mp4 → m4a；未识别返回 undefined", () => {
    const kinds = ["flac", "ogg", "mp3", "mp4", "wav", "aiff", "ape"];
    for (const k of kinds) {
      expect(sniffContainer(k)).toBeTypeOf("string");
      expect(sniffMimeType(k)).toBeTypeOf("string");
    }
    expect(sniffContainer("mp4")).toBe("m4a");
    expect(sniffMimeType("mp3")).toBe("audio/mpeg");
    expect(sniffContainer("text")).toBeUndefined();
    expect(sniffMimeType("empty")).toBeUndefined();
  });
});

describe("扩展名同族判定", () => {
  it("未知 kind 恒 true；同族 true；跨族 false；大小写不敏感", () => {
    expect(extMatchesSniff(".mp3", "weird")).toBe(true); // 未识别 kind → !fam 分支
    expect(extMatchesSniff(".mp3", "mp3")).toBe(true);
    expect(extMatchesSniff(".opus", "ogg")).toBe(true); // 同族多后缀（Ogg 家族）
    expect(extMatchesSniff(".mp4", "mp4")).toBe(true);
    expect(extMatchesSniff(".opus", "mp4")).toBe(false); // includes 为假
    expect(extMatchesSniff(".MP3", "mp3")).toBe(true); // toLowerCase
  });
});

describe("诊断串与调试日志", () => {
  it("扩展名有 / 无两种文案", () => {
    expect(describeSniffMismatch(".mp3", "wav")).toContain("扩展名=.mp3");
    expect(describeSniffMismatch("", "wav")).toContain("(无)");
  });

  it("MF_SNIFF_DEBUG 置位时才写 console.log", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubEnv("MF_SNIFF_DEBUG", "1");
    describeSniffMismatch(".a", "b");
    expect(spy).toHaveBeenCalled();
  });
});

describe("readHead 头部读取", () => {
  it("空文件返回 0 字节（want>0 为假）", () => {
    const p = path.join(tmpDir, "empty.bin");
    fs.writeFileSync(p, Buffer.alloc(0));
    expect(readHead(p, SNIFF_BYTES).length).toBe(0);
  });

  it("文件小于请求字节数 → 返回实际长度", () => {
    const p = path.join(tmpDir, "small.bin");
    fs.writeFileSync(p, Buffer.from([1, 2, 3, 4]));
    expect(readHead(p, SNIFF_BYTES).length).toBe(4);
  });

  it("文件大于请求字节数 → 截断到 n 且内容正确", () => {
    const p = path.join(tmpDir, "big.bin");
    fs.writeFileSync(p, Buffer.alloc(1024, 7));
    const head = readHead(p, 4);
    expect(head.length).toBe(4);
    expect(head.equals(Buffer.alloc(4, 7))).toBe(true);
  });
});
