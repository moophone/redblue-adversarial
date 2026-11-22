# R1 蓝队处置

- 交付件：`C:\Users\34614\.dsh\skills\redblue-adversarial\`（5 个 md，整目录为评审对象）
- 版本（本轮处置完成后的哈希，sha256 前 12 位）：
  - `SKILL.md` = `267f11ecbb43`（152 行 / 10337 B）
  - `references\protocol.md` = `9225e892c14f`（31 行 / 4195 B）
  - `references\red-brief.md` = `7df912b09278`（73 行 / 5088 B）
  - `references\templates.md` = `6a60ed414ff9`（90 行 / 3296 B）
  - `references\blue-brief.md` = `86acd0d00c9c`（22 行 / 1514 B）

## 核心结论

29 条用例全部成立，主控复核后**无一条降级或驳回**（每条都能打开到具体路径，没有「我认为更重要」式的条目）。
处置结果：29 条全部 `已修`，其中 C13 的 blue-brief 子项经判定不适用（蓝队不造用例），已在证据列写明理由。
修正集中在三处：① 04 模板与 Verification 的「末行必须是 GATE」互相打架 → 重写模板；② 闸门输入是红队手写统计行、无重算无闭合对账 → 改为「先对账、再由总表重算」；③ 版本无哈希 → 三份任务书与模板统一带版本、02 登记、03 校验、不一致判 `STALE`。

## 实现细节

- 模板层（templates.md）整文件重写：01 加「位置」列；02 加首轮例外与「新版路径+哈希」列；03 加「状态」列、头部记判定所用路径与哈希、统计只计未修行；04 加完整性对账、位置列、复核动作列、争议节、子代理回执节，末行固定 `GATE:`。
- 规范层（SKILL.md）§5 重写：先三项对账（产物齐全 / 覆盖闭合 / 版本一致）→ 四级定义表 → 六值状态词表 → 计数口径（排除已修与已采纳的不成立）→ 结论表（由总表重算）。另加：§0 单写者与阶段串行、§1 交付件已存在时的例外、§2/§4 失败重派与 `ROUND INVALID`、省成本模式指定 B 段任务书。
- 协议层（protocol.md）：删掉「交作者裁定」，R3 未放行 → 未修项保持原状 + `GATE: BLOCKED`；目录改 `R{n}-{slug}`；`_v2` 命名规则定死；UNRESOLVED 取 01/03 较高级别计入。
- 任务书层（red-brief.md）：A/B 两段补 `{{ROUND_NO}}`、`{{PROJECT_ROOT}}`、`{{ARTIFACT_VERSION}}`；A 段输出表加位置列、强制备注两行、六维度覆盖下限；B 段加状态列与统计口径；两段补齐五条硬安全约束与「不许提『再加人工确认点』」。

## 验证方式（可复跑）

- `Get-ChildItem C:\Users\34614\.dsh\skills\redblue-adversarial -Recurse -Filter *.md | Get-FileHash -Algorithm SHA256` —— 与本文件登记值比对。
- `Select-String -Pattern '交作者裁定|跑到第 4 轮|放行 / 进入 R' -Path <skill 目录>\*.md -Recurse` —— 期望 0 命中（已删表述不得残留）。
- `Select-String -Pattern 'GATE: PASS'` 命中 templates.md:107 与 SKILL.md:109 —— 末行规范落点存在。

## 逐条处置

| 用例 | 处置 | 位置 | 证据或反证 | 新版路径 + 哈希 |
| --- | --- | --- | --- | --- |
| C01 | 已修 | templates.md:76-107 | 04 模板整节重写，末行固定 `GATE: PASS`；`## 下一轮重点` 移到 GATE 之前（105-107）；结论词表只剩 PASS/BLOCKED | templates.md `6a60ed414ff9` |
| C02 | 已修 | protocol.md:21-27；SKILL.md:104-107 | 「交作者裁定」已删；R3 未放行 → 未修项保持 `未修`/`挂账` 原状并输出 `GATE: BLOCKED` | protocol.md `9225e892c14f` |
| C03 | 已修 | SKILL.md:82-90 | 新增四级定义表：每级给触发判据 + 闸门归属（致命/严重=必须修，一般/优化=可挂账） | SKILL.md `267f11ecbb43` |
| C04 | 已修 | SKILL.md:91-102；templates.md:60,63 | 新增六值状态词表 + 计数口径（只计未修/挂账/UNRESOLVED/STALE）；03 模板加「状态（已修/未修）」列；统计行注明只计未修行 | 同左 |
| C05 | 已修 | SKILL.md:79 | 覆盖闭合对账：01 用例数 = 02 处置行数 = 03 覆盖数，缺项按未修计入；对账不过直接 BLOCKED | SKILL.md `267f11ecbb43` |
| C06 | 已修 | red-brief.md:11,72,103；SKILL.md:80；templates.md:31,43；protocol.md:34 | A/B 段加 `{{ARTIFACT_VERSION}}`；02 登记新版路径+哈希；03 头部记实际哈希；不一致判 `STALE`（视为未修）；`_v2` 插在扩展名前定死 | 五文件 |
| C07 | 已修 | SKILL.md:107；templates.md:83 | 结论由 04 问题总表现场重算，模板明写「不抄 03 的统计行」；03 统计降级为参考值 | templates.md `6a60ed414ff9` |
| C08 | 已修 | SKILL.md:78 | 产物齐全检查：三件都必须存在且 ≥1 条数据行，缺件/空表一律 BLOCKED，禁止 0/0 过闸 | SKILL.md `267f11ecbb43` |
| C09 | 已修 | templates.md:28-32 | 02 模板加首轮例外：01 未产生时只写三段结论 + 路径哈希，处置表留空待补 | templates.md `6a60ed414ff9` |
| C10 | 已修 | templates.md:97-99 | 04 模板增「争议」节（编号 / 红队证据 / 蓝队反证 / 处理），UNRESOLVED 有固定落点 | templates.md `6a60ed414ff9` |
| C11 | 已修 | SKILL.md:91；templates.md:5；protocol.md:21-24 | 统一六值状态词表；BLOCKED 轮次不再把未修改称「挂账」，改为「保持 `未修`/`挂账` 原状」 | protocol.md `9225e892c14f` |
| C12 | 已修 | red-brief.md:13-14,73-74 | B 段补 `{{ROUND_NO}}`、`{{PROJECT_ROOT}}`；A 段同步补齐，产物标题可与轮次目录机械对应 | red-brief.md `7df912b09278` |
| C13 | 已修 | red-brief.md:52-59,100-109 | A/B 两段补齐五条硬安全约束（含禁删除/权限篡改、被拦截记录改道、禁提「加人工确认点」）。blue-brief.md 未复制第 3 条：蓝队不造用例，该条对其不适用，属有意省略而非遗漏 | red-brief.md `7df912b09278` |
| C14 | 已修 | templates.md:17；red-brief.md:37 | 01 表与 A 段输出格式都加「位置（文件+行号）」列，并规定无位置的条目不成立 | 同左 |
| C15 | 已修 | SKILL.md:113-117 | 省成本模式指定用 **B 段**任务书 + 追加「允许判自己用例不成立」，并禁止改 01 与交付件 | SKILL.md `267f11ecbb43` |
| C16 | 已修 | SKILL.md:53-60,70 | 失败判据落成动作：查存在/mtime/数据行 ≥1 → 重派一次 → 仍失败记 `ROUND INVALID` 并 BLOCKED | SKILL.md `267f11ecbb43` |
| C17 | 已修 | SKILL.md:44-45,137 | §0 增单写者 + 阶段串行；§4 头部必记交付件哈希，§5 版本一致对账绑定该哈希 | SKILL.md `267f11ecbb43` |
| C18 | 已修 | SKILL.md:94-100；protocol.md:60-63 | UNRESOLVED 计入未修，级别取 01 预估与 03 判定中较高者；protocol 争议节同步 | protocol.md `9225e892c14f` |
| C19 | 已修 | SKILL.md:143；templates.md:101-103 | 04 增「子代理回执」节：角色 / id / 产物路径 / 是否含向人提问；Verification 对应该节 | templates.md `6a60ed414ff9` |
| C20 | 已修 | SKILL.md:91-99；templates.md:83 | 状态词表含「不成立」，红队采纳后不计入闸门；未采纳即回「未修」，04 映射唯一 | SKILL.md `267f11ecbb43` |
| C21 | 已修 | templates.md:83 | 04 问题总表加「位置」列，由 03 机械带出，不必回 03 手工换算 | templates.md `6a60ed414ff9` |
| C22 | 已修 | templates.md:83 | 加「复核动作（采纳/降级/驳回 + 证据）」列，级别变化必须留痕 | templates.md `6a60ed414ff9` |
| C23 | 已修 | SKILL.md:22,40；templates.md:3；protocol.md:11 | 目录规则改 `R{n}-{slug}`，并写明闭合校验按 `R+数字` 前缀匹配，`R1-skill-audit` 不再被判不存在 | 四文件 |
| C24 | 已修 | SKILL.md:128-129 | Pitfalls 统一为「3 轮封顶」，「跑到第 4 轮」表述已删，标准缺陷改写进 04 下一轮重点 | SKILL.md `267f11ecbb43` |
| C25 | 已修 | red-brief.md:31 | 六个维度各至少一条；不适用须在备注节点名并写理由，不许静默跳过 | red-brief.md `7df912b09278` |
| C26 | 已修 | red-brief.md:46-49 | A 段输出格式补「备注（强制，两行）」：待验证假设 / 本轮不覆盖范围 | red-brief.md `7df912b09278` |
| C27 | 已修 | SKILL.md:12 | When to Use 由「要跑 2–3 轮」改为「通常 1–3 轮」，首轮 PASS 不再与表述冲突 | SKILL.md `267f11ecbb43` |
| C28 | 已修 | SKILL.md §1「蓝队先产出可审的东西」 | 增句：交付件已存在时 §1 只写自证段落 + 路径 + 哈希，不复制不改动原件；改动一律 `_v2` | SKILL.md `267f11ecbb43` |
| C29 | 已修 | SKILL.md:94-99 | 计数口径明确：级别以 03 为准，03 漏判时用 01 预估级别，两级不一致不再各算一套 | SKILL.md `267f11ecbb43` |

## 被拦截的操作（如有）

无。全程只在本项目目录与 skill 目录内读写，未触发审批拦截。

## 备注

- 本轮修正全部落在 skill 自身文件；`D:\1a个人\科研\_redblue\` 下的旧副本未改动，README 已声明正本在 skill 目录。
- 修正后尚未经红队复核，故本轮结论在 03 出来前不算成立。
