# Sendspin 模拟播放器使用说明

联调 MusicFlow Sendspin 服务端用的两个官方协议模拟器,均基于官方
`aiosendspin 9.x`(含 Noise 加密握手,与服务端互操作已验证)。
脚本在 `backend/scripts/` 下:`sendspin-sim-player.py`(拨入模式)、
`sendspin-sim-listener.py`(监听模式)。

## 准备环境

```bash
python3 -m venv /tmp/sendspin-venv
/tmp/sendspin-venv/bin/pip install "aiosendspin==9.1.1"
```

要求 Python ≥ 3.12。注意官方 `sendspin` CLI(播放器)至今还 pin 着
`aiosendspin~=6.0.1`(前加密时代),连不上合规加密服务端,不要用它联调。

## 模式一:拨入模式(模拟普通播放器上线)

播放器主动连服务端,上线后以 `sendspin:<clientId>` 出现在 `/v1/peers`。

```bash
/tmp/sendspin-venv/bin/python backend/scripts/sendspin-sim-player.py \
  ws://<服务端IP>:8927/sendspin [静态配对码]
```

- 不带配对码:以未配对访问(UNPAIRED)上线,能播(需服务端允许未配对播放)。
- 带 8 位静态码(如 `12345678`):同时打开配对窗口,可走设置页静态码配对全流程。
- `SIM_LOG=DEBUG` 看握手/配对详细日志。
- 收到音频会打 `[audio] chunks=... bytes=...` 日志,只计数不放音(无声卡依赖)。

## 模式二:监听模式(模拟可被拨号的播放器)

播放器在 `:8928` 监听等服务端来拨,对应播放器页"添加播放器"填 IP 的流程。

```bash
/tmp/sendspin-venv/bin/python backend/scripts/sendspin-sim-listener.py [端口] [名字]
# 缺省:端口 18931,名字 MF-Listen-Speaker
```

- 监听 `0.0.0.0:<端口>/sendspin`,mDNS 不广播(手动填 IP 即可)。
- 服务端拨入后完成握手并激活,日志显示 `server attached, admitted`。
- 同样只计数音频帧,不放音。

## 联调对照表

| 步骤 | 服务端日志 | 模拟器日志 |
|---|---|---|
| 连上 | `new connection from` | `CONNECTED+ADMITTED` / `server attached` |
| 握手通过 | `handshake ok: <clientId>` | (无报错即过) |
| 激活注册 | `activated <clientId> name=...` / `registered Sendspin client` | — |
| 推流到达 | (按组推帧,无单帧日志) | `[audio] chunks=N bytes=M fmt=...` |

## 常见问题

- **连上但 `chunks=0`**：看 `fmt=` 的 codec 是否在客户端声明的 `supported_formats` 里;
  服务端按客户端优先级协商 opus/flac/pcm,协商失败客户端拒收。
- **`pairing_required` 被拒**：未配对会话要开客户端 `unpaired_access`
  (拨入模拟器默认已开),或走正式配对流程。
- **连不上 8927**：先确认服务端插件 `sendspin-renderer` 已启用、
  端口配置(默认 8927)与防火墙;`curl` 能拿到 `101` 即 WS 通路正常。
- **拨号模式连不上 8928**：确认模拟器在监听(`ss -tlnp | grep 8928`),
  服务端 `POST /v1/sendspin/dial` 填的是播放器 IP、端口 8928。
