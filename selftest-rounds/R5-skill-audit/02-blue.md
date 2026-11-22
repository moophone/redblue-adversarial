# R5 蓝队处置

> **本轮无独立蓝队子代理产出。** 蓝队角色由**主控亲自执行**——理由如下，如实记录，不掩饰。

## 为什么本轮没有派独立蓝队

R5 的攻击对象是**机制自身**（`redblue.mjs` + `SKILL.md`），不是某个课题交付件。红队报出的 11 条缺陷全部是工具代码缺陷，修复动作就是改 `redblue.mjs` 源码 + 补 selftest。

派一个蓝队子代理去改工具源码的风险高于收益：本会话已记录蓝队子代理**两次零输出**（M8 非收敛 compaction、spark 1800s 超时 OUT=0B），且改源码需要精确的行级定位，子代理看不到上下文。

**所以蓝队工作由主控执行，但每一条都有机器可验的落点**：`selftest` 断言 + 实测退出码。这比蓝队自述「已修」更硬。

## 逐条处置

红队 37 条原始指控 → 去重 14 条独立缺陷 → 11 条已修、3 条记录为限制。逐条处置见上表「交付件改动」的 11 项。

## 交付件改动

| # | 文件 | 改动 | 验证 |
| --- | --- | --- | --- |
| 1 | `redblue.mjs` | 行正则 `[CNRr]` → `[A-Za-z]`；两处 | `selftest` PASS |
| 2 | `redblue.mjs` | `recount`/`gate` 0 行 → exit 2 | 实测 exit 2 |
| 3 | `redblue.mjs` | `parseVerdict` 加 `claimedLevel`，四分支全填 | `gate` 实测 `致命=10` |
| 4 | `redblue.mjs` | `tally` 加 `claimed` 独立统计 | `recount` 打印真实严重度 |
| 5 | `redblue.mjs` | `gate` 对 `t`/`claimed` 取大值 | 实测 `致命=10` |
| 6 | `redblue.mjs` | `cmdSeverity` 用 `claimedLevel`；单一级别全告警 | 实测 `WARN` exit 1 |
| 7 | `redblue.mjs` | `ADJ_VERDICT_ALIASES` 驳回/不成立 → 已结案 | 实测 `PASS` exit 0 |
| 8 | `redblue.mjs` | `cmdConverge` 加假修复检测（条件 2b） | 实测 `NOT_YET` exit 1 |
| 9 | `redblue.mjs` | `cmdCite` 无引文 → exit 2 | 实测 exit 2 |
| 10 | `redblue.mjs` | `refRe` 扩展名白名单 + 大小写不敏感 | `bundle` 可用 |
| 11 | `SKILL.md` | §8 加第 10/11/12 条限制；六维度定义；`:47` 只增不改；`:144` 加 `--track`；`:24-26` 产物位置 | 人工核对 |

## 工具哈希

| 阶段 | `redblue.mjs` |
| --- | --- |
| R5 开始 | 1148 行 / 60441 B |
| R5 结束 | **1368 行 / 77271 B / `820511CEAD33C8D7`** |

## selftest

**46 项断言，全绿，`SELFTEST_OK` exit 0。** 新增 6 项：
- 纯数字编号识别
- 带连字符编号识别
- 0 行 → exit 2（`recount` 与 `gate` 各一）
- 29 条全「一般」→ 分级失效必须报警
- 10 条「致命+未修」→ 不许放行
- `converge` 假修复 → 不许 PASS
- `adjudicate` 2 条「不成立」→ PASS

## 未处置项（诚实记录）

| 项 | 为什么没处置 |
| --- | --- |
| `bundle` 不核内容 | 需强制全量引文，会改动全部历史轮次格式；记为 §8-11 |
| `contract` 不核语义 | 只核结构的工具，语义校验不属其职责范围 |
| `audit` 对历史轮次全判无效 | 设计后果（bundle 先失败），需加显式提示，记为 §8-13 |

## SHA256

| 文件 | 字节 | 行数 | sha256 前 16 |
| --- | --- | --- | --- |
| `redblue.mjs` | 77271 | 1368 | `820511CEAD33C8D7` |
| `SKILL.md` | 30479 | 392 | `7574721005EE8A56`（修复前）→ 见 `00-frozen.txt` 最终值 |
| `02-red.md` | 51913 | 188 | `605F213A51C4E02B` |
| `03-review.md` | 9523 | — | 见 `00-frozen.txt` |
