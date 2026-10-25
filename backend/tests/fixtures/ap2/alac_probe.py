# -*- coding: utf-8 -*-
# 批 3 联合探针：①PyAV alac 自编自解（oracle 自检）②解码 TS 编码帧（跑完即删）
import json, struct, sys
import av


def extradata(sr, ss, cc, spf):
    x = (36).to_bytes(4, "big") + b"alac" + (0).to_bytes(4, "big") + spf.to_bytes(4, "big")
    x += bytes([0, ss, 40, 10, 14, cc])
    x += (255).to_bytes(2, "big") + (0).to_bytes(4, "big") + (0).to_bytes(4, "big")
    x += sr.to_bytes(4, "big")
    return x


def make_ctx(sr, ss, cc, spf):
    ctx = av.codec.CodecContext.create(av.codec.Codec("alac", "r"))
    ctx.extradata = extradata(sr, ss, cc, spf)
    ctx.sample_rate = sr
    try:
        ctx.channels = cc
    except AttributeError:
        ctx.layout = "stereo"
    ctx.format = av.AudioFormat("s" + str(ss) + "p")
    return ctx


class BitW:
    def __init__(self):
        self.bits = []

    def put(self, v, n):
        for i in range(n - 1, -1, -1):
            self.bits.append((v >> i) & 1)

    def bytes(self):
        out = bytearray((len(self.bits) + 7) // 8)
        for i, b in enumerate(self.bits):
            if b:
                out[i >> 3] |= 0x80 >> (i & 7)
        return bytes(out)


def py_escape_frame(pcm, spf):
    w = BitW()
    w.put(1, 3)     # TYPE_CPE
    w.put(0, 4)     # instance tag
    w.put(0, 12)    # reserved
    w.put(1, 1)     # has_size
    w.put(spf, 32)
    w.put(0, 2)     # extra_bits
    w.put(0, 1)     # uncompressed
    for i in range(spf):
        for ch in range(2):
            w.put(struct.unpack_from("<h", pcm, (i * 2 + ch) * 2)[0] & 0xFFFF, 16)
    w.put(7, 3)     # TYPE_END
    return w.bytes()


def decode_all(ctx, frames):
    resampler = av.AudioResampler(format=av.AudioFormat("s16").packed, rate=44100, layout="stereo")
    out = b""
    for f in frames:
        for fr in ctx.decode(av.packet.Packet(f)):
            r = resampler.resample(fr)
            if isinstance(r, list):
                r = r[0]
            out += bytes(r.planes[0])
    return out


sr, ss, cc, spf = 44100, 16, 2, 352
pcm = bytes(((i * 7 + ((i * i) >> 3)) % 65536) & 0xFF for i in range(spf * 2 * 2))  # 任意模式

print("== oracle self-check: python encode -> decode")
frame = py_escape_frame(pcm, spf)
print("frame len:", len(frame))
ctx = make_ctx(sr, ss, cc, spf)
try:
    got = decode_all(ctx, [frame])
    print("decoded:", len(got), "match:", got == pcm)
except Exception as e:
    print("SELF DECODE FAILED:", repr(e))

print("== TS frames from cfg")
cfg = json.load(open(sys.argv[1], encoding="utf-8"))
frames = [bytes.fromhex(h) for h in cfg["frames"]]
print("ts frame len:", len(frames[0]))
ctx2 = make_ctx(sr, ss, cc, spf)
try:
    got2 = decode_all(ctx2, frames)
    print("decoded:", len(got2), "expect:", len(cfg["expect_pcm_hex"]) // 2,
          "match:", got2.hex() == cfg["expect_pcm_hex"])
except Exception as e:
    print("TS DECODE FAILED:", repr(e))
