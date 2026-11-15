# redblue-adversarial · 红蓝对抗评审机制

把「这份交付件有没有致命/严重问题」变成**逐条可核对、可复算、可机器判定**的文件结论。

三个角色，一个对话：

| 角色 | 职责 | 约束 |
| --- | --- | --- |
| **红队** | 只攻击 | 零上下文，独立发现，每条指到文件与行号，必须能复现 |
| **蓝队** | 只执行与自证 | 逐条处置，不许辩解，必须给复算证据 |
| **主控** | 判放行 | 跑 `redblue.mjs` 出确定性结论，不靠「我觉得」 |

**闸门只认脚本，不认人话。**

---

## 安装

### 方式一：本地安装（开发/试用）

```bash
# 1. 把本目录放到任意位置
# 2. 在 DSH 里执行（或让 agent 执行）
#    plugin_manager: action=install_bundle, target=<本目录绝对路径>
```

安装后插件会挂载到当前 profile，重启 DSH 生效。

### 方式二：从市场安装（发布后）

```
（待发布到 DSH 插件市场后补充）
```

### 依赖

| 依赖 | 必需 | 说明 |
| --- | --- | --- |
| **DSH**（DeepSeek Harness） | ✅ | 插件是 DSH bundle，需要 DSH 运行时 |
| **node** | ✅ | `redblue.mjs` 是 Node ESM 脚本；DSH 自带 node |
| **Python 3**（可选） | ❌ | 复算脚本用；DSH 自带捆绑 Python（pandas/numpy） |
| **`$DSH_HOME/subagents/*.yaml`** | ✅ | 红蓝队角色定义，`delegate(library_id=...)` 调用 |

**不需要**：anaconda、额外 npm 包、数据库。

---

## 快速开始

```bash
# 1. 建项目配置（记住路径，以后不用重贴）
node tools/redblue.mjs project set 我的项目 --root="D:\path\to\project" --journal=JRP

# 2. 建轮次（冻结当前稿）
node tools/redblue.mjs init "D:\path\to\project\redblue\R1-001" "D:\path\to\project\论文.md"

# 3. 生成红队任务包（一条命令出 3 份备选）
node tools/redblue.mjs spawn "D:\path\to\project\论文.md" --roles=tech,devil --retry=3 --out="D:\path\to\project\redblue\R1-001\_pack.md"

# 4. 派红队（用任务包里的 library_id）
#    delegate(library_id="rb-r1-tech")  ← 失败就换 rb-r1-devil

# 5. 记账（成功与失败都要记）
node tools/redblue.mjs attack record <轮次目录> <provider> <model> <靶件> tech
node tools/redblue.mjs attack fail <轮次目录> <provider> <model> "原因"

# 6. 合并红队意见
node tools/redblue.mjs merge <轮次目录> <意见1.md> <意见2.md> --out=<轮次目录>\01-cases.md

# 7. 判定链
node tools/redblue.mjs bundle  <轮次目录>\03-review.md
node tools/redblue.mjs audit   <轮次目录>
node tools/redblue.mjs gate    <轮次目录>\03-review.md
node tools/redblue.mjs adjudicate <轮次目录>\03-review.md

# 8. 收敛 + 归档
node tools/redblue.mjs converge <轮次根>
node tools/redblue.mjs archive <轮次目录> --tag=R1
```

---

## 命令表（38 个）

| 类别 | 命令 | 用途 |
| --- | --- | --- |
| **建轮** | `init` `fp` `shortcode` `carry` | 建轮次、冻结指纹、生成短码、带旧账 |
| **派活** | `spawn` `route` `attack` | 出任务包、探模型选厂商、记账 |
| **查账** | `history` | 查某个数字/说法在历史轮次里有没有被处置过 |
| **合并** | `merge` | 合并红队意见、去重、编号 |
| **核引用** | `bundle` `cite` `refs` | 引用落地、引用内容、回原文 |
| **判定** | `audit` `gate` `adjudicate` `recount` `severity` | 轮次完整、闸门、三态、计数、校准 |
| **收敛** | `converge` `reattack` | 收敛判据、跨轮再攻击 |
| **归档** | `archive` `project` | 一键归档、项目配置 |
| **工具** | `selftest` `diff` `apply` `validate` `scancheck` `contract` `scaffold` `salvage` `checkpoint` `metrics` `churn` `quality` `canary` `ident` `occur` `xcheck` `auto` `ask` | 自测、对比、应用、校验、反查、契约、铺开、抢救、增量落盘、体量、浪费、精确率、召回标定、恒等式、出现次数、双路互校、自动续跑、求助包 |

**每轮必用**：`init` `fp` `shortcode` `spawn` `route` `attack` `history` `merge` `bundle` `audit` `gate` `adjudicate` `converge` `archive` `selftest`

---

## 核心设计

### 1. 闸门只认脚本

每一类解析缺陷都有同一个签名——**解析出比实际少的行却静默 exit 0**。所以：

- **0 行一律 `UNDECIDABLE`（exit 2）**，绝不 PASS
- 所有判定落到文件，可复算

### 2. 引用内容自动附

`bundle` 不只核「行号在范围内」，还**打印该行原文**。实测：不过滤时引用错行三轮无人发现，加了附引文后一眼可见。

### 3. 查历史账（防幻觉）

```
node redblue.mjs history "<项目根>" "3.31"
```

命中「已处置/已验证」的，别再当新问题。**实测教训**：R15 里主控把 `χ²=3.31` 当成「溯源不到」的新缺陷，实际 R12 早已复算确认——根因是没人查账。

### 4. 一次出 N 份备选（防低成功率）

```
node tools/redblue.mjs spawn <靶件> --retry=3
```

实测跨厂商派活成功率只有 **15%**（13 派 2 成）。`--retry=3` 生成 3 份不同 provider 组合的任务包，依次派直到成功。

### 5. 数字清单（防不可复现）

`spawn` 会列出靶件里所有带小数点的数字，红队逐个查 `history`。

---

## 已知限制（如实记录）

| 限制 | 说明 |
| --- | --- |
| **跨厂商派活成功率约 15%** | 失败模式是「静默无消息」。用 `--retry=N` 缓解 |
| **route-cache 有时效** | 网关按 model 动态路由，几小时前可用的组合现在可能不可用。`spawn` 超过 1 小时会报警 |
| **红队只读是「按路径收窄」** | `write/edit` 直改被审件会被 runtime guard 拒绝；但 `pwsh "echo > 文件"` 这类 shell 写入**没有**限制（需要沙箱级 ACL，那是 DSH 的事） |
| **`subagentModelSelection` 默认关闭** | 显式 `subagent(provider=..., model=...)` 会被拒；用 `delegate(library_id=...)` 走具名库 |
| **复算脚本归档** | 评审记录里的复算数字，其脚本应一并归档；否则后人无法复现 |

---

## 目录结构

```
redblue-bundle/
├── package.json              # DSH bundle 清单
├── cordis.patch.yml          # 注入 runtime guard（红队写入面收敛）
├── index.js                  # runtime 入口（agent.ctx.tools.guard）
├── skills/
│   └── redblue-adversarial/
│       ├── SKILL.md          # 技能正文（1328 行，含 §0-§10 全部规范）
│       └── tools/            # 辅助脚本（rb-run、route-*.yml）
├── tools/
│   └── redblue.mjs           # 确定性判定工具（38 个子命令，178 条自测）
├── docs/                     # 协议、角色卡、模板、错误类型
├── CHANGES.md                # 变更记录
└── README.md                 # 本文件
```

---

## 版本

**v6.29.0**（2026-11-11）

- 38 个子命令 / 178 条自测
- 新增 `history`、`spawn --retry=N`、数字清单、缓存过期报警
- 修复：硬编码路径（可移植性）、产物目录名不一致（runtime guard 会拒绝红队写自己的用例）

---

## 许可

（待补充）
