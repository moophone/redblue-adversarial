# 安装指南 · redblue-adversarial v6.29.0

**三步装好。全程约 5 分钟。**

---

## 前置：你需要有什么

| 必需 | 说明 |
| --- | --- |
| **DSH**（DeepSeek Harness） | 插件是 DSH 的 bundle，必须先装 DSH |
| **一个能用的 LLM 模型** | 红蓝队要跑在模型上；DSH 自带的模型或你自己配的都行 |
| **node** | DSH 自带，不用另外装 |

**不需要**：anaconda、额外 npm 包、数据库、Python（除非要跑复算脚本）。

---

## 第一步：装 DSH

如果还没装 DSH，先去装。装好后 DSH 会自带 node 运行时。

---

## 第二步：装插件

**方式 A（推荐）**：让 DSH 里的 agent 执行

```
plugin_manager: action=install_bundle, target=<解压后的 plugin 目录绝对路径>
```

**方式 B**：命令行

```bash
dsh plugin --profile <你的profile> add <plugin目录>
```

装完重启 DSH 生效。

**验证装好了**：

```bash
node <plugin目录>/tools/redblue.mjs selftest
```

看到 `PASS=178 FAIL=0` 就是好的。

---

## 第三步：配红蓝队角色

红蓝队是**具名子代理**，每个角色一个 YAML 文件，放在 `$DSH_HOME/subagents/`。

`$DSH_HOME` 是你的 DSH 主目录（Windows 通常是 `%USERPROFILE%\.dsh`，如果你改过就用你改的那个）。

**最小配置**（两个角色就够）：

`$DSH_HOME/subagents/rb-red.yaml`
```yaml
description: 红队（只攻击）
provider: <你的provider>
model: <你的model>
maxDepth: 1
backgroundMode: continuable
persona: |
  你是红队技术审查员，只攻击不修复。
  每条必须给 文件名:行号 或 命令+输出。
  算不出来写「未复算，原因：…」，不许猜。
```

`$DSH_HOME/subagents/rb-blue.yaml`
```yaml
description: 蓝队（只执行与自证）
provider: <你的provider>
model: <你的model>
maxDepth: 1
backgroundMode: continuable
persona: |
  你是蓝队，逐条处置红队用例，必须给复算证据，不许辩解。
```

**怎么找可用的 provider/model**：

```bash
node <plugin目录>/tools/redblue.mjs route probe
```

它会实发最小请求测出哪些模型现在有额度，结果存进缓存。然后：

```bash
node <plugin目录>/tools/redblue.mjs route pick
```

按倍率从低到高列出可用组合。挑一个填进你的 YAML。

---

## 跑起来（最小流程）

```bash
# 1. 建项目配置（记住路径，以后不用重贴）
node <plugin目录>/tools/redblue.mjs project set 我的项目 --root="D:\path\to\project"

# 2. 建轮次
node <plugin目录>/tools/redblue.mjs init "D:\path\to\project\redblue\R1-001" "D:\path\to\project\论文.md"

# 3. 生成红队任务包
node <plugin目录>/tools/redblue.mjs spawn "D:\path\to\project\论文.md" --roles=tech --retry=3 --out="D:\path\to\project\redblue\R1-001\_pack.md"

# 4. 派红队（在 DSH 里让 agent 执行）
#    delegate(library_id="rb-red", prompt=<任务包里的 prompt>)

# 5. 记账
node <plugin目录>/tools/redblue.mjs attack record <轮次目录> <provider> <model> <靶件> tech

# 6. 合并意见
node <plugin目录>/tools/redblue.mjs merge <轮次目录> <意见.md> --out=<轮次目录>\01-cases.md

# 7. 判定链
node <plugin目录>/tools/redblue.mjs bundle  <轮次目录>\03-review.md
node <plugin目录>/tools/redblue.mjs gate    <轮次目录>\03-review.md
node <plugin目录>/tools/redblue.mjs adjudicate <轮次目录>\03-review.md

# 8. 归档
node <plugin目录>/tools/redblue.mjs archive <轮次目录> --tag=R1
```

---

## 常见问题

| 问题 | 原因 | 解决 |
| --- | --- | --- |
| `route probe` 全部 FAIL | 网关没起 / 密钥没配 | 检查 DSH 的模型配置 |
| `delegate` 派出去没动静 | 该模型当子代理不工作 | 换一个模型（`--retry=N` 就是为此设计的） |
| `bundle` 报 MISSING | 引用文件不在搜索范围 | 加 `--root=<项目根>` |
| `merge` 报 UNDERCOUNT | 红队格式不认识 | 看提示，把新格式加进解析器 |
| 装插件报 JSON 错误 | package.json 有 BOM | 用 node 重写，别用 PowerShell 的 `Set-Content` |

---

## 更多

- **README.md**（插件根目录）：完整命令表、设计说明、已知限制
- **SKILL.md**：机制完整规范（1351 行，含全部踩过的坑）
- **example/**：一个最小示例项目，照着跑一遍就懂了

---

## 版本

**v6.29.0**（2026-11-11）· 38 个子命令 · 178 条自测
