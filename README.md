# redblue-adversarial v6.29.0 · 分发包

**红蓝对抗评审机制** —— 把「这份交付件有没有致命/严重问题」变成逐条可核对、可复算、可机器判定的文件结论。

---

## 这个包里有什么

```
redblue-adversarial-v6.29.0/
├── plugin/          ← 插件本体（装这个）
├── example/         ← 最小示例项目（照着跑一遍就懂）
├── INSTALL.md       ← 三步安装指引
└── README.md        ← 本文件
```

---

## 快速开始（5 分钟）

### 1. 装 DSH

如果还没装 DeepSeek Harness，先装。

### 2. 装插件

让 DSH 里的 agent 执行：

```
plugin_manager: action=install_bundle, target=<解压路径>\plugin
```

### 3. 配一个红队角色

在 `$DSH_HOME/subagents/` 下建 `rb-red.yaml`：

```yaml
description: 红队（只攻击）
provider: <你的provider>
model: <你的model>
maxDepth: 1
backgroundMode: continuable
persona: |
  你是红队技术审查员，只攻击不修复。
  每条必须给 文件名:行号 或 命令+输出。
```

**怎么找可用的模型**：

```bash
node plugin/tools/redblue.mjs route probe   # 测哪些有余额
node plugin/tools/redblue.mjs route pick    # 按倍率排序
```

### 4. 跑一遍示例

```bash
cd example
node ../plugin/tools/redblue.mjs project set 示例 --root=.
node ../plugin/tools/redblue.mjs init redblue/R1-001 论文-示例.md
node ../plugin/tools/redblue.mjs metrics 论文-示例.md
```

---

## 验证装好了

```bash
node plugin/tools/redblue.mjs selftest
```

**应该看到 `PASS=178 FAIL=0`。**

---

## 三个角色

| 角色 | 职责 | 约束 |
| --- | --- | --- |
| **红队** | 只攻击 | 零上下文，每条指到文件与行号，必须能复现 |
| **蓝队** | 只执行与自证 | 逐条处置，必须给复算证据 |
| **主控** | 判放行 | 跑工具出确定性结论，不靠「我觉得」 |

---

## 38 个命令（按用途分类）

| 类别 | 命令 |
| --- | --- |
| 建轮 | `init` `fp` `shortcode` `carry` |
| 派活 | `spawn` `route` `attack` |
| 查账 | `history` |
| 合并 | `merge` |
| 核引用 | `bundle` `cite` `refs` |
| 判定 | `audit` `gate` `adjudicate` `recount` `severity` |
| 收敛 | `converge` `reattack` |
| 归档 | `archive` `project` |
| 其他 | `selftest` `diff` `apply` `validate` `scancheck` `contract` `scaffold` `salvage` `checkpoint` `churn` `quality` `canary` `ident` `occur` `xcheck` `auto` `ask` `metrics` |

---

## 已知限制（如实记录）

| 限制 | 说明 |
| --- | --- |
| **跨厂商派活成功率约 15%** | 失败模式是「静默无消息」。用 `spawn --retry=N` 缓解 |
| **route 缓存有时效** | 网关按 model 动态路由，`spawn` 超过 1 小时会报警提示重测 |
| **红队写入是「按路径收窄」** | `write/edit` 直改被审件会被拒绝；但 shell 重定向没限制 |
| **复算脚本归档** | 建议归档，但无强制检查 |

---

## 版本

**v6.29.0**（2026-11-11）· 38 个子命令 · 178 条自测 · 0.37 MB

---

## 许可

（待补充）
