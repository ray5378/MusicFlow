// flacCodecHeaderB64 / flacCodecHeaderFromStream:供 stream/start 的 codec_header。
// 2026-09-17 ESPHome 真机:无此头整个 stream/start 被拒,之后每块音频全灭。
//
// ⚠️ 本文件曾三次改断言,根因都是「凭推测填 STREAMINFO 字段」而不是取真实编码产物。
// 金标准(aiosendspin FlacEncoder)的做法是:
//   codec_header = b"fLaC\x80" + u24(len) + encoder.extradata
// 即**直接取编码器自产的 STREAMINFO**。此处用固定的真实段字节做对照基准。
//
// ⚠️ 2026-09-17 再次更正:「必须 `-frame_size 4096`」的结论**已被推翻**。
// flac 已改为**进程内 libFLAC**(`LibFlacEncoder`),block_size 传 0 = 编码器自选,
// 实测自选 **4096**;`FLAC_BLOCK_SIZE` 现在只是「首段尚未产出」时的兜底值,
// 且刻意与 libFLAC 自选值对齐。真正决定有声无声的是**「每包恰好一帧」**(见下方用例)。
import { describe, it, expect } from "vitest";
import { flacCodecHeaderB64, flacCodecHeaderFromStream, flacFrameStreamOffset, parseFlacFrameHeader, scanFlacFrameSamples, sumFlacSamples, splitFlacFrames, FLAC_BLOCK_SIZE, FLAC_BIT_DEPTH, SAMPLE_RATE, CHANNELS } from "./encoding.js";

describe("flacCodecHeaderB64", () => {
  it("fLaC 魔数 + 0x80 块头 + 34B STREAMINFO,解出 48k/立体声/16bit", () => {
    const h = Buffer.from(flacCodecHeaderB64(), "base64");
    expect(h.length).toBe(42);
    expect(h.subarray(0, 4).toString("ascii")).toBe("fLaC");
    expect(h[4]).toBe(0x80); // last-block + STREAMINFO type 0
    expect(h.readUIntBE(5, 3)).toBe(34);
    const info = h.subarray(8);
    // 兜底值:仅用于「首段尚未产出」的极短窗口,刻意与 libFLAC 自选值对齐。
    // 真实值一律走 flacCodecHeaderFromStream(见下方用例)。
    expect(info.readUInt16BE(0)).toBe(FLAC_BLOCK_SIZE);
    expect(info.readUInt16BE(2)).toBe(FLAC_BLOCK_SIZE);
    expect(FLAC_BLOCK_SIZE).toBe(4096);
    // 10..17B:rate(20b)|ch-1(3b)|bps-1(5b)|总数(36b)
    let pack = 0n;
    for (let i = 0; i < 8; i++) pack = (pack << 8n) | BigInt(info[10 + i]);
    expect(Number((pack >> 44n) & 0xfffffn)).toBe(SAMPLE_RATE);
    expect(Number((pack >> 41n) & 0x7n)).toBe(CHANNELS - 1);
    // ⚠️ 位深必须 16:设备只声明 16bit。libFLAC 已显式按 16 建编码器
    // (create_libflac_encoder 第 3 参 = FLAC_BIT_DEPTH)。
    expect(Number((pack >> 36n) & 0x1fn)).toBe(FLAC_BIT_DEPTH - 1);
    expect(FLAC_BIT_DEPTH).toBe(16);
  });
});

describe("flacCodecHeaderFromStream", () => {
  /** 真实 libFLAC 段头(实测:s16 / 48k / 2ch / block 4096 = 0x1000)。
   *  `LibFlacEncoder` 前 3 次写回调依次给 fLaC(4B) + STREAMINFO(38B) + VORBIS(44B),
   *  取前 42B 即此值。直接照抄,不做任何推算。 */
  const realSegHead = Buffer.from(
    "664c6143000000221000100000034f0004c40bb802f00000bb80b83e82aff56db0c0462fa1eab56e5fcc",
    "hex",
  );

  it("从真实段头提取 42B 并 base64(字段取自实流)", () => {
    const b64 = flacCodecHeaderFromStream(new Uint8Array(realSegHead));
    expect(b64).not.toBeNull();
    const h = Buffer.from(b64!, "base64");
    expect(h.length).toBe(42);
    expect(h.subarray(0, 4).toString("ascii")).toBe("fLaC");
    let pack = 0n;
    for (let i = 0; i < 8; i++) pack = (pack << 8n) | BigInt(h[18 + i]);
    expect(Number((pack >> 44n) & 0xfffffn)).toBe(SAMPLE_RATE);
    expect(Number((pack >> 36n) & 0x1fn)).toBe(15); // 16bit
  });

  it("★ last-metadata-block 位必须置 1(2026-09-24 FLAC 无声事故回归)", () => {
    // 真实流里 STREAMINFO 之后还跟着 VORBIS_COMMENT / PADDING,libFLAC 因此把块头
    // 写成 0x00(last=0)—— 对**完整流**而言这是正确的。
    expect(realSegHead[4]).toBe(0x00);
    const h = Buffer.from(flacCodecHeaderFromStream(new Uint8Array(realSegHead))!, "base64");
    // 但 codec_header 是**单独**发给设备初始化解码器的,之后直接跟裸音频帧:
    // 若照抄 last=0,解码器读完 STREAMINFO 会继续按「元数据块」格式解析下一段,
    // 撞上 FLAC 帧同步码 0xFF → 块类型 = 0x7F(127)非法 → 解码失败
    // → 日志全绿、进度照走、完全无声(240 真机:v4.0.17 发 0x80 有声,v4.0.18
    //   发 0x00 无声,两者仅此一字节不同)。
    expect(h[4]).toBe(0x80);
    // 除这一位外,其余 41B 必须与实流逐字节一致 —— 只规范化标志位,不改写任何字段。
    expect(h.subarray(5).toString("hex")).toBe(realSegHead.subarray(5, 42).toString("hex"));
  });

  it("非 fLaC 或长度不足返回 null(调用方回落合成值)", () => {
    expect(flacCodecHeaderFromStream(new Uint8Array(10))).toBeNull();
    expect(flacCodecHeaderFromStream(new Uint8Array(64))).toBeNull(); // 全 0,非 fLaC
  });
});

// ==================== 容器头剥离(2026-09-17 无声事故核心修复) ====================
//
// ffmpeg 的 flac muxer 在 pipe 输出时写**完整文件头**:
//   fLaC(4B) + STREAMINFO(4B 头 + 34B) + VORBIS_COMMENT + 8KB PADDING ≈ 8288B
// 设备侧 STREAMINFO 已由 stream/start.codec_header 单独给过,之后按**连续帧流**解析。
// 若把容器头原样下发,设备在期待 frame sync 处读到 `66 4c 61 43` → micro-flac
// 静默丢弃 → 日志全绿、PLAYING、进度正常但**完全无声**(与 MA 金标准的差异点)。
describe("flacFrameStreamOffset", () => {
  it("跳过 fLaC + STREAMINFO(last-block 位)后指向首个 frame sync", () => {
    // fLaC(4) + [0x80|0=STREAMINFO, len=34](4) + 34B 填充 → 下一字节即 frame sync
    const buf = Buffer.concat([
      Buffer.from("fLaC", "ascii"),
      Buffer.from([0x80, 0x00, 0x00, 0x22]), // last=1, type=0(STREAMINFO), len=34
      Buffer.alloc(34),
      Buffer.from([0xff, 0xf8, 0x00, 0x00]), // frame sync
    ]);
    expect(flacFrameStreamOffset(new Uint8Array(buf))).toBe(42);
  });

  it("多个非 last 块后跟 last 块,逐一跳过", () => {
    const buf = Buffer.concat([
      Buffer.from("fLaC", "ascii"),
      Buffer.from([0x04, 0x00, 0x00, 0x02]), // type=4(VORBIS_COMMENT), len=2, 非 last
      Buffer.alloc(2),
      Buffer.from([0x81, 0x00, 0x00, 0x08]), // last=1, type=1(PADDING), len=8
      Buffer.alloc(8),
      Buffer.from([0xff, 0xf8]),
    ]);
    expect(flacFrameStreamOffset(new Uint8Array(buf))).toBe(4 + 6 + 12);
  });

  it("真实 ffmpeg 输出:容器头 8288B,剥离后首字节是 frame sync 0xFF", () => {
    // 实测:喂 2s PCM 得 8610B,首个 sync 在 8288(4+38+46+8192 布局)
    const head = Buffer.concat([
      Buffer.from("fLaC", "ascii"),
      Buffer.from([0x00, 0x00, 0x00, 0x22]), // STREAMINFO, 非 last
      Buffer.alloc(34),
      Buffer.from([0x04, 0x00, 0x00, 0x2e]), // VORBIS_COMMENT, 非 last (0x04)
      Buffer.alloc(0x2e),
    ]);
    // 再补一个 last 的 PADDING 块凑到 8288
    const remaining = 8288 - head.length - 4;
    const buf = Buffer.concat([
      head,
      Buffer.from([0x81, (remaining >> 16) & 0xff, (remaining >> 8) & 0xff, remaining & 0xff]),
      Buffer.alloc(remaining),
      Buffer.from([0xff, 0xf8, 0xca, 0x18]),
    ]);
    expect(buf.length).toBe(8288 + 4);
    const off = flacFrameStreamOffset(new Uint8Array(buf));
    expect(off).toBe(8288);
    if (off === null) throw new Error("offset 不应为 null");
    expect(buf[off]).toBe(0xff);
    expect(buf[off + 1] & 0xfe).toBe(0xf8);
  });

  it("非 fLaC / 块头不完整 / 非法块类型 → null(调用方原样保留,宁可多传不截断)", () => {
    expect(flacFrameStreamOffset(new Uint8Array(2))).toBeNull();
    expect(flacFrameStreamOffset(new Uint8Array(64))).toBeNull(); // 全 0
    // 头声明长度超过缓冲(尚未收全)
    const short = Buffer.concat([Buffer.from("fLaC", "ascii"), Buffer.from([0x80, 0x00, 0x10, 0x00])]);
    expect(flacFrameStreamOffset(new Uint8Array(short))).toBeNull();
  });
});

// ==================== 样本精确时间戳(2026-09-17 第三次无声事故)====================
//
// 事故:每个音频包只含 **1 个** 4096 样本 FLAC 帧(85.33ms),但服务端按
// 「调度帧序号 × FRAME_MS」打时间戳(100ms 步进)且基准恒 0 → 与墙钟脱钩。
// 设备按 `(ts - send_ahead) - now` 判播出时刻,实测十块 delta 全为负
// (−6079ms … −6126ms)→ 立即吐字节 → 缓冲永远空 → underrun → **无声**。
//
// 修复:每包自报**实测样本数**(EncodedChunk.frameSamples),调用方按样本推进时间线。
// 下面的 fixture 全部是「镜像探针从真实下发流里抓到的原始字节」,不做推算。
describe("parseFlacFrameHeader / scanFlacFrameSamples", () => {
  /** 真实 FLAC 帧头(探针从 ESPHome 设备的同组下发流中抓到,10 块)。
   *  每块前 8 字节,由 `ffmpeg -frame_size 4096 -sample_fmt s16` 产出。 */
  const realFrameHeads = [
    "fff8ca1833e64cfe", "fff8ca9838614eec", "fff8ca183fc24efb", "fff8ca9841094ef7",
    "fff8ca1843b14ced", "fff8ca1848804efb", "fff8ca1852c64e16", "fff8ca1859f74efa",
  ];

  it("真实帧头解析:block=4096 / sr=48000 / 2ch / 16bit", () => {
    for (const hex of realFrameHeads) {
      const b = new Uint8Array(Buffer.from(hex, "hex"));
      const r = parseFlacFrameHeader(b);
      expect(r).not.toBeNull();
      // bsize code 12 → 4096(FLAC_BLOCK_SIZE)
      expect(r!.samples).toBe(FLAC_BLOCK_SIZE);
      expect(r!.samples).toBe(4096);
    }
  });

  it("blk code 12 = 4096;code 6/7 走块尾扩展字节", () => {
    // code 12(0xC_)→ 查表 4096
    const t = new Uint8Array(Buffer.from("fff8ca1833e64cfe", "hex"));
    expect(parseFlacFrameHeader(t)!.samples).toBe(4096);
    // code 6(0x6_)→ 紧随 8bit +1;构造 0xFFF8 6A 18 ... 
    const c6 = new Uint8Array([0xff, 0xf8, 0x6a, 0x18, 0x00, 0x63, 0x00]);
    expect(parseFlacFrameHeader(c6)!.samples).toBe(0x64); // 100+1 = 101
    // code 7(0x7_)→ 16bit;构造 0xFFF8 7A 18 ...
    const c7 = new Uint8Array([0xff, 0xf8, 0x7a, 0x18, 0x00, 0x00, 0xff, 0x00]);
    expect(parseFlacFrameHeader(c7)!.samples).toBe(0x0100); // 256+1 = 257
  });

  it("非帧头 / 字段非法 → null", () => {
    expect(parseFlacFrameHeader(new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00]))).toBeNull();
    // 缺第二字节
    expect(parseFlacFrameHeader(new Uint8Array([0xff, 0xf8]))).toBeNull();
    // 采样率 code 15 非法
    expect(parseFlacFrameHeader(new Uint8Array([0xff, 0xf8, 0xcf, 0x18, 0x00]))).toBeNull();
    // block size code 0 非法
    expect(parseFlacFrameHeader(new Uint8Array([0xff, 0xf8, 0x0a, 0x18, 0x00]))).toBeNull();
  });

  it("scanFlacFrameSamples 在裸帧流里找出全部帧(用真实捕获字节)", () => {
    // 拼接 8 个真实帧头 + 填充,扫描应找到 8 帧
    const parts: Buffer[] = [];
    for (const hex of realFrameHeads) {
      parts.push(Buffer.from(hex, "hex"));
      parts.push(Buffer.alloc(64, 0x11)); // 帧体填充
    }
    const buf = new Uint8Array(Buffer.concat(parts));
    const samples = scanFlacFrameSamples(buf);
    expect(samples.length).toBeGreaterThanOrEqual(realFrameHeads.length);
    expect(samples.slice(0, realFrameHeads.length).every((s) => s === 4096)).toBe(true);
  });

  it("sumFlacSamples 累加真实帧;解析不出时按字节数兜底(不返回 0 卡住时间线)", () => {
    const buf = new Uint8Array(Buffer.concat([
      Buffer.from("fff8ca1833e64cfe", "hex"), Buffer.alloc(64, 0x11),
    ]));
    expect(sumFlacSamples(buf)).toBe(4096);
    // 完全不是帧流(无同步字)→ 回落字节估算:1024B / (2ch × 2B) = 256 样本
    expect(sumFlacSamples(new Uint8Array(Buffer.alloc(1024, 0x22)))).toBe(256);
  });
});

// ==================== 回归锁:FLAC 帧切分 + 逐帧下发契约 ====================
//
// ## 为什么必须有这组测试(2026-09-17 第六次无声事故)
//
// 设备侧 `sendspin-cpp` 的 `sync_task.cpp` 对**每个 chunk** 只调一次
// `decode_audio_chunk()`,而 micro-flac 的 `decode_frame()` **一次调用只解一帧**:
//   - 一包含多帧 → 只解第一帧,其余**静默丢弃**;
//   - 一包不足一帧 → `Serious error decoding FLAC file`,该块被丢弃。
// 旧实现(常驻 ffmpeg 管道)一次把 24 帧当**一个包**下发 →
// **1792 次报错、0 成功、完全无声**。MA(aiosendspin)无此问题是因为它用进程内
// 编码器,`encode(frame)` 天然一次一帧。
//
// 这组用例把「一包一帧」钉死为**可执行的契约**,任何回归会立刻红。
describe("splitFlacFrames(FLAC 帧切分:一包一帧的前提)", () => {
  /**
   * 构造**字节精确**的合成 FLAC 帧:`帧头 + N×VERBATIM 子帧 + CRC16`。
   *
   * ⚠️ 为什么不能用「帧头 + 纯填充字节」(2026-09-17 的失败教训):
   * `splitFlacFrames` 是**按子帧结构逐位精确推进**的(这正是「不靠同步字暴搜」的
   * 设计目的 —— 残差数据里完全可能出现 `FF F8`)。拿无法解析的填充字节当帧体,
   * 切分器读到子帧头就失败、`break`,一帧都切不出 —— 这是**正确行为**,
   * 不该为了让测试通过而放宽 walker。
   *
   * ⚠️ 为什么用 VERBATIM 而不是 CONSTANT(第二次失败教训):
   *   - CONSTANT 子帧 = `8 bit 头 + 1 × bps` 位 —— **无论多少样本,只存一个值**;
   *   - VERBATIM 子帧 = `8 bit 头 + samples × bps` 位 —— 长度随样本数增长。
   *   想要「帧体长度与样本数成正比」必须用 VERBATIM(这恰是它存在的意义:
   *   不可压缩的原始样本)。
   *
   * 布局(RFC 9639 §9.2.1 / §9.2.3):
   *   - 子帧位布局 = `pad(1) + type=1(6) + wastedFlag(0)` → 首字节 `0x02`;
   *   - 每声道恰好 `8 bit 头 + samples×bps`;立体声两声道**连续、不做字节对齐**;
   *   - 帧尾 `alignByte + CRC-16`(2B)。
   *
   * `bpsCode 4`(=16bit)→ 每声道 `samples × 2` 字节;`4096` 样本 ⇒ 帧体
   * `2 × 8192 = 16384` 字节 + 帧尾 ≤2 字节 → 帧总长 16392~16394 字节。
   *
   * @param samples     帧内样本数(须与 `bsizeCode` 表一致)
   * @param channelFill 每声道填充字节(0x00~0xFF),用于让各帧长度/内容不同
   * @param bsizeCode   帧头块大小 code(默认 12 = 4096)
   */
  function mkFrame(samples: number, channelFill = 0, bsizeCode = 12): Buffer {
    const hdr = Buffer.from([
      0xff, 0xf8,
      ((bsizeCode & 0x0f) << 4) | 0x09, // bsize code + samplerate code 9 = 48kHz
      0x18, // chanCode 0(立体声,同流默认)| bpsCode 4(16bit)| 0
      0x00, // UTF-8 帧号 0(单字节) —— 切分器不校验连续性
      0x00, // CRC-8(切分器不校验)
    ]);
    // 每声道字节数 = samples × bps ÷ 8 = samples × 2(16bit)。4096 样本 ⇒ 8192B/声道。
    const perCh = samples * 2;
    const ch0 = Buffer.alloc(perCh, channelFill);
    const ch1 = Buffer.alloc(perCh, channelFill ^ 0xff);
    // VERBATIM 子帧头(8 bit,值 0x02)+ 原始样本数据;两声道之间**不补齐到字节边界**。
    return Buffer.concat([
      hdr,
      Buffer.from([0x02]), ch0,
      Buffer.from([0x02]), ch1,
      Buffer.alloc(2, 0x22),
    ]);
  }

  it("⚠️ 空/欠数据不抛错,且如实返回残余(调用方留着等下一轮)", () => {
    expect(splitFlacFrames(new Uint8Array(0)).frames.length).toBe(0);
    expect(splitFlacFrames(new Uint8Array([0xff, 0xf8])).frames.length).toBe(0);
    // 只有帧头、没有帧体 → 一帧都切不出,残余原样保留
    const partial = new Uint8Array(Buffer.from([0xff, 0xf8, 0xc9, 0x18, 0x00, 0x00]));
    const r = splitFlacFrames(partial);
    expect(r.frames.length).toBe(0);
    expect(r.rest.length).toBe(partial.length);
  });

  it("⚠️ 容器头(fLaC + STREAMINFO + PADDING)被跳过,frames 从首个 sync 起算", () => {
    // 真实 ffmpeg 输出:容器头共 8288B —— `fLaC`(4) + STREAMINFO 块(4 头 + 34 体)
    // + PADDING 块(4 头 + 填充) ,首个 frame sync 落在 8288。
    // ⚠️ fixture 必须**真实**:STREAMINFO 块的 header 首字节是 `0x00`
    //   (last-block 位 = 0,因为后面还有 PADDING 块),PADDING 块才是 `0x81`(last)。
    //   若把 STREAMINFO 也标成 last(`0x80`),`flacFrameStreamOffset` 会在 42 处
    //   就认为容器头结束 —— 那是**正确的**解析行为,错的是 fixture。
    const paddingBody = Buffer.alloc(8288 - 42 - 4, 0);
    const paddingHeader = Buffer.alloc(4, 0);
    paddingHeader[0] = 0x81; // last-block 位 = 1,类型 1(PADDING)
    paddingHeader.writeUIntBE(paddingBody.length, 1, 3); // 24bit 大端块长度
    const container = Buffer.concat([
      Buffer.from("fLaC", "ascii"),
      Buffer.from([0x00]), Buffer.from([0, 0, 34]), Buffer.alloc(34, 0), // STREAMINFO(非 last)
      paddingHeader,
      paddingBody,
    ]);
    expect(container.length).toBe(8288);
    const buf = new Uint8Array(Buffer.concat([container, mkFrame(4096, 100)]));
    const r = splitFlacFrames(buf);
    expect(r.frames.length).toBe(1);
    expect(r.frames[0][0]).toBe(0xff); // 帧首必须是 sync,不含 fLaC
    expect(r.skippedContainerBytes).toBe(8288);
    expect(r.rest.length).toBe(0);
  });

  it("⚠️ 字节守恒:frames 长度之和 + rest 长度 === 输入长度(绝不丢/多字节)", () => {
    const frames = [mkFrame(4096, 137), mkFrame(4096, 211), mkFrame(4096, 99)];
    const tail = Buffer.from([0xff, 0xf8, 0xc9, 0x18]); // 不完整帧
    const buf = new Uint8Array(Buffer.concat([...frames, tail]));
    const r = splitFlacFrames(buf);
    expect(r.frames.length).toBe(3);
    const sum = r.frames.reduce((a, f) => a + f.length, 0) + r.rest.length;
    expect(sum).toBe(buf.length);
    expect(r.rest.length).toBe(tail.length);
  });

  it("⚠️ 每个切出的片段都以 sync 开头且能解析出帧头(无错位)", () => {
    const parts: Buffer[] = [];
    for (let i = 0; i < 12; i++) parts.push(mkFrame(4096, 80 + i * 7));
    const buf = new Uint8Array(Buffer.concat(parts));
    const r = splitFlacFrames(buf);
    expect(r.frames.length).toBe(12);
    for (const f of r.frames) {
      expect(f[0]).toBe(0xff);
      expect(f[1] & 0xfe).toBe(0xf8);
      expect(parseFlacFrameHeader(f, 0)).not.toBeNull();
      expect(parseFlacFrameHeader(f, 0)!.samples).toBe(4096);
    }
    expect(r.rest.length).toBe(0);
  });

  it("⚠️ 帧体内出现伪 sync(FF F8)也不会被误切 —— 必须按子帧结构精确推进", () => {
    // 这是「不能靠同步字暴搜」的核心原因:残差/verbatim 数据里完全可能出现 FF F8。
    // 合成帧的 VERBATIM 子帧(16bit × 4096 样本 = 8192B)恰好能容纳任意字节序列。
    const hdr = Buffer.from([0xff, 0xf8, 0xc9, 0x18, 0x00, 0x00]);
    // VERBATIM 子帧:pad(1)+type=1(6)+wastedFlag(0) → 首字节 0x02,其后 4096×16bit 原样数据
    const ch0 = Buffer.alloc(4096 * 2, 0x00);
    const ch1 = Buffer.alloc(4096 * 2, 0x00);
    // 在**第一个声道的数据区**中间埋一个伪 sync + 一个「看起来合法」的帧头
    const poison = Buffer.from([0xff, 0xf8, 0xc9, 0x18, 0x00, 0x00]);
    poison.copy(ch0, 1000);
    const verbatim = Buffer.concat([
      Buffer.from([0x02]), ch0,
      Buffer.from([0x02]), ch1,
    ]);
    const frame = Buffer.concat([hdr, verbatim, Buffer.alloc(2, 0x22)]);
    const buf = new Uint8Array(Buffer.concat([frame, mkFrame(4096, 50)]));
    const r = splitFlacFrames(buf);
    // 精确切分:第一帧长度 = frame.length(而非被伪 sync 截断)
    expect(r.frames.length).toBe(2);
    expect(r.frames[0].length).toBe(frame.length);
    expect(r.rest.length).toBe(0);
  });

  it("帧块大小 code 6／7(8／16bit 扩展)也能推进正确长度", () => {
    // ⚠️ 帧头完整字节序:`[FF][F8][bsize|sr][chan|bps|res][UTF-8 帧号][扩展][CRC-8]`
    //    —— 块大小扩展字节在**帧号之后、CRC-8 之前**。漏掉 CRC-8 会让 bodyOff 偏 1,
    //    子帧头被读成 `0x00`(CONSTANT)而不是 `0x02`(VERBATIM),帧长度直接错。
    //
    // code 6 → 紧随 UTF-8 号之后 **1** 字节,值 = samples - 1(8bit 覆盖 1..256 样本)
    const samples6 = 200;
    const ch6 = Buffer.alloc(samples6 * 2, 0x00);
    const frame6 = Buffer.concat([
      Buffer.from([0xff, 0xf8, 0x69, 0x18, 0x00, samples6 - 1, 0x00]), // + 0x00 = CRC-8 占位
      Buffer.from([0x02]), ch6,
      Buffer.from([0x02]), ch6,
      Buffer.alloc(2, 0x22),
    ]);
    const r6 = splitFlacFrames(new Uint8Array(frame6));
    expect(r6.frames.length).toBe(1);
    expect(r6.frames[0].length).toBe(frame6.length);
    expect(parseFlacFrameHeader(r6.frames[0], 0)!.samples).toBe(samples6);

    // code 7 → 紧随 UTF-8 号之后 **2** 字节,值 = samples - 1(16bit)
    const samples7 = 4608; // libFLAC/ffmpeg 都可能自选到的值
    const ch7 = Buffer.alloc(samples7 * 2, 0x00);
    const frame7 = Buffer.concat([
      Buffer.from([
        0xff, 0xf8, 0x79, 0x18, 0x00,
        (samples7 - 1) >> 8, (samples7 - 1) & 0xff, // bsize code 7 → 2 字节扩展
        0x00, // CRC-8
      ]),
      Buffer.from([0x02]), ch7,
      Buffer.from([0x02]), ch7,
      Buffer.alloc(2, 0x22),
    ]);
    const r7 = splitFlacFrames(new Uint8Array(frame7));
    expect(r7.frames.length).toBe(1);
    expect(r7.frames[0].length).toBe(frame7.length);
    expect(parseFlacFrameHeader(r7.frames[0], 0)!.samples).toBe(samples7);
  });

  it("⚠️⚠️ chanCode 4bit:mid/side(0b1010)等联合立体声不得被误判成 3 声道", () => {
    // 【2026-09-17 决定性 bug】RFC 9639 §9.1.3 的 byte3 高 4 bit 是 **channel
    // assignment**(不是 3 bit)。曾用 `>> 4 & 0x07`,于是:
    //   0b1000 left/side  → 0b000 → 1 声道
    //   0b1001 right/side → 0b001 → 2 声道(侥幸对)
    //   0b1010 mid/side   → 0b010 → **3 声道** ← 多走一个子帧 → 帧长走飞
    // libFLAC compression 0 只用独立立体声(0b0001)故侥幸通过;
    // compression ≥ 5 启用 mid/side → **全部帧切分失败**(frames=0, rest=全量)。
    // 本用例把「联合立体声 = 2 子帧」钉死。
    const samples = 4096; // 配 bsizeCode 12
    for (const [name, chanCode] of [["left/side", 0x8], ["right/side", 0x9], ["mid/side", 0xa]] as const) {
      const perCh = samples * 2;
      const frame = Buffer.concat([
        Buffer.from([
          0xff, 0xf8,
          (12 << 4) | 0x09,                 // bsize code 12(4096) + samplerate 9(48kHz)
          ((chanCode & 0x0f) << 4) | (4 << 1), // chanCode(4bit) | bps=4(16bit) | reserved 0
          0x00,                             // UTF-8 帧号 0
          0x00,                             // CRC-8 占位
        ]),
        Buffer.from([0x02]), Buffer.alloc(perCh, 0x33),
        Buffer.from([0x02]), Buffer.alloc(perCh, 0x33),
        Buffer.alloc(2, 0x22),
      ]);
      const r = splitFlacFrames(new Uint8Array(frame));
      expect(parseFlacFrameHeader(frame, 0), `${name} 帧头应被认作合法(chanCode ≤ 0b1010)`).not.toBeNull();
      expect(r.frames.length, `${name} 应切出 1 帧(2 子帧),而非误判 3 声道导致 0 帧`).toBe(1);
      expect(r.frames[0].length).toBe(frame.length);
      expect(r.rest.length).toBe(0);
    }
  });
});
