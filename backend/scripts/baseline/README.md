# 播放基线工具（baseline）

判定「播放链路有没有被改坏」的三件套。口径与阈值推导见
[`docs/播放基线-基准值与判读-20261126.md`](../../../docs/播放基线-基准值与判读-20261126.md)，
采集器可运行示例见 [`docs/examples/baseline_sampler.example.py`](../../../docs/examples/baseline_sampler.example.py)。

| 文件 | 作用 | 需要真机 | 凭据 |
|---|---|---|---|
| `baseline_cap.py` | 离线分析 `base.jsonl` → 统计 JSON（A 层 tick/ring/prog + B 层 status 偏差） | 需要样本文件 | 无 |
| `baseline_guard.py` | 用基准 JSON 判读一份样本，输出 PASS/FAIL/WARN 与退出码 | 现场采集时需要 | 无 |
| `invariant_guard.py` | CI 模拟播放判据：**绝对阈值**，不依赖真机基准（0=PASS/1=指标 FAIL/2=环境问题） | **不需要** | 无 |
| `selftest.py` | 判读器自检（CI blocking，45 条断言），fixtures 驱动 | **不需要** | 无 |
| `ci_sim_playback.sh` | GitHub runner 上的模拟 AirPlay 播放全流程（起镜像 → 建组起播 → 采样 → 判读） | **不需要** | 测试用户 `ci-probe` |
| `fixtures/*.json` | 三份真实样本：正常基准 / 前版正常 / 真实回归反例（**设备 key 已脱敏为 `DEVICE_*`**，只用于判读器回归，不可用于判真机样本） | — | 无 |

采集器本体（会调 `/rest/api/v1`，要 Basic 认证）不在本目录，脱敏示例在 `docs/examples/`。

## 一、为什么不拿 `/status` 当基准

`/status` 出口有四类已知缺陷：位置整秒量化、group 与成员口径差 ≈2s、换曲窗口两组描述不同曲目、
`updatedAt` 每次 poll 刷成 now（外推形同虚设）。所以判定只锚在**内部真值**上：

- **A 层（判死用）**：`tick`（桥投递 + 设备实收）、`ring`（设备水位）、`prog`（内部播放位置）
- **B 层（只记录）**：`/status` 出口值相对 A 层的偏差、`uaAge`、回退次数

关键量：`deltaUs` = 设备出音前沿 − 锚点。正常 1.56~2.06s、零负值；**为负 = 位置超过了已投递内容 = 可听缺口**。
`inQueueMs` 超过设备容量 4163ms = 投递过量；`realigned` 是同 `gen` 内恒 0 的阶跃量（换曲才爆发，短窗口为 0 不能单靠它判死）。

## 二、部署（在能读容器日志的主机上）

```bash
mkdir -p /root/mf_watch/baseline
cp backend/scripts/baseline/baseline_cap.py     /root/mf_watch/
cp backend/scripts/baseline/baseline_guard.py   /root/mf_watch/
cp docs/examples/baseline_sampler.example.py    /root/mf_watch/base_sampler.py
cp backend/scripts/baseline/fixtures/*.json     /root/mf_watch/baseline/
```

凭据只放 `/root/mf_watch/mf.env`（`chmod 600`），由 systemd 注入，**绝不进仓库**：

```bash
MF_USER=<用户名>
MF_PASS=<口令>
MF_GROUP_ID=<组 UUID>
MF_DEVICES=<AirPlay设备MAC1>,<AirPlay设备MAC2>
MF_OUTDIR=/root/mf_watch
MF_CONTAINER=musicflow
MF_BASE_URL=http://127.0.0.1:46400
```

常驻：采样器 `mf-sampler.service`（`EnvironmentFile=/root/mf_watch/mf.env`），
守卫 `mf-guard.timer` 每 5 分钟 `baseline_guard.py --window 10 --quiet`，异常写 `GUARD_ALERT.log` 且退出码 1。

路径可用 `MF_WATCH_DIR` 覆盖（默认 `/root/mf_watch`，即上述布局），容器名/镜像名分别用
`MF_CONTAINER` / `MF_IMAGE`，解释器用 `MF_PYTHON`。

## 三、日常用法

```bash
# 采一份基准（窗口 24 分钟）
python3 baseline_cap.py --window 24 --label v4.16.0 --out baseline/base_v4.16.0.json

# 回看历史区间（做 A/B 对照）
python3 baseline_cap.py --window 15 --end 01:20:00 --label bad

# 判读当前（现场采集）：0=过 1=FAIL 2=环境问题
python3 baseline_guard.py --window 10
python3 baseline_guard.py --window 10 --verbose        # 附带 B 层偏差

# 判读已有样本（不重新采集；CI 与离线复盘都走这条）
python3 baseline_guard.py --baseline baseline/base_v4.15.8.json --input /tmp/cap.json --strict-devices
```

判死顺序：`silenceChunks` → `deltaUs<0` → `inQueueMs>4163` → `realigned` 暴涨 → `late` 暴涨。
两台设备**对称**出问题 = 服务端；**单台** = 该设备链路。

## 四、CI 三层（`.github/workflows/playback-baseline.yml`）

- **L0 `sim-e2e`**（`ubuntu-latest`，tag / 手动触发）
  在 runner 自己的 docker 里起**被测镜像**（等 `build.yml` 推完，最多 25 分钟），
  同时起一个 `shairport-sync` 模拟 AirPlay 接收端（广播 `_raop._tcp`，输出到 FIFO 丢弃），
  然后真实走：启用 airplay 插件 → 等设备上线 → 建本地媒体源 + 生成 3 分钟正弦音 →
  建组 → `queue/play` → 采样 `MF_MINUTES` 分钟 → `baseline_cap.py` → `invariant_guard.py`。
  **为什么模拟 AirPlay 而不是 sendspin**：A 层 `ev:"tick"` / `ring-diag` /
  `deltaUs` / `inQueueMs` 全部由 `services/airplay/bridgeSession.ts` 在服务端计算，
  sendspin 模拟端不产生这些字段。
  判据是绝对不变量（`deltaUs p50 ∈ [0.5,4]s` 且 `negPct≤1%`、`inQueueMs p95≤4163ms`、
  `overCapPct≤5%`、`realigned/min≤30`、`advanceRate∈[0.98,1.02]`），
  因此不需要真机基准，也不会因为模拟设备 key 不同就假 FAIL。
  样本不足（tick<20）算**环境问题 exit 2**，不冒充指标 FAIL。
- **L1 `judge-selftest`**（`ubuntu-latest`，blocking，push/PR/tag 都跑）
  `selftest.py` 用 fixtures 断言：正常样本必须 PASS、v4.15.9 反例必须命中 ≥7 条且覆盖五类判据、
  放大容差后对应红必须消失（证明阈值真有牙齿）、7 个容差常量字面量指纹、设备失配在 strict 下必须 FAIL、
  CLI 退出码 0/1/2 语义。
  **它防的是「守卫被改软」**——否则线上永远绿，等于没有守卫。
- **L2 `live-check`**（`[self-hosted, musicflow-live]`，非阻塞）
  对现网真机采 `--window 12` 后判读，结果写 Job Summary + artifact。
  基准取**宿主机** `${MF_WATCH_DIR}/baseline/base_v4.15.8.json`（含真实设备 key）——仓库 fixtures 已脱敏，
  拿它判真机样本会全员 strict FAIL；宿主机缺基准时 job 直接 exit 2 并给出采集命令。
  默认关闭：需仓库变量 `MF_LIVE_CHECK=true`（可选 `MF_WATCH_DIR`）且内网 runner 具备
  docker 权限（`baseline_cap.py` 用 `docker exec` 取 dist 指纹）。

> L0/L2 刻意**不挂在 `build.yml` 的 needs 链上**：tag CI 的门禁失败会触发回滚 job，
> 把 GHCR/DockerHub 的 `:X.Y.Z` 与 `:latest` 打回旧 digest。体检只出报告，不允许反向动镜像。

真机体检要人等设备出声，因此 tag 触发时若不满足条件（没人播、设备离线），
判定会因样本不足而 FAIL —— 这是**期望行为**（缺数据不许当通过），但要读 Job Summary 区分
「链路坏了」与「没采到」。

## 五、维护规则

1. 容差常量（`TOL_*`）改动必须同时改：本目录 `selftest.py` 的 `PINS`、基线文档 §4 的推导。
   三者不一致 CI 直接红。
2. 新采的基准替换 `fixtures/base_*.json` 时，`selftest.py` 的 `BAD_MUST_HIT` 必须仍然全部命中
   （即新基准要能把 v4.15.9 反例判红）。
3. 采样器改动同步 `docs/examples/baseline_sampler.example.py` 与手册附录 C。
4. `invariant_guard.py` 的阈值常量改动必须同步 `selftest.py` §9 与基线文档 §4；
   改 `ci_sim_playback.sh` 的接口调用前先用 `bash -n` + tag 手动跑一轮 L0。
