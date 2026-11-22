# R3 蓝队处置

- 交付件根：`C:\Users\34614\.dsh\skills\redblue-adversarial\`
- 交付件版本（sha256 前 12，本轮实测）：
  - `SKILL.md` = `b3449f21fb1b`（156 行 / 10774 B）
  - `references/protocol.md` = `9225e892c14f`（70 行 / 4195 B）
  - `references/red-brief.md` = `45743db8ea37`（130 行 / 6155 B）
  - `references/templates.md` = `17dc7d691a36`（108 行 / 3415 B）
  - `references/blue-brief.md` = `e5bd63128b06`（49 行 / 2549 B）
- 相对 R2 变动的两个文件：`SKILL.md`（`ea16861d8bc1`→`b3449f21fb1b`）、`blue-brief.md`（`50c8b8455045`→`e5bd63128b06`）。
- 行数口径：`Select-String -Pattern '^' -AllMatches`（`(Get-Content).Count` 在本机报错值，不作数）。

## 核心结论

R2 判定只剩 2 条未修：C03（严重）与 C13（一般），都是「文件与自述不一致」，不是机制缺口。
本轮各补一处真实条款，两处均为「把话说的和文件里有的对齐」，不是新增规则。

## 实现细节

1. **C03（严重）**：R2 的 02 声称「blue-brief 也带同一张表」，实测该文件 0 命中——是虚报。
   本轮选择判定书给的第一方案：**在 `references/blue-brief.md` 第 41 行起真加这张表**
   （标题「分级参考（与 red-brief A/B 段同一张表；蓝队不判级，此表只用于理解红队的量级）」）。
   现在该主张为真，且 R2 里那条验证命令 `Select-String blue-brief.md -Pattern '分级参考'` 会命中。
   同时承认：R2 的 02 里那句是没有跑过就写下的自证，与本轮无关但性质同 C15，已在 04 记入台账。
2. **C13（一般）**：`SKILL.md` 带入选则原写「红队**两段**任务书另加『只针对产出，不做话术攻击』」，
   实测 `red-brief.md:60-68` 的 A 段 7 条里没有这句（只有 B 段 :129 有）。
   本轮按判定书给的「二者取一」，把 `SKILL.md` 改为「红队 **B 段（判定）** 另加……」，
   不再声称 A 段也有。未去 A 段补一句，因为 A 段只造用例不判级，加与不加都不改判据。

## 验证方式（可复跑）

```powershell
$root='C:\Users\34614\.dsh\skills\redblue-adversarial'
Get-ChildItem $root -Recurse -Filter *.md | ForEach-Object {
  "{0} {1} {2}行 {3}B" -f (Get-FileHash $_.FullName -Algorithm SHA256).Hash.Substring(0,12).ToLower(),
    $_.Name, (Select-String -Path $_.FullName -Pattern '^' -AllMatches).Count, $_.Length }

# C03：期望 blue-brief.md 命中（非 0），且命中行数 ≥1
Select-String -Path "$root\references\blue-brief.md" -Pattern '分级参考'

# C13：期望 0 命中「红队\*\*两段\*\*任务书」这种旧表述，1 命中新的「红队 \*\*B 段（判定）\*\*」
Select-String -Path "$root\SKILL.md" -Pattern '红队两段任务书'
Select-String -Path "$root\SKILL.md" -Pattern '红队 \*\*B 段（判定）\*\*'

# 人工确认点清零（沿用 R2 的正确检查）
Select-String -Path "$root\SKILL.md","$root\references\*.md" -Pattern '上交作者裁定|待作者裁定|等待确认'
```

## 逐条处置

| 用例 | 处置 | 位置 | 证据或反证 |
| --- | --- | --- | --- |
| C03 | 已修 | blue-brief.md:41-49 | 四级表已真写入 blue-brief（49 行，原 40 行）；R2 的虚报以「把文件补齐」方式消解，不再删主张 |
| C13 | 已修 | SKILL.md:149-150 | 「红队两段」改为「红队 **B 段（判定）**」，声明与 `red-brief.md:129` 的实现一致 |
| C01–C02、C04–C12、C14–C29 | 已修（沿用 R2 判定） | 见 R2 03 | R2 判定这 27 条为已修，本轮交付件仅改动 SKILL.md 两处与 blue-brief 一处，未触及这些条款所在段落 |

## 被拦截的操作

无。读写仅落在 `C:\Users\34614\.dsh\skills\redblue-adversarial\` 与 `D:\1a个人\科研\_redblue\`。
