# Sendspin 归档文档

这里是 Sendspin 相关文档的**历史存档**。这些文档的内容已被
[`docs/sendspin-权威方案文档.md`](../../sendspin-权威方案文档.md) 合并。

> **现行权威 = `docs/sendspin-权威方案文档.md`**。本目录仅用于追溯，**不要照此施工**。
> 与权威文档冲突时，一律以权威文档为准。

## 归档清单（10 份，按原路径）

| 归档文件 | 原路径 | 内容 | 在权威文档中的落点 |
|---|---|---|---|
| `2026-09-12-sendspin-renderer-design.md` | `docs/superpowers/specs/` | 渲染器插件设计（全角色 / 三配对法 / 多房同步 / 时钟 Kalman）；含 4 处**事实订正** | §1、§2.13、§2.14、§6.3 |
| `2026-09-12-sendspin-renderer.md` | `docs/superpowers/plans/` | 实施计划（16 个 Task），含「字节级既定事实」原文 | §2.2（来源） |
| `sendspin-renderer-handoff-2026-09-13.md` | `docs/` | 任务交接日志：P0~P2 进度、握手互操作验证、架构与职责 | §1.1、§2.1 |
| `SENDSPIN_ESPHOME_DEBUG.md` | `docs/` | 真机联调手册：抓日志三法 / 抓包速查 / mDNS 速查 / 正确出声序列 / 坑位 10 条 | §7.0、§7.1、§7.3、§7.4、§7.5（坑位 10 条散入 §2.1 / §2.12 / §2.13） |
| `SENDSPIN_ESPHOME_FLAC_2026-09-17.md` | `docs/` | 真机排障与修复真相版（四个根因、端口分工、6053 只读面） | §1.3、§2.6、§2.7、§9.3 |
| `SENDSPIN_PITFALLS_2026-09-18.md` | `docs/` | 早期踩坑录（11 条 + 共同模式 + 取证顺序） | §6 A 组、§6.3、§7.8 |
| `SENDSPIN_FLAC_ROADMAP.md` | `docs/` | FLAC 专项任务书（核心矛盾、备选方案 A/B/C、约束、验收清单） | §4（全部） |
| `SENDSPIN_MA_ALIGNMENT_AUDIT.md` | `docs/` | MA 对齐审计（16 行对照表 + P0~P3 根因） | §8.1 |
| `SENDSPIN_MULTIROOM_STREAMING_PLAN.md` | `docs/` | 多房组 + 流式解码方案与施工日志 | §5（全部） |
| `sendspin-sim-player.md` | `docs/` | 协议模拟器使用说明（拨入 / 监听两模式） | §7.7 |

## 这些文档里**仍有独立价值**的部分

权威文档做了提炼，但以下内容在归档原件里更完整，需要细节时可直接查阅：

- **实现级施工日志**：`SENDSPIN_MULTIROOM_STREAMING_PLAN.md` 的 T1–T7 逐项记录、文件级改动清单。
- **实施计划的 Task 1–16 伪代码**：`2026-09-12-sendspin-renderer.md`。
- **历史 CHANGELOG 条目的对应关系**：`CHANGELOG.md` 里 `[3.0.31]`～`[3.0.36]` 引用的即这批文件名（当时路径为 `docs/`，现已归档）。
- **调试方法的完整原文**：`SENDSPIN_ESPHOME_DEBUG.md` 已整体提炼进权威文档 §7（含新增的 §7.0 症状索引），**现行调试一律以 §7 为准**。

> **关于「调试文档」**：权威文档 §7 已是完整的调试手册（症状索引 → 分层判据 → 抓日志三法 → 抓包速查 → mDNS → 受控 A/B → 模拟器 → 取证顺序），**不再单独出文件**，避免两份内容漂移。
