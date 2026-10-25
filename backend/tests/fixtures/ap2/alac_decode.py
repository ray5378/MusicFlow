# -*- coding: utf-8 -*-
# 批 3 ALAC 解码 oracle：用床 venv PyAV（=ffmpeg alac 解码器）解码 TS 编码的 escape 帧。
# 用法: /root/ap2venv/bin/python alac_decode.py <cfg.json> <out.pcm>
# cfg: {"sr":44100, "ss":16, "cc":2, "spf":352, "frames":["<hex>",...]}
import sys, json
import av


def extradata(sr, ss, cc, spf):
    # 与 bed audio.py AudioSetup.get_extra_data 逐字对齐（36B QuickTime atom）
    x = (36).to_bytes(4, "big") + b"alac" + (0).to_bytes(4, "big") + spf.to_bytes(4, "big")
    x += bytes([0, ss, 40, 10, 14, cc])
    x += (255).to_bytes(2, "big") + (0).to_bytes(4, "big") + (0).to_bytes(4, "big")
    x += sr.to_bytes(4, "big")
    return x


def main():
    cfg = json.load(open(sys.argv[1], encoding="utf-8"))
    sr, ss, cc, spf = cfg["sr"], cfg["ss"], cfg["cc"], cfg["spf"]
    ctx = av.codec.CodecContext.create(av.codec.Codec("alac", "r"))
    ctx.extradata = extradata(sr, ss, cc, spf)
    ctx.sample_rate = sr
    try:
        ctx.channels = cc  # PyAV <= 12
    except AttributeError:
        ctx.layout = "stereo"
    ctx.format = av.AudioFormat("s" + str(ss) + "p")
    resampler = av.AudioResampler(
        format=av.AudioFormat("s" + str(ss)).packed, rate=sr, layout="stereo"
    )
    out = b""
    for fhex in cfg["frames"]:
        pkt = av.packet.Packet(bytes.fromhex(fhex))
        for frame in ctx.decode(pkt):
            fr = resampler.resample(frame)
            if isinstance(fr, list):
                fr = fr[0]
            out += bytes(fr.planes[0])
    open(sys.argv[2], "wb").write(out)
    print("decoded", len(out), "bytes")


main()
