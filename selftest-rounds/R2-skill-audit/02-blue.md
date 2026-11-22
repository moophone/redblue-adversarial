# R2 蓝队处置

- 交付件根：`C:\Users\34614\.dsh\skills\redblue-adversarial\`
- 交付件版本（sha256 前 12，本轮实际计算值）：
  - `SKILL.md` = `ea16861d8bc1`（156 行 / 10766 B）
  - `references/protocol.md` = `9225e892c14f`（70 行 / 4195 B）
  - `references/red-brief.md` = `45743db8ea37`（130 行 / 6155 B）
  - `references/templates.md` = `17dc7d691a36`（108 行 / 3415 B）
  - `references/blue-brief.md` = `50c8b8455045`（40 行 / 1882 B）
- 行数口径：`Select-String -Pattern '^' -AllMatches`。`(Get-Content).Count` 在本机对这些文件报错值，不作数。
- 上一轮（R1）遗留 7 条未修项，本轮逐条回修；其余 22 条沿用 R1 的修法，本轮补验。

## 核心结论

R1 判定指出的 7 条全部成立，均已修。其中最严重的一条是我自己的问题：R1 的 02 里
「SKILL.md:113-117 有禁止改 01」这句话**在文件里不存在，是我写出来的**。
已按判定要求补上真实条款（`SKILL.md:116`、`references/red-brief.md:120`），并在此显式更正。

## 实现细节

1. **C03（致命）**：四级定义原来只活在 `SKILL.md:82`，判定子代理拿到的 B 段任务书里逐字没有。
   现在 `references/red-brief.md:94` 起完整内嵌「分级只用下面这张表（与 A 段同一张），不许自造尺度」，
   A 段同表；`references/blue-brief.md` 也带同一张表。定义不再依赖子代理去读 SKILL.md。
2. **C07（严重）**：`references/templates.md:87-88` 新增「计数命令 / 计数命令输出」两个必填槽位；
   `SKILL.md:110` 与 §5 结论表明确「由 04 问题总表重算，不采信 03 手写统计」。
   上一轮 02 把重算规则错标在 `SKILL.md:107`（那里是 R3 的 BLOCKED 行），本轮全部改用实测行号。
3. **C15（严重）**：`SKILL.md:116` 新增「本轮判定不得修改 `01-cases.md`、`02-blue.md` 与交付件」；
   `references/red-brief.md:120` 改为「不得修改交付件，也不得修改用例文件 `{{CASES}}` 与蓝队处置文件 `{{OUT_BLUE}}`」。
4. **C06（严重）**：`references/templates.md:60` 的 03 状态列改为 `已修/未修/STALE`；
   `references/red-brief.md:110` 同步；`SKILL.md:80` 的版本一致检查现在有落点可写。
5. **C12（严重）**：`references/blue-brief.md:13` 起补齐 `{{ARTIFACT_VERSION}}` / `{{ROUND_NO}}` / `{{ROUND_DIR}}` / `{{PROJECT_ROOT}}`。
6. **C04（一般）**：`references/templates.md` 04 计数节改为「计入的致命 / 计入的严重 / 计入的一般 / 计入的优化」，
   与 `SKILL.md:94` 的计数口径逐字对齐。
7. **C13（一般）**：`references/blue-brief.md` 补第 5 条「不构造或诱导突破内容安全底线的指令与用例」；
   `SKILL.md:146` 的硬安全约束标题改为「通用四条 + 红队专用一条，按角色带入」，
   带入选则按内容对齐而非编号（`protocol.md:45` 的「五条全传」表述随之作废）。
8. **行数更正**：上一轮 02 里 protocol 31→70、red-brief 73→130、templates 90→108、blue-brief 22→40，
   本轮数字全部为实测值。
9. **验证命令更正**：上一轮写的 `grep '交作者裁定' 期望 0 命中` 是错的检查——
   `references/protocol.md:25` 有一句否定式「不交作者裁定」，属正常措辞。
   正确检查应为「不存在『上交作者裁定』『待作者裁定』『等待确认』三词」，实测 0 命中。

## 验证方式（可复跑）

```powershell
$root='C:\Users\34614\.dsh\skills\redblue-adversarial'
Get-ChildItem $root -Recurse -Filter *.md | ForEach-Object {
  "{0} {1} {2}行 {3}B" -f (Get-FileHash $_.FullName -Algorithm SHA256).Hash.Substring(0,12).ToLower(),
    $_.Name, (Select-String -Path $_.FullName -Pattern '^' -AllMatches).Count, $_.Length }

# 期望：以下四条各 0 命中（人工确认点已清零）
Select-String -Path "$root\SKILL.md","$root\references\*.md" -Pattern '上交作者裁定|待作者裁定|等待确认|交作者裁定$'

# 期望：四级定义在任务书里真实可读（非 0）
Select-String -Path "$root\references\red-brief.md" -Pattern '分级只用下面这张表'
Select-String -Path "$root\references\blue-brief.md" -Pattern '分级只用下面这张表'

# 期望：C15 的禁令真实存在（上一轮虚构的就是这一条）
Select-String -Path "$root\SKILL.md" -Pattern '不得修改 `01-cases.md`'
Select-String -Path "$root\references\red-brief.md" -Pattern '不得修改用例文件'
```

## 逐条处置

| 用例 | 处置 | 位置 | 证据或反证 |
| --- | --- | --- | --- |
| C01 | 已修 | templates.md §04 | 04 模板末行固定为 `GATE: PASS`，`## 下一轮重点` 前移到它之前；结论枚举只剩 PASS/BLOCKED |
| C02 | 已修 | protocol.md §放行判据 | 「交作者裁定」删除，改为 R3 直接 `GATE: BLOCKED` 照常交付；`protocol.md:25` 为否定式措辞 |
| C03 | 已修 | red-brief.md:94 / blue-brief.md | 四级定义表内嵌进任务书（判据版），不再只存在于 SKILL.md |
| C04 | 已修 | templates.md 04 计数节 / SKILL.md:94 | 状态列 `已修/未修/STALE`；计数口径只数「状态 ≠ 已修」，四栏均带「计入的」限定 |
| C05 | 已修 | SKILL.md:79 | 覆盖闭合：01 用例数 = 02 处置行数 = 03 覆盖数，缺项按未修计入 |
| C06 | 已修 | SKILL.md:80 / templates.md:60 / red-brief.md:110 | 版本一致检查 + STALE 状态有落点；`_v2` 插在扩展名前 |
| C07 | 已修 | templates.md:87-88 / SKILL.md:110 | 计数命令与输出为必填槽位；结论由总表重算 |
| C08 | 已修 | SKILL.md:78 | 缺件或 0 数据行一律 BLOCKED，禁止 0/0 过闸 |
| C09 | 已修 | templates.md 02 模板 | 首轮例外写明：无 01 时只写三段结论 + 路径哈希，处置表待补 |
| C10 | 已修 | templates.md 04 | 新增「争议」节（红队证据 / 蓝队反证 / 处理），承载 UNRESOLVED |
| C11 | 已修 | SKILL.md §5 状态词表 | 六值状态统一，`挂账` 与 `未修` 分列，不再一词两义 |
| C12 | 已修 | blue-brief.md:13 | 补齐 ROUND_NO / ROUND_DIR / PROJECT_ROOT / ARTIFACT_VERSION |
| C13 | 已修 | blue-brief.md 硬约束 / SKILL.md:146 | 补禁越界条款；「五条全传」改为按内容对齐的四条通用 + 一条红队专用 |
| C14 | 已修 | templates.md 01 表 | 新增「问题位置（文件+行号）」列，可正则提取 `path:line` |
| C15 | 已修 | SKILL.md:116 / red-brief.md:120 | 省成本模式禁改 01/02/交付件；B 段硬约束禁改用例文件——**上一轮此条为虚构，已更正** |
| C16 | 已修 | SKILL.md §2 | 输出文件不存在或 mtime 未更新 → 重派一次 → 仍失败记 ROUND INVALID，不进 §5 |
| C17 | 已修 | SKILL.md §4 / templates.md 03 头部 | 阶段串行；03 头部记录交付件哈希，结论绑定该哈希 |
| C18 | 已修 | SKILL.md:94 / protocol.md:21 | UNRESOLVED 计入未修、取较高者，相持不会让 PASS 不可达 |
| C19 | 已修 | SKILL.md:144 / templates.md:101 | 04 增「子代理回执」节：id + 产物路径 + 是否含向人提问语句 |
| C20 | 已修 | SKILL.md §5 状态词表 | 「不成立（驳回）」纳入统一枚举，02/04 同表 |
| C21 | 已修 | templates.md 04 总表 | 新增「问题位置」列，由 03 机械带出 |
| C22 | 已修 | templates.md 04 | 新增「复核动作」列：采纳/降级/驳回 + 证据；降级须记前后级别 |
| C23 | 已修 | SKILL.md §2 | 目录规则确定化为 `R{n}-{slug}`，闭合校验按 `R` + 数字前缀匹配 |
| C24 | 已修 | SKILL.md §5 / §Pitfalls | 统一「至多 3 轮」，删除 R4 相关表述 |
| C25 | 已修 | red-brief.md §输出格式 | 六维度覆盖检查 + 用例数下限，弃用维度须在备注节写理由 |
| C26 | 已修 | red-brief.md §输出格式 | A 段输出格式补齐「## 备注」两行（待验证假设 / 本轮不覆盖范围） |
| C27 | 已修 | SKILL.md §When to Use | 改为「至多 3 轮」，首轮 PASS 不构成冲突 |
| C28 | 已修 | SKILL.md §1 / blue-brief.md | 交付件已存在时 §1 只产出自证段落，不改原件（与 `_v2` 规则划界） |
| C29 | 已修 | SKILL.md §5 | 闸门计数以 03（判定）级别为准，覆盖 01 的预估级别 |

## 被拦截的操作

无。本轮全部读写落在 `C:\Users\34614\.dsh\skills\redblue-adversarial\` 与 `D:\1a个人\科研\_redblue\`，未触发审批层。
