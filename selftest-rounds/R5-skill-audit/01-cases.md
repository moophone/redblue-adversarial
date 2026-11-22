# R5 用例表

> **本轮无独立 01-cases.md。** 红队任务书（`_prompt-red.md`）直接给了攻击面，红队自建 20 个探测件放在 `_probe/`。
> 这不是漏做，是 R5 的方法本身：**不给用例清单，让红队自己造输入**——否则红队只会照着清单打，重演 R1–R3 的「用例集冻结」。
> R5 的实际用例集 = `_probe/` 下 20 个 fixture，清单见下。

## 实际用例集（红队自建，非主控给定）

| 探测件 | 攻击面 | 结果 |
| --- | --- | --- |
| `e1-num-ids.md` | 纯数字编号 | **抓到致命 1** |
| `e11-dashed-id.md` | 带连字符编号 | **抓到致命 1** |
| `e12-empty-review.md` | 空表 | **抓到致命 1** |
| `e11b-nodash.md` | 编码不一致（GBK） | 部分（红队自身污染） |
| `e4-adj-bufounding.md` | `不成立` 行带级别 | **抓到严重 1** |
| `e7b-r5-cformat.md` | 29 条全「一般」 | **抓到严重 1** |
| `n05-fatal-unfixed.md` | 级别列 vs 状态列 | **抓到致命 1** |
| `bt\claim.md` + `bt\protocol.md` | `bundle` 不核内容 | **抓到严重 1** |
| `rounds/R2-convA` / `R2-convB` | `converge` 假修复 | **抓到致命 1** |
| `n-adjudicate-rejected.md` | `adjudicate` 驳回语义 | **抓到严重 1** |
| `e9-level-status-collide.md` | 级别/状态列冲突 | 成立（同 N05） |
| `e10-documented-format-silent-pass.md` | 文档格式静默通过 | 设计如此 |
| `e9b-single-fatal-fixed.md` | 单条致命已修 | 控制组，正确 |
| `e11c-ctrl.md` | UTF-8 控制组 | 控制组，正确 |
| `e5-legacy-bufounding.md` | 旧格式三态 | **抓到一般 1** |
| `e1b-qualified-level.md` | 级别带括号注 | 正确解析 |
| `e1c-valid-id-paren-level.md` | 同上变体 | 正确解析 |
| `e7-r5-format.md` | R5 新格式 | 正确解析 |
| `SKILL-pin-R5.md` | 快照钉住 | 方法学 |
| `rb-pin-R5.mjs` | 工具快照钉住 | 方法学 |

## 维度覆盖

| 六通用维度 | 覆盖 | 说明 |
| --- | --- | --- |
| 结论 vs 证据 | 覆盖 | 每条判定都带 fixture 路径 + 实测退出码 |
| 口径一致性 | 覆盖 | `recount`/`gate`/`severity`/`converge`/`reattack`/`adjudicate` 六个命令口径互比 |
| 可比性前提 | 覆盖 | 新旧格式、UTF-8/GBK、数字/连字符/字母三种编号体系 |
| 证据链完整性 | 覆盖 | 每条修复都有 selftest 断言 + 实测命令 |
| 范围与适用性 | 不覆盖 | 未测 >100 行大表、未测并发写同一 round 目录 |
| 可复算性 | 覆盖 | 全部命令可重放；`00-frozen.txt` 已冻结哈希 |

## 不覆盖

| 项 | 原因 |
| --- | --- |
| `init`/`fp`/`diff`/`shortcode`/`contract`/`scaffold`/`salvage`/`checkpoint`/`validate` | 红队未构造探测（9 个子命令） |
| `SKILL.md` §0–§2、§5–§7 | 只逐句核了 §3/§4/§8/§9 |
| 并发 | 两红队同时写同一 round 目录未测 |
| 大表 | >100 行复核表未测性能与截断 |
