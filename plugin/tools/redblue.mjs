#!/usr/bin/env node
/**
 * redblue.mjs — 红蓝对抗的确定性工具（替代 v3 的 8 个 bash 脚本）
 *
 * 为什么换掉 bash：
 *   1. 目标机器（Windows）没有 bash/awk/grep/sed，WSL 也未安装 → v3 的脚本一次都跑不起来。
 *   2. mawk 在 C locale 下按字节匹配字符类，`sub(/[（(].*\/,"")` 会把
 *      「一般」(e4 b8 80 e8 88 ac) / 「优化」(e4 bc 98 ...) / 「已消除」(e6 b6 88 ...)
 *      从 0x88、0xbc 处截断 → 三个级别词全变未识别。Node 天然 UTF-8，无此问题。
 *   3. 一份实现跨平台，且能自带自检。
 *
 * 用法：
 *   node redblue.mjs init      <roundDir> <deliverable...>
 *   node redblue.mjs fp        <outFile> <path...>
 *   node redblue.mjs diff      <fpA> <fpB>
 *   node redblue.mjs shortcode <roundsRoot> <round>
 *   node redblue.mjs contract  <roundDir>
 *   node redblue.mjs audit     <roundDir> [prevRoundDir]
 *   node redblue.mjs recount   <03-review.md>
 *   node redblue.mjs gate      <03-review.md>
 *   node redblue.mjs cite      <文件>:<行号> ["引文"]   # 校验交付件引用（M6）`n *   node redblue.mjs validate  <current.json|state.md>
 *   node redblue.mjs selftest
 *
 * 退出码：0 通过；1 违规/不放行；2 用法错误。
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync, copyFileSync, utimesSync } from 'node:fs'
import { join, resolve, basename, dirname } from 'node:path'

/**
 * 自然序比较器 —— 修「R10 排在 R2 前面」「v13 排在 v7 前面」这类**名字 ≠ 数值**的排序错。
 * 2026-11-08 实测：converge 因此把 R9 当成"最新一轮"；gate 因此拿 v7 的指纹与行号去核 v13。
 * 这是独立的一类 bug：代码没写错，**名字排序不等于时间/版本排序**。
 */
const natKey = (s) => String(s).replace(/\d+/g, (m) => m.padStart(8, '0'))
const natCmp = (a, b) => natKey(a).localeCompare(natKey(b))

const LEVELS = ['致命', '严重', '一般', '优化', '已消除', '挂账', '不成立']  // v3.3.2: 加「不成立」（归属错误/事实基础不存在，不阻断闸门）
const ARTIFACTS = ['00-target.md', '01-cases.md', '02-blue.md', '03-review.md', '04-summary.md', '05-signoff.md']  // v4: 加 05 签字
// v6.24 缺陷28：表外（未并入判定表）的一般/优化问题容差。
// 此前闸门只拦表外致命/严重，一般/优化直接被丢弃 → 红队抓到的问题静默消失。
// 留一点容差是承认「表外小问题不必逐条入表」，但超过就必须补。
const OFF_MINOR_LIMIT = 3
const CONTRACT_SECTIONS = [
  ['02-blue.md', '逐条处置'],
  ['02-blue.md', '交付件改动'],
  ['03-review.md', '统计'],
  ['04-summary.md', '闸门'],
  ['04-summary.md', '主控决策'],
  ['04-summary.md', '统计复算'],
]

const die = (msg, code = 2) => { console.error(msg); process.exit(code) }
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/** 递归收集文件（目录会被展开并排序，保证指纹稳定）。 */
function collect(p, out = []) {
  const st = statSync(p)
  if (st.isDirectory()) {
    for (const name of readdirSync(p).sort()) collect(join(p, name), out)
  } else out.push(p)
  return out
}

/** 指纹文本：sha256 + 两个空格 + 绝对路径，一行一条，按路径排序。 */
function fingerprint(paths) {
  const files = paths.flatMap((p) => collect(resolve(p))).sort()
  return files.map((f) => `${sha256(readFileSync(f))}  ${f}`).join('\n') + (files.length ? '\n' : '')
}

/**
 * 从「级别」单元格解析级别。
 * 修复 F1：不用正则删括号，改用前缀匹配 —— 不依赖字节语义。
 * 「致命 → 已消除」取箭头后的终判；「一般（残留）」按「一般」计。
 */
// v6.29M（R11 实跑抓到的机制缺陷，**致命级**）：`parseLevel` 用 `startsWith` 匹配级别词，
// 遇到 markdown 加粗的 `**严重**` 直接返回 null → **整行被丢弃**。
// 实测 R11 的 01-cases.md 有 6 条严重写成 `**严重**`，`recount`/`gate` 报「致命=0 严重=0 合计=9」，
// 只靠 `GATE_UNEXECUTED`（没有 02-blue.md）侥幸没放行 —— **若 02-blue.md 存在，闸门会带着 6 条严重假放行**。
// 加粗是严重度列最自然的写法，这不是"格式不合规"，是解析器的「少算」失效。
// 同类历史：v5.4 不认 R01 编号、v6.20 丢级别列、v6.29j 丢三态词 —— 每次都是「少算」，从不是「报错」。
const MD_WRAP = /^[\s*_~`]+|[\s*_~`]+$/g
const stripMd = (s) => String(s).replace(MD_WRAP, '')

function parseLevel(cell) {
  let s = stripMd(cell)
  const arrow = s.lastIndexOf('→')
  if (arrow >= 0) s = stripMd(s.slice(arrow + 1))
  for (const lv of LEVELS) if (s.startsWith(lv)) return lv
  return null
}

/**
 * 只解析 `## 逐条判定` 这一节，避免把「复核对照表」也算进来
 * （v3 的 node 版 recount 曾把两张表都数进去，得到 36 行）。
 */
function parseVerdict(file) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  // v5.3 缺陷4：不再要求小节标题含「逐条判定」。红队把判定表写在 `# R4 红队复攻` 这种
  // 标题下时，老逻辑整张表被跳过 → recount 数出 0 行却静默 exit 0，闸门等于瞎的。
  // 同时支持两种列序：
  //   A) | 用例 | 级别 | 位置 | …          （03-review.md 的旧格式）
  //   B) | 用例 | 判定 | 级别 | 位置 | 证据 | （02-red.md 的新格式）
  const rows = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // v5.4 缺陷5：原先只认 [CN]\d 与「观点\d」。复核表用 R01–R05 这种「R+两位」编号时整表被跳过，
    // 于是 9 行的复核只数出 4 行（漏掉全部 R 编号行），闸门按错误的低计数放行。现在认 R/r + 1~3 位数字。
    // v6.29M（R12 实测）：编号正则认不出**跨轮携带编号** `R10-N17`。
    // 而「携带上一轮未闭合项」正是本机制的核心要求（converge 会专门查「靠遗忘收敛」）——
    // 工具必须支持这种编号，否则 21 条只数出 17 条，闸门按错误的低计数放行。
    // 做法：在「字母+可选分隔+数字」之后，允许再接一个「-字母+数字」段（如 R10-N17 / R11-C03）。
    const ID_RE = /^\|\s*((?:[A-Za-z][-\s]?\d{1,3}(?:-[A-Za-z]\d{1,3})?)|(?:观点\s*\d{1,3})|(?:问题\s*\d{1,3})|(?:论点\s*\d{1,3})|(?:\d{1,3}))\s*\|([^|]*)\|([^|]*)\|/
    const m = line.match(ID_RE)
    if (!m) continue
    // v6.4 缺陷9：raw 必须保存**判定词原文**，不能保存级别列。
    // 三态词（当前文本已答/部分已答/仍未解决）不在 LEVELS 里，parseLevel 返回 null，
    // 旧逻辑于是取第 3 列（级别）当 raw —— 三态信息整个丢失，reattack 无法判断
    // 「上一轮说已答、这一轮说仍未解决」。现在先认三态词，再认级别。
    const VERDICT_WORDS = /^(当前文本已答|部分已答|仍未解决|已修|未修|STALE|部分修|驳回|挂账|已消除|已答|成立|不成立|部分成立)$/
    const strip = (s) => stripMd(s)
    const dashOnly = (s) => /^[—\-]+$/.test(strip(s))
    let rawCell = null
    let level = null
    let claimedLevel = null

    // v6.29j：STATUS_MAP 必须提到分支外统一定义。
    // 实测致命缺口：第 2 列是三态判定词的轮次（技能自己推荐的写法）原代码只写
    //   level = parseLevel(m[3])
    // 也就是**把「级别列」当成了状态桶**，STATUS_MAP 完全没参与。
    // 后果：12 条「当前文本已答」被读成「一般=12、已消除=0」，
    // converge 的干净轮数、gate 的闭合计数、quality 的驳回率全部失真。
    // 是 selftest 里两条 converge 用例把这条暴露出来的，不是我读代码发现的。
    const STATUS_MAP = { '已消除': '已消除', '已修': '已消除', '未修': '挂账', 'STALE': '挂账', '部分修': '挂账', '驳回': '不成立', '不成立': '不成立', '挂账': '挂账', '当前文本已答': '已消除', '部分已答': '挂账', '仍未解决': '挂账' }

    // 优先：第 2 列是三态/状态词 → 它才是判定词，第 3 列是级别
    if (VERDICT_WORDS.test(strip(m[2]))) {
      rawCell = strip(m[2])
      claimedLevel = parseLevel(m[3]) || null
      level = STATUS_MAP[rawCell] || claimedLevel
    } else if (dashOnly(m[2]) && VERDICT_WORDS.test(strip(m[3]))) {
      // 旧格式 `| 编号 | — | 已修 | 位置 |`
      rawCell = strip(m[3])
      // STATUS_MAP 已在循环外统一定义（v6.29j）
      level = STATUS_MAP[rawCell] || parseLevel(m[2])
    } else if (parseLevel(m[2]) && VERDICT_WORDS.test(strip(m[3]))) {
      // 旧格式 `| 编号 | 级别 | 状态 |`：级别在前、状态在后
      rawCell = strip(m[3])
      // STATUS_MAP 已在循环外统一定义（v6.29j）
      // v6.20 缺陷23（R5 红队 N05 抓到，最致命的一个）：
      // 旧逻辑 `level = STATUS_MAP[rawCell]` **把级别列整个丢弃**。
      // 实测 10 行 `| C01 | 致命 | 未修 |` → recount 输出 致命=0 严重=0 挂账=10，
      // 10 行 `| C01 | 致命 | 已修 |` → 致命=0 严重=0 已消除=10。
      // 也就是说：**无论修没修，级别列的「致命」都被清零**，闸门靠兜底扫描才勉强拦住。
      // 正确做法：状态词决定「桶」（已修/未修/挂账/不成立），级别列单独存为 claimedLevel，
      // 让 tally 能同时回答「多少条被判致命」和「多少条还没修」。
      level = STATUS_MAP[rawCell] || parseLevel(m[2])
      claimedLevel = parseLevel(m[2]) || null
    } else {
      // 新格式 `| 用例 | 判定 | 级别 | 位置 |`：第 2 列是「成立/不成立」这类非标准词
      const c2 = parseLevel(m[2])
      const c3 = parseLevel(m[3])
      level = c2 || c3
      rawCell = (c2 ? strip(m[2]) : strip(m[3]))
      claimedLevel = c3 || c2 || null
    }
    if (!level) continue
    // v6.18 缺陷21（R5 红队 e4 抓到，最狠的一个）：
    // 判定 = 「不成立」时，级别列写什么都不算数 —— 红队自己已经驳回了这条指控。
    // 旧逻辑照抄级别列，于是 `| N01 | 不成立 | 严重 |` 被算成 1 条严重，
    // gate 判「进下一轮」：两条已被驳回的指控把闸门卡死。
    // 正确语义：不成立 ⇒ 归「不成立」桶，不计入致命/严重/一般/优化。
    if (rawCell === '不成立') {
      // v6.29c 缺陷（由新命令 quality 反查暴露）：这里原先把 claimedLevel 写成 level，
      // 而 level 在此已被映射成 '不成立'，原始级别列（严重/一般）当场丢失 ——
      // 后果是「按级别统计驳回率」永远显示 0%，严重级误报率这个核心指标是假的。
      // 必须保留原始级别：claimedLevel 变量此时存的就是级别列。
      rows.push({
        id: m[1],
        level: '不成立',
        raw: rawCell,
        claimedLevel: claimedLevel && claimedLevel !== '不成立' ? claimedLevel : null,
      })
      continue
    }
    rows.push({ id: m[1], level, raw: rawCell, claimedLevel })
  }
  return rows
}

function tally(rows) {
  const t = Object.fromEntries(LEVELS.map((l) => [l, 0]))
  const unknown = []
  for (const r of rows) {
    if (r.level) t[r.level]++
    else unknown.push(r)
  }
  // v6.21 缺陷24：**真实严重度**必须独立统计。
  // 状态列（已修/未修）说明的是「处置进度」，级别列说明的是「这条有多严重」。
  // 旧逻辑只统计状态桶，于是 10 条「致命+未修」报成 致命=0 挂账=10 ——
  // 严重度被处置状态掩盖，闸门看不到"有 10 条致命级问题"这件事。
  // claimed 只统计**仍未结案**的行（已修/已消除/不成立不计入真实风险），
  // 因为"曾经致命但已修好"不构成当前阻断理由。
  const claimed = { '致命': 0, '严重': 0, '一般': 0, '优化': 0 }
  for (const r of rows) {
    const cl = r.claimedLevel
    if (!cl || !(cl in claimed)) continue
    const closed = r.level === '已消除' || r.level === '不成立'
    if (closed) continue
    claimed[cl]++
  }
  return { t, unknown, claimed }
}

// ---------------------------------------------------------------- subcommands

function cmdInit([roundDir, ...dels]) {
  if (!roundDir || dels.length === 0) die('usage: init <roundDir> <deliverable...>')
  mkdirSync(join(roundDir, 'fingerprints'), { recursive: true })
  const missing = dels.filter((d) => !existsSync(d))
  if (missing.length) die(`init: 交付件不存在: ${missing.join(', ')}`)
  const fp = fingerprint(dels)
  writeFileSync(join(roundDir, 'fingerprints', '00-baseline.txt'), fp, 'utf8')
  console.log(`INIT_OK: ${roundDir}`)
  console.log(`baseline files=${fp.trim().split('\n').filter(Boolean).length}`)
  process.stdout.write(fp)
  return 0
}

function cmdFp([outFile, ...paths]) {
  if (!outFile || paths.length === 0) die('usage: fp <outFile> <path...>')
  const fp = fingerprint(paths)
  writeFileSync(outFile, fp, 'utf8')
  console.log(`FP_WRITTEN: ${outFile} (${fp.trim().split('\n').filter(Boolean).length} files)`)
  return 0
}

function cmdDiff([a, b]) {
  if (!a || !b) die('usage: diff <fpA> <fpB>')
  const A = readFileSync(a, 'utf8').trim().split('\n').filter(Boolean)
  const B = readFileSync(b, 'utf8').trim().split('\n').filter(Boolean)
  const mapA = new Map(A.map((l) => [l.slice(66), l.slice(0, 64)]))
  const mapB = new Map(B.map((l) => [l.slice(66), l.slice(0, 64)]))
  let diffs = 0
  for (const [k, v] of mapA) {
    if (!mapB.has(k)) { console.log(`MISSING  ${k}`); diffs++ }
    else if (mapB.get(k) !== v) { console.log(`CHANGED  ${k}\n  ${v} -> ${mapB.get(k)}`); diffs++ }
  }
  for (const k of mapB.keys()) if (!mapA.has(k)) { console.log(`ADDED    ${k}`); diffs++ }
  if (diffs === 0) { console.log('FP_MATCH: fingerprints identical'); return 0 }
  console.error(`FP_DIFF: ${diffs} difference(s)`)
  return 1
}

function cmdShortcode([roundsRoot, round]) {
  if (!roundsRoot || !round) die('usage: shortcode <roundsRoot> <round>')
  // v6.29M（探针发现）：原来不校验 <round>，传进整个目录名 `R10-1108r1` 会拼出
  // `RR10-1108r1-1108b9` 这种废名，而且**静默 exit 0** —— 拿它去建目录就建出个假轮次。
  // 现在只接受 `11` 或 `R11`，两种写法都归一成 `R11-<code>`。
  const nRaw = String(round).replace(/^R/i, '')
  if (!/^\d+$/.test(nRaw)) {
    // 用 return 而不是 die：die 会 process.exit，自测里没法断言（可测性也是判据的一部分）。
    console.error(`SHORTCODE_BAD_ROUND: <round> 只接受 "11" 或 "R11"，收到 "${round}"`)
    return 2
  }
  const tag = `R${nRaw}`
  const d = new Date()
  const mmdd = String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0')
  const base = mmdd + Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
  let cand = base
  let n = 1
  while (existsSync(join(roundsRoot, `${tag}-${cand}`))) {
    cand = `${base}-${n}`
    if (++n > 99) die('SHORTCODE_EXHAUSTED')
  }
  console.log(`${tag}-${cand}`)
  return 0
}

/**
 * 产物契约。
 * 修复 F3：01-cases.md 只在 R1 必需；R2 起从上一轮继承，不重复建。
 */
function cmdContract([roundDir]) {
  if (!roundDir) die('usage: contract <roundDir>')
  const isR1 = /[\\/]R1-/.test(roundDir + '/')
  let fail = 0
  const INHERITED = new Set(['00-target.md', '01-cases.md'])  // v3.3.2: R2+ 从上一轮继承
  for (const f of ARTIFACTS) {
    const required = INHERITED.has(f) ? isR1 : true
    if (!existsSync(join(roundDir, f))) {
      // v6.24：01-cases.md 在 R2+ 不再笼统地报「继承」—— 它必须走下面的红队交付检查，
      // 否则同一轮会同时打印「CONTRACT_OK(继承)」和「VIOLATION」，自相矛盾。
      if (!required && f !== '01-cases.md') console.log(`CONTRACT_OK(继承): ${f} 由上一轮提供`)
      else if (!required && f === '01-cases.md') { /* 交给下面的红队交付检查 */ }
      else { console.log(`CONTRACT_VIOLATION: missing ${f}`); fail = 1 }
    }
  }
  // v6.24 缺陷27b（2026-11-02 实测）：**R2+ 的红队产物从来不被检查**。
  // INHERITED 把 01-cases.md 当作「由上一轮提供」，于是 R10 这种
  // 「红队完全没启动」的轮次在 contract 上是 CONTRACT_OK —— 与 gate 的
  // GATE_UNATTACKED 形成两道都漏的合流。这里补一条：R2+ 若存在 01-cases.md
  // 就必须是可识别的红队产出；若不存在，则必须在 04-summary 里显式声明
  // 「本轮无红队交付」并说明理由，否则视为违约。
  if (!isR1) {
    const cp = join(roundDir, '01-cases.md')
    if (existsSync(cp)) {
      const d = redTeamDelivered(roundDir)
      if (!d.ok) { console.log(`CONTRACT_VIOLATION: 01-cases.md 存在但不是红队产出（${d.why}）`); fail = 1 }
    } else {
      const sp = join(roundDir, '04-summary.md')
      const declared = existsSync(sp) && /无红队交付|红队未启动|红队未参与|本轮无红队/.test(readFileSync(sp, 'utf8'))
      if (!declared) { console.log('CONTRACT_VIOLATION: R2+ 缺 01-cases.md，且 04-summary 未声明「本轮无红队交付」'); fail = 1 }
      else console.log('CONTRACT_OK(声明无红队): 04-summary 已如实声明本轮无红队交付')
    }
  }
  for (const [f, needle] of CONTRACT_SECTIONS) {
    const p = join(roundDir, f)
    if (existsSync(p) && !readFileSync(p, 'utf8').includes(needle)) {
      console.log(`CONTRACT_VIOLATION: ${f} missing '${needle}'`)
      fail = 1
    }
  }
  // v5.1 修 BUG B：「不是「定稿」」这类否定句不再误报 —— 只看状态/结论行
  const sumP = join(roundDir, '04-summary.md')
  const sigP = join(roundDir, '05-signoff.md')
  if (existsSync(sumP) && /(状态|结论)\s*[:：]\s*定稿/.test(readFileSync(sumP, 'utf8'))) {
    const signed = existsSync(sigP) && !readFileSync(sigP, 'utf8').includes('待签')
    if (!signed) { console.log("CONTRACT_VIOLATION: 04 状态为「定稿」但 05-signoff 未签"); fail = 1 }
  }
  if (!fail) console.log(`CONTRACT_OK: ${roundDir}`)
  return fail
}

/** 修复 F2：用例计数同时认 C 与 N 系列。 */
function countCases(file) {
  if (!existsSync(file)) return 0
  // v5.1 修 BUG A：只数「用例表」小节里的行。映射表/覆盖表里的 `| C01 | ... |` 不是用例
  //（实测：R1-103180 的 01-cases.md 有「合并与去重映射」表，工具把它数成用例，15 条数成 30 条）
  const all = readFileSync(file, 'utf8')
  const lines = all.split(/\r?\n/)
  let inCases = false, found = false, n = 0
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) { inCases = /用例表|用例清单|窄口/.test(line); if (inCases) found = true; continue }  // v5.1：窄口新增也算用例
    if (inCases && /^\|\s*((?:[CNR]\d{1,3})|(?:观点\s*\d{1,3}))\s*\|/.test(line)) n++
  }
  // v6.29S（2026-11-11 端到端验证）：found 为 true 但 n=0 时回退到全文匹配。
  // 起因：R14 的标题是 `# 01 · R12 用例表（...）`（命中「用例表」→ found=true），
  // 但表格在 `## A. 保留用例` 下（不命中 → inCases=false），n=0，
  // 于是返回 0 —— 而实际有 21 条。audit 因此报「本轮用例数=0」。
  const full = (all.match(/^\|\s*((?:[CNR]\d{1,3})|(?:观点\s*\d{1,3}))\s*\|/gm) || []).length
  if (n > 0) return n
  if (!found) return full
  // found 但 n=0：标题命中了、表格不在该标题下 —— 回退全文匹配
  return full
}

function cmdAudit([roundDir, prevDir]) {
  if (!roundDir) die('usage: audit <roundDir> [prevRoundDir]')
  // v6.6：开工前先核「被引用的交付件集合」是否还完整。
  // 实测 R5 开工时，R3 审计引用的 5 个文件只剩 1 个（templates.md/red-brief.md/blue-brief.md 已不存在），
  // 56 处行号引用全部悬空 —— 而 audit 完全不报这件事，整轮审计建在空气上。
  const revFile = join(roundDir, '03-review.md')
  if (existsSync(revFile)) {
    const bcode = cmdBundle([revFile])
    if (bcode !== 0) {
      console.error('AUDIT: ROUND INVALID —— 被引用的交付件集合不完整，本轮的行号引用无法核实。')
      console.error('先修 bundle 报的缺文件/越界，再跑 audit。')
      return 2
    }
  }
  const cur = countCases(join(roundDir, '01-cases.md'))
  let prev = 0
  if (prevDir) prev = countCases(join(prevDir, '01-cases.md'))
  console.log(`本轮用例数=${cur}  上一轮=${prev}`)
  // v5.1 修 BUG D：协议 §9 允许「窄口 ≤3 条/轮」新增，工具却禁止任何增加
  //（实测 R2 15→18 是合法的窄口新增，被误判为违规）
  const NARROW_CAP = 3
  if (prevDir && cur > prev) {
    const delta = cur - prev
    if (delta <= NARROW_CAP) {
      console.log(`COUNT_OK(窄口 +${delta}，须在 04 写明每条的「R1 为何漏」)`)
      return 0
    }
    console.error(`COUNT_VIOLATION: 用例数 ${prev} -> ${cur}（增加 ${delta} 条，超过窄口上限 ${NARROW_CAP}）`)
    return 1
  }
  console.log('COUNT_OK')
  return 0
}

/**
 * v5.1 新增：扫描「表外新问题」。
 *
 * 老会话（session-feed2be6）踩过：复核红队在判定表之外又报了 1 条严重，
 * 脚本只看判定表 → GATE 放行 → 主控人工否决。同一坑在 R3 复现
 * （判定表 一般=1，表外另有 严重=1）。现在工具自己看得见。
 *
 * 认的小节标题：新问题 / 新增问题 / 新发现
 * 表格行的「级别」列位置不定，所以在整行单元格里找级别词。
 */
/**
 * v5.2 缺陷1：进程超时会吞掉全部工作。
 *
 * 今晚 spark-x2.6 蓝队跑满 30 min 被 ETIMEDOUT 杀掉，产出 0 字节 —— 因为它
 * 只在最后一次性写文件。任何长跑角色都必须**先写骨架、再增量追加**，
 * 这样即使被杀，下一轮也能从残骸接续。
 *
 * 本命令检查：round 目录里每个角色的产物是否存在、是否只有骨架没有内容。
 */
// v6.29M：`body.includes(k)` 太弱 —— 文件里写「本文没有『逐条处置』」也算"有这个小节"。
// 实测：造一份三个文件都明写「没有 XX」的轮次，salvage 仍判 SALVAGE_OK exit 0。
// 现在要求：关键词至少有一次出现在**非否定语境**下。真项目数据里否定语境出现 0 次，所以本改动对历史轮次无影响。
const NEG_BEFORE = /(没有|不含|并无|未|非|缺|漏|省略|跳过|无)[了]?\s*$/
const hasKey = (body, key) => {
  let i = body.indexOf(key)
  while (i !== -1) {
    if (!NEG_BEFORE.test(body.slice(Math.max(0, i - 6), i))) return true
    i = body.indexOf(key, i + 1)
  }
  return false
}

function cmdSalvage([roundDir]) {
  if (!roundDir) die('usage: salvage <roundDir>')
  const roles = [
    { file: '01-cases.md', who: '红队', minBytes: 300, keys: ['用例表', '维度覆盖', '不覆盖'] },
    { file: '02-blue.md', who: '蓝队', minBytes: 300, keys: ['逐条处置', '交付件改动', 'SHA256'] },
    { file: '03-review.md', who: '复核', minBytes: 300, keys: ['逐条判定', '统计'] },
  ]
  let problems = 0
  for (const r of roles) {
    const p = join(roundDir, r.file)
    if (!existsSync(p)) { console.log(`MISSING  ${r.who} ${r.file} —— 该角色完全没有落盘`); problems++; continue }
    const sz = statSync(p).size
    const body = readFileSync(p, 'utf8')
    const missKeys = r.keys.filter((k) => !hasKey(body, k))
    const status = sz < r.minBytes ? 'THIN' : missKeys.length ? 'INCOMPLETE' : 'OK'
    console.log(`${status.padEnd(11)} ${r.who} ${r.file}  ${sz}B` + (missKeys.length ? `  缺小节: ${missKeys.join(',')}` : ''))
    if (status !== 'OK') problems++
  }
  if (problems > 0) {
    console.log(`\nSALVAGE_NEEDED: ${problems} 处不完整。下一轮必须从残骸接续，不要重跑整轮。`)
    return 1
  }
  console.log('\nSALVAGE_OK: 三个角色产物齐全')
  return 0
}

/**
 * v5.2 缺陷1配套：给长跑角色的任务包加"增量落盘"条款。
 * 单独成文，便于直接贴进 prompt。
 */
function cmdCheckpointTemplate() {
  console.log(`## 增量落盘（硬性）

长跑会被超时杀掉。**先写骨架，再逐条追加**，任何时刻被杀，残骸都能接续。

1. 开工 30 秒内：先写目标文件的骨架（标题 + 表格表头 + 空的逐条行）
2. 每完成一条用例：立刻把该行写进去（追加，不要攒到最后）
3. 每 10 分钟：在文件末尾追加一行 \`<!-- checkpoint HH:MM 已完成 N/M -->\`
4. 交卷时：把 \`## 摘要\` 段补全

被杀之后，下一轮第一件事是读残骸，从 \`checkpoint\` 行之后继续，**不要从头再来**。`)
  return 0
}

function scanOffTable(file) {
  if (!existsSync(file)) return { fatal: 0, serious: 0, minor: 0, opt: 0, rows: [] }
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  let inNew = false
  const rows = []
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) { inNew = /新问题|新增问题|新发现/.test(line); continue }
    if (!inNew || !/^\|\s*[^|\-]/.test(line)) continue
    if (/^\|\s*:?-{2,}/.test(line)) continue
    const cells = line.split('|').map((s) => s.trim()).filter(Boolean)
    const level = cells.find((c) => ['致命', '严重', '一般', '优化'].includes(c))
    if (level) rows.push({ level, text: line.slice(0, 90) })
  }
  return {
    fatal: rows.filter((r) => r.level === '致命').length,
    serious: rows.filter((r) => r.level === '严重').length,
    // v6.24：表外的一般/优化此前被完全丢弃（只统计 fatal/serious），
    // 于是红队抓到但没进判定表的问题会静默消失。现在一并计数。
    minor: rows.filter((r) => r.level === '一般').length,
    opt: rows.filter((r) => r.level === '优化').length,
    rows,
  }
}

/**
 * v6.24 缺陷27：判定「这一轮红队是否真的交付过」。
 * R10-1102a1 实测：红队两路都没启动，主控把 02-blue.md 和 03-review.md 全自己写了，
 * 判「20 条全部已消除」→ gate 放行。闸门从不检查红队产物，这是最大的漏洞。
 *
 * 判定标准（三条全满足才算红队交付）：
 *   1. 01-cases.md 存在且含「用例表」小节（红队的产出格式）；
 *   2. 该小节里至少 1 行用例（C/N/R/观点 编号）；
 *   3. 文件里不是只有「继承」字样（即红队确实写了东西，不是只抄上一轮）。
 */
function redTeamDelivered(roundDir) {
  // v6.24：实测 11 轮真实产物，01-cases.md 有三种形态，不能只认「用例表」标题：
  //   R8/R9  ：多份红队文件拼接（`<!-- ===== 01-cases-tech.md ===== -->` + `# 01-cases-tech — R8 技术审查员`）
  //   R11    ：单文件多小节，用例表散在各节
  //   R1/R3/R4：单份用例清单
  // 共同的可测特征：存在 01-cases*.md，且其中至少有一行「带编号 + 级别词」的判定行。
  // 反面样本 R10-1102a1：文件开头就自述「本轮无红队交付」，正文是上一轮的转抄。
  const files = readdirSync(roundDir).filter((f) => /^01-cases.*\.md$/.test(f))
  if (files.length === 0) return { ok: false, why: '没有任何 01-cases*.md' }
  // 自述无红队 = 未交付（R10 的形态）。这是最强信号，先判。
  for (const f of files) {
    const t = readFileSync(join(roundDir, f), 'utf8')
    if (/无红队交付|红队未启动|红队未参与|本轮无红队|无红队/.test(t)) {
      return { ok: false, why: `${f} 自述「无红队交付」` }
    }
  }
  // v6.25 缺陷30（实测 R10 第二次假放行的真正原因）：
  // R10 的 01-cases.md 开头写「# R10 用例清单（**继承 R9 红队 13 条** + 主控撤回 2 条）」，
  // 正文是上一轮红队的转抄 —— 它有「编号+级别」判定行，所以第一版 redTeamDelivered
  // 判它**已交付**，闸门放行。**转抄上一轮 ≠ 本轮有人攻击过。**
  // 判据：文件自述「继承/沿用/转抄上一轮」⇒ 本轮红队未真交付。
  // 注意只认**明确指向上一轮**的表述，避免误伤「R1 为何漏」这类合法的历史引用。
  for (const f of files) {
    const t = readFileSync(join(roundDir, f), 'utf8')
    const head = t.split(/\r?\n/).slice(0, 12).join('\n')   // 只看开头，正文引用历史不算
    if (/(继承|沿用|转抄|摘自|复制自)\s*(?:自\s*)?上一?轮|(继承|沿用)\s*R\d+\s*红队|本轮[^\n]{0,8}(继承|沿用|转抄)/.test(head)) {
      return { ok: false, why: `${f} 自述「继承上一轮红队」——转抄不等于本轮有人攻击过` }
    }
  }
  // 必须有带编号 + 级别词的判定行（红队产出的实质内容）。
  // v6.24：实测两种真实形态，都必须认：
  //   表格态（R8/R11 等）：`| V01 | 成立 | 致命 | …` 或 `| 观点1（致命·…） | 已修 | …`
  //   正文态（R3）：`### 观点 1（指向 …，维度 …）：…` + 紧跟 `- 严重度：致命`
  let rows = 0
  for (const f of files) {
    const lines = readFileSync(join(roundDir, f), 'utf8').split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      // 表格态
      if (/^\|\s*[^|\-]/.test(line) && !/^\|\s*:?-{2,}/.test(line)) {
        const cells = line.split('|').map((s) => s.trim()).filter(Boolean)
        const hasId = cells.some((c) => /^(?:[CNRKVTD]\d{1,3}|N\d{1,3}|观点\s*\d{1,3})/i.test(c))
        const hasLevel = cells.some((c) => ['致命', '严重', '一般', '优化'].includes(c))
        if (hasId && hasLevel) rows++
        continue
      }
      // 正文态：标题行带「观点 N」，其后 8 行内出现「严重度：X」
      if (/^#{1,6}\s/.test(line) && /观点\s*\d{1,3}/.test(line)) {
        const win = lines.slice(i + 1, i + 9).join('\n')
        if (/严重度\s*[:：]\s*(致命|严重|一般|优化)/.test(win)) rows++
      }
    }
  }
  if (rows === 0) return { ok: false, why: '01-cases*.md 里 0 行「编号+级别」判定行' }
  return { ok: true, n: rows, files: files.length }
}

/**
 * v6.24 缺陷27c：判定「蓝队是否真的逐条处置过」。
 * 只看文件里有没有「逐条处置」四个字太宽松 —— 一句「（无逐条处置小节）」
 * 就含这四个字，实测把它误判成已执行。改为要求小节存在且小节内有处置行。
 */
function blueTeamExecuted(roundDir) {
  const p = join(roundDir, '02-blue.md')
  if (!existsSync(p)) return { ok: false, why: '02-blue.md 不存在' }
  const lines = readFileSync(p, 'utf8').split(/\r?\n/)
  // v6.24：真实标题有 `## 逐条处置`（R2/R3/R11）、`## 一、逐条处置`（R8）、`## 逐条处置（28 条）`。
  // 必须用「包含」而不是精确匹配；且要能容忍「（无逐条处置小节）」这种负例 —— 该行不是标题，
  // 不会被 inSec 采纳，所以只要不把正文行当标题就安全。
  let inSec = false
  let secLevel = 0
  let rows = 0
  for (const line of lines) {
    const h = line.match(/^(#{1,6})\s/)
    if (h) {
      const lv = h[1].length
      if (inSec && lv <= secLevel) inSec = false   // 同级或更高级标题 → 离开本节
      if (!inSec && /逐条处置/.test(line)) { inSec = true; secLevel = lv }
      continue
    }
    if (!inSec) continue
    if (/^\|\s*[^|\-]/.test(line) && !/^\|\s*:?-{2,}/.test(line)) {
      // v6.29M：编号正则要认**跨轮携带编号** `R10-N17`（同 parseVerdict 的修正）。
      const first = line.split('|')[1] ? line.split('|')[1].trim() : ''
      if (/^([CNRKVTD]\d{1,3}(?:-[A-Za-z]\d{1,3})?|观点\s*\d{1,3})/i.test(first)) rows++
    }
  }
  if (rows === 0) return { ok: false, why: '02-blue.md 的「逐条处置」小节里 0 行处置记录' }
  return { ok: true, rows }
}



/**
 * v5.2 缺陷3：判定表之外任何表格行若标了 致命/严重，都算未入表的严重发现。
 * 老会话（session-feed2be6）与 R3 都出现过：正文表格里藏着一条严重，
 * 脚本只读判定表 → 放行 → 主控人工否决。现在一律拦。
 */
function scanStraySeverity(file) {
  if (!existsSync(file)) return []
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  const out = []
  let inTable = false
  let thisIsVerdict = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const isSep = /^\|\s*:?-{2,}/.test(line)
    const isRow = /^\|\s*[^|\-]/.test(line)
    if (isSep) continue                       // 分隔行不改变状态
    if (!isRow) { inTable = false; thisIsVerdict = false; continue }
    const cells = line.split('|').map((s) => s.trim()).filter(Boolean)
    if (!inTable) {
      // v6.29M：**靠表头判断，不靠标题词**。
      // 实测 bug（R12）：原逻辑靠标题是否含「逐条判定|判定表|裁决表」来判断是否在判定表内，
      // 而 R12 的标题是「# 03 · R12 复核红队判定」——不含「判定表」三字，
      // 于是整张 21 行判定表被当成「表外散落」，6 条严重全被误报 STRAY，干净的轮次反被拦下。
      // 判定表的表头特征是**同时有「编号」列与「级别/判定/状态」列**，用结构判断比用词表稳。
      inTable = true
      thisIsVerdict = cells.some((c) => /^编号$/.test(c)) && cells.some((c) => /级别|判定|状态/.test(c))
      continue
    }
    if (thisIsVerdict) continue
    const hit = cells.find((c) => c === '致命' || c === '严重')
    if (hit) out.push({ line: i + 1, level: hit, text: line.slice(0, 70) })
  }
  return out
}

/**
 * refs <casesFile> <targetFile> —— 把用例里提到的行号回原文打出来。
 *
 * 为什么需要它（2026-11-08 R1-1107g1 实跑教训）：
 *   本轮主控两次把二手转述当原文采信，两次都被推翻：
 *   ① 拿 duration-domain 敏感性变体当主结果，错判「头号统计复现不出来」；
 *   ② 照领域审稿人转述判「无 hedge 全称」成立，而 L11 原文写着 "to our knowledge"。
 *   "承诺回原文核对"作为纪律不管用 —— 必须把它变成一条命令：
 *   用例里只要写了 `L42` 或 `文件:42`，跑它就得到那几行的真实内容，肉眼一比对就现形。
 *
 * 认的行号写法：`L42`、`L42-45`、`:42`、`文件:42`。
 * 行号超出文件长度 ⇒ DANGLING_REF + exit 2（悬空引用本身就是缺陷）。
 * 一个行号都提取不到 ⇒ REFS_EMPTY + exit 2（不是"没问题"，是"没核对"）。
 */
function cmdRefs([casesFile, targetFile]) {
  if (!casesFile || !targetFile) die('usage: refs <casesFile> <targetFile>')
  if (!existsSync(casesFile)) die(`refs: 用例文件不存在: ${casesFile}`)
  if (!existsSync(targetFile)) die(`refs: 目标文件不存在: ${targetFile}`)
  const caseText = readFileSync(casesFile, 'utf8')
  const target = readFileSync(targetFile, 'utf8').split(/\r?\n/)
  const nums = new Set()
  for (const m of caseText.matchAll(/\bL(\d{1,5})(?:\s*[-–]\s*(\d{1,5}))?/g)) {
    const a = Number(m[1])
    const b = m[2] ? Number(m[2]) : a
    for (let n = a; n <= Math.min(b, a + 50); n++) nums.add(n)
  }
  // 只认显式的「文件.扩展名:行号」。裸冒号（`… :2012`）会把正文里的年份当行号，
  // 实测就产生过 DANGLING_REF: 2012 这种假阳性 —— 会狼来了的工具比没有更糟。
  for (const m of caseText.matchAll(/[\w.\-]+\.(?:md|txt|py|mjs|cjs|js|ts|csv|json|yml|yaml)[：:](\d{1,5})(?!\d)/g)) {
    nums.add(Number(m[1]))
  }
  const sorted = [...nums].sort((x, y) => x - y)
  if (sorted.length === 0) {
    console.error('REFS_EMPTY: 用例文件里没有可识别的行号引用 —— 没有可核对的东西，视为不可判定。')
    return 2
  }
  const dangling = sorted.filter((n) => n < 1 || n > target.length)
  console.log(`REFS: 用例引用 ${sorted.length} 个行号，目标文件 ${target.length} 行 —— 逐行回原文`)
  for (const n of sorted) {
    const full = n >= 1 && n <= target.length ? String(target[n - 1] ?? '') : '<越界>'
    // 不能短截断：本轮主控被 "to our knowledge" 骗到，而它正好在一行 1294 字符的后半段。
    // 一个防断章取义的工具，自己绝不能只显示前 260 字符。上限给到 1200 并显式标注截断。
    const shown = full.length > 1200 ? `${full.slice(0, 1200)} …[截断，本行共 ${full.length} 字符]` : full
    console.log(`${String(n).padStart(4)}| ${shown}`)
  }
  if (dangling.length) {
    console.error(`DANGLING_REF: ${dangling.join(', ')} —— 超出目标文件 ${target.length} 行，引用悬空。`)
    return 2
  }
  return 0
}

/**
 * apply <src> <edits.md> <out> —— 应用「精确替换块」并逐块校验。
 * v6.29（2026-11-08 希腊课题实跑）：三条拦截全部来自摔跤 ——
 *   OLD_NOT_FOUND  ：修订块逐字复制不一致（实测十块全挂，因为把 OLD 尾部的空行算进了锚点）
 *   OLD_NOT_UNIQUE ：命中多处，无法确定改哪一处
 *   NEW_HAS_CJK    ：英文稿里混入成串中文 ＝ 编辑说明误入正文（实测被写进 L3，R2 未发现、R3 发现）
 * 任一条不过即 exit 2，候选稿不得进复核。
 */
function cmdApply([src, editsFile, out]) {
  if (!src || !editsFile || !out) die('usage: apply <src> <edits.md> <out>')
  for (const p of [src, editsFile]) if (!existsSync(p)) die(`apply: 文件不存在: ${p}`)
  let content = readFileSync(src, 'utf8')
  const raw = readFileSync(editsFile, 'utf8')
  const starts = []
  const re = /^###\s*修\s*([A-Za-z]+\d+)\b[^\n]*$/gm
  let m
  while ((m = re.exec(raw))) starts.push({ id: m[1], at: m.index, end: re.lastIndex })
  if (starts.length === 0) {
    console.error('NO_BLOCKS: 没找到任何「### 修 <编号>」块 —— 没有可应用的修订。')
    return 2
  }
  const trimNl = (s) => s.replace(/^(?:\r?\n)+/, '').replace(/(?:\r?\n)+$/, '')
  const cjkCount = (s) => (s.match(/[\u4e00-\u9fff]/g) || []).length
  const targetCJK = cjkCount(content)
  const beforeLines = content.split(/\r?\n/).length
  let applied = 0
  let bad = 0
  for (let i = 0; i < starts.length; i++) {
    const segEnd = i + 1 < starts.length ? starts[i + 1].at : raw.length
    const seg = raw.slice(starts[i].end, segEnd)
    const om = seg.match(/---\s*OLD\s*---\r?\n([\s\S]*?)\r?\n---\s*NEW\s*---\r?\n([\s\S]*)$/)
    if (!om) {
      const isNote = /并入|核验|统一记录|无需替换|不单独替换|共用同一替换块/.test(seg)
      if (isNote) { console.log(`NOTE  ${starts[i].id}: 说明块（合并/核验记录），不含替换`); continue }
      console.error(`BLOCK_INVALID ${starts[i].id}: 缺 OLD/NEW 标记且不像说明块`)
      bad++
      continue
    }
    const oldText = trimNl(om[1])
    const newText = trimNl(om[2])
    if (targetCJK < 5 && cjkCount(newText) >= 5) {
      console.error(`NEW_HAS_CJK ${starts[i].id}: NEW 段含 ${cjkCount(newText)} 个中文字符，而目标稿几乎不含中文 —— 疑似「编辑说明」误入正文。已拒绝应用。`)
      bad++
      continue
    }
    const hits = content.split(oldText).length - 1
    if (hits === 0) { console.error(`OLD_NOT_FOUND ${starts[i].id}: OLD 段在源文件找不到（逐字不一致，或被前一块改动影响）`); bad++; continue }
    if (hits > 1) { console.error(`OLD_NOT_UNIQUE ${starts[i].id}: OLD 段命中 ${hits} 次，无法确定改哪一处`); bad++; continue }
    content = content.replace(oldText, () => newText)
    console.log(`APPLIED ${starts[i].id}  (-${oldText.length} +${newText.length})`)
    // v6.29I：「过度纠正」是目前唯一还没机器护栏的错误类。
    // 实例：主控把**本来正确**的 Herfindahl 基线 `23 州 / 0.043 / 6.1×` 改成了 `26 州 / 0.0385 / 6.9×`。
    // 改完之后账**仍然自洽**（1/26=0.0385、0.266/0.0385=6.9 都对），只有回原始数据重算才知道分母该是 23。
    // 能机械化的部分：**凡改动涉及数字，就把改前/改后的数字摆出来**，让"数字变了"这件事无法悄悄发生。
    const numOf = (s) => (s.match(/\d+(?:[.,]\d+)?/g) || [])
    const nOld = numOf(oldText)
    const nNew = numOf(newText)
    const sig = (a) => [...new Set(a)].sort().join('|')
    if (sig(nOld) !== sig(nNew)) {
      const gone = [...new Set(nOld)].filter((x) => !nNew.includes(x))
      const came = [...new Set(nNew)].filter((x) => !nOld.includes(x))
      console.log(`  NOTICE_NUMERIC_CHANGE ${starts[i].id}: 改动涉及数字`
        + `  去掉[${gone.join(', ') || '无'}]  新增[${came.join(', ') || '无'}]`
        + '  —— 数字变了就要能指出依据（回原始数据核，别只看账自不自洽）')
    }
    applied++
  }
  writeFileSync(out, content, 'utf8')
  console.log(`SUMMARY blocks=${starts.length} applied=${applied} bad=${bad} lines ${beforeLines}->${content.split(/\r?\n/).length}`)
  if (bad > 0) {
    console.error('APPLY_INCOMPLETE: 有块未应用 —— 候选稿不完整，不得进复核。')
    return 2
  }
  console.log('APPLY_OK')
  return 0
}

/**
 * metrics <file> [limitPages] —— 量体量：正文/参考文献分开计词，估算页数，对比上限。
 * v6.29：论文类的「版面预算」是硬约束。实测某稿按字数估 12.28 页、真实排版 17 页 —— 差 5 页。
 * 所以本命令只给「估算」，并在有上限时强制提醒：必须编译实测。
 */
function cmdMetrics([file, limit, measured]) {
  if (!file) die('usage: metrics <file.md> [limitPages] [measuredPages]')
  if (!existsSync(file)) die(`metrics: 文件不存在: ${file}`)
  const s = readFileSync(file, 'utf8')
  // 2026-11-11：中文按字计数。原实现只数拉丁词，中文文档（无空格）会被严重低估
  // —— 实测一篇 1572 B 的中文稿只数出 10 个词。CJK 表意文字每个字算一个词（对齐「字数」惯例）。
  const wc = (t) => {
    const latin = (t.match(/[A-Za-z\u0370-\u03ff][A-Za-z\u0370-\u03ff'-]*/g) || []).length
    const cjk = (t.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length
    return latin + cjk
  }
  const idx = s.indexOf('## References')
  const body = idx > 0 ? s.slice(0, idx) : s
  const refs = idx > 0 ? s.slice(idx) : ''
  const bw = wc(body)
  const rw = wc(refs)
  console.log(`body_words=${bw}  refs_words=${rw}  total_words=${bw + rw}`)
  console.log(`est_pages@500=${(bw / 500).toFixed(2)}  est_pages@550=${(bw / 550).toFixed(2)}  （仅正文，不含图表）`)
  if (limit && measured) {
    const lim = Number(limit)
    const mp = Number(measured)
    if (!Number.isFinite(mp)) die('metrics: measuredPages 必须是数字')
    if (mp > lim) {
      console.error(`BUDGET_OVER: 实测 ${mp} 页 > 上限 ${lim} 页（超 ${mp - lim} 页）`)
      return 2
    }
    console.log(`BUDGET_OK: 实测 ${mp} ≤ ${lim} 页`)
    return 0
  }
  if (limit) {
    // 绝不在这里打 OK。实测：估算 11.04 页的稿子真实排版 16 页 —— 差 5 页。
    // 一个在超预算时显示"通过"的工具，比没有更糟。
    console.error(`BUDGET_UNMEASURED: 只有估算 ${(bw / 500).toFixed(2)} 页（仅正文、不含图表），**估算不具权威性**。`
      + '实测某稿估算 11.04 页而真实排版 16 页。请排版编译后传第三个参数：metrics <file> <limitPages> <measuredPages>')
  }
  return 0
}

/**
 * scancheck <file> —— 结构性反查：扫「不该在的」。
 * v6.29 核心教训：正向验证（「该在的在不在」）永远证明不了「没有混入」。
 * 实测主控逐条验证了 7 个修复标记仍在，却在英文稿 L3 留下中文编辑说明。
 */
function cmdScancheck([file]) {
  if (!file) die('usage: scancheck <file>')
  if (!existsSync(file)) die(`scancheck: 文件不存在: ${file}`)
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  const findings = []
  const cjk = lines.map((t, i) => [i + 1, t]).filter(([, t]) => /[\u4e00-\u9fff]/.test(t))
  // 判据演进（v6.29b）：初版用「中文字符占比 <2%」，对长文档有效但**短文档漏报** ——
  // 自测里 6 行文件含 1 行中文，字符占比 31%，被判为"正常中文文档"。
  // 改为**行占比**：中文行 < 20% 且至少 1 行 ⇒ 几乎一定是编辑说明混入。
  // 长文档同理有效（233 行稿里 1 行中文 → 0.4%），且不会误报中文文档（占比高）。
  const cjkLineRatio = cjk.length / Math.max(1, lines.length)
  if (cjk.length && cjkLineRatio < 0.2) findings.push({ code: 'CJK_IN_TEXT', msg: `含中文字符的行 ${cjk.length}/${lines.length} 处（占 ${(cjkLineRatio * 100).toFixed(1)}%，几乎一定是编辑说明误入）`, at: cjk.slice(0, 5).map(([n]) => 'L' + n) })
  const ph = lines.map((t, i) => [i + 1, t]).filter(([, t]) => /AUTHOR TO COMPLETE|\[待补\]|\[填写|TODO|TBD|FIXME|XXX/.test(t))
  if (ph.length) findings.push({ code: 'PLACEHOLDER', msg: `占位符 ${ph.length} 处（投稿前必须清空）`, at: ph.slice(0, 5).map(([n]) => 'L' + n) })
  const orphan = []
  for (let i = 0; i < lines.length; i++) {
    const hm = lines[i].match(/^(#{1,6})\s+\S/)
    if (!hm) continue
    const lvl = hm[1].length
    if (lvl === 1) continue // 文档标题后面紧跟节标题是正常的，不算空节
    let j = i + 1
    while (j < lines.length && lines[j].trim() === '') j++
    if (j >= lines.length) { orphan.push('L' + (i + 1)); continue }
    const nm = lines[j].match(/^(#{1,6})\s/)
    if (nm && nm[1].length <= lvl) orphan.push('L' + (i + 1))
  }
  if (orphan.length) findings.push({ code: 'ORPHAN_HEADING', msg: `空标题 ${orphan.length} 处（到下一个同级/更高级标题之间没有任何正文）`, at: orphan.slice(0, 5) })
  const dup = []
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i].trim()
    if (a.length > 40 && a === lines[i - 1].trim()) dup.push('L' + (i + 1))
  }
  if (dup.length) findings.push({ code: 'DUPLICATE_PARA', msg: `连续重复段落 ${dup.length} 处`, at: dup.slice(0, 5) })
  if (findings.length === 0) { console.log('SCAN_CLEAN: 未发现结构性残留'); return 0 }
  for (const f of findings) console.error(`${f.code}: ${f.msg}  ${f.at.join(', ')}`)
  const severe = findings.some((f) => ['CJK_IN_TEXT', 'DUPLICATE_PARA'].includes(f.code))
  return severe ? 2 : 0
}

/**
 * quality <roundDir...> —— 红队质量：从各轮判定表算「被主控驳回的比例」。
 *
 * v6.29c：为什么需要它 —— 三轮实跑里我手工数出「红队判错 4 次 / 多报率 25%」，
 * 那是判断「红队值不值得用、哪个模型好用」的核心指标，却只活在我的记忆里。
 * 换一次对话就丢了，等于这项评估从来没做过。
 *
 * 口径（必须写清，否则数字会被滥用）：
 *   rejected = 判定表里状态为「不成立」的行 —— 即主控附反证驳回了红队的指控。
 *   accepted = 其余（已消除 / 挂账 / 未修 / 部分修）——即指控成立，只是处置进度不同。
 *   多轮按「编号」合并，**后轮覆盖前轮**（同一编号在 R3 的状态才是当前真值）。
 *
 * 已知盲区（如实报告，不掩盖）：**被驳回于「编号之前」的主张无法被本命令看到**。
 * 实测 R1 的技术审查员 F3/F9 就是这样丢的——我在合并时把它们写成了散文，没进编号表。
 * 因此本命令会打印 UNMATCHED 提示：若某轮 01-cases 的行数远多于其判定行数，说明有主张没被编号。
 */
function cmdQuality(dirs) {
  if (!dirs.length) die('usage: quality <roundDir...>')
  const latest = new Map() // 编号 -> { level, state, round, claimedLevel }
  const perRound = []
  const seen = new Set() // 之前轮次已经判定过的编号（用于区分「本轮不审」与「彻底丢失」）
  // v6.29d：读侧车文件。为什么用侧车而不是往用例表加列 ——
  // 实测往多表文档加列会因「只认第一个表头」而把表改坏（三轮全部错位，靠备份 zip 才还原）。
  // 侧车对文档零侵入，删了也不影响原稿。
  const role2model = new Map()
  const id2role = new Map()
  for (const d of dirs) {
    const rp = join(d, 'redteam-roster.json')
    if (existsSync(rp)) {
      try {
        const j = JSON.parse(readFileSync(rp, 'utf8').replace(/^\uFEFF/, ''))
        for (const e of j.roles || []) if (e.role) role2model.set(e.role, `${e.provider}/${e.model}`)
      } catch (e) { console.error(`ROSTER_INVALID ${d}: ${e.message}`) }
    }
    const mp = join(d, 'role-map.json')
    if (existsSync(mp)) {
      try {
        for (const [k, v] of Object.entries(JSON.parse(readFileSync(mp, 'utf8').replace(/^\uFEFF/, '')))) id2role.set(k, v)
      } catch (e) { console.error(`ROLEMAP_INVALID ${d}: ${e.message}`) }
    }
  }
  for (const d of dirs) {
    let f = join(d, '03-review.md')
    if (!existsSync(f)) f = join(d, '01-cases.md')
    if (!existsSync(f)) { console.error(`SKIP ${d}: 既无 03-review.md 也无 01-cases.md`); continue }
    const rows = parseVerdict(f)
    if (!rows.length) { console.error(`SKIP ${d}: ${f.split(/[\\/]/).pop()} 里 0 行可识别`); continue }
    const rej = rows.filter((r) => r.level === '不成立')
    const byLvl = {}
    for (const r of rows) {
      const k = r.claimedLevel || '?'
      byLvl[k] = byLvl[k] || { claimed: 0, rejected: 0 }
      byLvl[k].claimed++
      if (r.level === '不成立') byLvl[k].rejected++
    }
    const tag = d.split(/[\\/]/).filter(Boolean).pop()
    perRound.push({ tag, file: f.split(/[\\/]/).pop(), total: rows.length, rejected: rej.length, byLvl })
    for (const r of rows) latest.set(r.id, { level: r.level, claimedLevel: r.claimedLevel, round: tag })
    // 盲区探测：只有「本轮没审、而且历史轮次也从没判定过」的编号才算真丢失。
    // 否则 R2/R3 只复核 7 条严重时，会把 C06–C11 全报成"丢失"，变成狼来了。
    const casesPath = join(d, '01-cases.md')
    if (existsSync(casesPath) && f.endsWith('03-review.md')) {
      const caseRows = parseVerdict(casesPath)
      const lost = caseRows.filter((c) => !rows.some((r) => r.id === c.id) && !seen.has(c.id))
      if (lost.length) {
        console.error(`UNMATCHED ${tag}: 01-cases 有 ${lost.length} 条（${lost.slice(0, 6).map((x) => x.id).join(',')}）既不在本轮判定表、也不在任何前轮判定表里`
          + ' —— 这多半是被驳回于「编号之前」，红队误判率会被低估。')
      }
    }
    for (const r of rows) seen.add(r.id)
  }
  if (!perRound.length) { console.error('QUALITY_EMPTY: 没有可解析的轮次'); return 2 }

  console.log('轮次           来源            条数  驳回  驳回率')
  for (const p of perRound) {
    console.log(`${p.tag.padEnd(14)} ${String(p.file).padEnd(15)} ${String(p.total).padStart(4)}  ${String(p.rejected).padStart(4)}  ${(p.rejected / p.total * 100).toFixed(1)}%`)
  }
  console.log('')
  console.log('按级别（各轮累加，会重复计同一编号）：')
  const agg = {}
  for (const p of perRound) for (const [k, v] of Object.entries(p.byLvl)) {
    agg[k] = agg[k] || { claimed: 0, rejected: 0 }
    agg[k].claimed += v.claimed
    agg[k].rejected += v.rejected
  }
  for (const k of ['致命', '严重', '一般', '优化', '?']) {
    if (!agg[k]) continue
    console.log(`  ${k}: claimed=${agg[k].claimed} rejected=${agg[k].rejected} rate=${(agg[k].rejected / agg[k].claimed * 100).toFixed(1)}%`)
  }

  // 去重后（按编号取最新轮）的当前真值
  const uniq = [...latest.values()]
  const uRej = uniq.filter((x) => x.level === '不成立')
  console.log('')
  console.log(`去重后（按编号取最新轮）: unique=${uniq.length} rejected=${uRej.length} rejected_rate=${(uRej.length / uniq.length * 100).toFixed(1)}%`)
  const uByLvl = {}
  for (const x of uniq) {
    const k = x.claimedLevel || '?'
    uByLvl[k] = uByLvl[k] || { claimed: 0, rejected: 0 }
    uByLvl[k].claimed++
    if (x.level === '不成立') uByLvl[k].rejected++
  }
  for (const k of ['严重', '一般']) {
    if (!uByLvl[k]) continue
    console.log(`  ${k}: claimed=${uByLvl[k].claimed} rejected=${uByLvl[k].rejected} rate=${(uByLvl[k].rejected / uByLvl[k].claimed * 100).toFixed(1)}%`)
  }

  // 按红队模型（需要 redteam-roster.json + role-map.json 两个侧车）
  if (role2model.size) {
    const byModel = {}
    let unattributed = 0
    for (const [id, x] of latest.entries()) {
      const role = id2role.get(id)
      const model = role ? role2model.get(role) : null
      if (!model) { unattributed++; continue }
      byModel[model] = byModel[model] || { claimed: 0, rejected: 0 }
      byModel[model].claimed++
      if (x.level === '不成立') byModel[model].rejected++
    }
    console.log('')
    console.log('按红队模型（去重后，取最新轮状态）：')
    const rows = Object.entries(byModel).sort((a, b) => b[1].claimed - a[1].claimed)
    for (const [m, v] of rows) {
      console.log(`  ${m.padEnd(36)} claimed=${String(v.claimed).padStart(2)} rejected=${String(v.rejected).padStart(2)} rate=${(v.rejected / v.claimed * 100).toFixed(1)}%`)
    }
    if (unattributed) {
      console.error(`  UNATTRIBUTED=${unattributed} 条无角色/模型映射 —— 这些不计入上面的模型统计。`)
    }
    console.log('  注意：驳回率**受「该角色被分到什么任务」影响**，不能单独当模型好坏排名。')
    console.log('        实测例：sensenova 的 0% 全部来自 R3 复核轮（复核只需确认闭合，结构性上很难驳）；')
    console.log('        而 qwen3.8-flash 的 33% 来自领域/新颖性任务，那类主张本身最容易站不住。')
  } else {
    console.error('NO_ROSTER: 未找到 redteam-roster.json —— 无法按模型统计（见 SKILL §4.7 第八条）。')
  }

  // v6.29g：精确率必须与召回率并排。
  // 只看"驳回率低"可能是红队少报（漏判换来的干净），只看"召回低"可能是任务本身就难。
  // 扫描兄弟目录（而不是只扫传入目录）—— 标定轮通常没有判定表，不会被传进来。
  try {
    const root = dirname(resolve(dirs[0]))
    const scores = []
    for (const name of readdirSync(root)) {
      const d2 = join(root, name)
      if (!existsSync(d2)) continue
      let files = []
      try { files = readdirSync(d2) } catch { continue }
      for (const f of files) {
        if (!f.endsWith('.score.json')) continue
        try {
          const j = JSON.parse(readFileSync(join(d2, f), 'utf8'))
          scores.push({ dir: name, file: f, recall: j.recall, at: j.scoredAt, flags: Array.isArray(j.flags) ? j.flags : [] })
        } catch { /* 单个坏文件不影响整体 */ }
      }
    }
    if (scores.length) {
      scores.sort((a, b) => String(a.at).localeCompare(String(b.at)))
      const last = scores[scores.length - 1]
      console.log('')
      console.log(`召回基线（同一批产物）: ${(Number(last.recall) * 100).toFixed(1)}%  （${last.dir}/${last.file}，共 ${scores.length} 次标定）`)
      if (last.flags && last.flags.length) {
        console.error(`  标定告警: ${last.flags.join(', ')} —— 召回率可能被挑选过的锚抬高，别把 100% 当成红队强`)
      }
      console.log('  精确率与召回率必须并排看：只报「驳回率低」可能是红队少报；只报「召回低」可能是任务本身太难。')
    } else {
      console.error('QUALITY_NO_RECALL: 没有任何 canary 标定记录 —— 上面的驳回率只是精确率的一半信息，'
        + '不能据此判断红队"好"或"差"。先跑 canary。')
    }
  } catch (e) {
    // v6.29x：这段负责把「召回基线」打到输出上。它若静默失败，读者只会看到驳回率、看不到召回率，
    // 于是"精确率与召回率必须并排看"这条纪律就名存实亡。至少要留一条痕迹。
    console.error(`QUALITY_RECALL_SCAN_ERROR: 召回基线扫描出错（${String(e?.message ?? e)}）—— 下面的驳回率缺少召回率对照，别单看。`)
  }
  return 0
}

/**
 * 通用表格行解析：支持一个文件里有多张表（遇到非表格行就重置表头）。
 * v6.29e：为什么要它 —— 之前直接用 split('|') 的临时脚本只认第一个表头，
 * 往多表文档里加列时把三轮表格全改坏了，靠备份 zip 才还原。
 */
function parseTableRows(file) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  const out = []
  let hdr = null
  for (const line of lines) {
    if (!line.startsWith('|')) { hdr = null; continue }
    const cells = line.split('|').slice(1, -1).map((s) => s.trim())
    if (!hdr) {
      if (/^(编号|用例)$/.test(cells[0] || '')) hdr = cells
      continue
    }
    if (cells.every((c) => /^:?-{3,}:?$/.test(c))) continue
    const id = cells[0]
    if (!/^[A-Za-z]+\d{1,3}$/.test(id)) continue
    const row = { id }
    hdr.forEach((h, i) => { row[h] = cells[i] || '' })
    out.push(row)
  }
  return out
}

/** 从判据/证据里抽「识别锚」：引号内片段 + 长标识符。锚越独特，召回判定越可信。 */
function extractAnchors(text) {
  const set = new Set()
  for (const m of text.matchAll(/[「"“]([^」"”]{4,80})[」"”]/g)) set.add(m[1].trim())
  for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9_.\-\/]{7,}/g)) set.add(m[0])
  return [...set].filter((s) => s.length >= 4).slice(0, 6)
}

/**
 * canary build <casesFile> <keyOut.json> --ids C01,C02,... —— 造「召回金丝雀」的对照键。
 *
 * 为什么需要它：现有机制只能测「红队多报」（假阳性），**测不了漏判**（假阴性）。
 * 技能 §4.2 早就写了金丝雀办法，但一直是散文、没有机器。
 *
 * 口径：键里存的是每条缺陷的「识别锚」（判据/证据里的独特字符串）。
 * 之后拿一个**没见过这些缺陷的新模型**去攻击原始交付件，再看它有没有独立撞到同样的锚。
 * 命中 = 召回；未命中 = 漏判。注意锚可能出现在无关上下文里 —— 这是已知噪声，需人抽检。
 */
function cmdCanaryBuild(args) {
  const [casesFile, keyOut] = args
  if (!casesFile || !keyOut) die('usage: canary build <casesFile> <keyOut.json> --ids C01,C02 [--anchors "C01=a|b;C02=c"]')
  if (!existsSync(casesFile)) die(`canary build: 文件不存在: ${casesFile}`)
  // 选项从传入的参数数组里读，不从全局 process.argv 读 ——
  // 全局读法会让这个函数无法被 selftest 直接调用（自测传不了参），等于没有护栏。
  const argVal = (name) => {
    const hit = args.find((a) => a.startsWith(`${name}=`))
    if (hit) return hit.slice(name.length + 1)
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : ''
  }
  const ids = String(argVal('--ids') || '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!ids.length) die('canary build: 需要 --ids C01,C02,...')
  // 显式锚优先。为什么：自动从中文判据里抽西文锚经常只抽到 0–1 个（实测 7 条里 4 条不足），
  // 而召回判定必须靠「能识别这条缺陷的独特串」。锚宁可由主控手工指定，也不要自动猜。
  const manual = new Map()
  for (const chunk of String(argVal('--anchors') || '').split(';')) {
    const eq = chunk.indexOf('=')
    if (eq < 0) continue
    manual.set(chunk.slice(0, eq).trim(), chunk.slice(eq + 1).split('|').map((s) => s.trim()).filter(Boolean))
  }
  const rows = parseTableRows(casesFile)
  const items = []
  for (const id of ids) {
    const r = rows.find((x) => x.id === id)
    if (!r) { console.error(`MISSING_CASE ${id}: 用例表里没有这一行`); continue }
    const src = [r['判据'], r['证据'], r['位置']].filter(Boolean).join(' ')

    const anchors = manual.get(id) || extractAnchors(src)
    if (anchors.length < 2) {
      console.error(`WEAK_ANCHORS ${id}: 只有 ${anchors.length} 个锚，召回判定不可靠（用 --anchors ${id}=a|b 手工指定）`)
    }
    items.push({
      id,
      level: r['级别'] || '',
      claim: (r['判据'] || '').slice(0, 300),
      anchors,
      minHit: Math.max(1, Math.ceil(anchors.length / 2)),
      anchorSource: manual.has(id) ? 'manual' : 'auto',
    })
  }
  if (!items.length) { console.error('CANARY_EMPTY: 没有造出任何金丝雀条目'); return 2 }
  const weak = items.filter((x) => x.anchors.length < 2)
  if (weak.length) {
    console.error(`CANARY_WEAK: ${weak.map((x) => x.id).join(',')} 的锚不足 2 个，召回率会被高估（更容易命中）`)
  }
  const key = {
    builtAt: new Date().toISOString(),
    casesFile: casesFile.split(/[\\/]/).pop(),
    items,
    note: '命中判定 = 该条 anchors 中被红队输出提及的数量 ≥ minHit。锚可能出现在无关上下文中，需人抽检。',
  }
  writeFileSync(keyOut, JSON.stringify(key, null, 2), 'utf8')
  console.log(`CANARY_BUILT: ${items.length} 条 -> ${keyOut}`)
  for (const it of items) {
    console.log(`  ${it.id} [${it.level}] ${it.anchorSource.padEnd(6)} anchors=${it.anchors.length} minHit=${it.minHit}  ${it.anchors.slice(0, 2).join(' | ')}`)
  }
  return 0
}

/**
 * canary score <key.json> <redOutput.md> —— 拿红队输出对照金丝雀，算召回率。
 */
function cmdCanaryScore([keyFile, redFile]) {
  if (!keyFile || !redFile) die('usage: canary score <key.json> <redOutput.md>')
  for (const p of [keyFile, redFile]) if (!existsSync(p)) die(`canary score: 文件不存在: ${p}`)
  let key
  try { key = JSON.parse(readFileSync(keyFile, 'utf8').replace(/^\uFEFF/, '')) } catch (e) { die(`canary score: key 不是合法 JSON: ${e.message}`) }
  const hay = readFileSync(redFile, 'utf8').toLowerCase()
  const results = []
  const flags = []
  for (const it of key.items) {
    const hitAnchors = it.anchors.filter((a) => hay.includes(String(a).toLowerCase()))
    const hit = hitAnchors.length >= (it.minHit || 1)
    // v6.29u（A4 盲点之三）：反锚点刷分。
    // 一条锚在一个红队输出里出现 ≥3 次，多半是"话题词"（lifespan / survival 之类），
    // 而不是"能唯一指认这条缺陷的辨识串"。用它算命中，召回率就会虚高。
    const genericHits = hitAnchors.filter((a) => {
      const re = new RegExp(String(a).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
      return (hay.match(re) || []).length >= 3
    })
    results.push({ id: it.id, level: it.level, hit, matched: hitAnchors.length, total: it.anchors.length, hitAnchors, genericHits })
  }
  const recall = results.filter((r) => r.hit).length / results.length
  const perfect = recall === 1 && results.length >= 3
  const generic = results.flatMap((r) => r.genericHits.map((a) => `${r.id}:${a}`))
  if (perfect) flags.push('RECALL_TOO_PERFECT')
  if (generic.length) flags.push('ANCHOR_GENERIC')
  // v6.29v：单锚条目太脆 —— minHit=1 时任何一个词命中就算"重新发现"，噪声极大。
  const weakItems = results.filter((r) => r.total < 2).map((r) => r.id)
  if (weakItems.length) flags.push('ANCHOR_WEAK')
  if (weakItems.length) {
    console.error(`ANCHOR_WEAK: ${weakItems.length} 条只有 1 个锚（${weakItems.join(',')}）—— 单锚命中即算"重新发现"，噪声太大；建议每条 ≥2 个。`)
  }
  console.log('金丝雀召回：')
  for (const r of results) {
    console.log(`  ${r.hit ? 'HIT ' : 'MISS'} ${r.id} [${r.level}] anchors ${r.matched}/${r.total}  ${r.hitAnchors.slice(0, 2).join(' | ')}`)
  }
  console.log(`CANARY_RECALL: ${(recall * 100).toFixed(1)}%  (${results.filter((r) => r.hit).length}/${results.length})`)
  const sev = results.filter((r) => r.level === '严重')
  if (sev.length) console.log(`  其中严重级召回：${sev.filter((r) => r.hit).length}/${sev.length}`)
  if (perfect) {
    console.error(`RECALL_TOO_PERFECT: ${results.length} 条全部命中 —— 锚是主控手工挑的，100% 召回请人工抽检至少一条，确认命中的词真的在指认同一条缺陷，而不是"话题词撞车"。`)
  }
  if (generic.length) {
    console.error(`ANCHOR_GENERIC: 有 ${generic.length} 个命中锚在红队输出里出现 ≥3 次（${generic.slice(0, 4).join(', ')}）—— 这类词缺乏辨识度，不宜作为召回判据。`)
  }
  console.log('  提醒：锚命中只是弱证据，需人抽检是否真在说同一件事（避免「关键词撞车」）。')
  // 落盘一份结果，供 converge 引用 —— 否则"收敛"这个结论没有任何覆盖率证据可查。
  const scorePath = redFile.replace(/\.md$/i, '') + '.score.json'
  writeFileSync(scorePath, JSON.stringify({
    scoredAt: new Date().toISOString(),
    keyFile: keyFile.split(/[\\/]/).pop(),
    redFile: redFile.split(/[\\/]/).pop(),
    recall,
    severeRecall: sev.length ? sev.filter((r) => r.hit).length / sev.length : null,
    flags,
    results,
    note: '锚命中为弱证据，需人抽检；CANARY_RECALL 低不代表红队差，先看它被分到什么任务。',
  }, null, 2), 'utf8')
  console.log(`SCORE_SAVED: ${scorePath}`)
  return recall >= 0.5 ? 0 : 1
}

function cmdCanary(args) {
  const sub = args[0]
  if (sub === 'build') return cmdCanaryBuild(args.slice(1))
  if (sub === 'score') return cmdCanaryScore(args.slice(1))
  die('usage: canary build <casesFile> <keyOut.json> --ids C01,C02  |  canary score <key.json> <redOutput.md>')
}

/**
 * carry <prevRoundDir> <currRoundDir> —— 建轮时的「携带旧账」检查。
 *
 * v6.29k：converge 里已有同一条判据，但那是收敛阶段才跑。实测 R5 把 R3 未闭合的 N3 丢了，
 * 直到跑 converge 才被发现 —— 应该在**建轮时**就拦。
 * 判据同 converge 条件 3：上一轮未闭合（非「已消除/不成立」）的编号，必须在本轮出现。
 * 已闭合的用例不必再列，所以条数变少不是问题。
 */
function cmdCarry([prevDir, currDir]) {
  if (!prevDir || !currDir) die('usage: carry <prevRoundDir> <currRoundDir>')
  const load = (d) => {
    const p3 = join(d, '03-review.md')
    const p1 = join(d, '01-cases.md')
    const f = existsSync(p3) ? p3 : (existsSync(p1) ? p1 : null)
    if (!f) return null
    return parseVerdict(f)
  }
  const prev = load(prevDir)
  const curr = load(currDir)
  if (!prev) die(`carry: 上一轮没有判定文件（03-review.md / 01-cases.md）: ${prevDir}`)
  if (!curr) die(`carry: 本轮没有判定文件（03-review.md / 01-cases.md）: ${currDir}`)
  const currIds = new Set(curr.map((r) => r.id))
  const prevOpen = prev.filter((r) => !(r.level === '已消除' || r.level === '不成立'))
  const lost = prevOpen.filter((r) => !currIds.has(r.id))
  console.log(`上一轮=${prev.length} 行（未闭合 ${prevOpen.length}）  本轮=${curr.length} 行`)
  if (!lost.length) {
    console.log('CARRY_OK: 上一轮所有未闭合项都已带入本轮')
    return 0
  }
  for (const r of lost) {
    console.error(`LOST_OPEN ${r.id}（状态 ${r.level}${r.claimedLevel ? '，级别 ' + r.claimedLevel : ''}）—— 上一轮未闭合，本轮没带`)
  }
  console.error(`CARRY_INCOMPLETE: 丢了 ${lost.length} 条旧账 —— 换了新用例却不携带旧账 = 靠遗忘"收敛"`)
  return 2
}

/**
 * route [<configPath>] [<providerFilter>] —— 列出 DSH profile 里**真正配置了**的 provider→model。
 *
 * v6.29l：为什么需要 —— 选子代理路由时实测踩了两次坑：
 *   ① `crossmodel.mjs list` 列的是**网关侧** 168 个模型，不等于 DSH 已配置（trae/kimi-k2.6 被预校验拒）
 *   ② 内置 `list_subagent_models` 对 agent2api-* 一律 "not allowed for this Session"
 * 唯一可靠来源是 profile 的 cordis.patch.yml。这个命令把那套读法固定下来，免得每次现编。
 *
 * 注意：本命令只回答「配置里有」，不回答「上游能用」—— 实测 gpt-6-astra 配置里有，但派活运行时失败。
 */
// ---------------- route probe / pick / mklib ----------------
// 用户 2026-11-10 第 10 次强调：「谁有余额就用谁，谁合适就用谁，别来问我」。
// 这里把「选模型」整件事变成代码：探测 → 排序 → 写库。不再依赖主控记不记得。
/**
 * 自动探测 DSH_HOME（可移植性：不假设用户的目录结构）。
 * 优先级：环境变量 DSH_HOME → <用户主目录>/.dsh → <用户主目录>/dsh-home → null
 *
 * 2026-11-11：原来硬编码 D:\1a个人\dsh-home，别人装了插件直接失效。
 */
function detectDshHome() {
  if (process.env.DSH_HOME && existsSync(process.env.DSH_HOME)) return process.env.DSH_HOME
  const home = process.env.USERPROFILE || process.env.HOME
  if (!home) return null
  for (const c of [join(home, '.dsh'), join(home, 'dsh-home')]) {
    try { if (existsSync(c)) return c } catch { /* 忽略 */ }
  }
  return null
}

/** 探测 node 可执行文件（工具本身需要 node 才能跑）。 */
function detectNode() {
  if (process.execPath && /node/i.test(process.execPath)) return process.execPath
  for (const c of ['node', 'nodejs']) {
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' })
      return c
    } catch { /* 继续 */ }
  }
  return null
}
const RB_CFG = process.env.RB_PROFILE_CONFIG || (detectDshHome() ? join(detectDshHome(), 'profiles', 'desktop', 'cordis.patch.yml') : null)
const RB_CRED = process.env.RB_CREDENTIALS || (detectDshHome() ? join(detectDshHome(), '.credentials.yaml') : null)
const RB_CACHE = process.env.RB_ROUTE_CACHE || join(dirname(RB_CFG), 'route-cache.json')

/** 从 profile 配置里解析 provider → baseURL / apiKeyEnv / models[{id,label,mult}]。 */
function parseProvidersFromCfg(cfgPath) {
  const L = readFileSync(cfgPath, 'utf8').split(/\r?\n/)
  const out = []
  let cur = null
  let inModels = false
  for (const line of L) {
    const pm = line.match(/^(\s*)(agent2api-[\w-]+|minekuai|longcat|deepseek[\w-]*):\s*$/)
    if (pm) { cur = { name: pm[2], baseURL: null, apiKeyEnv: null, models: [] }; out.push(cur); inModels = false; continue }
    if (!cur) continue
    const bm = line.match(/^\s*baseURL:\s*(\S+)\s*$/)
    if (bm) { cur.baseURL = bm[1]; continue }
    const km = line.match(/^\s*apiKeyEnv:\s*(\S+)\s*$/)
    if (km) { cur.apiKeyEnv = km[1]; continue }
    if (/^\s*models:\s*$/.test(line)) { inModels = true; continue }
    if (!inModels) continue
    const im = line.match(/^\s*-\s*id:\s*(\S+)\s*$/)
    if (im) { cur.models.push({ id: im[1], label: '', mult: null }); continue }
    const nm = line.match(/^\s*name:\s*(.+?)\s*$/)
    if (nm && cur.models.length) {
      const m = cur.models[cur.models.length - 1]
      if (!m.label) {
        m.label = nm[1]
        const mm = m.label.match(/×\s*([\d.]+)/)
        if (mm) m.mult = parseFloat(mm[1])
      }
      continue
    }
  }
  return out.filter((p) => p.models.length && p.baseURL)
}

/** 密钥优先取环境变量，其次 .credentials.yaml 的 refs。绝不打印密钥。 */
function readApiKey(envName) {
  const name = envName || 'AGENT2API_API_KEY'
  if (process.env[name]) return process.env[name]
  if (!existsSync(RB_CRED)) return null
  const t = readFileSync(RB_CRED, 'utf8')
  const m = t.match(new RegExp('^\\s+' + name + ':\\s*(\\S+)\\s*$', 'm'))
  return m ? m[1] : null
}

/** 发一次最小请求。max_tokens 给 16 是为了让推理模型也能出 content 且花费可忽略。 */
async function probeOne(baseURL, key, modelId) {
  const t0 = Date.now()
  try {
    const r = await fetch(String(baseURL).replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: '1' }], max_tokens: 16 }),
      signal: AbortSignal.timeout(40000),
    })
    const txt = await r.text()
    const ms = Date.now() - t0
    if (r.ok) return { ok: true, ms }
    let kind = 'HTTP_' + r.status
    if (/余额|不足|balance|credit|insufficient|quota|package/i.test(txt)) kind = 'NO_BALANCE'
    else if (/not allowed|forbidden|permission|user type/i.test(txt)) kind = 'FORBIDDEN'
    else if (/not exist|no such model|invalid model|model .* not/i.test(txt)) kind = 'NO_MODEL'
    return { ok: false, ms, kind, msg: txt.replace(/\s+/g, ' ').slice(0, 160) }
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, kind: 'NETWORK', msg: String(e && e.message ? e.message : e).slice(0, 160) }
  }
}

/** route probe [过滤词] [配置.yml] —— 实发请求，写入缓存。 */
async function routeProbe(args) {
  const filter = (args || []).find((a) => !/\.ya?ml$/i.test(a)) || ''
  const cfg = (args || []).find((a) => /\.ya?ml$/i.test(a)) || RB_CFG
  if (!existsSync(cfg)) die('route probe: 找不到配置 ' + cfg)
  const provs = parseProvidersFromCfg(cfg).filter((p) => !filter || p.name.includes(filter))
  if (!provs.length) { console.error('ROUTE_PROBE_EMPTY: 配置里没解析出 provider'); return 2 }
  const key = readApiKey('AGENT2API_API_KEY')
  if (!key) { console.error('ROUTE_PROBE_NO_KEY: 找不到 AGENT2API_API_KEY（环境变量与 .credentials.yaml 都没有）'); return 2 }
  console.log('PROBE: ' + provs.length + ' 个 provider，每个取倍率最低的 2 个模型实发最小请求（max_tokens=16）')
  const results = []
  for (const p of provs) {
    const sorted = [...p.models].sort((a, b) => (a.mult === null ? 99 : a.mult) - (b.mult === null ? 99 : b.mult))
    const picks = sorted.slice(0, 2)
    const perModel = []
    for (const m of picks) {
      const r = await probeOne(p.baseURL, key, m.id)
      perModel.push({ model: m.id, label: m.label, mult: m.mult, ...r })
    }
    const okAny = perModel.some((x) => x.ok)
    results.push({ provider: p.name, ok: okAny, models: perModel })
    const detail = perModel
      .map((x) => (x.ok ? x.model + ' OK ' + x.ms + 'ms' : x.model + ' ' + x.kind))
      .join(' ; ')
    console.log('  ' + (okAny ? 'OK  ' : 'FAIL') + ' ' + String(p.name).padEnd(22) + detail)
  }
  const cache = { probedAt: new Date().toISOString(), cfg, results }
  writeFileSync(RB_CACHE, JSON.stringify(cache, null, 2), 'utf8')
  const okN = results.filter((r) => r.ok).length
  console.log('')
  console.log('  ' + okN + ' / ' + results.length + ' 个 provider 可用 → 缓存写 ' + RB_CACHE)
  if (!okN) { console.error('ROUTE_PROBE_ALL_FAIL: 全部不可用，先确认网关 127.0.0.1:3065 在跑、密钥有效'); return 1 }
  return 0
}

function readRouteCache() {
  if (!existsSync(RB_CACHE)) return null
  try { return JSON.parse(readFileSync(RB_CACHE, 'utf8').replace(/^\uFEFF/, '')) } catch { return null }
}

/** route pick [偏好词] —— 按「可用 + 倍率最低」给出推荐，不问人。 */
function routePick(args) {
  const prefer = (args && args[0] ? args[0] : '').toLowerCase()
  const cache = readRouteCache()
  if (!cache) { console.error('ROUTE_PICK_NO_CACHE: 还没有探测缓存，先跑 route probe'); return 2 }
  const cands = []
  for (const r of cache.results) {
    if (!r.ok) continue
    for (const m of r.models) {
      if (m.ok) cands.push({ provider: r.provider, model: m.model, label: m.label, mult: m.mult === null ? 99 : m.mult, ms: m.ms })
    }
  }
  if (!cands.length) { console.error('ROUTE_PICK_NONE: 缓存里没有可用组合，重跑 route probe'); return 1 }
  cands.sort((a, b) => a.mult - b.mult || a.ms - b.ms)
  let shown = cands
  if (prefer) {
    const hit = cands.filter((c) => (c.provider + ' ' + c.model + ' ' + (c.label || '')).toLowerCase().includes(prefer))
    if (hit.length) shown = hit
    else console.error('  （没有匹配的，列出全部）')
  }
  const ageMin = Math.round((Date.now() - new Date(cache.probedAt).getTime()) / 60000)
  console.log('可用组合（倍率升序，越低越省）：')
  for (const c of shown.slice(0, 12)) {
    console.log('  ×' + String(c.mult).padEnd(6) + String(c.provider).padEnd(22) + c.model + (c.label ? '   ' + c.label : ''))
  }
  console.log('')
  console.log('  缓存时间 ' + cache.probedAt + '（' + ageMin + ' 分钟前）')
  console.log('  写库：route mklib <库名> ' + shown[0].provider + ' ' + shown[0].model)
  console.log('')
  console.log('  ⚠ **探测通过 ≠ 派活成功**（2026-11-10 实测）：provider 名只是网关的快照标签，')
  console.log('    实际扣费账号由网关按 model 动态路由。实测踩到：配置写 agent2api-autoclaw，')
  console.log('    派活时上游返回的却是「catpaw 余额不足」。所以：')
  console.log('      · probe 结果是**有时效的快照**，超过几小时应重测')
  console.log('      · 派活失败必须用 `attack fail` 记账，否则可用率被高估')
  console.log('      · 真实可用率按「实际派活成功」统计，不按 probe 数')
  return 0
}

/** route mklib <库名> <provider> <model> [描述] —— 写 subagents/*.yaml，立即生效。 */
async function routeMklib(args) {
  const force = (args || []).includes('--force')
  const pos = (args || []).filter((a) => a !== '--force')
  const libName = pos[0]
  const provider = pos[1]
  const model = pos[2]
  if (!libName || !provider || !model) die('usage: route mklib <库名> <provider> <model> [描述] [--force]')
  const dir = process.env.RB_SUBAGENT_DIR || (detectDshHome() ? join(detectDshHome(), 'subagents') : null)
  if (!existsSync(dir)) die('route mklib: subagents 目录不存在 ' + dir)
  const desc = pos[3] || ('红蓝对抗角色（' + provider + '/' + model + '）')
  const lines = [
    'description: ' + desc,
    'provider: ' + provider,
    'model: ' + model,
    'maxDepth: 1',
    'backgroundMode: continuable',
    'persona: |',
    '  你是红蓝对抗机制里的一个角色，运行在 ' + provider + '/' + model + ' 上。',
    '  只做分配给你的那一件事（攻击 / 处置 / 复核 / 复算），不越界。',
    '',
    '  硬要求：',
    '  - 每条结论必须给 文件名:行号 或 命令+实际输出，没有的不写',
    '  - 无法核实就写「未核实，原因：…」，不许猜',
    '  - 只读，不改任何文件（除非角色明确要求改）',
    '',
  ]
  const fp = join(dir, libName + '.yaml')
  if (existsSync(fp) && !force) {
    console.error('ROUTE_MKLIB_EXISTS: ' + fp + ' 已存在（加 --force 覆盖）')
    return 1
  }
  writeFileSync(fp, lines.join('\n'), 'utf8')
  console.log('ROUTE_MKLIB_OK: ' + fp)
  console.log('  provider/model = ' + provider + '/' + model)
  console.log('  → 立即生效（delegate 实时读目录），用 delegate(library_id="' + libName + '") 派')
  return 0
}

// ---------------- spawn：一条命令生成跨厂商红队任务包 ----------------
// 用户要的是「做项目时能通过红蓝对抗不断磨合」。那"做项目"这一步就不能是手工串十几条命令。
// 实测（2026-11-10）：我用三段固定 prompt 派了 Kimi / GLM / 讯飞，拿到三份互不重复的高质量审计。
// 那三段 prompt 就该固化成命令输出，而不是每次现写。
const SPAWN_ROLES = [
  {
    id: 'tech',
    name: '技术审查',
    hint: '数字/引用/逻辑/覆盖/过度声称 —— 只查"写出的对不对"',
    body: [
      '你是红队技术审查员。**只攻击，不修复。**',
      '',
      '## 靶件',
      '{TARGET}',
      '',
      '## 你要找什么（按这六类扫）',
      '1. **算错**：数字、比例、分母、时间窗、样本量 —— 全部自己复算，不许采信原文',
      '2. **口径错**：同一个量用了两种定义；标签与它描述的量不符；单位/时间原点不一致',
      '3. **引用错**：声称某处写着 X，实际写的是 Y；行号偏移；引文与论证无关',
      '4. **逻辑断裂**：前提推不出结论；证据只支撑一个更弱的版本',
      '5. **覆盖遗漏**：样本/时段/变量的缺口被写成"没有发生"',
      '6. **过度声称**：把"我没找到"写成"不存在"；把"不显著"写成"无效应"',
      '',
      '## 硬要求',
      '- 每条必须给 `文件名:行号` 或 `命令+实际输出`。**没有的不写。**',
      '- 每条说清：**什么事实 → 与原文哪一句冲突 → 后果是什么**。',
      '- 最多 8 条，按严重度排序（致命 > 严重 > 一般 > 优化）。',
      '- 你只能读，不能改任何文件。',
      '',
      '## 你不做什么',
      '- 不提改法（只说错在哪）',
      '- 不评价作者水平',
      '- 不写"建议加强论证"这类无法执行的空话',
      '- **算不出来就写「未复算，原因：…」，不许猜。**',
    ].join('\n'),
  },
  {
    id: 'domain',
    name: '方法/领域审查',
    hint: '估计量、推断越界、替代解释、证据等级 —— 只判"方法能不能支撑结论"',
    body: [
      '你是方法论审查员。**你只判方法能不能支撑结论，不查拼写、不查格式。**',
      '',
      '## 靶件',
      '{TARGET}',
      '',
      '## 你要回答的四件事',
      '1. **估计量对不对**：这个统计量/指标回答的是作者想问的那个问题吗？时间原点、分母、截断/删失处理是否与研究问题匹配？',
      '2. **推断是否越界**：显著性、区间、模型假设（独立性、同分布、比例风险…）在本文样本下成立吗？不成立时结论还能留多少？',
      '3. **替代解释**：观测到的模式，有没有比作者的解释更平凡、更结构性的解释（时期效应、样本选择、聚集性）？',
      '4. **证据等级**：作者把哪个层级的证据说成了哪个层级？（描述性 / 相关性 / 因果）',
      '',
      '## 硬要求',
      '- 每条给 `文件名:行号` + 原文片段。',
      '- 每条说清：**这个做法在什么条件下失效 → 本文是否满足该条件 → 失效后结论还剩什么**。',
      '- 最多 6 条，按「结论会不会因此翻转」排序。',
      '- 只读，不改文件。不提改法。',
      '- **无法判断就写「信息不足，需要 …」，不许编。**',
    ].join('\n'),
  },
  {
    id: 'devil',
    name: '魔鬼代言人',
    hint: '论证"这个交付件不该存在" —— 不给维度、不给判据、不给目标',
    body: [
      '你只拿到一个交付件，**没有目标、没有维度、没有判据 —— 这是故意的**。',
      '',
      '## 靶件',
      '{TARGET}',
      '',
      '## 你的任务',
      '论证这个交付件**不该存在**。至少覆盖：',
      '1. **问题不成立**：它要解决的问题，是不是伪问题？换个定义就不存在了？',
      '2. **结论可替代解释**：观测到的现象，有没有更平凡的解释？',
      '3. **方法有致命捷径**：有没有更简单、更可靠的做法，做了它这套就白做？',
      '4. **它保护了谁**：这套东西真正降低的是"错误被采纳"的概率，还是"被质疑时有人能拿出一份文件"的概率？',
      '5. **如果它消失**：一个诚实的人不带这套东西，会在哪里做得更好？',
      '',
      '## 硬要求',
      '- ≤6 条，编号 K01、K02…',
      '- 每条是**单一论证**，不 hedge、不写"可能/建议"。',
      '- 每条必须引用靶件的 `行号` 作为靶子。',
      '- 不许说"但它的初衷是好的"这类缓和话。',
      '- 不许提改法 —— 你只论证它不该存在。',
      '',
      '## 唯一允许的正面判断（写在结尾一句）',
      '如果作者只能保留一个零件，保留哪个？',
    ].join('\n'),
  },
]

/**
 * 从靶件所在目录收「已经处置过的条目」，塞进红队任务包。
 *
 * 为什么需要（2026-11-11 R15 实测）：三个跨厂商红队里，方法审查那份最重的三条
 * （主检验混淆 / 空间聚集未校正 / 断档窗替代解释）全部是 01-cases.md 里 N01/N02/N05/N17
 * 的重复——而 §5.1 早已写了「p=0.0001 is anti-conservative」「do not interpret as a cohort
 * lifespan effect」。红队不知道前几轮修过什么，只能把同一个洞再挖一遍。
 * 修法不是让它猜，是**把清单交给它**。
 */
function collectResolvedBrief(target) {
  const startDir = dirname(resolve(target))
  // 当前轮次还没有 03-review.md（新轮刚建），就往同级找最近的 R*-* 轮次 ——
  // R15 实测：新轮目录里没有判定记录，清单是空的，红队照样重挖 R14 已经处置的条目。
  let dir = startDir
  let review = join(dir, "03-review.md")
  if (!existsSync(review)) {
    let best = null
    let bestTime = 0
    try {
      for (const e of readdirSync(dirname(startDir), { withFileTypes: true })) {
        if (!e.isDirectory() || !/^R\d+/i.test(e.name)) continue
        const f = join(dirname(startDir), e.name, "03-review.md")
        if (!existsSync(f)) continue
        const t = statSync(f).mtimeMs
        if (t > bestTime) { bestTime = t; best = join(dirname(startDir), e.name) }
      }
    } catch { /* 找不到就空 */ }
    if (!best) return []
    dir = best
    review = join(dir, "03-review.md")
  }
  const out = []
  let text = ""
  try { text = readFileSync(review, "utf8").replace(/^\uFEFF/, "") } catch { return out }
  // 判定表行：| N01 | 已答 | … | 或 | N01 | 部分已答 | … |
  const resolved = new Set()
  // 判定表列序在各项目里不统一（有的第 2 列是级别、第 3 列才是状态），
  // 按「整行含肯定词且不含否定词」判断，比猜列序稳。
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\|\s*(N\d+)\s*\|/)
    if (!m) continue
    const positive = /已答|已消除|已处置|已修|已解决/.test(line)
    const negative = /未答|未解决|部分已答|部分已解决|仍未|待修/.test(line)
    if (positive && !negative) resolved.add(m[1])
  }
  if (!resolved.size) return out
  // 从 01-cases*.md 取摘要（取「判据与证据」那列前 80 字）
  const cases = readdirSync(dir).filter((f) => /^01-cases.*\.md$/i.test(f))
  const brief = new Map()
  for (const f of cases) {
    let c = ""
    try { c = readFileSync(join(dir, f), "utf8").replace(/^\uFEFF/, "") } catch { continue }
    for (const line of c.split(/\r?\n/)) {
      const m = line.match(/^\|\s*(N\d+)\s*\|/)
      if (!m) continue
      const cells = line.split("|").map((x) => x.trim())
      const body = cells.length >= 6 ? cells[5] : cells.join(" ")
      brief.set(m[1], body.replace(/\*\*/g, "").slice(0, 90))
    }
  }
  for (const id of resolved) out.push({ id, brief: brief.get(id) || "(无摘要)", from: basename(dir) })
  out.sort((a, b) => a.id.localeCompare(b.id))
  return out
}
/**
 * 从文本里抽数字（含小数），去重、保序。
 * 用途：把论文里的数字列出来给红队核对 —— 每个数字都该能指出算出它的脚本。
 */
function extractNumbers(text, limit) {
  // 只保留带小数点的数字（统计量）。
  // 理由：论文里的年份（2006/2026）、行号（172/162）、月份（08/07）会淹没真正的统计量。
  // 实测 R15：不过滤时前 60 个里只有 8 个是统计量，其余全是噪音。
  const seen = new Set()
  const out = []
  for (const m of text.matchAll(/\d+\.\d+/g)) {
    const v = m[0]
    if (seen.has(v)) continue
    seen.add(v)
    out.push(v)
    if (limit && out.length >= limit) break
  }
  return out
}

/**
 * 按 provider 去重选模型（每 provider 取最便宜的一个），支持 offset 轮换。
 * offset 用于 --retry=N：第 r 份任务包从第 r 个组合开始取。
 */
function pickModels(cache, roles, offset) {
  const picks = []
  if (!cache) return picks
  const ok = []
  for (const r of cache.results) {
    if (!r.ok) continue
    for (const m of r.models) if (m.ok) ok.push({ provider: r.provider, model: m.model, mult: m.mult === null ? 99 : m.mult })
  }
  const seenP = new Set()
  const uniqByProvider = []
  for (const c of ok.sort((a, b) => a.mult - b.mult)) {
    if (seenP.has(c.provider)) continue
    seenP.add(c.provider)
    uniqByProvider.push(c)
  }
  for (let i = 0; i < roles.length; i++) {
    picks.push(uniqByProvider[(offset + i) % Math.max(1, uniqByProvider.length)] || null)
  }
  return picks
}

function cmdSpawn(args) {
  const target = args.find((a) => !a.startsWith('--'))
  if (!target) die('usage: spawn <交付件路径> [--out=<文件>] [--roles=tech,domain,devil] [--retry=N] [--no-probe]')
  if (!existsSync(target)) die('spawn: 靶件不存在: ' + target)
  const outFlag = args.find((a) => a.startsWith('--out='))
  const outFile = outFlag ? outFlag.slice(6) : null
  const rolesFlag = args.find((a) => a.startsWith('--roles='))
  const wantRoles = rolesFlag ? rolesFlag.slice(8).split(',').map((s) => s.trim()) : SPAWN_ROLES.map((r) => r.id)
  const roles = SPAWN_ROLES.filter((r) => wantRoles.includes(r.id))
  if (!roles.length) die('spawn: --roles 里没有一个合法角色（可选 tech / domain / devil）')
  const retryFlag = args.find((a) => a.startsWith('--retry='))
  const retry = retryFlag ? Math.max(1, parseInt(retryFlag.slice(8), 10) || 1) : 1

  // 读 cache 与历史账（与 r 无关，只读一次）
  const cache = readRouteCache()
  const resolvedBrief = collectResolvedBrief(target)
  const resolvedFrom = resolvedBrief.length ? (resolvedBrief[0].from || '上一轮') : ''

  for (let r = 0; r < retry; r++) {
    const picks = pickModels(cache, roles, r)
    const lines = []
    lines.push('=== 跨厂商红队任务包 ===')
    lines.push('靶件: ' + resolve(target))
    lines.push('生成时间: ' + new Date().toISOString())
    if (!cache) {
      lines.push('')
      lines.push('⚠ 没有 route-cache，先跑：node redblue.mjs route probe')
      lines.push('   它会实发最小请求测出哪个 provider 现在有额度，并把结果写进缓存。')
    } else {
      const cacheAgeMin = Math.round((Date.now() - new Date(cache.probedAt).getTime()) / 60000)
    lines.push('模型缓存: ' + cache.probedAt + '（' + cacheAgeMin + ' 分钟前）')
    // v6.29Q（2026-11-11 实测）：缓存超过 1 小时就报警。
    // 实测：6 小时前的缓存里只有 1 个 provider 可用，重新 probe 后有 11 个 ——
    // 用旧缓存派活等于自断备选，而 --retry 的整个意义就是有备选。
    if (cacheAgeMin > 60) {
      lines.push('⚠ 缓存已 ' + Math.floor(cacheAgeMin / 60) + ' 小时 ' + (cacheAgeMin % 60) + ' 分钟，**强烈建议先重新 probe**：')
      lines.push('    node redblue.mjs route probe')
      lines.push('  （网关按 model 动态路由，几小时前可用的组合现在可能不可用，反之亦然）')
    }
      lines.push('')
      lines.push('建议组合（已按 provider 去重；同 provider 不同模型不算跨厂商）：')
      // v6.29P（2026-11-11）：把论文里的数字列出来（与角色无关，只加一次）。
    {
      let tgt = ''
      try { tgt = readFileSync(resolve(target), 'utf8').replace(/^\uFEFF/, '') } catch { /* 读不到就跳过 */ }
      if (tgt) {
        const nums = extractNumbers(tgt, 60)
        if (nums.length) {
          lines.push('')
          lines.push('## 靶件里的数字（供核对）')
          lines.push('')
          lines.push('红队质疑任何数字前，先跑 history 查它有没有被复算过。以下是靶件里出现的数字（前 ' + nums.length + ' 个）：')
          lines.push('')
          lines.push('  ' + nums.join(', '))
        }
      }
    }
    for (let i = 0; i < roles.length; i++) {
        const p = picks[i]
        lines.push('  ' + roles[i].id.padEnd(8) + (p ? p.provider + ' / ' + p.model + '  ×' + p.mult : '(无可用模型)'))
      }
    }
    // v6.29N（R15 实测）：把「已处置条目」交给红队，否则它会重挖同一批洞。
    if (resolvedBrief.length) {
      lines.push('')
      lines.push('## 前几轮已经处置过的条目（来自 ' + resolvedFrom + '；红队请勿重复报，除非你能证明处置不成立）')
      for (const r of resolvedBrief.slice(0, 40)) lines.push('  ' + r.id + '  ' + r.brief)
      if (resolvedBrief.length > 40) lines.push('  … 另 ' + (resolvedBrief.length - 40) + ' 条（见 01-cases.md）')
      lines.push('')
      lines.push('如果你的发现与上面某条相同，**请明确写「同 Nxx，但处置不成立，因为 …」**，不要当成新缺陷。')
    // v6.29O（2026-11-11）：强制红队先查历史账。
    // R15 实测：红队（和我自己）会重复发现已处置的问题，根因是没人查历史。
    // 现在把「查账」写成任务包的硬性第一步。
    lines.push('')
    lines.push('## 派活前必做（硬性，不是建议）')
    lines.push('')
    lines.push('对你要质疑的**每一个数字或说法**，先跑一次历史账查询：')
    lines.push('')
    lines.push('    node redblue.mjs history "<项目根>" "<关键词>"')
    lines.push('')
    lines.push('例如：')
    lines.push('    node redblue.mjs history "D:\\…\\30_课题_希腊网兴衰" "3.31"')
    lines.push('    node redblue.mjs history "D:\\…\\30_课题_希腊网兴衰" "materially shorter"')
    lines.push('')
    lines.push('命中「已处置/已验证」的，**不要重复报**；如果你认为处置不成立，写「同 Nxx，但处置不成立，因为 …」。')
    lines.push('查不到（HISTORY_NONE）才说明这是新问题。')
    } else {
      lines.push('')
      lines.push('（本轮目录里没有 03-review.md 判定记录，无法给出已处置清单——红队可能重复历史条目。）')
    }
    // v6.29O（2026-11-11）：强制红队先查历史账。
    // R15 实测：红队（和我自己）会重复发现已处置的问题，根因是没人查历史。
    // 现在把「查账」写成任务包的硬性第一步。
    lines.push('')
    lines.push('## 派活前必做（硬性，不是建议）')
    lines.push('')
    lines.push('对你要质疑的**每一个数字或说法**，先跑一次历史账查询：')
    lines.push('')
    lines.push('    node redblue.mjs history "<项目根>" "<关键词>"')
    lines.push('')
    lines.push('例如：')
    lines.push('    node redblue.mjs history "D:\\…\\30_课题_希腊网兴衰" "3.31"')
    lines.push('    node redblue.mjs history "D:\\…\\30_课题_希腊网兴衰" "materially shorter"')
    lines.push('')
    lines.push('命中「已处置/已验证」的，**不要重复报**；如果你认为处置不成立，写「同 Nxx，但处置不成立，因为 …」。')
    lines.push('查不到（HISTORY_NONE）才说明这是新问题。')
    lines.push('')
    lines.push('⚠ 探测通过 ≠ 派活成功（网关按 model 动态路由到不同账号）。派完失败要记账：')
    lines.push('   node redblue.mjs attack fail <轮次目录> <provider> <model> "<原因>"')
    lines.push('')
    for (let i = 0; i < roles.length; i++) {
      const role = roles[i]
      const p = picks[i]
      lines.push('─'.repeat(72))
      lines.push('【' + role.id + '】' + role.name + ' —— ' + role.hint)
      if (p) {
        lines.push('派法: delegate(library_id="rb-' + role.id + '")   ← 先用 route mklib 建这个库：')
        lines.push('      node redblue.mjs route mklib rb-' + role.id + ' ' + p.provider + ' ' + p.model + ' "红队·' + role.name + '"')
      }
      lines.push('─'.repeat(72))
      lines.push(role.body.replace(/\{TARGET\}/g, resolve(target)))
      lines.push('')
    }
    lines.push('─'.repeat(72))
    lines.push('派完之后：')
    lines.push('  1. 每个成功的红队：node redblue.mjs attack record <轮次目录> <provider> <model> <靶件> <角色>')
    lines.push('  2. 失败的要记：node redblue.mjs attack fail <轮次目录> <provider> <model> "<原因>"')
    lines.push('  3. 收到的意见合并去重编号，写进 01-cases.md')
    lines.push('  4. 蓝队逐条处置，写 02-blue.md + 改稿')
    lines.push('  5. 复核后写 03-review.md，然后：bundle → audit → gate → adjudicate')
    lines.push('─'.repeat(72))
    const out = lines.join('\n')
    if (outFile) {
      const f = retry > 1 ? outFile.replace(/\.md$/, '-' + (r + 1) + '.md') : outFile
      writeFileSync(f, out, 'utf8')
      console.log('SPAWN_OK: ' + f + '（' + roles.length + ' 个角色，第 ' + (r + 1) + '/' + retry + ' 份）')
    } else {
      console.log(out)
    }
  }
  if (retry > 1) {
    console.log('')
    console.log('── 派活顺序（--retry=' + retry + '）──')
    console.log('  依次派上面的 ' + retry + ' 份；某一份失败（静默无消息/余额不足）就换下一份。')
    console.log('  每份失败都要记账：attack fail <轮次目录> <provider> <model> "<原因>"')
  }
  return 0
}

function cmdArchive(args) {
  const positional = args.filter((a) => !a.startsWith('--'))
  if (!positional.length) {
    die([
      'usage: archive <源路径...> [--dest=<备份目录>] [--tag=<标记>] [--out=<zip路径>]',
      '',
      '  例: archive "D:\\项目\\30_课题" --dest="D:\\项目\\_备份" --tag=R15',
      '  例: archive "<插件根>\\plugins\\redblue-adversarial" --tag=r65',
    ].join('\n'))
  }
  const destFlag = args.find((a) => a.startsWith('--dest='))
  const tagFlag = args.find((a) => a.startsWith('--tag='))
  const outFlag = args.find((a) => a.startsWith('--out='))
  const tag = tagFlag ? tagFlag.slice(6) : 'archive'

  const sources = positional.map((s) => resolve(s))
  for (const s of sources) {
    if (!existsSync(s)) die('archive: 源路径不存在: ' + s)
  }

  // 备份目录：--dest 优先；否则取第一个源路径的父目录下的 _备份
  let destDir
  if (destFlag) destDir = resolve(destFlag.slice(7))
  else {
    const first = sources[0]
    const parent = statSync(first).isDirectory() ? dirname(first) : dirname(dirname(first))
    destDir = join(parent, '_备份')
  }
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })

  // 文件名：<首个源的名字>-<标记>_<时间戳>.zip
  const baseName = basename(sources[0]).replace(/[\\/:*?"<>|]/g, '_')
  // 本地时间 yyyymmdd-HHMM（原来是 UTC 且去掉了所有分隔符，读起来是一串数字）
  const _d = new Date()
  const _p2 = (v) => String(v).padStart(2, '0')
  const ts = String(_d.getFullYear()) + _p2(_d.getMonth() + 1) + _p2(_d.getDate())
    + '-' + _p2(_d.getHours()) + _p2(_d.getMinutes())
  const zipPath = outFlag ? resolve(outFlag.slice(6)) : join(destDir, baseName + '-' + tag + '_' + ts + '.zip')
  if (existsSync(zipPath)) {
    // 不用 die()：die 是 process.exit，会让上方 selftest 直接中断（实测 PASS 从 173 掉到 171）。
    // 「参数错」用 die，「运行时错」用 return 2 —— 后者可被自测捕获。
    console.error('archive: 目标已存在，不覆盖: ' + zipPath + '（换个 --tag 或 --out）')
    return 2
  }

  const isWin = process.platform === 'win32'
  console.log('ARCHIVE: ' + sources.length + ' 个源 → ' + zipPath)
  try {
    if (isWin) {
      // Compress-Archive 的 -Path 支持通配符，用单引号包住以免路径里的空格/中文出问题
      const psPaths = sources.map((s) => "'" + s.replace(/'/g, "''") + "'").join(',')
      const psScript = `Compress-Archive -Path ${psPaths} -DestinationPath '${zipPath.replace(/'/g, "''")}' -CompressionLevel Optimal -Force`
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } else {
      execFileSync('zip', ['-r', '-q', zipPath, ...sources], { stdio: ['ignore', 'pipe', 'pipe'] })
    }
  } catch (e) {
    const msg = String(e && e.stderr ? e.stderr : (e && e.message) || e).slice(0, 300)
    console.error('ARCHIVE_FAIL: 打包失败 —— ' + msg)
    return 2
  }

  if (!existsSync(zipPath)) {
    console.error('ARCHIVE_FAIL: 命令返回成功但目标文件不存在: ' + zipPath)
    return 2
  }
  const sz = statSync(zipPath).size
  const h = createHash('sha256').update(readFileSync(zipPath)).digest('hex').slice(0, 16).toUpperCase()
  console.log('ARCHIVE_OK: ' + (sz / 1048576).toFixed(2) + ' MB  ' + h)
  console.log('  路径: ' + zipPath)
  for (const s of sources) console.log('  含: ' + s)
  return 0
}

// ---------------- project：项目配置（记住每个项目的路径，不用每次重传） ----------------
// 用户目标：做项目时能不断磨合。但每开一个项目，路径（项目根/轮次根/期刊/备份目录）
// 都要重新告诉一遍 —— 这是纯摩擦，没有判断成分。
//
// 存储：<DSH_HOME>/redblue-projects.json（无 DSH_HOME 时退回工具同级目录）
function projectStorePath() {
  const home = detectDshHome()
  return join(home, 'redblue-projects.json')
}

function readProjectStore() {
  const p = projectStorePath()
  if (!existsSync(p)) return { projects: {}, current: null }
  try {
    const j = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
    if (!j.projects) j.projects = {}
    return j
  } catch {
    return { projects: {}, current: null }
  }
}

function writeProjectStore(store) {
  const p = projectStorePath()
  const dir = dirname(p)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(p, JSON.stringify(store, null, 2), 'utf8')
  return p
}

function cmdProject(args) {
  const sub = args[0]
  const store = readProjectStore()
  const val = (name) => {
    const f = args.find((a) => a.startsWith('--' + name + '='))
    return f ? f.slice(name.length + 3) : null
  }

  if (sub === 'list' || sub === undefined) {
    const names = Object.keys(store.projects).sort()
    if (!names.length) {
      console.log('PROJECT_NONE: 还没有任何项目。用 project set <名字> --root=<项目根> 建一个。')
      return 0
    }
    console.log('已登记 ' + names.length + ' 个项目（* = 当前）:')
    for (const n of names) {
      const p = store.projects[n]
      console.log('  ' + (n === store.current ? '*' : ' ') + ' ' + n.padEnd(20) + ' ' + (p.root || '(无根)'))
      if (p.rounds) console.log('    ' + ' '.repeat(22) + 'rounds=' + p.rounds)
      if (p.journal) console.log('    ' + ' '.repeat(22) + 'journal=' + p.journal)
    }
    return 0
  }

  if (sub === 'set') {
    const name = args[1]
    if (!name) die('usage: project set <名字> --root=<项目根> [--rounds=<轮次根>] [--journal=<期刊>] [--dest=<备份目录>]')
    const root = val('root')
    if (!root) die('project set: 必须给 --root=<项目根>')
    if (!existsSync(resolve(root))) die('project set: 项目根不存在: ' + root)
    const prev = store.projects[name] || {}
    store.projects[name] = {
      root: resolve(root),
      rounds: val('rounds') ? resolve(val('rounds')) : (prev.rounds || null),
      journal: val('journal') || prev.journal || null,
      dest: val('dest') ? resolve(val('dest')) : (prev.dest || null),
      updatedAt: new Date().toISOString(),
    }
    store.current = name
    const p = writeProjectStore(store)
    console.log('PROJECT_SET: ' + name + ' → ' + store.projects[name].root)
    console.log('  已设为当前项目；配置写 ' + p)
    return 0
  }

  if (sub === 'use') {
    const name = args[1]
    if (!name) die('usage: project use <名字>')
    if (!store.projects[name]) die('project use: 没有这个项目: ' + name + '（先 project list 看看）')
    store.current = name
    writeProjectStore(store)
    const p = store.projects[name]
    console.log('PROJECT_USE: 当前项目 = ' + name)
    console.log('  root   = ' + p.root)
    if (p.rounds) console.log('  rounds = ' + p.rounds)
    if (p.journal) console.log('  journal= ' + p.journal)
    return 0
  }

  if (sub === 'show') {
    const name = args[1] || store.current
    if (!name) die('project show: 没有指定名字，且没有当前项目')
    const p = store.projects[name]
    if (!p) die('project show: 没有这个项目: ' + name)
    console.log(JSON.stringify({ name, ...p }, null, 2))
    return 0
  }

  if (sub === 'unset') {
    const name = args[1] || store.current
    if (!name || !store.projects[name]) die('project unset: 没有这个项目: ' + (name || '(空)'))
    delete store.projects[name]
    if (store.current === name) store.current = null
    writeProjectStore(store)
    console.log('PROJECT_UNSET: ' + name + ' 已删除')
    return 0
  }

  die([
    'usage: project <list|set|use|show|unset> [名字] [--root=] [--rounds=] [--journal=] [--dest=]',
    '',
    '  project set 课题30 --root="D:\\…\\30_课题_希腊网兴衰" --journal=JRP',
    '  project use 课题30',
    '  project list',
  ].join('\n'))
}

// ---------------- history：查历史账（某个说法/数字在 R1–RN 里有没有被处置过） ----------------
// 2026-11-11 实测教训：
//   R15 里我（主控）把 `χ²=3.31` 当成「溯源不到」的新缺陷，实际 R14 的 `03-review.md:27`
//   早就写着 `χ²=1.6651（标准方差）/1.7230（脚本方差）`；
//   我还把「6.3 y 要限定 141 ever-active」当成新发现，实际 `01-cases.md:49` 早已判定
//   「领域 D10：23 端点被排除，6.3 y 是条件中位 → 已充分披露」。
// 根因不是「没存档」，是**没有人去查**：这个项目有 15 个轮次目录，每个里面有
//   01-cases*.md（红队用例）/ 02-blue*.md（蓝队处置）/ 03-review.md（复核判定）/ 04-summary.md（汇总），
//   那就是「改过什么、为什么改、谁验过」的完整账。
//
// 这个命令把「查账」变成一条命令，而不是靠人记得。

const RB_HISTORY_FILES = ['01-cases.md', '02-blue.md', '03-review.md', '04-summary.md']

/** 从一行里抽条目编号（N01 / C01 / K01 / A03 / D10 / F1 …）。 */
function extractId(line) {
  const m = line.match(/(?:^|[^A-Za-z0-9])((?:N|C|K|F|A|D)\d{1,3})\b/)
  return m ? m[1] : null
}

/** 从一行里抽状态词。返回数组，便于判断「是否已处置」。 */
function extractStates(line) {
  const found = []
  const positives = ['已答', '已消除', '已处置', '已修', '已解决', '闭合', '修', '已验证', '复算命中']
  const negatives = ['未答', '未解决', '部分已答', '部分已解决', '仍未', '待修', '挂账', '未修', '留']
  for (const p of positives) if (line.includes(p)) found.push(p)
  for (const n of negatives) if (line.includes(n)) found.push(n)
  return found
}

/**
 * 查历史账。
 *
 * 用法：history <项目根> <关键词> [关键词2 ...] [--limit=N] [--rounds=R1,R2]
 *
 * 输出：每个命中一行，带轮次、文件、行号、条目编号、状态词、命中片段。
 * 末尾给一个「是否已处置」的汇总判断。
 */
function cmdHistory(args) {
  const positional = args.filter((a) => !a.startsWith('--'))
  if (positional.length < 2) {
    die([
      'usage: history <项目根> <关键词> [关键词2 ...] [--limit=N] [--rounds=R1,R2]',
      '',
      '  例: history "D:\\…\\30_课题_希腊网兴衰" "3.31"',
      '  例: history "D:\\…\\30_课题_希腊网兴衰" "materially shorter" --limit=20',
      '',
      '  搜所有 R*-* 轮次目录下的 01-cases*.md / 02-blue*.md / 03-review.md / 04-summary.md，',
      '  返回包含关键词的行，并标出条目编号与处置状态。',
    ].join('\n'))
  }
  const rootArg = positional[0]
  const keywords = positional.slice(1).map((k) => k.toLowerCase())
  const limitFlag = args.find((a) => a.startsWith('--limit='))
  const limit = limitFlag ? parseInt(limitFlag.slice(8), 10) : 30
  const roundsFlag = args.find((a) => a.startsWith('--rounds='))
  const onlyRounds = roundsFlag ? roundsFlag.slice(9).split(',').map((s) => s.trim()) : null

  const redblueDir = join(resolve(rootArg), 'redblue')
  if (!existsSync(redblueDir)) {
    console.error('history: 找不到 redblue 目录: ' + redblueDir)
    return 2
  }

  // 收集所有 R*-* 轮次目录，按轮次号排序
  let dirs = []
  try {
    for (const e of readdirSync(redblueDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const m = e.name.match(/^R(\d+)/i)
      if (!m) continue
      if (onlyRounds && !onlyRounds.includes(e.name)) continue
      dirs.push({ name: e.name, num: parseInt(m[1], 10), path: join(redblueDir, e.name) })
    }
  } catch (e) {
    console.error('history: 读取目录失败: ' + String(e.message || e))
    return 2
  }
  dirs.sort((a, b) => a.num - b.num)

  const hits = []
  for (const d of dirs) {
    for (const fname of RB_HISTORY_FILES) {
      // 通配：01-cases-tech.md 之类也算
      let files = []
      try {
        files = readdirSync(d.path).filter((f) => {
          const low = f.toLowerCase()
          return low.startsWith(fname.slice(0, 6).toLowerCase()) && low.endsWith('.md')
        })
      } catch { continue }
      for (const f of files) {
        let text = ''
        try { text = readFileSync(join(d.path, f), 'utf8').replace(/^\uFEFF/, '') } catch { continue }
        const lines = text.split(/\r?\n/)
        for (let i = 0; i < lines.length; i++) {
          const low = lines[i].toLowerCase()
          if (!keywords.some((k) => low.includes(k))) continue
          hits.push({
            round: d.name, file: f, lineNo: i + 1,
            id: extractId(lines[i]), states: extractStates(lines[i]),
            text: lines[i].trim(),
          })
        }
      }
    }
  }

  if (!hits.length) {
    console.log('HISTORY_NONE: 在 ' + dirs.length + ' 个轮次里没找到包含「' + keywords.join(' / ') + '」的记录。')
    console.log('  这意味着：**这是新问题**（或者你拼错了关键词）。')
    console.log('  轮次范围: ' + (dirs.length ? dirs[0].name + ' … ' + dirs[dirs.length - 1].name : '(无)'))
    return 0
  }

  console.log('HISTORY: ' + keywords.join(' / ') + ' → ' + hits.length + ' 处命中（' + dirs.length + ' 个轮次）')
  console.log('')

  // 已处置 / 未处置 分类
  const resolved = []
  const open = []
  for (const h of hits) {
    const hasPos = h.states.some((s) => !['未答', '未解决', '部分已答', '部分已解决', '仍未', '待修', '挂账', '未修', '留'].includes(s))
    const hasNeg = h.states.some((s) => ['未答', '未解决', '部分已答', '部分已解决', '仍未', '待修', '挂账', '未修', '留'].includes(s))
    if (hasPos && !hasNeg) resolved.push(h)
    else open.push(h)
  }

  const show = (arr, label) => {
    if (!arr.length) return
    console.log('  【' + label + '】')
    for (const h of arr.slice(0, limit)) {
      const id = h.id ? h.id.padEnd(6) : '      '
      const st = h.states.length ? h.states.join('/') : '(无状态词)'
      console.log('    ' + h.round.padEnd(16) + h.file.padEnd(20) + 'L' + String(h.lineNo).padEnd(4) + id + st)
      console.log('      ' + h.text.slice(0, 150))
    }
    if (arr.length > limit) console.log('    … 另 ' + (arr.length - limit) + ' 处')
    console.log('')
  }

  show(resolved, '已处置/已验证 —— 这些别再当新问题')
  show(open, '未处置/挂账 —— 这些才是要处理的')

  // 汇总判断
  const idSet = new Set(hits.map((h) => h.id).filter(Boolean))
  console.log('  ── 汇总 ──')
  console.log('    涉及条目: ' + (idSet.size ? [...idSet].sort().join(', ') : '(未识别到编号)'))
  if (resolved.length && !open.length) {
    console.log('    判断: **该问题已有处置记录，且全部标为已答/已验证。** 再报一次就是重复劳动。')
  } else if (open.length) {
    console.log('    判断: **有 ' + open.length + ' 处仍标为未处置/挂账** —— 这些是真空白。')
  } else {
    console.log('    判断: 命中但状态词不明确，请人工看上面的片段。')
  }
  return 0
}

function cmdRoute(args) {
  {
    const sub = args[0]
    if (sub === 'probe') return routeProbe(args.slice(1))
    if (sub === 'pick') return routePick(args.slice(1))
    if (sub === 'mklib') return routeMklib(args.slice(1))
  }

  // 参数识别按「是否以 .yml/.yaml 结尾」判断，不靠位置 ——
  // 实测 PowerShell 会吞掉空字符串参数，位置式解析会把过滤词错当成配置路径。
  const cfgArg = args.find((a) => /\.ya?ml$/i.test(a))
  const cfg = cfgArg || process.env.RB_PROFILE_CONFIG
    || (detectDshHome() ? join(detectDshHome(), 'profiles', 'desktop', 'cordis.patch.yml') : null)
  const filter = args.find((a) => !/\.ya?ml$/i.test(a)) || ''
  if (!existsSync(cfg)) die(`route: 找不到 profile 配置: ${cfg}（可传一个 .yml 路径，或设 RB_PROFILE_CONFIG）`)
  const lines = readFileSync(cfg, 'utf8').split(/\r?\n/)
  const map = new Map()
  let cur = null
  for (const line of lines) {
    const h = line.match(/^(\s*)([A-Za-z0-9_-]+):\s*$/)
    if (h && /^(agent2api-|minekuai|longcat|deepseek)/.test(h[2])) {
      cur = h[2]
      if (!map.has(cur)) map.set(cur, [])
      continue
    }
    const m = line.match(/^\s*-\s*id:\s*(\S+)\s*$/)
    if (m && cur) map.get(cur).push(m[1])
  }
  if (!map.size) { console.error('ROUTE_EMPTY: 配置里没解析出任何 provider —— 结构可能变了，需要更新本命令的解析规则'); return 2 }
  let shown = 0
  for (const [p, models] of [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (filter && !p.includes(filter)) continue
    shown++
    console.log(`${p}  (${models.length})`)
    for (const m of models) console.log(`    ${m}`)
  }
  if (!shown) { console.error(`ROUTE_NO_MATCH: 没有 provider 匹配 "${filter}"`); return 2 }

  // v6.29M（R14 实测，最贵的一次教训）：原来这里只打一句「配置里存在≠上游可用」就结束，
  // **没有告诉使用者"怎么让红队真的用上这些模型"**。结果主控自己在 14 轮里
  // 全部用 `longcat_worker`（路由钉死 longcat）当红队，四张脸、蓝队、复核**全是同一个模型**，
  // 却一直对外宣称"独立复核"——直到用户指出"除了 DeepSeek account，我能用哪些你就能用哪些"。
  // 命令给对了答案、却没给用法，等于没给。现在补三块：
  //   ① 具名库（真正可用的跨厂商路径）
  //   ② subagentModelSelection 开关状态（它决定能不能显式选模型）
  //   ③ 一句明确的操作指令
  const libDir = process.env.RB_SUBAGENT_DIR || (detectDshHome() ? join(detectDshHome(), 'subagents') : null)
  if (existsSync(libDir)) {
    console.log('\n=== 具名库（用 delegate(library_id=…) 派）—— **这才是真正跨厂商的路径** ===')
    let anyLib = false
    for (const f of readdirSync(libDir).filter((n) => /\.ya?ml$/i.test(n))) {
      const t = readFileSync(join(libDir, f), 'utf8')
      const p = (t.match(/^provider:\s*(\S+)/m) || [])[1] || '(未配 provider)'
      const m = (t.match(/^model:\s*(\S+)/m) || [])[1] || '(未配 model)'
      const d = (t.match(/^description:\s*(.+)$/m) || [])[1] || ''
      anyLib = true
      console.log(`  ${f.replace(/\.ya?ml$/i, '').padEnd(12)} ${p}/${m}`)
      if (d) console.log(`    ${d.slice(0, 100)}`)
    }
    if (!anyLib) console.log('  （目录里没有 .yaml）')
    else console.log('  ⚠ 库条目算「配置好的」而非「请求指定的」，因此**不受** subagentModelSelection 限制')
  } else {
    console.log(`\n  （找不到 subagents 目录：${libDir}）`)
  }

  let selOn = false
  try {
    const raw = readFileSync(cfg, 'utf8')
    selOn = /subagentModelSelection:\s*[\s\S]{0,200}?enabled:\s*true/.test(raw)
  } catch { /* 读不到就当未开启 */ }
  console.log(`\n  subagentModelSelection（显式选模型的白名单）：${selOn ? '已开启' : '**未开启**'}`)
  if (!selOn) {
    console.log('    未开启时，`subagent(provider=…, model=…)` 会被拒：')
    console.log('      child LLM route "X/Y" is not allowed for this Session; without a recorded model-selection policy,')
    console.log('      explicit selection (including reasoning_effort) is limited to the parent route')
    console.log('    这不代表"没有其他 provider"——**只代表不能显式指定**，具名库仍然可用。')
  }

  console.log('\n提示（按顺序读）：')
  console.log('  1. 「配置里存在」≠「上游可用」。实测：qoder 余额 0、catpaw 余额不足、accio 不通；')
  console.log('     raccoon 有余额且一家横跨 Kimi/智谱/商汤/DeepSeek 四个厂商。')
  console.log('  2. 派**跨厂商红队**用 `delegate(library_id="rb-domain")` 这类具名库；')
  console.log('     **绝不要**用 `longcat_worker` / `rb_lc25` / `rb_lc20` —— 它们的 provider/model')
  console.log('     在 config 里钉死 longcat，拿它们当红队 = 所有角色同一个模型 = 独立性为零。')
  console.log('  3. 派完用 `attack record <轮次> <provider> <model> <交付件> <role>` 把真实路由记下来，')
  console.log('     `converge` 靠这份记录判断"到底换没换过红队"。')
  // v6.29M（2026-11-10，用户当面骂醒）：库不够用的时候，主控竟然回头问用户"换哪个"——
  // 而 `subagents\\*.yaml` 就是纯文件，`delegate` 实时读目录，**写一个新的立即生效，不用重启**。
  // 实测：写 `rb-claude.yaml` 之后 `delegate(library_id="rb-claude")` 立刻返回 subagent id。
  // 这条必须由工具说出来，否则每次换模型都要绕一圈问人。
  console.log('  4. **库不够用就自己写**：`subagents\\*.yaml` 是纯文件，`delegate` 实时读目录，')
  console.log('     **新增 yaml 立即生效，不用重启 DSH**（2026-11-10 实测）。最小条目：')
  console.log('       description: 一句话说明')
  console.log('       provider: agent2api-raccoon')
  console.log('       model: sn-kimi-k3')
  console.log('       maxDepth: 1')
  console.log('       backgroundMode: continuable')
  console.log('       persona: |')
  console.log('         你是…')
  console.log('     → 想要哪个模型，就直接给它写一个库。**不要回头问用户"换哪个"**。')
  console.log('  5. **失败也要记账**：`attack fail <轮次> <provider> <model> <原因>`。')
  console.log('     否则账上「只派了 1 个」与「派了 5 个挂了 4 个」长得一模一样，独立性被高估。')
  return 0
}

/**
 * attack record <roundDir> <provider> <model> <artifactPath> [role] —— 记录"谁在什么时候审了哪一版"。
 *
 * v6.29r：为什么需要它 —— `gate` 的 "attacked" 检查一直是名义的：它只验证判定表里有红队归属列，
 * 验证不了这个交付件真的被红队看过。实测两次：R6 的四项全绿是在独立复核缺席时得到的；
 * R9 的 v5 至今没有任何独立复核，但 gate 照样放行。
 *
 * 本命令把攻击证据绑定到**交付件的 sha256 前 16 位**。gate 会核对：
 * 记录的指纹与当前候选稿不符 ⇒ `GATE_ATTACK_STALE`（红队审的不是这一版，不得放行）。
 */
function cmdAttack(args) {
  const sub = args[0]
  const USAGE = 'usage: attack record <roundDir> <provider> <model> <artifactPath> [role]'
  const EXT_USAGE = 'usage: attack record-ext <roundDir> <source> <artifactPath> [note]'
  // v6.29M：新增 `record-ext` —— 登记**机制之外**的独立评审（外部 AI、人工评审、跨组织复核）。
  //
  // **重要更正（2026-11-10，用户指出后实测）**：本命令最初的理由写着「本机只有一个 provider，
  // 这条判据物理上无法满足」——**那个判断是错的**。`route` 实测配置里有 14 组 provider
  // （agent2api-accio 42 个含 claude-opus-4-6 / gemini-3-flash-preview、catpaw 8 个含
  // kimi-k3 / MiniMax-M3、autoclaw、cline-free…），`subagents\*.yaml` 里还有 4 个具名库
  // 直接配了真跨厂商模型。真实原因是主控在 14 轮里**全部用 `longcat_worker`**（它的
  // provider/model 在 config 里钉死 longcat）充当红队/蓝队/复核——所有角色同一个模型。
  // 也就是说：不是环境没有，是主控没去找。详见 SKILL §10.17。
  //
  // 但 `record-ext` 本身仍然成立：有些独立性来源**根本不在本机**
  //（外部 AI 转贴、期刊审稿意见、领域专家口头评审），机制需要能登记它们，
  // 否则这类真证据反而进不了账。
  const FAIL_USAGE = 'usage: attack fail <roundDir> <provider> <model> <原因>'
  if (sub !== 'record' && sub !== 'record-ext' && sub !== 'fail') {
    die(`${USAGE}\n       ${EXT_USAGE}\n       ${FAIL_USAGE}`)
  }

  const roundDir = args[1]

  // v6.29M（2026-11-10 实测）：新增 `fail` —— 记录**派出去但没回来**的红队。
  //
  // 起因（真实发生）：同一轮里派了 3 个跨厂商红队 ——
  //   rb-red   → agent2api-qoder/Kimi-K3.1-Pro   **失败**（余额 0）
  //   rb-domain→ agent2api-raccoon/sn-glm-5-3    **失败**（无消息）
  //   rb-devil → agent2api-raccoon/sn-kimi-k3    **成功**
  // 但 `red-attack.json` 里只留下成功的那个 —— `gate` 看到「1 个攻击者」，
  // 看不到「派了 3 个、挂了 2 个」，**独立性被系统性高估**。
  //
  // 机制必须能区分两种完全不同的处境：
  //   「我只派了一个」（可能是资源不足）
  //   「我派了三个但两个失灵」（可能是上游故障，换个时段就通）
  // 这两种在旧账上长得一模一样。
  if (sub === 'fail') {
    const provider = args[2]
    const model = args[3]
    const reason = args[4] || '(未记录原因)'
    if (!roundDir || !provider || !model) die(FAIL_USAGE)
    if (!existsSync(roundDir)) die(`attack: 轮次目录不存在: ${roundDir}`)
    const p = join(roundDir, 'red-attack.json')
    let doc = { attackers: [], external: [], failed: [], updatedAt: null }
    if (existsSync(p)) {
      try { doc = { ...doc, ...JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) } } catch { /* 坏文件用新骨架 */ }
    }
    let sha0 = null
    try {
      const cands = readdirSync(roundDir).filter((f) => /^\d+-candidate.*\.md$/i.test(f)).sort()
      if (cands.length) {
        sha0 = createHash('sha256')
          .update(readFileSync(join(roundDir, cands[cands.length - 1])))
          .digest('hex').slice(0, 16).toUpperCase()
      }
    } catch { /* 没有候选稿就不绑指纹，仍记账 */ }
    doc.failed = (doc.failed || []).concat([{
      provider, model, reason, at: new Date().toISOString(), artifactSha256_16: sha0,
    }])
    doc.updatedAt = new Date().toISOString()
    writeFileSync(p, JSON.stringify(doc, null, 2), 'utf8')
    console.log(`ATTACK_FAIL_RECORDED: ${provider}/${model} — ${reason}`)
    console.log(`  failed attempts now: ${doc.failed.length}`)
    return 0
  }

  const isExt = sub === 'record-ext'
  const artifact = isExt ? args[3] : args[4]
  if (isExt) {
    if (!roundDir || !args[2] || !artifact) die(EXT_USAGE)
  } else {
    if (!roundDir || !args[2] || !args[3] || !artifact) die(USAGE)
  }
  if (!existsSync(roundDir)) die(`attack: 轮次目录不存在: ${roundDir}`)
  if (!existsSync(artifact)) die(`attack: 交付件不存在: ${artifact}`)

  const sha = createHash('sha256').update(readFileSync(artifact)).digest('hex').slice(0, 16).toUpperCase()
  const p = join(roundDir, 'red-attack.json')
  let doc = { artifactPath: artifact, artifactSha256_16: sha, artifactBytes: statSync(artifact).size, attackers: [], updatedAt: null }
  if (existsSync(p)) {
    try { doc = { ...doc, ...JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) } } catch { /* 坏文件就用新骨架 */ }
  }
  // 换了交付件就以新指纹为准，并清掉旧攻击者与旧外部评审
  //（对旧版本的攻击/意见不能算在对新版本的账上）。
  if (String(doc.artifactSha256_16 || '').toUpperCase() !== sha) {
    doc.previous = (doc.previous || []).concat([{
      artifactSha256_16: doc.artifactSha256_16,
      attackers: doc.attackers || [],
      external: doc.external || [],
    }]).slice(-5)
    doc.attackers = []
    doc.external = []
    doc.artifactSha256_16 = sha
    doc.artifactBytes = statSync(artifact).size
    doc.artifactPath = artifact
  }

  if (isExt) {
    const source = args[2]
    const note = args[4] || ''
    doc.external = (doc.external || []).filter((e) => e.source !== source)
    doc.external.push({ source, note, at: new Date().toISOString(), artifactSha256_16: sha })
    doc.updatedAt = new Date().toISOString()
    writeFileSync(p, JSON.stringify(doc, null, 2), 'utf8')
    console.log(`ATTACK_EXT_RECORDED: ${source} on ${sha} -> ${p}`)
    console.log(`  external reviewers now: ${doc.external.length}`
      + (doc.external.length ? ` — ${doc.external.map((e) => e.source).join(' | ')}` : ''))
    return 0
  }

  const provider = args[2]
  const model = args[3]
  const role = args[5]
  doc.attackers = (doc.attackers || []).filter((a) => !(a.provider === provider && a.model === model))
  doc.attackers.push({ role: role || 'red', provider, model, at: new Date().toISOString(), artifactSha256_16: sha })
  doc.updatedAt = new Date().toISOString()
  writeFileSync(p, JSON.stringify(doc, null, 2), 'utf8')
  console.log(`ATTACK_RECORDED: ${provider}/${model} on ${sha} -> ${p}`)
  console.log(`  attackers now: ${doc.attackers.length}`)
  return 0
}

/**
 * ident <spec.json> —— 按 spec 抽值并验算术恒等式。
 *
 * v6.29A：把今晚三次"手写一次性复算脚本"固化成命令。
 * 今晚两处造假都不是被形态检查抓到的，而是被**数据复算**抓到的：
 *   ① 编造的 `137/138`（正确是 138/138）；② 把正确的 23 州基线改成 26 州。
 * 形态检查查"有没有写"，复算查"数字对不对" —— 后者才是这类错误的唯一办法。
 *
 * spec 形态：
 * {
 *   "text": "稿件路径（可选，作为 from 的默认值）",
 *   "values": {
 *     "total": 164,                                              // 字面量
 *     "ever":  { "regex": "(\\d+) ever-active", "group": 1 }      // 从文件抽取
 *   },
 *   "identities": ["ever + never === total", "131 + 10 === 141"]
 * }
 *
 * 安全阀：identity 只允许 数字/标识符/空格/+-* / () . < > = ! 这些字符，
 * 其它一律拒（避免 spec 变成任意代码执行）。
 */
function cmdIdent(args) {
  // v6.29J：`ident draft` —— 先实测再写 spec。
  // 起因：`occur` 有 draft 而 `ident` 没有，于是恒等式 spec 全靠手写；
  // 手写时同样会凭印象列错关系（今夜 `occur` 那次把 4 处写成 3 处就是同类错）。
  // draft 的做法：把正文里出现的数值连同**所在行与上下文片段**列出来，让人只负责"挑哪些该有关系"。
  if (args[0] === 'draft') {
    const target = args[1]
    if (!target || !existsSync(target)) die('usage: ident draft <稿件> [--out spec.json]')
    const oi = args.indexOf('--out')
    const outPath = oi >= 0 ? args[oi + 1] : null
    const lines = readFileSync(target, 'utf8').split(/\r?\n/)
    const refIdx = lines.findIndex((l) => /^##\s+References/i.test(l))
    const scan = refIdx >= 0 ? lines.slice(0, refIdx) : lines
    const base = refIdx >= 0 ? refIdx : lines.length

    // 数值 token：整数、小数、比率 a/b
    const TOK = /\b\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?\b/g
    const seen = new Map() // token -> { lines:[], ctx:[] }
    scan.forEach((ln, i) => {
      for (const m of ln.matchAll(TOK)) {
        const tok = m[0]
        if (!seen.has(tok)) seen.set(tok, { lines: [], ctx: [] })
        const rec = seen.get(tok)
        if (!rec.lines.includes(i + 1)) rec.lines.push(i + 1)
        if (rec.ctx.length < 2) {
          const s = Math.max(0, m.index - 26)
          rec.ctx.push(ln.slice(s, m.index + tok.length + 26).replace(/\s+/g, ' '))
        }
      }
    })

    const items = [...seen.entries()]
      // 与 occur draft 同一条经验：年份不是"量"，个位数噪声太大。
      // 但**不能**要求"出现 ≥2 次"——`164` 与 `141`、`23` 各出现一次，却正是该闭合的一对。
      // （第一版按 ≥2 次过滤，小正文直接一个候选都不剩，自测当场报错。）
      .filter(([tok]) => {
        if (/^\d{4}$/.test(tok) && Number(tok) >= 1900 && Number(tok) <= 2100) return false  // 年份
        if (/^[0-9]$/.test(tok)) return false                                                 // 个位数
        // 比率（如 161/164）**不是数值**：ident 抽值时会 Number("161/164") = NaN。
        // 第一版把比率也放进候选，往返测试里这两条全部 IDENT_VALUE_MISSING。
        if (tok.includes('/')) return false
        return true
      })
      .sort((a, b) => b[1].lines.length - a[1].lines.length)

    console.log(`扫描范围: 正文 ${scan.length} 行（References 之前），候选数值 ${items.length} 个（已滤去年份 / 个位数 / 比率）`);
    for (const [tok, v] of items.slice(0, 24)) {
      console.log(`  ${String(v.lines.length).padStart(3)} 次  ${tok.padEnd(12)} L${v.lines.slice(0, 6).join(',L')}`)
      if (v.ctx[0]) console.log(`       …${v.ctx[0].slice(0, 90)}…`)
    }
    if (items.length > 24) console.log(`  …… 另有 ${items.length - 24} 个未列出`)

    if (outPath) {
      const values = {}
      for (const [tok, v] of items.slice(0, 40)) {
        // 用**上下文片段**当正则锚，比裸数字更不容易误配；抓第 1 组
        const ctx = v.ctx[0] || ''
        const idx = ctx.indexOf(tok)
        // ctx 里的空白已被压成单个空格，而正文里可能是多空格/制表符 —— 所以空白一律用 \s+ 匹配。
        // （第一版直接转义原文，压缩过的空白与原稿对不上。）
        const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
        const left = esc(ctx.slice(Math.max(0, idx - 18), idx))
        const right = esc(ctx.slice(idx + tok.length, idx + tok.length + 12))
        values['n' + tok.replace(/[^0-9]/g, '_')] = { regex: left + '(\\d+(?:\\.\\d+)?)' + right, group: 1, _measured: tok }
      }
      const spec = {
        _note: '由 ident draft 生成：值用上下文锚定的正则从正文抽取（不是手抄）。identities 需人工填写。',
        _examples: ['a + b === c', 'a === c - b', 'a === 2 * b'],
        text: target,
        values,
        identities: [],
      }
      writeFileSync(outPath, JSON.stringify(spec, null, 2), 'utf8')
      console.log(`DRAFT_WRITTEN: ${outPath}（${Object.keys(values).length} 个候选值，identities 待填）`)
    } else {
      console.log('（加 --out <路径> 可写出 spec 骨架）')
    }
    return 0
  }

  const [specPath] = args
  if (!specPath) die('usage: ident <spec.json>')
  if (!existsSync(specPath)) die(`ident: spec 不存在: ${specPath}`)
  let spec
  try { spec = readJsonFile(specPath) } catch (e) { die(`ident: spec 不是合法 JSON: ${e.message}`) }
  const vals = {}
  let bad = 0
  const skip = new Set()
  for (const [k, v] of Object.entries(spec.values || {})) {
    if (typeof v === 'number') { vals[k] = v; continue }
    const src = v.from || spec.text
    if (!src || !existsSync(src)) { console.error(`IDENT_VALUE_UNREADABLE ${k}: 来源文件不存在（${src || '未指定'}）`); bad++; skip.add(k); continue }
    const txt = readFileSync(src, 'utf8')
    let m
    try { m = txt.match(new RegExp(v.regex, v.flags || '')) } catch (e) { console.error(`IDENT_REGEX_INVALID ${k}: ${e.message}`); bad++; skip.add(k); continue }
    if (!m) { console.error(`IDENT_VALUE_MISSING ${k}: 在 ${src.split(/[\\/]/).pop()} 里匹配不到 /${v.regex}/`); bad++; skip.add(k); continue }
    const raw = String(m[Number(v.group ?? 1)] ?? '').replace(/[,\s]/g, '')
    const num = Number(raw)
    if (!Number.isFinite(num)) { console.error(`IDENT_VALUE_NOT_NUMBER ${k}: 抽到 "${raw}"`); bad++; skip.add(k); continue }
    vals[k] = num
  }
  console.log(`抽值 ${Object.keys(vals).length} 个${skip.size ? `，失败 ${skip.size} 个` : ''}：`
    + Object.entries(vals).map(([k, v]) => `${k}=${v}`).join(' '))
  for (const expr of spec.identities || []) {
    if (typeof expr !== 'string' || !/^[A-Za-z0-9_+\-*/() .<>=!]+$/.test(expr)) {
      console.error(`IDENT_UNSAFE_EXPR: 拒绝执行（只允许数字/标识符/算术与比较符号）：${String(expr).slice(0, 60)}`)
      bad++
      continue
    }
    try {
      // eslint-disable-next-line no-new-func
      const result = Function(...Object.keys(vals), `"use strict"; return (${expr});`)(...Object.values(vals))
      const pass = result === true
      if (!pass) bad++
      // 结果行缩进两格：避免与 selftest 的 `PASS `/`FAIL ` 行前缀混淆（实测会把日志计数带歪）。
      console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${expr}${pass ? '' : `   →  ${String(result)}`}`)
    } catch (e) {
      console.error(`IDENT_EVAL_ERROR: ${expr} —— ${String(e?.message ?? e)}`)
      bad++
    }
  }
  console.log(bad === 0 ? 'IDENT_OK: 全部恒等式成立' : `IDENT_FAIL: ${bad} 项不成立`)
  return bad === 0 ? 0 : 2
}

/**
 * occur <spec.json> —— 全稿出现位置扫描：把"某个说法应该还剩几处"变成可核判据。
 *
 * v6.29C：落地技能第十条纪律第 6 条「同一说法要搜全稿」。
 * 今晚它抓到主控两次——N8 只改了 L142，L176 还在；N6 只改了 L95，L4/L181 还在。
 * 两次都导致"已消除"被后续复核推翻。当时靠手写一次性脚本 `_scan_v5.mjs`，现在固化成命令。
 *
 * spec 形态：
 * {
 *   "file": "稿件路径",
 *   "checks": [
 *     { "name": "旧 137/138", "regex": "137/138", "expect": 0, "why": "主控造数，已改 138/138" },
 *     { "name": "23 州基线", "regex": "23 prefectures that record at least one death", "expect": 1 }
 *   ]
 * }
 * expect 是**精确命中行数**；省略 expect 则只报告不判定。
 */
/**
 * 读 JSON 文件并**容忍 UTF-8 BOM**。
 * v6.29C：Windows 上 PowerShell 的 `Set-Content -Encoding utf8` 会写 BOM，
 * `JSON.parse` 遇到 BOM 直接报 "Unexpected token '﻿'"。今天为此绊了三次：
 * apply 的修订块文件（NO_BLOCKS）、occur 的 spec、以及更早的修复脚本。
 * 这不是用户写错，是平台默认行为 —— 工具必须自己咽掉。
 */
function readJsonFile(p) {
  return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
}

function cmdOccur(args) {
  // v6.29D：`occur draft` —— 先实测再生成骨架。
  // 起因：上一轮我手写 spec 时把 `161/164` 的期望写成 3，实查是 4 处。
  // **期望值必须量出来，不能猜。** draft 把所有候选说法的**实际出现次数**直接写进 spec，
  // 人只负责删掉不相关的候选，不再负责"想一个数"。
  if (args[0] === 'draft') {
    const target = args[1]
    if (!target || !existsSync(target)) die('usage: occur draft <稿件> [--out spec.json]')
    const oi = args.indexOf('--out')
    const outPath = oi >= 0 ? args[oi + 1] : null
    const lines = readFileSync(target, 'utf8').split(/\r?\n/)
    const counts = new Map()
    const TOKEN_RES = [
      /\b\d+\s*\/\s*\d+\b/g,        // 比率 161/164
      /\b\d+\.\d+\s*×/g,            // 倍数 6.1×
      /\b\d+\.\d+%/g,               // 百分比
      /\b\d+\.\d+\b/g,              // 小数统计量 0.266 / 0.546
      /\b\d{3,}\b/g,                // 三位以上计数 164 / 131 / 3444
    ]
    for (const ln of lines) {
      const seen = new Set()
      for (const re of TOKEN_RES) {
        for (const m of ln.matchAll(re)) seen.add(String(m[0]).replace(/\s+/g, ''))
      }
      for (const tok of seen) counts.set(tok, (counts.get(tok) || 0) + 1)
    }
    // 按出现次数**从多到少**排。
    // 理由：第 6 条纪律要抓的是「同一说法出现在多处、只改了一处」——
    // 次数=1 的说法根本不可能"只改一处"，对这条纪律没有价值。
    // （第一版按次数从少到多排，被 257 个一次性的 S(t) 数值淹没了，排序帮了倒忙。）
    const all = args.includes('--all')
    // 滤掉年份（1900–2100 的 4 位整数）：它是时间轴噪声，不是"说法"。
    // 第一版没滤，结果列表被 2026(36 处)/2006(13 处) 这类年份占满，真正要盯的 164/141 被挤到后面。
    const isYear = (tok) => /^\d{4}$/.test(tok) && Number(tok) >= 1900 && Number(tok) <= 2100
    const items = [...counts.entries()].filter(([tok, n]) => (all || n >= 2) && !isYear(tok))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    console.log(`候选说法 ${items.length} 个（次数已实测，不是估的；默认只列出现 ≥2 次的，--all 可列全部）：`)
    for (const [tok, n] of items.slice(0, 30)) {
      console.log(`  ${String(n).padStart(3)} 处   ${tok}`)
    }
    if (items.length > 30) console.log(`  …… 另有 ${items.length - 30} 个未列出`)
    if (outPath) {
      const spec = {
        _note: `由 occur draft 自动生成：expect 全部为实测次数，不是猜测。请删掉不相关的候选后再用。`,
        file: target,
        checks: items.map(([tok, n]) => ({
          name: `${tok} 出现 ${n} 处`,
          regex: tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
          expect: n,
        })),
      }
      writeFileSync(outPath, JSON.stringify(spec, null, 2), 'utf8')
      console.log(`DRAFT_WRITTEN: ${outPath}（${items.length} 条候选，expect 均为实测值）`)
    } else {
      console.log('（加 --out <路径> 可把骨架写成 spec 文件）')
    }
    return 0
  }
  const [specPath] = args
  if (!specPath) die('usage: occur <spec.json>')
  if (!existsSync(specPath)) die(`occur: spec 不存在: ${specPath}`)
  let spec
  try { spec = readJsonFile(specPath) } catch (e) { die(`occur: spec 不是合法 JSON: ${e.message}`) }
  const target = spec.file
  if (!target || !existsSync(target)) die(`occur: 目标文件不存在: ${target}`)
  const allLines = readFileSync(target, 'utf8').split(/\r?\n/)
  // v6.29H：**必须报出扫描范围**。
  // 起因：主控今天四次栽在"量的范围划错"而非"算法错"——
  // 把 12 页当成字数上限、把关键词算进摘要 300 词、用作者姓氏检索 DOI 引注、把参考文献表的 DOI 算成正文残留。
  // 所以扫描类命令先把范围打出来：看见"含 References"就该警觉。
  const scopeWant = String(spec.scope || 'all').toLowerCase()
  let scopeDesc = '全文'
  let lines = allLines
  const refIdx = allLines.findIndex((l) => /^##\s+References/i.test(l))
  if (scopeWant === 'body' && refIdx >= 0) {
    lines = allLines.slice(0, refIdx)
    scopeDesc = `正文（References 之前，L1–L${refIdx}）`
  } else if (refIdx >= 0) {
    scopeDesc = `全文（含 References，L${refIdx + 1} 起共 ${allLines.length - refIdx} 行）`
  }
  console.log(`扫描范围: ${scopeDesc}，${lines.length} 行${scopeWant === 'body' ? '' : '（要排除参考表请在 spec 里写 "scope": "body"）'}`)
  let bad = 0
  for (const c of spec.checks || []) {
    if (!c || !c.regex) { console.error(`OCCUR_SPEC_INVALID: 有一条检查缺 regex`); bad++; continue }
    let re
    try { re = new RegExp(c.regex, c.flags || 'g') } catch (e) { console.error(`OCCUR_REGEX_INVALID ${c.name || c.regex}: ${e.message}`); bad++; continue }
    const hits = []
    // 注意：带 g 标志的正则 .test() 是**有状态**的（会推进 lastIndex）。
    // 第一版只在循环外重置 lastIndex，导致逐行扫描会跳行、计数偏低（实测 21 处被数成 19 处）。
    // 必须每行都重置。
    lines.forEach((ln, i) => {
      re.lastIndex = 0
      if (re.test(ln)) hits.push(i + 1)
    })
    re.lastIndex = 0
    const want = typeof c.expect === 'number' ? c.expect : null
    const okk = want === null ? null : hits.length === want
    if (okk === false) bad++
    const mark = okk === null ? 'INFO' : okk ? 'PASS' : 'FAIL'
    console.log(`  ${mark}  ${c.name || c.regex}  命中 ${hits.length} 处${want === null ? '' : `（期望 ${want}）`}`
      + (hits.length && hits.length <= 8 ? `  L${hits.join(',L')}` : ''))
    if (okk === false && c.why) console.error(`OCCUR_MISMATCH: ${c.name || c.regex} —— ${c.why}`)
  }
  console.log(bad === 0 ? 'OCCUR_OK: 全部出现次数符合预期' : `OCCUR_FAIL: ${bad} 项不符`)
  return bad === 0 ? 0 : 2
}

/**
 * v6.29E：列错位检测 —— 抓「级别」与「状态」两列写反。
 *
 * 为什么需要：今晚真踩过。`parseVerdict` 曾在某个分支里把「级别」列当状态桶读，
 * 于是 12 条「已消除」被统计成「一般=12」，而 **recount / gate / quality / converge 四个命令全部被静默污染**。
 * 这类错误不报错、不崩溃，只给出一个**好看但错的**统计 —— 单靠"跑一遍"发现不了。
 *
 * 抓法：级别列只该出现级别词，状态列只该出现状态词；一旦**互相越界**就是写反了。
 * 这利用了词表的互斥性，而不是去猜语义。
 */
function detectColumnSwap(file) {
  const LVL = /(致命|严重|一般|优化)/
  const STS = /(已消除|挂账|不成立|未修复|未修|不适用|未处置|已处置|无结论|已答复|当前文本已答|部分已答|仍未解决)/
  const swapped = []
  try {
    for (const r of parseTableRows(file)) {
      const lv = String(r['级别'] || '')
      const st = String(r['状态'] || r['判定'] || '')
      if (!lv && !st) continue
      if (STS.test(lv) && LVL.test(st)) swapped.push(`${r.id}（级别列写「${lv}」/ 状态列写「${st}」）`)
    }
  } catch { /* 解析失败不算检测失败 */ }
  return swapped
}

/**
 * xcheck <file> —— 同一个量用**两条独立路径**算，不一致就报。
 *
 * v6.29F：今天最重要的方法论是「两个独立实现给出的数不一致时，不要挑一个信，去写第三个」。
 * 它今天抓到三类真问题：编造的 137/138、occur 的 lastIndex 计数偏低、160 vs 162 的口径差。
 * 但每次都是我临时写脚本。这里把它固化成命令：让工具自己给自己做交叉验证。
 *
 * 目前交叉验证三组量：
 *   ① 行数      split(/\r?\n/) vs 数 \n 的个数
 *   ② 词数      按空白切 vs 按词元正则匹配（允许 5% 误差 —— 连字符与斜杠的切法天然不同）
 *   ③ 判定表行数 parseVerdict vs parseTableRows（**工具里两个独立解析器互校**）
 */
function cmdXcheck([file]) {
  if (!file || !existsSync(file)) die('usage: xcheck <file>')
  const txt = readFileSync(file, 'utf8')
  const results = []
  const push = (name, a, b, mode) => {
    let ok
    if (mode === 'exact') ok = a === b
    else {
      const m = Math.max(a, b, 1)
      ok = Math.abs(a - b) / m <= 0.05
    }
    results.push({ name, a, b, ok, mode })
  }
  push('行数', txt.split(/\r?\n/).length, (txt.match(/\n/g) || []).length + 1, 'exact')
  // 词数交叉验证只对**以西文为主**的文本有意义。
  // 中文没有空格分词：按空白切得到的是"片段数"，按词元正则得到的只是 ASCII 词元，
  // 两者算的根本不是同一个量（实测中文判定表 197 vs 109 —— 差 45%，不是谁错了，是概念不成立）。
  // 不可比的量就不该拿来比：CJK 占比超过 20% 直接跳过，并说明原因。
  // 判据用**中文绝对字数**而不是占比：第一版写成 cjkRatio > 0.2，而中文判定表的占比恰是 0.19
  // （表格里还有大量 ASCII 的用例编号与路径），刚好卡在门槛下没跳过。占比阈值是我拍的，字数不是。
  const cjkCount = (txt.match(/[\u4e00-\u9fa5]/g) || []).length
  const cjkRatio = txt.length ? cjkCount / txt.length : 0
  if (cjkCount >= 50 || cjkRatio > 0.1) {
    results.push({ name: '词数', a: '跳过', b: `CJK ${cjkCount} 字（占比 ${(cjkRatio * 100).toFixed(0)}%）`, ok: true, skip: true })
  } else {
    push('词数', txt.split(/\s+/).filter(Boolean).length, (txt.match(/[A-Za-z0-9][A-Za-z0-9'’_-]*/g) || []).length, 'ratio')
  }
  // 两个独立解析器互校 —— 这条最像"写第三个脚本"的做法
  let nVerdict = 0
  let nTable = 0
  try { nVerdict = parseVerdict(resolve(file)).length } catch { nVerdict = -1 }
  try { nTable = parseTableRows(resolve(file)).length } catch { nTable = -1 }
  if (nVerdict >= 0 && nTable >= 0) push('判定表行数', nVerdict, nTable, 'exact')

  let bad = 0
  console.log(`交叉验证 ${file.split(/[\\/]/).pop()}：`)
  for (const r of results) {
    if (!r.ok) bad++
    if (r.skip) { console.log(`  SKIP  ${r.name}  ${r.b} —— 不可比，已跳过（不是通过，是不适用）`); continue }
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  路径A=${r.a}  路径B=${r.b}${r.mode === 'ratio' ? '（允许 5% 误差）' : '（要求完全相等）'}`)
  }
  if (bad) {
    console.error(`XCHECK_DISAGREE: ${bad} 组量两条路径不一致 —— 两条路径至少有一条是错的，别挑一个信，去查第三条。`)
    return 2
  }
  console.log('XCHECK_OK: 所有量两条独立路径一致')
  return 0
}

function cmdRecount([file]) {
  if (!file) die('usage: recount <03-review.md>')
  const rows = parseVerdict(file)
  const { t, unknown, claimed } = tally(rows)
  // v6.28（2026-11-08 实跑 R1-1107g1 暴露）：**同一编号出现多次 = 文件里有多张用例表**。
  // 解析器逐行匹配、不区分表，于是同一批缺陷被重复计数：
  // 实测 17 条被数成 19 条、真实严重 7 被数成 10。
  // 失效方向是「多算」而非报错，而人看到 19 就以为自己写多了、看到 10 就以为更严重——
  // 两种误读都会污染闸门。修法：重复编号必须点名，并按「不可判定」非零退出。
  const idCount = new Map()
  for (const r of rows) idCount.set(r.id, (idCount.get(r.id) || 0) + 1)
  const dupIds = [...idCount.entries()].filter(([, n]) => n > 1)
  console.log(
    `致命=${t['致命']} 严重=${t['严重']} 一般=${t['一般']} 优化=${t['优化']} 已消除=${t['已消除']} 挂账=${t['挂账']} 不成立=${t['不成立']} 未识别=${unknown.length} 合计=${rows.length}`,
  )
  // v6.22 缺陷25：把「按级别列的真实严重度」单独打出来。
  // 上面那行是「按处置状态」的桶，下面这行是「按原始级别」的风险面 —— 两者必须分开看。
  if (claimed['致命'] > 0 || claimed['严重'] > 0) {
    console.log(`未结案的真实严重度: 致命=${claimed['致命']} 严重=${claimed['严重']} 一般=${claimed['一般']} 优化=${claimed['优化']}`)
  }
  // v5.2 缺陷2：不只认「新问题」小节 —— 任何小节里出现 致命/严重 的表格行都要拦
  const off = scanOffTable(file)
  const stray = scanStraySeverity(file)
  if (off.rows.length > 0) console.log(`表外新问题: 致命=${off.fatal} 严重=${off.serious} 合计=${off.rows.length}（不计入上表，但闸门会看）`)
  for (const u of unknown) console.log(`UNKNOWN_LEVEL: ${u.id} raw=[${u.raw}]`)
  const swap = detectColumnSwap(file)
  if (swap.length) {
    console.error(`SUSPECT_COLUMN_SWAP: ${swap.length} 行的「级别」与「状态」两列疑似写反 —— ${swap.slice(0, 3).join('；')}`)
    console.error('  上面的统计因此全部不可信（曾经把 12 条"已消除"统计成"一般=12"）。请先把两列对调再重跑。')
    // 只警告不失败 = 允许拿一份失真的统计继续走流程。统计不可信就必须非零退出。
    return 2
  }
  // 未识别 > 0 时以非零退出，避免"统计失真却静默通过"
  // v6.14 缺陷17（R5 红队 e12 抓到）：**0 行也必须非零退出**。
  // 实测 e12-empty-review.md（「（本轮无判定行）」）→ recount 合计=0 且 exit 0，
  // 闸门拿到「致命=0 严重=0」直接放行 —— 一份没有任何判定行的复核被当成"全部通过"。
  // 空表不是"没有严重问题"，是"没有结论"。
  if (rows.length === 0) {
    // v6.19 缺陷22：0 行时先查是不是**编码问题**。实测红队用 PowerShell 默认 GBK 写的
    // 复核件，中文标题全变乱码（「绾у埆」= 级别），正则匹配不到表头语义，但行还在。
    // 这种情况报「空表」会误导人去补内容，实际该做的是转 UTF-8。
    let hint = ''
    try {
      const raw = readFileSync(file)
      const txt = raw.toString('utf8')
      const badChars = (txt.match(/\uFFFD/g) || []).length
      const cn = (txt.match(/[\u4e00-\u9fa5]/g) || []).length
      if (badChars > 0 || cn < 20) {
        hint = '  （疑似编码不是 UTF-8：文件里有大量替换字符或几乎没有中文，请转存 UTF-8 后重跑）'
      }
    } catch {}
    console.error('RECOUNT_UNDECIDABLE: 该复核文件 0 行可识别 —— 空表不等于全部通过，闸门不得放行。' + hint)
    return 2
  }
  if (dupIds.length > 0) {
    console.error(
      `DUPLICATE_IDS: ${dupIds.map(([id, n]) => `${id}×${n}`).join(' ')} —— 同一编号出现多次，`
      + '说明文件里有多张「编号+级别+状态」的表；本行统计被重复计数，不可作为闸门依据。'
      + '修法：只保留一张机器可读的用例表，审计轨迹/追加说明一律写成散文。',
    )
    return 2
  }
  return unknown.length > 0 ? 1 : 0
}

/**
 * 严格模式分界：2026-11-10 之后创建的轮次，证据检查优先于形状检查。
 *
 * 两份跨厂商审计共同指出的洞（2026-11-10）：
 *   智谱 GLM-5.3 第 4 条：「gate vs bundle 冲突时裁决是『只报不拦』——形状检查压过证据检查，
 *     一份 0 处可落地引用的复核件 + 合规的 04 文档仍可放行。」
 *   Kimi 第 2 条：「这套机制出错时永远错向『放行』。」
 * 但直接改成拦会把 R8/R11 这些历史真放行全部判死（SKILL §10 第 22 条）。
 * 所以按 03-review.md 的 mtime 分界：新轮次严格，老轮次只报。
 * 这个分界本身也是形状判断，但它只决定「严格还是一般」，不决定「对还是错」。
 */
function isStrictRound(roundDir) {
  const mode = process.env.RB_STRICT_MODE
  if (mode === 'off') return false
  if (mode === 'on') return true
  const d = String(roundDir)
  // 自测/探针 fixture 一律按历史轮次处理：它们建在系统临时目录，mtime 永远是「现在」，
  // 若不豁免会让整批历史自测一起进严格分支（实测挂了 8 条）。
  if (/(^|[\\/])(tmp|temp|TEMP|Temp)([\\/]|$)/.test(d)) return false
  if (d.includes('rb-probe') || d.includes('rb_dv') || d.includes('rb_div')) return false
  try {
    const f = join(roundDir, '03-review.md')
    if (!existsSync(f)) return true
    return statSync(f).mtimeMs >= Date.parse('2026-11-10T00:00:00+08:00')
  } catch { return true }
}
function cmdGate([file]) {
  if (!file) die('usage: gate <03-review.md>')
  const rows = parseVerdict(file)
  const { t, unknown, claimed } = tally(rows)
  // v6.23 缺陷26（R5 红队 N05 直接后果）：
  // 闸门必须看**级别列的真实严重度**，不能只看处置状态桶。
  // 实测 10 行 `| C01 | 致命 | 未修 |`：状态桶给出 致命=0 挂账=10，闸门读成"没有致命"；
  // 而真实情况是「10 条致命级问题一条都没修」。把两者取大，闸门才不会漏。
  const fatal = Math.max(t['致命'], claimed['致命'])
  const severe = Math.max(t['严重'], claimed['严重'])
  console.log(`致命=${fatal} 严重=${severe} 一般=${t['一般']} 优化=${t['优化']} 已消除=${t['已消除']} 挂账=${t['挂账']} 不成立=${t['不成立']} 未识别=${unknown.length} 合计=${rows.length}`)
  if (claimed['致命'] > t['致命'] || claimed['严重'] > t['严重']) {
    console.log(`  （按级别列的真实严重度: 致命=${claimed['致命']} 严重=${claimed['严重']} —— 状态桶把它们掩盖了，已取大值）`)
  }
  if (t['挂账'] > 5) console.log('NOTICE: 挂账 > 5 条（不阻断，但记 04）')

  // v6.29M（本轮命令探针发现）：**gate 与 bundle 各查各的，从不交叉。**
  // gate 只查 04-summary 有没有「证据落地」小节；bundle 只查 03-review 有没有「文件名:行号」。
  // 实测 R10：03-review 位置栏全是 `v5 L151` 这种无文件名简写 → bundle 直接 UNDECIDABLE，
  // 而 gate 照旧「放行」。两条命令对同一份数据结论相反，正是最该消掉的那类不一致。
  // 处理：**不阻断**（历史轮次就是用简写的），但必须说出来。放在最前面 —— 它只关乎引用形态，
  // 与后面的攻击/执行检查无关；放在后面会被 GATE_UNATTACKED 之类的早退挡住（实测过一次）。
  {
    try {
      // 不用解析出来的行对象：实测 parseVerdict 的行里取不到「级别」列（tally 会把它算进状态桶），
      // 一版按 r['级别'] 过滤得到 0 条，这道提示从未触发。直接看原文更可靠。
      const text = readFileSync(file, 'utf8')
      const hasSevereWord = /(致命|严重)/.test(text)
      const hasFileLine = /[\w.\-/]+\.(md|json|txt|csv|py|ts|mjs):\d+/.test(text)
      if (hasSevereWord && !hasFileLine) {
        console.error('GATE_LOCATION_UNRESOLVABLE: 本文件提到致命/严重，但整份复核**没有一处「文件名:行号」**')
        console.error('  —— bundle/audit 会判 UNDECIDABLE；位置栏里的 L151 这类简写指不到文件。')
        if (isStrictRound(dirname(resolve(file)))) {
          console.error('  严格模式（2026-11-10 之后创建的轮次）：**证据检查优先于形状检查，不得放行**。')
          console.error('  跨厂商审计（智谱 GLM-5.3 第 4 条）：形状检查压过证据检查时，一份 0 处可落地引用的')
          console.error('  复核件 + 合规的 04 文档仍能放行 —— 这正是要堵的洞。')
          return 1
        }
        console.error('  历史轮次：只报不拦（避免回溯判死真放行）。')
      }
    } catch { /* 只报不拦 */ }
  }

  // v6.24 缺陷27（2026-11-02 实跑 R10-1102a1 暴露）：
  // **主控可以绕过红队自己判「全部已消除」**。
  // 实测 R10：两路红队均未启动、蓝队子代理失控、02-blue.md 由主控代笔，
  // 03-review.md 仍写「20 条全部已消除」→ gate 放行。假放行的根因不是解析错误，
  // 而是**闸门只看 03-review.md 这一张表，从不问「这一轮真的有人攻击过吗」**。
  // 判定：红队产物缺失/无「用例表」/红队小节为空 ⇒「全部已消除」不成立。
  const rd = dirname(resolve(file))
  const attacked = redTeamDelivered(rd)
  // 蓝队「真的执行过」：不能只看有没有「逐条处置」这几个字 ——
  // 实测一句「（无逐条处置小节）」就含这四个字，被误判成已执行。
  // 改为要求：该小节存在，且小节里有 ≥1 行带用例编号的处置行。
  const executed = blueTeamExecuted(rd)
  const clean = fatal === 0 && severe === 0 && rows.length > 0
  if (clean && !attacked.ok) {
    console.error(`GATE_UNATTACKED: ${attacked.why} ——「全部已消除」不成立，不得放行。`)
    console.error('  主控自判不能替代红队独立复核。R10-1102a1 就是这样假放行的：红队没启动，却判了 20 条全清。')
    return 1
  }
  if (clean && !executed.ok) {
    console.error(`GATE_UNEXECUTED: ${executed.why} —— 没有蓝队执行记录，处置结论无来源，不得放行。`)
    return 1
  }

  if (unknown.length > 0) { console.error(`GATE_UNDECIDABLE: ${unknown.length} 行级别无法解析，先修数据再判闸门`); return 2 }
  // v6.15 缺陷18（R5 红队 e12 抓到）：**空表不许放行**。
  // 致命=0 严重=0 有两种来源：真的没有，或者**一行都没解析出来**。
  // 后者会把"没有结论"读成"全部通过"，这是闸门最危险的失效模式。
  if (rows.length === 0) {
    console.error('GATE_UNDECIDABLE: 判定表 0 行可识别 —— 没有结论不等于全部通过，不得放行。')
    return 2
  }
  // v5.2 缺陷2：不只认「新问题」小节 —— 任何小节里出现 致命/严重 的表格行都要拦
  const off = scanOffTable(file)
  const stray = scanStraySeverity(file)
  if (off.rows.length > 0) console.log(`表外新问题: 致命=${off.fatal} 严重=${off.serious} 一般=${off.minor} 优化=${off.opt} 合计=${off.rows.length}`)
    // v6.29s（A4 盲点之一）：定级合理性 —— 未闭合的致命/严重必须能指到具体位置。
    // 为什么：`severity` 只查"级别分布有没有区分度"，不查定级是否有落点；
    // 于是"把一般写成严重"、"严重但位置栏是空的"都能过。这是今晚自查清单里
    // 我主动承认的三处"靠自觉"之一，这里把它变成判据。
    // 只拦**未闭合**的（已消除/不成立的行早已给出证据），避免回溯判死历史轮次。
    try {
      const rowsP = parseTableRows(file)
      const unlocatable = rowsP.filter((r) => {
        const lvl = String(r['级别'] || '')
        if (!/(致命|严重)/.test(lvl)) return false
        const st = String(r['状态'] || r['判定'] || '')
        if (/(已消除|不成立|当前文本已答)/.test(st)) return false
        const pos = String(r['位置'] || r['行号'] || '')
        return !/(L\d+|:\d+)/.test(pos)
      })
      if (unlocatable.length) {
        console.error(`GATE_SEVERE_UNLOCATABLE: ${unlocatable.length} 条**未闭合**的致命/严重没有可定位位置`
          + `（${unlocatable.map((r) => r.id).join(',')}）—— 定级必须有落点（位置栏需含 L行号 或 文件:行号）。`)
        return 1
      }
      // v6.29v：光有"L数字"不够 —— 那个行号可以是随便填的。再核两层：
      //   ① 行号必须落在候选稿的实际行数范围内；
      //   ② 被引的那几行里，至少要出现判据/证据里的一个西文词（≥6 字符）。
      // 只在"判据/证据含西文词"时做词面核对，纯中文判据跳过（否则全是假阳性）。
      // v6.29x：本块原来引用了未定义的 rdA2（那是后面攻击检查块的变量名），
    // 抛 ReferenceError 后被外层 catch 吞掉 —— 两道判据从未真正执行。
    const rdS = dirname(resolve(file))
    const candsS = readdirSync(rdS).filter((f) => /^\d+-candidate.*\.md$/i.test(f)).sort(natCmp)
      if (candsS.length) {
        const artLines = readFileSync(join(rdS, candsS[candsS.length - 1]), 'utf8').split(/\r?\n/)
        const misplaced = []
        for (const r of rowsP) {
          if (!/(致命|严重)/.test(String(r['级别'] || ''))) continue
          if (/(已消除|不成立|当前文本已答)/.test(String(r['状态'] || r['判定'] || ''))) continue
          const nums = [...String(r['位置'] || '').matchAll(/L(\d+)/g)].map((m) => Number(m[1]))
          if (!nums.length) continue
          const oob = nums.filter((n) => n < 1 || n > artLines.length)
          if (oob.length) { misplaced.push(`${r.id}:行号越界(${oob.join(',')})`); continue }
          const claim = [r['判据'], r['证据']].filter(Boolean).join(' ')
          const toks = [...new Set((claim.match(/[A-Za-z][A-Za-z0-9_.-]{5,}/g) || []))].slice(0, 12)
          if (!toks.length) continue
          const cited = nums.map((n) => artLines[n - 1] || '').join(' ').toLowerCase()
          // v6.29w：只要求"判据里任意一个词出现在被引行"太软 —— `registry` 这种泛词满稿都是。
          // 改成优先用**稀有词**（在整篇稿里出现 ≤3 次）来核对；没有稀有词时才退回全量词。
          const whole = artLines.join(' ').toLowerCase()
          const rare = toks.filter((t) => (whole.split(t.toLowerCase()).length - 1) <= 3)
          const pool = rare.length ? rare : toks
          if (!pool.some((t) => cited.includes(t.toLowerCase()))) {
            misplaced.push(`${r.id}:被引行里找不到判据中的${rare.length ? '稀有词' : '任何词'}`)
          }
        }
        if (misplaced.length) {
          console.error(`GATE_SEVERE_MISLOCATED: ${misplaced.join('；')} —— 位置必须真的指向该缺陷所在的原文，随便填一个行号不算。`)
          return 1
        }
      }
      // v6.29G：严重级别必须有**可核的核实方法**。
      // 起因：主控今天三次把非严重的事定成严重（编造的 137/138、假设出的"12 页上限"、
      // 以及"14 条文献 0 处引注"——最后这条是用作者姓氏去搜正文得出的，而正文其实用 DOI 引注）。
      // 三次的共同点：**级别是拍出来的，不是核出来的**。
      {
        // v6.29M（R11 实测）：这份白名单原来**只有 redblue 自己的子命令** ——
        // 而本机制的主力用法是**审论文/数据集**，那时最硬的核实方式是「拿补充数据重算」，
        // 不是跑 redblue 子命令。实测 R11：6 条严重的证据全是「解压 S11 → 读 P34b 脚本 →
        // 用 S4 复算」，一条都过不了这道闸，被整批拦下。**拦的是真证据，放过的是假证据**
        // （只要写一句 "recount" 就能过，真做了复算反而过不了）—— 这是反向失效。
        // 修法：认可「一切可复现的核实载体」：脚本名、数据文件名:行号、运行器、外部来源。
        const METHOD = /(\b(ident|occur|xcheck|refs|scancheck|metrics|recount|gate|canary|quality|carry|route|attack|validate|audit)\b)|(\.(py|mjs|js|ps1|sh|r)\b)|(\b(node|python3?|powershell|pwsh|grep|rg|awk|sed)\b)|([\w.\-]+\.(csv|json|txt|md|xlsx|tsv):\d+)|(\bdoi:\S+)|(https?:\/\/\S+)/
        const ABSENCE = /(0\s*处|从未|未出现|没有出现|找不到|未找到|absent|not cited|no evidence|零处|none\b)/
        const bad2 = []
        for (const r of rowsP) {
          if (!/(致命|严重)/.test(String(r['级别'] || ''))) continue
          if (/(已消除|不成立|当前文本已答)/.test(String(r['状态'] || r['判定'] || ''))) continue
          const ev = [r['证据'], r['判据'], r['位置']].filter(Boolean).join(' ')
          const methods = new Set((ev.match(new RegExp(METHOD.source, 'g')) || []).map((x) => x.toLowerCase()))
          if (!methods.size) { bad2.push(`${r.id}:证据里没有任何可核方法（ident/occur/xcheck/refs/…）`); continue }
          // 缺失类断言：单方法声称"没有"最不可靠 —— 换个方法往往就找得到。
          if (ABSENCE.test(ev) && methods.size < 2) {
            bad2.push(`${r.id}:声称"缺失/0 处"，但只有 1 种核实方法（${[...methods].join(',')}）—— 缺失类断言必须 ≥2 条独立方法`)
          }
        }
        if (bad2.length) {
          console.error(`GATE_SEVERE_UNVERIFIED: ${bad2.join('；')} —— 严重级别必须是核出来的，不是拍出来的。`)
          return 1
        }
      }
    } catch (e) {
      // v6.29x：这里原来是一句 `catch {}` —— 它同时罩着「位置核对」与「稀有词核对」两道判据，
      // 任何异常（包括变量名写错导致的 ReferenceError）都会让两道一起**静默失效**。
      // 今晚已经因为这个吃过一次亏。判据失败必须 fail-closed，并留下可见痕迹。
      console.error(`GATE_SEVERE_CHECK_ERROR: 定级位置核对自身出错（${String(e?.message ?? e)}）—— 该判据未生效，不得当作已检查。`)
      return 1
    }

  if (fatal === 0 && severe === 0) {
    // v5.1：判定表干净但表外有致命/严重 ⇒ 不许放行（老会话的教训）
    if (off.fatal > 0 || off.serious > 0 || stray.length > 0) {
      const total = off.fatal + off.serious + stray.length
      console.log(`GATE: 不放行（表外还有 致命${off.fatal}/严重${off.serious}，散落未入表 ${stray.length} 条，共 ${total} 条，须先补进判定表再判）`)
      for (const s of stray.slice(0, 5)) console.log(`  STRAY: 行${s.line} ${s.text}`)
      return 1
    }
    // v6.24 缺陷28（2026-11-02 实测）：**表外的一般/优化被完全无视**。
    // 实测 3 条表外「一般」+ 表内干净 ⇒ GATE: 放行。这些是红队抓到但没进判定表的问题，
    // 直接消失。判定：表外一般/优化超过阈值 ⇒ 不许放行，须先并入判定表。
    if (off.minor + off.opt > OFF_MINOR_LIMIT) {
      console.log(`GATE: 不放行（表外还有 一般${off.minor}/优化${off.opt} 共 ${off.minor + off.opt} 条未并入判定表，超过容差 ${OFF_MINOR_LIMIT}）`)
      for (const r of off.rows.slice(0, 6)) console.log(`  OFF-TABLE: ${r.text}`)
      return 1
    }
    if (off.minor + off.opt > 0) console.log(`NOTICE: 表外 一般${off.minor}/优化${off.opt} 条未并入判定表（未超容差 ${OFF_MINOR_LIMIT}，但应补入）`)

    // v6.25「实事求是」三节检查（用户 2026-11-02 明确要求）：
    //   必须实事求是地做，有什么才能做什么；不要以预期为导向，要有实打实的数据支撑；
    //   设想和实际矛盾就重新设想；不要 AI 幻觉，不要阿谀奉承，不要为求快而做少。
    // 这三条落成三个必需小节。gate 只能查「有没有做」，查不了「做得真不真」——
    // 这是诚实的边界（见 SKILL.md §8），但「没做」是能机械查出来的。
    const recon = checkReconcileSections(rd)
    if (!recon.ok) {
      for (const m of recon.missing) console.error(`${m.code}: ${m.why}`)
      if (recon.missing.some((m) => m.code === 'GATE_UNGROUNDED')) {
        console.error('  用户底线：每个结论必须有落地证据（文件:行号 或 命令+输出）。标「未核实」的不算已消除。')
      }
      if (recon.missing.some((m) => m.code === 'GATE_NO_RECONCILE')) {
        console.error('  用户底线：设想和实际矛盾时必须重新设想。没有「## 设想 vs 实际」小节 = 从没检查过。')
      }
      if (recon.missing.some((m) => m.code === 'GATE_NO_SCOPE')) {
        console.error('  用户底线：不许为求快而缩小范围。缩小范围本身是缺陷，必须显式声明。')
      }
      return 1
    }

    // v6.29r：把 "attacked" 从"看归属列"变成"核交付件指纹"。
    // 为什么：实测两次栽在这 —— R6 四项全绿时独立复核根本没成功；R9 的 v5 至今无人复核。
    // 有了 red-attack.json，就能判「红队审的是不是这一版」；指纹不符 ⇒ 拦。
    try {
      const rdA = dirname(resolve(file))
      const ap = join(rdA, 'red-attack.json')
      if (existsSync(ap)) {
        const ja = JSON.parse(readFileSync(ap, 'utf8').replace(/^\uFEFF/, ''))
        const cands = readdirSync(rdA).filter((f) => /^\d+-candidate.*\.md$/i.test(f)).sort(natCmp)
        if (cands.length) {
          const newest = cands[cands.length - 1]
          const h = createHash('sha256').update(readFileSync(join(rdA, newest))).digest('hex').slice(0, 16).toUpperCase()
          if (String(ja.artifactSha256_16 || '').toUpperCase() !== h) {
            console.error(`GATE_ATTACK_STALE: red-attack.json 记录的是 ${ja.artifactSha256_16}，`
              + `而当前候选稿 ${newest} 是 ${h} —— 红队审的不是这一版，不得放行。`)
            return 1
          }
          const n = Array.isArray(ja.attackers) ? ja.attackers.length : 0
          if (n === 0) {
            console.error(`GATE_ATTACK_EMPTY: red-attack.json 指纹匹配但没有任何攻击者记录 —— 等于没被审过。`)
            return 1
          }
          console.log(`  攻击证据: ${n} 个红队实例，交付件指纹 ${h} 匹配`)
          // v6.29M：把「派出去但没回来」的也报出来 —— 否则「只派了一个」与
          // 「派了三个挂了两个」在账上长得一模一样，独立性被系统性高估。
          const failed = Array.isArray(ja.failed) ? ja.failed : []
          if (failed.length) {
            console.error(`  NOTICE_ATTACK_FAILED: 另有 ${failed.length} 次派出失败 —— 独立性按**实际成功**的 ${n} 个计，`
              + `不按派出的 ${n + failed.length} 个计：`)
            for (const f of failed.slice(0, 6)) console.error(`    ${f.provider}/${f.model} — ${f.reason}`)
          }
          // v6.29M（2026-11-10，跨厂商魔鬼代言人点名抓到的机制漏洞）：
          //
          // 上面这段只检查「有没有攻击记录」，**从没检查「攻击者到底是谁」**。
          // 后果实测：R11–R14 四轮里，四张脸、蓝队、复核全部由 `longcat_worker` 充当，
          // 而它的 provider/model 在 config 里钉死成 `longcat/LongCat-2.5-Preview` ——
          // **所有角色是同一个模型**，但产物里印着「独立复核红队」，`gate` 一路绿灯。
          // 机制自己承诺的「收敛必须由换过红队的轮次证明」因此在四轮里从未被真正满足，
          // 而没有任何命令发现。
          //
          // 判据：把 (provider, model) 去重，只有 1 种 = 单路由。
          // **只报不拦**：新判据回溯会把历史上真放行的轮次全部判死（SKILL §10 第 22 条教训）。
          // 但它必须说出来——因为「一个模型的三个名字」冒充「三方独立」是本机制最贵的失效模式。
          const routes = [...new Set((ja.attackers || []).map((a) => `${a.provider}/${a.model}`))]
          const extN = Array.isArray(ja.external) ? ja.external.length : 0
          if (routes.length <= 1) {
            const who = routes[0] || '(未记 provider/model)'
            if (extN) {
              console.log(`  NOTICE_ATTACK_NOT_DIVERSE: ${n} 个攻击者只有 1 种路由（${who}），`
                + `但有 ${extN} 份机制外独立评审 —— 独立性来自后者，不是前者。`)
            } else {
              console.error('NOTICE_ATTACK_NOT_DIVERSE: ' + n + ' 个攻击者只有 1 种路由（' + who + '），'
                + '且无机制外独立评审 ——「红队/蓝队/复核」可能只是同一个模型的三个名字。')
              console.error('  **不得在任何报告里写成「独立复核」**。')
              console.error('  修法：route probe → route pick → route mklib 三步就能拿到真跨厂商角色，')
              console.error('        再用 attack record <轮次> <provider> <model> <交付件> <角色> 记录真实路由。')
              console.error('  这不阻断放行（避免在资源不足时卡死机制），但**不得在任何报告里写成「独立复核」**。')
            }
          } else {
            console.log(`  攻击者路由: ${routes.join(' | ')}（${routes.length} 种，可称独立）`)
          }
        }
      } else {
        console.error('NOTICE_ATTACK_MISSING: 本轮没有 red-attack.json —— "attacked" 检查仍是名义的'
          + '（用 `attack record <轮次目录> <provider> <model> <交付件>` 记录；见 CHANGES M16/M19-r）。')
      }
    } catch (e) {
      console.error(`GATE_ATTACK_INVALID: red-attack.json 无法解析: ${String(e?.message ?? e)}`)
      return 1
    }

    // v6.29 追加两条「只报不拦」的检查（第 3 条增量声明、第 6 条两类未覆盖范围）。
    // 为什么只报不拦：v6.25 的教训是新判据回溯旧产物会把历史上真放行的轮次全部判死。
    // 先以 NOTICE 形式跑若干轮，等新轮次自然满足、且确认不误伤后再考虑升级为拦截。
    try {
      const rd0 = dirname(resolve(file))
      const bluePath = join(rd0, '02-blue.md')
      if (existsSync(bluePath)) {
        const bt = readFileSync(bluePath, 'utf8')
        const hasDelta = /words\s*[=:]\s*\d+|pages\s*[=:]\s*\d+|词数[^\n]{0,30}\d[^\n]{0,20}→|页数[^\n]{0,30}\d[^\n]{0,20}→|body_words\s*=\s*\d+/.test(bt)
        if (!hasDelta) {
          console.error('NOTICE_NO_DELTA: 02-blue.md 未声明本轮修订的词数/页数增量（v6.29 第 3 条）。不阻断本轮，下轮应补。')
        }
      }
      const sumPath = join(rd0, '04-summary.md')
      if (existsSync(sumPath)) {
        const st = readFileSync(sumPath, 'utf8')
        const hasEnv = /环境不允许|环境限制|网络不可达|沙箱不可|沙箱打不开|付费墙|iopscience/.test(st)
        const hasAsk = /(主控|我)[^\n]{0,10}(没问|未问)|问人|该问没问/.test(st)
        if (!(hasEnv && hasAsk)) {
          console.error('NOTICE_SCOPE_UNQUALIFIED: 04-summary.md 的「未覆盖范围」未分成「环境不允许 / 主控没问人」两类（v6.29 第 6 条）。不阻断本轮。')
        }
      }
    } catch { /* 只报不拦：任何异常都不得影响闸门结论 */ }

    // v6.29B：账目闭合（ident）接入闸门。
    // 起因：`ident` 做出来之后没有任何机制强制它被跑 —— 那它就只是一条"可以不用"的命令，
    // 和写成散文的纪律没有本质区别。本轮若在轮次目录里声明了 identities*.json，就必须全部成立。
    {
      const rdI = dirname(resolve(file))
      let idFiles = []
      try { idFiles = readdirSync(rdI).filter((f) => /^identities.*\.json$/i.test(f)).sort() } catch { idFiles = [] }
      if (!idFiles.length) {
        console.error('NOTICE_NO_IDENT: 本轮没有 identities*.json —— 账目是否闭合没被机器验过'
          + '（写一份 spec 用 `ident` 声明恒等式即可消除此提示）。')
      } else {
        for (const f of idFiles) {
          const ip = join(rdI, f)
          let specOk = true
          try { readJsonFile(ip) } catch { specOk = false }
          if (!specOk) { console.error(`GATE_IDENT_INVALID: ${f} 不是合法 JSON —— 账目 spec 坏了，不得当作"验过"。`); return 1 }
          const rc = cmdIdent([ip])
          if (rc !== 0) {
            console.error(`GATE_IDENT_FAIL: ${f} 的恒等式未全部成立 —— 账目不闭合不得放行（数字对不上，说明正文里有互相矛盾的计数）。`)
            return 1
          }
        }
      }
    }

    // v6.29C：全稿出现次数扫描（occur）接入闸门 —— 同一待遇，不强制跑就等于没做。
    {
      const rdO = dirname(resolve(file))
      let ocFiles = []
      try { ocFiles = readdirSync(rdO).filter((f) => /^occur.*\.json$/i.test(f)).sort() } catch { ocFiles = [] }
      if (!ocFiles.length) {
        console.error('NOTICE_NO_OCCUR: 本轮没有 occur*.json —— 「改完只改一处、别处还在」这类问题没被机器查过'
          + '（写一份 spec 声明"某说法应剩几处"即可消除此提示）。')
      } else {
        for (const f of ocFiles) {
          const op = join(rdO, f)
          let specOk = true
          try { readJsonFile(op) } catch { specOk = false }
          if (!specOk) { console.error(`GATE_OCCUR_INVALID: ${f} 不是合法 JSON —— 出现次数 spec 坏了，不得当作"查过"。`); return 1 }
          const rc = cmdOccur([op])
          if (rc !== 0) {
            console.error(`GATE_OCCUR_FAIL: ${f} 的出现次数不符 —— 说明"某个说法没改干净"或"改过头了"。`)
            return 1
          }
        }
      }
    }

    // v6.29E：列错位 —— 级别与状态写反时，统计全部失真，不得放行。
    {
      const swapped = detectColumnSwap(file)
      if (swapped.length) {
        console.error(`GATE_COLUMN_SWAP: ${swapped.length} 行的「级别」与「状态」两列写反（${swapped.slice(0, 3).join('；')}）`
          + ' —— 统计失真不得放行，先把两列对调。')
        return 1
      }
    }

    console.log('GATE: 放行')
    // v6.29M（2026-11-10，跨厂商魔鬼代言人 Kimi 点名）：
    //
    // 它的两条原话：「这套机制保护的从来不是结论，是『事后有人能指着一份文件说当时放行过』」
    // 与「它出错时永远错向放行，所以越信任它越危险」。**两条都对。**
    // 因为上面每一条判据查的都是**形状**（有没有判定行 / 级别可不可读 / 指纹匹配不匹配 /
    // 三节在不在 / 列有没有写反），没有一条查**结论对不对** —— 机制没有外部真值。
    //
    // 这个天花板改不掉（机器没有外部真值就是没有）。能做的是：
    // **每次放行时把天花板一并印出来**，让使用者看到「放行」的同时看到「没放行什么」，
    // 而不是只拿走一个绿色戳。它的实测案底支持这个改动：L645-648 有两份带致命/严重的
    // 复核件被判成 0 行且 exit 0；L653 里 reattack 判 FAIL 而 converge 判 PASS，绿的那条是错的。
    console.log('  ── 本次放行不覆盖以下四项（机制无外部真值，只证形式合规）──')
    console.log('     1. 引用内容：`bundle` 只核「文件在 + 行号不越界」，不核那一行写的是什么。')
    console.log('        实测：S10 引用连续三轮指向错行（说 Jan-1，实为 Jul-1）仍判 OK；')
    console.log('        本项目 14 轮 `cite` 零次使用。要核内容必须 `cite <文件:行号> --quote="原文"`。')
    console.log('     2. 攻击者身份：只核「有没有攻击记录」，不核「是不是同一个模型」。')
    console.log('        单路由会另报 NOTICE_ATTACK_NOT_DIVERSE，但**不阻断**放行。')
    console.log('     3. 结论正确性：闸门检查「有没有做对称的动作」，不检查「结论对不对」。')
    console.log('        **「放行」= 形式合规；「结论成立」必须另行取证，不得互相代替。**')
    console.log('     4. 实事求是三节：只证明「证据落地 / 设想vs实际 / 未覆盖范围」三节存在且非空模板，')
    console.log('        **不证明里面写的是真的**。机械阈值是存在性下限，不是质量标准。')
    return 0
  }
  console.log('GATE: 进下一轮')
  return 1
}

/**
 * v6.25：检查 04-summary.md 的三个「实事求是」小节。
 *
 * 判据刻意做得**宽松但不可绕过**：只查小节存在 + 有实质内容（>200 字符、
 * 且不是纯模板占位）。查不到内容真假 —— 那需要外部真值，本机制没有。
 * 但「有没有做这件事」是可查的，而用户要的正是这个：先别谈做得对不对，先别装。
 */
function checkReconcileSections(roundDir) {
  const p = join(roundDir, '04-summary.md')
  const missing = []
  if (!existsSync(p)) {
    return {
      ok: false,
      missing: [
        { code: 'GATE_UNGROUNDED', why: '缺 04-summary.md —— 没有汇总文件，无从谈证据落地。' },
        { code: 'GATE_NO_RECONCILE', why: '缺 04-summary.md —— 没有汇总文件，无从谈设想与实际。' },
        { code: 'GATE_NO_SCOPE', why: '缺 04-summary.md —— 没有汇总文件，无从谈未覆盖范围。' },
      ],
    }
  }
  const txt = readFileSync(p, 'utf8')
  const lines = txt.split(/\r?\n/)
  // 取某小节正文：从匹配标题行到下一个同级或更高级标题。
  // notRe：标题里含这些词就不算（防止「本轮修了什么（… 未结案）」被当成「未覆盖范围」）。
  function sectionBody(re, notRe) {
    let start = -1, level = 0
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(#{1,6})\s+(.*)$/)
      if (!m) continue
      if (notRe && notRe.test(m[2])) continue
      if (re.test(m[2])) { start = i; level = m[1].length; break }
    }
    if (start < 0) return null
    const out = []
    for (let i = start + 1; i < lines.length; i++) {
      const m = lines[i].match(/^(#{1,6})\s+/)
      if (m && m[1].length <= level) break
      out.push(lines[i])
    }
    return out.join('\n')
  }
  const placeholder = /^[\s\-—>|*#]*$/
  // v6.25 阈值修正（实测教训）：
  // 第一版用「>200 字符」判实质内容，结果把一份**内容完整**的中文「设想 vs 实际」
  // （137 字符、含 2 行实质论断）判成「缺实质小节」。**中文字符信息密度约为英文 3 倍**，
  // 200 字符对中文是过严的门槛 —— 这是判据设计错误，不是内容不合格。
  // 改为「实质行数」：表格数据行与叙述行都算，≥3 行且有 ≥60 字符散文即认为做过。
  // 目的不是判写得好不好，而是判**有没有做这件事**。
  function substantive(body) {
    if (body == null) return false
    const t = body.trim()
    if (t.length < 60) return false
    if (placeholder.test(t)) return false
    const rows = t.split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !/^[|\-:\s]+$/.test(l))          // 去掉分隔线
      .filter((l) => !/^\|\s*$/.test(l))
    // 实质行：表格数据行（| 开头且含非分隔内容）或叙述行（非 | 开头且 ≥8 字）
    const real = rows.filter((l) => {
      if (l.startsWith('|')) return l.replace(/\|/g, '').trim().length >= 6
      return l.replace(/^[-*>\d.\s]+/, '').length >= 8
    })
    const prose = rows.filter((l) => !l.startsWith('|')).join('').length
    // v6.25 第二轮修正（实测 R8/R10 教训）：
    //   1) R8 的「纪律核验」是**纯表格**（prose=0），但 4 行表格逐项给了 mtime/指纹
    //      —— **表格本身就是证据**，不该因为它没有散文就判"没做"。
    //   2) R10 的「本轮修了什么（… + T14≡K02）」标题含「未结案」被误匹配成未覆盖小节，
    //      内容却是修了什么。→ 标题匹配不能只看包含关系（见下方 notSection 排除）。
    // 判定改为：**实质表格行 ≥3 且每行有内容**，或 **表格 ≥2 行 + 散文 ≥30**。
    const tableRows = real.filter((l) => l.startsWith('|')).length
    if (tableRows >= 3) return true
    return real.length >= 3 && prose >= 30
  }

  const g = sectionBody(/证据落地|证据链|落地证据/)
  if (!substantive(g)) {
    // 等价形态：R8 的「纪律核验」表逐项给了 mtime/指纹等落地证据，功能等价。
    const alt = sectionBody(/纪律核验|纪律检查|核验|证据/)
    if (!substantive(alt)) {
      missing.push({ code: 'GATE_UNGROUNDED', why: '04-summary.md 缺实质「## 证据落地」（或等价「## 纪律核验」）小节——每条已消除须能指到 文件:行号 或 命令+输出。' })
    }
  }
  const r = sectionBody(/设想\s*vs\s*实际|设想与实际|设想和实际|预期与实际/)
  if (!substantive(r)) {
    // v6.25 实测教训：R8/R11 是**真放行**的历史轮次，它们写的是「主控决策」表
    // （逐条写「我以为 X，实测 Y，所以改判」），功能上就是设想 vs 实际，
    // 只是没用这个标题。判据必须认历史真实形态，否则新规则回溯会把真放行全判死。
    const alt = sectionBody(/主控决策|改判|决策|推翻|修正|降档/)
    if (!substantive(alt)) {
      missing.push({ code: 'GATE_NO_RECONCILE', why: '04-summary.md 缺实质「## 设想 vs 实际」（或等价「## 主控决策/改判」）小节——须写清哪条设想被数据推翻、改成了什么。' })
    }
  } else {
    // v6.29t（A4 盲点之一）：光有 3 行不算数 —— 这个节以前可以写「设想 A 成立」糊过去。
    // 现在必须出现**具体的推翻/改写**，或**显式声明本轮没有被推翻的设想**（把沉默变成声明）。
    const REFUTE = /(推翻|改成|改为|证伪|纠正|打回|错在|实际是|反了|与.{0,8}矛盾)/
    const DECLARE_NONE = /(本轮|这次|R\d+).{0,10}(无|没有|未被).{0,10}(设想|假设|预期).{0,6}(推翻|证伪|改动)|无设想被推翻/
    // v6.29v：光有"推翻/改成"这类词也不够 —— 「设想 A 被推翻」没说是哪条、被什么推翻。
    // 要求：出现推翻语的那一行，还得带一个**对象**（用例编号 C01/N12，或一个具体数量）。
    const refuteLine = r.split(/\r?\n/).find((ln) => REFUTE.test(ln)
      && /([A-Z]{1,3}\d{1,3}|\d|设想\s*[A-Za-z一二三四五六七八九十])/.test(ln))
    // 技能第 22 条：新判据必须认历史真实形态 —— 真实轮次里「设想 / 实际 / 改成什么」三列表格
    // 在语义上完全满足本节要求，但它一个 REFUTE 词都不一定写。表格形态要直接认可。
    const tableForm = r.split(/\r?\n/).some((ln) => /^\s*\|/.test(ln)
      && /设想/.test(ln) && /(实际|改成|改判|推翻)/.test(ln))
    if (!refuteLine && !tableForm && !DECLARE_NONE.test(r)) {
      missing.push({ code: 'GATE_NO_RECONCILE_CONTENT', why: '04-summary.md 的「## 设想 vs 实际」有内容但既没写清"哪条设想（用例编号或具体数字）被推翻/改成了什么"，也没显式声明"本轮无设想被推翻"——空泛的"设想成立"不算做过。' })
    } else if (refuteLine) {
      // v6.29w：引用的用例编号必须真的存在于本轮判定表 —— 否则可以随手编一个 C99 蒙过去。
      // 注意两点（都是第一版的错）：
      //   ① 本函数的参数是 roundDir，不是 file —— 第一版写 dirname(resolve(file)) 直接抛 ReferenceError；
      //   ② 那个 ReferenceError 被 catch 静默吞掉，判据"看起来有护栏、其实一行没执行"。
      //   ⇒ **catch 里至少要留一条可见的痕迹**，否则静默失败比没有判据更糟。
      try {
        // 只认 C01 / N12 这类用例编号；**不能**用 [A-Z]{1,3}\d+ —— 那会把轮次号 R9 也吞进来（实测误伤 R10）。
        const cited = refuteLine.match(/\b([CN]\d{1,3})\b/)
        if (cited) {
          // 注意：跨轮引用是**合法的**（"R9 的 N6 修复…"）。所以编号集合取整个项目下所有轮次，
          // 不能只看本轮 —— 否则 R10 引用 N6 会被误判成"编造编号"。
          const ids = new Set()
          const rootDir = dirname(resolve(roundDir))
          const scan = [roundDir]
          try {
            for (const nm of readdirSync(rootDir)) {
              const d = join(rootDir, nm)
              if (d !== roundDir && existsSync(join(d, '03-review.md'))) scan.push(d)
            }
          } catch { /* 目录不可读就只扫本轮 */ }
          for (const d of scan) {
            for (const cand of ['03-review.md', '01-cases.md']) {
              const cp = join(d, cand)
              if (!existsSync(cp)) continue
              for (const x of parseVerdict(cp)) ids.add(String(x.id))
            }
          }
          if (ids.size && !ids.has(cited[1])) {
            missing.push({ code: 'GATE_RECONCILE_FAKE_REF', why: `04-summary.md 的「设想 vs 实际」引用了 ${cited[1]}，但本轮判定表里没有这个编号 —— 不许引用不存在的用例。` })
          }
        }
      } catch (e) {
        console.error(`GATE_RECONCILE_CHECK_ERROR: 引用核对自身出错（${String(e?.message ?? e)}）—— 这条判据没生效，别把它当成"已检查"。`)
        return { ok: false, missing: [{ code: 'GATE_RECONCILE_CHECK_ERROR', why: '引用核对自身出错，判据未生效。' }] }
      }
    }
  }
  const s = sectionBody(/未覆盖范围|覆盖边界|未审范围/)
  if (!substantive(s)) {
    // 等价形态：R8 的「未关闭项」、R11 的「仍未关闭的待办」都如实列了没做到的部分。
    // notRe 排除「本轮修了什么（… 未结案）」这种标题含关键词但内容是修了什么的误匹配。
    const alt = sectionBody(/未关闭|未结案|待办|边界|挂账|未覆盖|剩余/, /修了什么|已修|修复|处置|做了什么/)
    if (!substantive(alt)) {
      missing.push({ code: 'GATE_NO_SCOPE', why: '04-summary.md 缺实质「## 未覆盖范围」（或等价「## 未关闭项」）小节——须如实列出没审到的部分。' })
    }
  }
  return { ok: missing.length === 0, missing }
}

const ENUMS = {
  gate: ['放行', '进下一轮', 'BLOCKED'],
  stage: ['造用例', '执行中', '待判定', '待汇总', '已收尾'],
  status: ['未修', '已修', '驳回', '部分修', '挂账'],
  // v6 吸收自 kill-argument：判定词换成三态中立分类。
  // 「已修」隐含「曾经坏过、现在补好了」的历史假设，会系统性地偏向乐观；
  // 「当前文本已答」只问事实：读现在的稿子，这条指控还站得住吗。
  adjudication: ['当前文本已答', '部分已答', '仍未解决'],
}

/** 三态判定的严重度映射（吸收自 kill-argument 的 verdict 表）。 */
const ADJ_SEVERITY = ['致命', '严重', '一般']

function cmdAdjudicate([file]) {
  if (!file) die('usage: adjudicate <03-review.md>')
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  const rows = []
  for (const line of lines) {
    // v5.4 缺陷5（同 parseVerdict）：复核表用 R01–R05 编号，原先整表被跳过 → adjudicate 只判 4/9 行。
    // v6.29M：两处修正 ——
    // ① 编号正则要认跨轮携带编号 `R10-N17`（原先 21 条只数出 17 条，漏报 4 条未解决项）
    // ② 级别要在**前三列**都找。原逻辑只查 m[3]/m[4]，而 `| 编号 | 级别 | 状态 |` 这种列序里
    //    级别在 m[2]，于是严重级全被判成「未标级别」，`unresolved_major_or_minor` 的映射就失真。
    const m = line.match(/^\|\s*((?:[A-Za-z][-\s]?\d{1,3}(?:-[A-Za-z]\d{1,3})?)|(?:观点\s*\d{1,3})|(?:问题\s*\d{1,3})|(?:论点\s*\d{1,3})|(?:\d{1,3}))\s*\|([^|]*)\|([^|]*)\|([^|]*)\|/)
    if (!m) continue
    const verdict = ADJ_VERDICT_ALIASES(m[2]) || ADJ_VERDICT_ALIASES(m[3])
    const sev = ADJ_SEVERITY.find((s) => String(m[2]).includes(s) || String(m[3]).includes(s) || String(m[4]).includes(s))
    if (!verdict) continue
    rows.push({ id: m[1], verdict, severity: sev || null })
  }
  const counts = { '当前文本已答': 0, '部分已答': 0, '仍未解决': 0 }
  for (const r of rows) counts[r.verdict]++
  const unresolved = rows.filter((r) => r.verdict === '仍未解决')
  const partial = rows.filter((r) => r.verdict === '部分已答')
  console.log(`已答=${counts['当前文本已答']} 部分已答=${counts['部分已答']} 仍未解决=${counts['仍未解决']} 合计=${rows.length}`)

  // 缺陷：0 行时绝不能判 PASS。空表通过闸门 = 闸门形同虚设（同 M3/M6 的静默失真）。
  if (rows.length === 0) {
    console.error('ADJUDICATE_UNDECIDABLE: 0 行可识别。该文件不是三态判定表（可能用了「成立/已修/不成立」等旧判定词）。')
    console.error('  修法：判定词改为 当前文本已答 / 部分已答 / 仍未解决，或先用 recount/gate 判旧格式。')
    return 2
  }

  // verdict 映射（照抄 kill-argument Step 4 的表，只换成中文判定词）
  const critUnresolved = unresolved.filter((r) => r.severity === '致命').length
  const majorUnresolved = unresolved.filter((r) => r.severity === '严重').length
  const anyUnresolved = unresolved.length
  const critPartial = partial.filter((r) => r.severity === '致命' || r.severity === '严重').length
  const majorPartial = partial.filter((r) => r.severity === '一般').length

  let verdict, code
  if (critUnresolved > 0) { verdict = 'FAIL'; code = 'unresolved_critical' }
  else if (anyUnresolved > 0) { verdict = 'WARN'; code = 'unresolved_major_or_minor' }
  else if (critPartial > 0) { verdict = 'WARN'; code = 'partial_critical_or_repeated_major' }
  else if (majorPartial > 0) { verdict = 'PASS'; code = 'defense_survives_with_minor_partial_only' }
  else { verdict = 'PASS'; code = 'defense_survives' }

  console.log(`ADJUDICATE: ${verdict} (reason_code: ${code})`)
  for (const r of unresolved) console.log(`  UNRESOLVED: ${r.id} [${r.severity || '未标级别'}]`)
  return verdict === 'FAIL' ? 1 : verdict === 'WARN' ? 1 : 0
}

/** 判定词别名：兼容红队/蓝队各自写惯的说法。 */
function ADJ_VERDICT_ALIASES(cell) {
  const s = String(cell).trim()
  if (/^(已修|当前文本已答|已答|已消除)/.test(s)) return '当前文本已答'
  if (/^(部分|部分已答|部分修)/.test(s)) return '部分已答'
  // v6.29 缺陷32（R5 红队第二实例抓到）：`不成立` / `驳回` 是**指控被驳回**，
  // 不是"还没解决"。旧逻辑把它们归入「仍未解决」→ 2 条「不成立」被判成
  // `仍未解决=2` + `ADJUDICATE: FAIL (unresolved_critical)` exit 1，
  // 而同文件 `:30` 的注释却写「不成立」不阻断闸门 —— 代码与文档自相矛盾。
  // 语义修正：驳回/不成立 = 这条指控已被证伪，归「当前文本已答」桶（已结案）。
  if (/^(不成立|驳回|已驳回)/.test(s)) return '当前文本已答'
  if (/^(未修|仍未解决|挂账|STALE)/.test(s)) return '仍未解决'
  return null
}


function cmdValidate([file]) {
  if (!file) die('usage: validate <current.json|state.md>')
  const text = readFileSync(file, 'utf8')
  let fail = 0
  if (file.endsWith('.json')) {
    let j
    try { j = JSON.parse(text) } catch (e) { console.error(`VALIDATE_FAIL: JSON 解析失败 ${e.message}`); return 1 }
    if (j.gate && !ENUMS.gate.includes(j.gate)) { console.log(`ENUM_VIOLATION: gate='${j.gate}'`); fail = 1 }
    if (j.stage && !ENUMS.stage.includes(j.stage)) { console.log(`ENUM_VIOLATION: stage='${j.stage}'`); fail = 1 }
  } else {
    for (const line of text.split(/\r?\n/)) {
      if (!/^\|\s*R\d/.test(line)) continue
      // v5.1 修 BUG C：不再用固定列索引（列内写说明会错位，实测「0（表内）/ 1（表外）」）
      const cells = line.split('|').map(s => s.trim())
      const verdict = cells.find(c => /^(放行|进下一轮|BLOCKED)/.test(c)) ?? ''
      if (verdict && !ENUMS.gate.some((g) => verdict.startsWith(g))) {
        console.log(`ENUM_VIOLATION: 台账结论='${verdict}'`)
        fail = 1
      }
    }
  }
  if (!fail) console.log(`VALIDATE_OK: ${file}`)
  return fail
}

/**
 * v4.1：把红蓝对抗铺到任意项目根。幂等——已存在的文件不覆盖。
 * 用途：解决"机制不可迁移"（D9）：换项目不用手工重建目录结构。
 */
function cmdScaffold([root]) {
  if (!root) die('usage: scaffold <项目根>')
  const rb = join(root, '_redblue')
  mkdirSync(join(rb, 'rounds'), { recursive: true })
  const put = (name, body) => {
    const p = join(rb, name)
    if (!existsSync(p)) { writeFileSync(p, body, 'utf8'); console.log(`  + ${name}`) }
    else console.log(`  = ${name}（已存在，跳过）`)
  }
  put('state.md', '# 对抗状态\n\n## 闸门台账\n\n| 轮次目录 | 致命 | 严重 | 挂账 | 结论 | 日期 |\n| --- | --- | --- | --- | --- | --- |\n')
  put('current.json', JSON.stringify({ round: 0, shortcode: null, stage: '待汇总', gate: null }, null, 2) + '\n')
  put('error-types.md', [
    '# 错误类型目录（跨项目累积）',
    '',
    '| 代码 | 类型 | 典型表现 | 已命中次数 | 最近一次 |',
    '| --- | --- | --- | --- | --- |',
    '| E01 | 量纲/单位 | 把倍数标成 dB、场因子乘在功率域 | 0 | — |',
    '| E02 | 口径不一致 | 同一量全文两套定义 | 0 | — |',
    '| E03 | 引用归属错 | 句子记错文件/行号 | 0 | — |',
    '| E04 | 页码/条款错 | 引原文 page/line 对不上 | 0 | — |',
    '| E05 | 统计前提 | 样本不独立、无 CI | 0 | — |',
    '| E06 | 逻辑断裂 | 论证链断、因果倒置、界向推错 | 0 | — |',
    '| E07 | 覆盖遗漏 | 该做的实验/对比没做 | 0 | — |',
    '| E08 | 数据可复现 | 数字无法由原始数据重推 | 0 | — |',
    '| E09 | 定义不一致 | 同一术语两处定义不同 | 0 | — |',
    '| E10 | 结论强于证据 | "证明/必然"用于只是"提示/可能" | 0 | — |',
    '| E11 | 实现缺陷 | 除零、零方差、边界未处理 | 0 | — |',
    '| E12 | 格式/合规 | 目标期刊/赛事硬性要求不满足 | 0 | — |',
    '',
  ].join('\n'))
  console.log(`SCAFFOLD_OK: ${rb}`)
  return 0
}
/**
 * v3.3.2 / M6：交付件引用校验。
 * 复核红队写「某文件:某行 有某句」时，主控可以用它机械核对，防止把 A 文件的句子
 * 记到 B 文件的行号上（R1 实测：把 02-blue.md:127 的句子记成 交付件 v2:91）。
 */
function cmdCite([target, ...quote]) {
  if (!target) die('usage: cite <文件>:<行号> ["引文"]')
  const m = target.match(/^(.*):(\d+)$/)
  if (!m) die(`cite: 需要 <文件>:<行号> 形式，收到 ${target}`)
  const [, file, ln] = m
  if (!existsSync(file)) { console.error(`CITE_FAIL: 文件不存在 ${file}`); return 1 }
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  const idx = Number(ln) - 1
  if (idx < 0 || idx >= lines.length) {
    console.error(`CITE_FAIL: 行号越界 ${target}（该文件共 ${lines.length} 行）`)
    return 1
  }
  const text = lines[idx]
  const q = quote.join(' ').trim()
  // v6.25 缺陷28（R5 红队 N12 抓到）：不带引文时只打印该行内容并 exit 0 ——
  // 这不叫"校验通过"，叫"什么都没校验"。SKILL.md:325 要求引用必须指到文件+行号，
  // 而唯一能机械核引用的命令在缺引文时静默放行，与 bundle 的"只核范围不核内容"同源。
  if (!q) {
    console.log(`CITE_LINE_UNVERIFIED: ${target} = ${text.trim().slice(0, 140)}`)
    console.log('  → 未提供引文，本行内容未经校验；要核引用请追加引文参数')
    return 2
  }
  if (!text.includes(q)) {
    console.error(`CITE_FAIL: ${target} 不含引文「${q}」\n  该行实际: ${text.trim().slice(0, 160)}`)
    return 1
  }
  console.log(`CITE_OK: ${target} 含「${q}」`)
  return 0
}

// ------------------------------------------------------------------ selftest

// ══════════════════════════════════════════════════════════════════════════
// v6.0 闭环三件套：让「已修」不再可信、让「一轮」变成「收敛」、让「跨轮」可追踪
// ══════════════════════════════════════════════════════════════════════════

/**
 * reattack —— 跨轮次"再攻击"检测器。
 *
 * 为什么需要：R3-skill-audit 的 29 条全判「已修」、致命=0。但「已修」隐含
 * 「曾经坏过、现在补好了」的历史假设，是最危险的乐观信号。真正的检验是：
 * 下一轮红队**重新攻击**同一个位置，看它还站不站得住。
 *
 * 本命令对比两轮的判定表：
 *   - 上一轮「已修/当前文本已答」+ 本轮「仍未解决」⇒ 假修复（FALSE_FIX），最严重
 *   - 上一轮「已修」+ 本轮根本没有该用例 ⇒ 静默消失（DROPPED），次严重
 *   - 上一轮「挂账」+ 本轮「仍未解决」⇒ 预期内，不算假修复
 *
 * 用法：reattack <prevReview.md> <currReview.md>
 */
function cmdReattack([prevFile, currFile]) {
  if (!prevFile || !currFile) die('usage: reattack <prev 03-review.md> <curr 03-review.md>')
  // v6.29M（LongCat 工人 A 抓到）：缺文件时 readFileSync 抛 ENOENT 未捕获 → 打堆栈 + exit 1，
  // 应为用法错误 exit 2。
  if (!existsSync(prevFile)) die(`reattack: 上一轮文件不存在 ${resolve(prevFile)}`)
  if (!existsSync(currFile)) die(`reattack: 本轮文件不存在 ${resolve(currFile)}`)
  const prev = parseVerdict(prevFile)
  const curr = parseVerdict(currFile)
  if (prev.length === 0) {
    console.error('REATTACK_UNDECIDABLE: 上一轮判定表 0 行可识别，无法对比。')
    return 2
  }
  if (curr.length === 0) {
    console.error('REATTACK_UNDECIDABLE: 本轮判定表 0 行可识别，无法对比。')
    return 2
  }

  // 归一化 ID：N01/N1/R01/R1 都收敛到「字母+数字」
  // v6.10 缺陷13：编号体系会跨轮变化。R3-1101cf 用「观点1–12」，R4-1101c4 用
  // 「N01–N04 + R01–R05」。旧 norm 只认「字母+数字」，于是「观点3」原样保留、
  // 「N03」归一成 N03 —— 两轮重合率算出 0%，把同一篇论文的相邻两轮判成"不同对象"。
  const norm = (id) => {
    const s = String(id).trim()
    const cn = s.match(/(?:观点|论点|问题)\s*(\d{1,3})/)
    if (cn) return 'P' + String(Number(cn[1])).padStart(2, '0')
    const m = s.match(/([A-Za-z])[-\s]?(\d{1,3})/)
    return m ? (m[1].toUpperCase() + String(Number(m[2])).padStart(2, '0')) : s
  }
  const prevMap = new Map()
  for (const r of prev) prevMap.set(norm(r.id), r)
  const currMap = new Map()
  for (const r of curr) currMap.set(norm(r.id), r)

  // 「已修」的判定词（三态 + 旧六值都要认）
  const CLAIMED_FIXED = /^(已修|当前文本已答|已答|已消除|驳回)$/
  const isClaimed = (r) => CLAIMED_FIXED.test(String(r.raw).trim()) || r.level === '已消除'
  const STILL_OPEN = /^(仍未解决|未修|成立|部分已答|挂账)$/

  const falseFix = []
  const dropped = []
  const reopened = []

  for (const [id, p] of prevMap) {
    const claimed = isClaimed(p)
    if (!claimed) continue
    const c = currMap.get(id)
    if (!c) { dropped.push({ id, prevRaw: p.raw, prevLevel: p.level }); continue }
    if (STILL_OPEN.test(c.raw)) {
      falseFix.push({ id, prevRaw: p.raw, prevLevel: p.level, currRaw: c.raw, currLevel: c.level })
    }
  }
  // 上一轮挂账、本轮变成仍未解决 → 不算假修复，但值得记录
  for (const [id, p] of prevMap) {
    if (p.raw !== '挂账') continue
    const c = currMap.get(id)
    if (c && /^(仍未解决|未修)$/.test(c.raw)) reopened.push({ id })
  }

  // v6.9 缺陷12：跨课题对比不是「用例静默消失」，是**比错了对象**。
  // 实测：`reattack R3-skill-audit R4-1101c4` 报 DROPPED=29 —— 但这两轮审计的是
  // 完全不同的东西（一份技能文档 vs 一篇论文）。旧逻辑把它读成"上一轮声称修好的
  // 29 条全都不见了"，这是误报，会让 WARN 变成噪音、真问题被淹没。
  // 判据：共同编号数 / 上一轮编号数 < 20% ⇒ 两轮根本不是同一个审计对象。
  const common = [...prevMap.keys()].filter((k) => currMap.has(k)).length
  const overlap = prevMap.size > 0 ? common / prevMap.size : 0
  console.log(`上一轮=${prev.length} 行 本轮=${curr.length} 行 共同=${common}（重合率 ${(overlap * 100).toFixed(0)}%）`)
  // v6.29M（R11→R12 实测）：20% 的门槛**太松**。实测 `reattack R10-1108r1 R11-1109cb` 重合率
  // 恰好 23%，刚过 20% 的门槛，于是把**编号碰撞**读成了假修复：
  //   R10 的 N16 是「137/138 造数已改（已消除）」，R11 的 N16 是「P34b 引用错（仍未解决）」
  //   —— 两件完全不同的事，却被报成 FALSE_FIX；N22–N26 被报成 DROPPED，
  //   实际是 R11 重新编号了（这正是 R11 的流程错误，converge 已经抓过）。
  // 本机制规定「用例集只增不改」：正常推进的两轮，重合率应接近 100%。
  // 因此把门槛提到 **50%**：低于一半就说明换了编号体系或换了对象，必须先建编号映射表再判。
  if (overlap < 0.5) {
    console.error(`\nREATTACK_UNDECIDABLE: 两轮编号重合率仅 ${(overlap * 100).toFixed(0)}%（共同 ${common} / 上轮 ${prevMap.size}）。`)
    console.error('本机制规定「用例集只增不改」，正常推进的两轮重合率应接近 100%；低于 50% 说明下面两种之一：')
    console.error('  (a) 两轮审计的不是同一个对象 → 用 converge --track=<后缀> 分别看。')
    console.error('  (b) 同一个对象但换了编号体系（如「观点1–12」→「N01–R05」，或新建轮次时重新编号）')
    console.error('      → 必须先写一份编号映射表，把上轮编号对本轮编号登记清楚，再跑 reattack。')
    console.error('      **不许跳过映射直接判 PASS，也不许按编号碰撞判 FALSE_FIX/DROPPED。**')
    return 2
  }
  if (falseFix.length > 0) {
    console.log(`\n假修复 FALSE_FIX = ${falseFix.length}（上一轮声称修好，本轮重新攻击仍不成立）`)
    for (const x of falseFix) console.log(`  ${x.id}  上轮「${x.prevRaw}」(${x.prevLevel}) → 本轮「${x.currRaw}」(${x.currLevel})`)
  }
  if (dropped.length > 0) {
    console.log(`\n静默消失 DROPPED = ${dropped.length}（上一轮声称修好，本轮连用例都不见了）`)
    for (const x of dropped) console.log(`  ${x.id}  上轮「${x.prevRaw}」(${x.prevLevel})`)
  }
  if (reopened.length > 0) console.log(`\n挂账重开 REOPENED = ${reopened.length}（上轮挂账，本轮仍未解决）: ${reopened.map((x) => x.id).join(', ')}`)

  if (falseFix.length > 0) {
    console.log('\nREATTACK: FAIL (false_fix_detected)')
    return 1
  }
  if (dropped.length > 0) {
    console.log('\nREATTACK: WARN (cases_dropped)')
    return 1
  }
  // v6.3 缺陷8：如果两轮用例集合完全相同、且上一轮全部「已修」，这不是"修得好"，
  // 而是"没重新攻击"——真正的再攻击会改变用例集（旧问题消失 + 新问题出现）。
  // R3-skill-audit 的 29 条三轮完全一致、全部已修，而 R4 跨厂商零上下文红队
  // 一上来就抓到 4 条严重级 ⇒ 证明同源审同源会系统性放过问题。
  const sameSet = prevMap.size === currMap.size &&
    [...prevMap.keys()].every((k) => currMap.has(k))
  const allClaimed = [...prevMap.values()].every((p) => isClaimed(p))
  if (sameSet && allClaimed && prev.length >= 10) {
    console.log(`\nREATTACK: SUSPICIOUS (identical_case_set_all_claimed_fixed)`)
    console.log(`  ${prev.length} 条用例集两轮完全一致、全部声称已修。`)
    console.log('  真正的再攻击会改变用例集：旧问题消失、新问题出现。用例集一字不差 = 没重新攻击。')
    console.log('  修法：下一轮红队必须用不同模型/不同上下文重新造用例，不得沿用上一轮用例集。')
    return 1
  }

  console.log('\nREATTACK: PASS (all_claimed_fixes_survive_reattack)')
  return 0
}

/**
 * converge —— 多轮收敛判据。
 *
 * 为什么需要：现在的闸门只看「这一轮」，红了就进下一轮，但没说什么时候停。
 * 没有停止条件 = 要么无限循环烧 token，要么在第 3 轮凭感觉停。
 *
 * 收敛条件（全部满足才 PASS）：
 *   1. 连续 CONVERGE_N 轮 致命=0 且 严重=0
 *   2. 最后一轮 reattack 无假修复
 *   3. 用例数不萎缩（本轮 ≥ 上轮 × 0.9），防止靠删用例"收敛"
 *   4. 已消除/已答比例 ≥ 阈值
 *
 * 用法：converge <roundsRoot> [--n=2]
 */
function cmdConverge([roundsRoot, ...flags]) {
  if (!roundsRoot) die('usage: converge <roundsRoot> [--n=2]')
  const nFlag = flags.find((f) => f.startsWith('--n='))
  const need = nFlag ? Number(nFlag.slice(4)) : 2
  // v6.7 缺陷10：轮次目录名形如 `R1-103182` / `R2-skill-audit`，后缀才是**课题标识**。
  // 旧逻辑把所有 `R*` 按名字排序后算「连续干净轮数」——把两个完全不同的项目混成一条序列，
  // 算出来的"收敛"毫无意义。现在按后缀分组，各自算。
  const trackFlag = flags.find((x) => x.startsWith('--track='))
  const track = trackFlag ? trackFlag.slice(8) : null
  const allDirs = readdirSync(roundsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((d) => /^R\d/.test(d))
  const trackOf = (name) => {
    const mm = name.match(/^R\d(?:\.\d)?-(.*)$/)
    return mm ? mm[1] : '(no-suffix)'
  }
  const dirs = allDirs.filter((d) => (track ? trackOf(d) === track : true)).sort(natCmp)

  // 只取有 03-review.md 的轮次
  const rounds = []
  for (const d of dirs) {
    const p = join(roundsRoot, d, '03-review.md')
    if (!existsSync(p)) continue
    const rows = parseVerdict(p)
    if (rows.length === 0) { console.log(`NOTICE: ${d} 的 03-review.md 0 行可识别，跳过`); continue }
    const { t } = tally(rows)
    rounds.push({ name: d, file: p, rows, fatal: t['致命'], severe: t['严重'], minor: t['一般'], fixed: t['已消除'], total: rows.length,
      // v6.29i：状态桶会掩盖真实严重度。R5 的状态列全是「未修/挂账」，严重度只落在级别列，
      // 于是 severe（状态桶）=0，而 gate 对同一文件报「严重=1」—— 两个命令结论相反。
      // 这里额外记下「级别列里尚未闭合的致命/严重条数」，供干净轮数判据取大值。
      openSevere: rows.filter((r) => r.claimedLevel === '严重' && !(r.level === '已消除' || r.level === '不成立')).length,
      openFatal: rows.filter((r) => r.claimedLevel === '致命' && !(r.level === '已消除' || r.level === '不成立')).length })
  }
  if (rounds.length === 0) {
    console.error('CONVERGE_UNDECIDABLE: 没有任何一轮有可识别的 03-review.md')
    return 2
  }

  console.log('轮次         致命 严重 一般 已消除 合计')
  for (const r of rounds) {
    console.log(`${r.name.padEnd(13)} ${String(r.fatal).padStart(4)} ${String(r.severe).padStart(4)} ${String(r.minor).padStart(4)} ${String(r.fixed).padStart(6)} ${String(r.total).padStart(4)}`)
  }

  // 条件 1：连续 need 轮 致命=0 且 严重=0
  let streak = 0
  for (let i = rounds.length - 1; i >= 0; i--) {
    if (rounds[i].fatal === 0 && rounds[i].severe === 0 && rounds[i].openSevere === 0 && rounds[i].openFatal === 0) { streak++; continue }
    // v6.29o（实测致命 bug）：这一支原来只打印、**不中断循环**，于是"连续干净轮数"实际数成了
    // "历史上总共几个干净轮"。实测 R8 明明被判"不计入干净轮数"，streak 仍是 3（R2/R3/R6 三个互不相邻的轮次）
    // → converge 在最新一轮有未闭合严重项时照样 PASS。指标名实不符，比指标缺失更危险。
    if (rounds[i].openSevere || rounds[i].openFatal) {
      console.log(`  ${rounds[i].name}: 状态桶干净但级别列有未闭合项（严重=${rounds[i].openSevere} 致命=${rounds[i].openFatal}）→ 连续干净轮数在此中断`)
    } else {
      console.log(`  ${rounds[i].name}: 本轮不干净（致命=${rounds[i].fatal} 严重=${rounds[i].severe}）→ 连续干净轮数在此中断`)
    }
    // v6.29p：这里只 break，**不能**把 streak 清零 ——
    // 从末尾往前数到第一个不干净轮就该停，途中已数到的干净轮是"末尾连续干净轮数"的真值。
    // 实测：R9 干净、R8 不干净 ⇒ 真值应为 1；清零会报成 0，结论虽是 NOT_YET 但理由是错的。
    break
  }
  console.log(`\n连续干净轮数 = ${streak}（要求 ≥ ${need}）`)

  // 条件 2b（v6.28 缺陷31，R5 红队第二实例抓到，最严重的一条）：
  // `converge` 自己实现了一遍收敛判据，**从不调用 `cmdReattack`**，于是同一批数据
  // `reattack` 判 FAIL（假修复）而 `converge` 判 PASS（已收敛）。
  // 实测 _probe/rounds/R2-convA vs R2-convB：reattack → REATTACK: FAIL (false_fix_detected) exit 1，
  // converge --n=2 → CONVERGE: PASS (converged) exit 0。**两个命令对同一批数据结论相反。**
  // 收敛的定义里必须包含「上一轮声称修好的，这一轮没被重新打开」，否则"收敛"只是"数字变小"。
  let falseFix = null
  for (let i = 1; i < rounds.length; i++) {
    const prev = rounds[i - 1].rows
    const curr = rounds[i].rows
    const pm = new Map(prev.map((r) => [String(r.id).trim(), r]))
    // v6.29M（R12 实测）：先算编号重合率。两轮若换了编号体系（重合率 < 50%），
    // 相同编号只是**碰撞**，不是"同一条用例被重新打开"。
    // 实测 R10 的 N16 是「137/138 造数已改（已消除）」，R11 的 N16 是「P34b 引用错（仍未解决）」——
    // 两件完全不同的事，却被这里判成假修复，导致 converge 永远 NOT_YET、而且理由是错的。
    // 与 `cmdReattack` 的阈值保持一致（50%），否则两个命令对同一批数据又会对不上。
    const commonIds = curr.filter((c) => pm.has(String(c.id).trim())).length
    const ov = prev.length ? commonIds / prev.length : 0
    if (ov < 0.5) {
      console.log(`  NOTICE: ${rounds[i - 1].name}→${rounds[i].name} 编号重合率 ${(ov * 100).toFixed(0)}% < 50%，跳过假修复比对（两轮编号体系不同，同编号是碰撞不是重开）`)
      continue
    }
    for (const c of curr) {
      const pv = pm.get(String(c.id).trim())
      if (!pv) continue
      const wasFixed = /^(已修|当前文本已答|已答|已消除)$/.test(String(pv.raw).trim())
      const stillOpen = /^(仍未解决|未修|成立|部分已答|挂账)$/.test(String(c.raw).trim())
      if (wasFixed && stillOpen) {
        falseFix = `${rounds[i - 1].name}(${c.id} 声称已修) → ${rounds[i].name}(仍未解决)`
        break
      }
    }
    if (falseFix) break
  }
  if (falseFix) console.log(`假修复 SUSPICIOUS: ${falseFix}（上一轮说修好了，这一轮又开了）`)

  // 条件 3：本轮不许丢上一轮的未闭合项（v6.29h 重写）。
  // 旧判据是「条数 ≥ 上轮 × 0.9」，它把「合法地只复核新发现」误报成"靠删用例收敛"（R5 实测）。
  // 真正要防的不是条数变少，而是**上一轮还没闭合的项在本轮静默消失** ——
  // 已闭合的用例本来就不必再列，条数下降完全可能是正常的。
  // 实测收益：这条判据一上线就抓出 R1→R2→R3 每一轮都在丢上一轮的未闭合项（见 CHANGES M13）。
  let shrink = null
  const recoveredNotes = []
  for (let i = 1; i < rounds.length; i++) {
    const prev = rounds[i - 1]
    const curr = rounds[i]
    const currIds = new Set(curr.rows.map((r) => r.id))
    const prevOpen = prev.rows.filter((r) => !(r.level === '已消除' || r.level === '不成立'))
    const lost = prevOpen.filter((r) => !currIds.has(r.id))
    if (!lost.length) continue
    // v6.29n：区分「丢了就再也不管」与「后来补回来了」。
    // 实测：R3 未闭合的 N3 在 R5 消失，但 R6 又把它作为必带旧账捡回来并修掉。
    // 若一律判死，一条历史坏轮会让整条链永远无法收敛 —— 那等于惩罚已经改好的项目。
    // 判据：后续任何一轮重新带上了该编号 ⇒ 已补偿，记 RECOVERED 提示，不阻拦。
    const laterIds = new Set()
    for (let j = i + 1; j < rounds.length; j++) for (const r of rounds[j].rows) laterIds.add(r.id)
    // v6.29M（R13 实测）：携带旧账时编号会带轮次前缀（R10-N19），原先只认裸编号，
    // 于是 R12 明明把 R10 的 N19/N20/N27 带回来并处置了，converge 仍判「用例萎缩」——假阳性。
    // 只认「该轮编号」与「该轮前缀+该编号」两种形式，**不做全局后缀归一**：
    // 因为不同轮的同后缀可能是不同的事（R10 的 N17 是「2026 快照无冻结限定」，
    // R11 的 N17 是「P34b 引用错」），归一化会把它们混成一条。
    const prevNum = (rounds[i - 1].name.match(/^R(\d+)/) || [])[1]
    const isRecovered = (id) => laterIds.has(id) || Boolean(prevNum && laterIds.has(`R${prevNum}-${id}`))
    const recovered = lost.filter((r) => isRecovered(r.id))
    const trulyLost = lost.filter((r) => !isRecovered(r.id))
    if (recovered.length) {
      recoveredNotes.push(`${prev.name}→${curr.name} 丢了 ${recovered.map((r) => r.id).join(',')}，已在后续轮次补回`)
    }
    if (trulyLost.length) {
      shrink = `${prev.name} 未闭合的 ${trulyLost.map((r) => `${r.id}(${r.level})`).join(',')} 在 ${curr.name} 里消失且从未补回`
      break
    }
  }
  if (recoveredNotes.length) console.log(`旧账补回 RECOVERED: ${recoveredNotes.join('；')}（不按"靠遗忘收敛"处理）`)
  if (shrink) console.log(`丢未闭合项 SUSPICIOUS: ${shrink}（换了新用例却不携带旧账 = 靠遗忘"收敛"）`)

  // 条件 4（v6.8 缺陷11）：**用例集必须真的变过**。
  // 实测 skill-audit 线 R1/R2/R3 的 29 条编号一字不差（C01–C29 全同）、全部「已修」，
  // streak=3、无萎缩 → 旧逻辑直接 PASS。但真相是三轮之间没有任何独立红队重新攻击过这 29 条。
  // 用例集一字不差 = 红队没换人/没换模型/没换视角 = 收敛证据为零。
  let staticSet = null
  // v6.29M（R13 实测）：这条判据原来用「编号是否相同」当「有没有换红队」的代理指标，
  // 但两者不是一回事：
  //   ① SKILL 硬规则 5 要求「R2 起只复核不重造、用例只增不改」——**按 SKILL 做的轮次，
  //      用例集本来就该几乎一字不差**，于是每对合规轮次都会被这条判死；
  //   ② 真正要防的是「同一批攻击者连审三轮」（v6.8 缺陷11 的场景），那要看 red-attack.json。
  // 改为：编号相同 **且** 前后两轮记录的攻击者相同（或都没有记录）才算零证据；
  // 换了攻击者（换厂商/换模型）的复核是有效证据。
  const attackerOf = (roundName) => {
    try {
      const p = join(roundsRoot, roundName, 'red-attack.json')
      if (!existsSync(p)) return null
      const j = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
      const arr = Array.isArray(j) ? j : (j.attackers || [])
      const set = [...new Set(arr.map((a) => `${a.provider}/${a.model}`))]
      return set.length ? set.sort().join(',') : null
    } catch { return null }
  }
  // v6.29M（R14）：机制外的独立评审也算"换过红队"的证据。
  // 只认**针对当前交付件指纹**的记录 —— 对旧版本的外部意见不能算在新版本的账上。
  const externalOf = (roundName) => {
    try {
      const p = join(roundsRoot, roundName, 'red-attack.json')
      if (!existsSync(p)) return null
      const j = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
      if (Array.isArray(j)) return null
      const sha = String(j.artifactSha256_16 || '').toUpperCase()
      const fresh = (j.external || []).filter((e) => !e.artifactSha256_16 || String(e.artifactSha256_16).toUpperCase() === sha)
      return fresh.length ? fresh.map((e) => e.source) : null
    } catch { return null }
  }
  const latestName = rounds.length ? rounds[rounds.length - 1].name : null
  const latestExt = latestName ? externalOf(latestName) : null
  if (latestExt && latestExt.length) {
    // v6.29M（R14 实测）：必须先看**最新一轮**有没有机制外评审，再进循环。
    // 踩过的坑：`staticSet` 只报第一个「编号相同的相邻对」，而 R12→R13 往往先撞上
    // （同套 21 条一字不差），循环在那里就 break 了 —— R14 登记的 5 份外部评审**永远轮不到被看**，
    // converge 照样判「用例集冻结」。收敛关心的是"最近有没有重新攻击"，不是"历史上哪一对先冻结"。
    console.log(`  NOTICE: 最新一轮 ${latestName} 有 ${latestExt.length} 份**机制外**独立评审（${latestExt.join(' | ')}）→ 不判「用例集冻结」`)
  } else {
    for (let i = 1; i < rounds.length; i++) {
      const a = new Set(rounds[i - 1].rows.map((r) => String(r.id).trim()))
      const b = new Set(rounds[i].rows.map((r) => String(r.id).trim()))
      const same = a.size === b.size && [...a].every((k) => b.has(k))
      if (same && a.size >= 10) {
        const pa = attackerOf(rounds[i - 1].name)
        const ca = attackerOf(rounds[i].name)
        if (pa && ca && pa !== ca) {
          console.log(`  NOTICE: ${rounds[i - 1].name}→${rounds[i].name} 用例编号相同但攻击者不同（${pa} → ${ca}）→ 算有效再攻击，不判冻结`)
          continue
        }
        const who = ca || pa || '(无记录)'
        staticSet = `${rounds[i - 1].name} → ${rounds[i].name}（${a.size} 条编号一字不差；攻击者 ${who} 相同或未换，且无机制外独立评审）`
        break
      }
    }
    if (staticSet) console.log(`用例集冻结 SUSPICIOUS: ${staticSet}（没换红队/没换模型，等于没重新攻击）`)
  }

  // v6.29f：收敛必须带「覆盖率证据」。
  // 技能第 647 条早有规则（收敛必须由换过红队/换过模型的轮次证明，同一红队连审三轮 = 零证据），
  // 但一直只是散文 —— 本轮主控就违反了它：R3 宣布收敛时，没有任何一轮用新模型重打过整篇稿子，
  // 结果换一个零上下文模型（minekuai，从未用过）一上来又找出 5 条新缺陷。
  // 把规则做成机器：扫轮次目录里的 *.score.json（canary score 自动落盘），把召回基线与轮次一起打出来。
  let recallLine = null
  try {
    const scores = []
    // 扫**全部**子目录，不只"有效轮次" —— 标定轮（canary）通常没有 03-review.md，
    // 若只在有效轮次里找，召回证据会永远找不到（本轮实测就是这个原因）。
    for (const name of readdirSync(roundsRoot)) {
      const dir = join(roundsRoot, name)
      if (!existsSync(dir)) continue
      let files = []
      try { files = readdirSync(dir) } catch { continue }
      for (const f of files) {
        if (!f.endsWith('.score.json')) continue
        try {
          const j = JSON.parse(readFileSync(join(dir, f), 'utf8'))
          scores.push({ round: name, file: f, recall: j.recall, at: j.scoredAt })
        } catch { /* 单个坏文件不影响整体 */ }
      }
    }
    if (scores.length) {
      scores.sort((a, b) => String(a.at).localeCompare(String(b.at)))
      const last = scores[scores.length - 1]
      recallLine = `召回基线 RECALL_BASELINE: ${(Number(last.recall) * 100).toFixed(1)}%  （${last.round}/${last.file}，共 ${scores.length} 次标定）`
    }
  } catch { /* 只报不拦：任何异常都不得影响收敛结论 */ }
  if (recallLine) console.log(recallLine)
  else console.error('CONVERGE_NO_RECALL_BASELINE: 没有任何 canary 标定记录 —— 本轮的"收敛"只证明这批红队不再报新问题，**不证明覆盖率**。'
    + ' 先跑一次 canary：换一个本项目没用过的模型，打**未修复**的交付件，看它能重现多少历史已确认缺陷。')

  // v6.29K（A2-c）：**没有独立复核，就不许宣称"收敛"**。
  // 起因：`gate` 对"没绑指纹的攻击证据"只报 NOTICE（不拦），于是 v13 是靠这条不拦通过的；
  // 而 `converge` 的语义是"这批红队不再报新问题" —— 如果没有记录证明真有人审过这一版，
  // 那句"不再报新问题"就是空的。不改 gate（会回溯判死历史轮次），改在这里加一条硬条件。
  let attackUndeclared = false
  {
    const latestDir = dirs.length ? join(roundsRoot, dirs[dirs.length - 1]) : null
    const hasAttack = latestDir ? existsSync(join(latestDir, 'red-attack.json')) : false
    // 只在**有交付件可绑**时要求：没有候选稿文件的合成 fixture 无从"指纹绑定"，不适用此条。
    let hasCand = false
    try { hasCand = latestDir ? readdirSync(latestDir).some((f) => /^\d+-candidate.*\.md$/i.test(f)) : false } catch { hasCand = false }
    if (latestDir && !hasAttack && hasCand) {
      let sum = ''
      try { sum = readFileSync(join(latestDir, '04-summary.md'), 'utf8') } catch { sum = '' }
      // 允许"如实声明未复核"通过 —— 要求的是承认，不是掩盖
      const declared = /(未.{0,6}独立复核|没有.{0,6}独立复核|未.{0,4}红队.{0,4}审|NOTICE_ATTACK_MISSING|无\s*red-attack\.json|未被.{0,6}复核)/.test(sum)
      if (!declared) attackUndeclared = true
      console.error(declared
        ? 'CONVERGE_ATTACK_DECLARED: 本轮无 red-attack.json，但 04-summary 已**书面声明**未独立复核 —— 允许继续，但"收敛"的含义到此为止。'
        : 'CONVERGE_ATTACK_UNDECLARED: 本轮无 red-attack.json，且 04-summary **没有书面声明**未独立复核。'
          + ' 没有证据证明这一版被审过，"不再报新问题"就是空的。请在 04-summary 里如实写一句，或先跑 attack record。')
    }
  }

  const pass = streak >= need && !shrink && !staticSet && !falseFix && !attackUndeclared
  if (pass) { console.log('\nCONVERGE: PASS (converged)'); return 0 }
  const why = []
  if (streak < need) why.push(`连续干净轮数 ${streak} < ${need}`)
  if (shrink) why.push('用例萎缩')
  if (staticSet) why.push('用例集冻结（没重新攻击）')
  if (falseFix) why.push('上一轮声称已修的被重新打开（假修复）')
  if (attackUndeclared) why.push('最新一轮无独立复核证据且未书面声明')
  console.log(`\nCONVERGE: NOT_YET (${why.join('; ')})`)
  return 1
}

/**
 * severity —— 严重度校准检查。
 *
 * 为什么需要：红队会系统性高报（把「一般」写成「严重」以显得有价值），
 * 蓝队会系统性低报。判据是「同样的错误，两轮之间级别是否稳定」。
 *
 * 检查项：
 *   1. 同一用例在两轮之间级别跳变 ≥ 2 级 ⇒ 级别不稳定
 *   2. 全部用例都是「严重」⇒ 无区分度（等于没有分级）
 *   3. 全部用例都是「一般/优化」⇒ 可能漏报
 *
 * 用法：severity <03-review.md> [prevReview.md]
 */
function cmdSeverity([file, prevFile]) {
  if (!file) die('usage: severity <03-review.md> [prev 03-review.md]')
  // v6.29M（LongCat 工人 A 抓到）：原来直接 parseVerdict → readFileSync 抛 ENOENT 未被捕获，
  // 打完整堆栈并以 exit 1 退出；而本工具约定「2 = 用法错误」。缺文件是用法错误，不是程序崩溃。
  if (!existsSync(file)) die(`severity: 文件不存在 ${resolve(file)}`)
  const rows = parseVerdict(file)
  if (rows.length === 0) { console.error('SEVERITY_UNDECIDABLE: 0 行可识别'); return 2 }
  const { t } = tally(rows)
  const ORDER = { '优化': 0, '一般': 1, '严重': 2, '致命': 3 }
  // v6.27 缺陷30（R5 红队 N06 抓到）：`已消除` 不在 ORDER 里 → 全部「已修」的行被滤掉，
  // dist 成空对象 → `Object.keys(dist).length === 1` 不成立 → 直接落 SEVERITY: OK。
  // 实测 severity R3-skill-audit → `级别分布:   合计=0` + SEVERITY: OK exit 0，
  // 而 R3 正是后来被证明是假收敛的那一轮（SKILL.md:370 自述）。**校准命令对假收敛报绿。**
  // 修法：级别取 claimedLevel（级别列原文），状态桶只决定「是否已结案」。
  const sevRows = rows
    .map((r) => ({ ...r, lv: r.claimedLevel || (r.level && r.level in ORDER ? r.level : null) }))
    .filter((r) => r.lv && r.lv in ORDER)
  const dist = {}
  for (const r of sevRows) dist[r.lv] = (dist[r.lv] ?? 0) + 1
  console.log(`级别分布: ${Object.entries(dist).map(([k, v]) => `${k}=${v}`).join(' ')}  合计=${sevRows.length}`)

  let warn = 0
  // v6.16 缺陷19（R5 红队 e7b 抓到）：单一级别 = 分级失效，**不论那一个级别是什么**。
  // 旧逻辑只对「全部严重/全部致命」报警，于是 29 条全「一般」直接放行。
  // 但 29 条全部落在同一个桶里，无论桶是哪一级，都说明红队没有真的在分级。
  if (sevRows.length >= 4 && Object.keys(dist).length === 1) {
    const only = Object.keys(dist)[0]
    console.log(`SEVERITY_NO_GRADATION: ${sevRows.length} 条全部是「${only}」——单一级别 = 分级失效`)
    if (only === '严重' || only === '致命') console.log('  → 红队可能在系统性强报')
    else if (only === '一般') console.log(`  → 红队把 ${sevRows.length} 个真问题全压在「一般」，等于没有分级；闸门会因此全部放行`)
    else console.log('  → 红队没找到实质问题，或把实质问题全降级了')
    warn = 1
  }
  if (sevRows.length >= 4 && !dist['严重'] && !dist['致命'] && !dist['一般']) {
    console.log('SEVERITY_NO_GRADATION: 全部是「优化」——可能漏报，红队没找到实质问题')
    warn = 1
  }

  // v6.17 缺陷20：**全部「成立」却 0 条严重/致命 ⇒ 分级可疑**。
  // 红队 e7b 的构造：29 条全部判定「成立」（= 红队认为全部是真问题），
  // 级别全部「一般」→ gate 放行。但 29 个"确认存在的问题"里连一个严重都没有，
  // 这在真实审计里极罕见；要么级别被系统性压低，要么 gate 的放行标准被绕开。
  const upheld = rows.filter((r) => /^(成立|仍未解决|部分成立)$/.test(String(r.raw).trim()))
  if (upheld.length >= 10 && !dist['严重'] && !dist['致命']) {
    console.log(`SEVERITY_SUSPICIOUS: ${upheld.length} 条判定「成立/仍未解决」却 0 条严重/致命 —— 分级被系统性压低，闸门会因此放行`)
    warn = 1
  }

  if (prevFile && existsSync(prevFile)) {
    const prev = parseVerdict(prevFile)
    const norm = (id) => { const m = String(id).match(/([A-Za-z])[-\s]?(\d{1,3})/); return m ? m[1].toUpperCase() + String(Number(m[2])).padStart(2, '0') : String(id) }
    const pm = new Map(prev.map((r) => [norm(r.id), r]))
    // v6.29M（LongCat 工人 A 抓到，监工复核确认）：原来比较 r.level / p.level —— 那是**状态桶**
    // （已消除 / 挂账 / 不成立），不在 ORDER 里，于是 `continue` 把整行跳过。
    // 实测：状态写「已修 / 仍未解决」时，级别列 致命→一般 的 2 级跳变被报成「级别跨轮稳定」；
    // 状态写「成立」（不在 STATUS_MAP 里）时反而能报出来 —— **判据对少见写法有效，对常见写法失效**。
    // 真数据更糟：R10 的 13 行状态是 挂账=5 / 已消除=6 / 未修=2，**全部不在 ORDER 里 → 比较了 0 行**，
    // 也就是这个检查在真数据上从来没有执行过，「级别跨轮稳定」一直是空判。
    // 与 v6.27 缺陷30 是同一处遗漏：级别分布行改用了 claimedLevel，跳变检查没跟着改。
    const lvOf = (r) => {
      const lv = r.claimedLevel || (r.level && r.level in ORDER ? r.level : null)
      return lv && lv in ORDER ? lv : null
    }
    let jumps = 0
    let compared = 0
    for (const r of rows) {
      const p = pm.get(norm(r.id))
      if (!p) continue
      const rl = lvOf(r)
      const pl = lvOf(p)
      if (!rl || !pl) continue
      compared++
      const d = Math.abs(ORDER[rl] - ORDER[pl])
      if (d >= 2) { console.log(`  JUMP: ${r.id} ${pl}(${ORDER[pl]}) → ${rl}(${ORDER[rl]})`); jumps++ }
    }
    if (compared === 0) {
      // 「比较了 0 行」不许静默通过 —— 空判必须说出来（这正是上面那个缺陷能藏这么久的原因）
      console.error(`SEVERITY_NO_COMPARABLE: 跨轮 0 条可比较（本轮 ${rows.length} 行 / 上轮 ${prev.length} 行）`
        + ' —— 「级别跨轮稳定」这句话没有依据，不得当成通过。')
      warn = 1
    } else {
      console.log(`  跨轮可比 ${compared} 条`)
      if (jumps > 0) { console.log(`SEVERITY_UNSTABLE: ${jumps} 条级别跳变 ≥2 级`); warn = 1 }
      else console.log('级别跨轮稳定（无 ≥2 级跳变）')
    }
  }
  console.log(warn ? '\nSEVERITY: WARN' : '\nSEVERITY: OK')
  return warn
}

/**
 * bundle —— 交付件集合完整性检查（v6.5）。
 *
 * 为什么需要：R3 审计技能文档时，`03-review.md` 的行号引用横跨 5 个文件
 * （`SKILL.md` / `protocol.md` / `red-brief.md` / `templates.md` / `blue-brief.md`）。
 * R5 开工时目录里**只剩 `SKILL.md`**，另外 4 个文件已经不存在，于是那 29 条
 * 「已修」里的行号全部悬空 —— 而**没有任何检查会报这件事**。
 *
 * 这是"多文件结构静默退化"：文档没坏，是它依赖的东西没了。
 *
 * 本命令从 03-review.md 的「问题位置」列提取所有 `文件名:行号` 引用，
 * 逐个核实文件是否存在、行号是否在范围内。
 *
 * 用法：bundle <03-review.md> [--root=<被审计文件所在目录>]
 */
function cmdBundle([reviewFile, ...flags]) {
  if (!reviewFile) die('usage: bundle <03-review.md> [--root=<dir>]')
  const rootFlag = flags.find((f) => f.startsWith('--root='))
  const root = rootFlag ? rootFlag.slice(7) : null
  const text = readFileSync(reviewFile, 'utf8')

  // 提取形如 `name.md:12` 或 `name.md:12-15` 的引用
  const refRe = /([\w.\-]+\.(?:md|mjs|js|py|json|txt|yml|yaml|csv|h5|parquet|pdf|docx|xlsx|rs|go|c|java|cpp|h))\s*:\s*(\d+)(?:\s*[-–]\s*(\d+))?/gi
  const refs = new Map()
  let m
  while ((m = refRe.exec(text)) !== null) {
    const file = m[1]
    const lo = Number(m[2])
    const hi = m[3] ? Number(m[3]) : lo
    if (!refs.has(file)) refs.set(file, [])
    // 记下引用所在行的原文 —— 用来判断这条引用有没有附引文（v6.26 缺陷29 的修复要用）
    const ls = text.lastIndexOf('\n', m.index) + 1
    const le = text.indexOf('\n', m.index)
    refs.get(file).push({ lo, hi, lineText: text.slice(ls, le === -1 ? text.length : le) })
  }
  if (refs.size === 0) {
    console.error('BUNDLE_UNDECIDABLE: 该复核文件里没有任何「文件名:行号」引用')
    return 2
  }

  // 候选搜索根：--root、复核文件所在目录、当前目录、<DSH_HOME>/skills（自动探测）
  // v6.12 缺陷15：搜索根必须覆盖被审计对象所在的整棵树。
  // 实测 R4 引用的 `E1.py` 真名 `E1_瞬时vs6minRMS.py` 在
  // `大创\论文\...\16_课题_标准符合性评估方法学\实验_2026-10-07_标准符合性\` 下，
  // 而 searchRoots 只含 round 目录和 skills 目录 → 模糊匹配也搜不到，仍报 MISSING。
  const searchRoots = [
    root,
    dirname(reviewFile),
    process.cwd(),
  (detectDshHome() ? join(detectDshHome(), 'skills') : null),
  ].filter(Boolean)

  // v6.29R（2026-11-11 端到端验证）：向上查找 3 层，覆盖项目根下的
  // supplementary/ 等子目录。
  // 起因：把本机搜索根抽象掉之后，bundle 找不到 `09_投稿包/supplementary/` 下的
  // S8_cohort_test.csv 与 S10 —— 而这两个是 R14 判定表引用最多的文件。
  // 本机路径不该有，但「向上查找」必须有。
  {
    let _up = dirname(reviewFile)
    for (let _i = 0; _i < 3; _i++) {
      _up = dirname(_up)
      searchRoots.push(_up)
    }
  }

  // v6.11 缺陷14：文件名可能被简写。实测 R4 的 `v4:142` 引用 `E1.py:10`，
  // 但磁盘上真名是 `E1_瞬时vs6minRMS.py` —— 只写 `E1.py` 就找不到，行号引用悬空。
  // 现在先精确匹配；找不到就按「主干名包含」做一次模糊匹配，命中多个则报歧义。
  const fuzzyFind = (name) => {
    const stem = name.replace(/\.(md|mjs|js|py|json|txt|yml|yaml)$/i, '')
    if (stem.length < 3) return []
    const hits = []
    const walk = (dir, depth) => {
      if (depth < 0 || !existsSync(dir)) return
      let entries
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (e.isFile() && e.name.toLowerCase().includes(stem.toLowerCase())) hits.push(join(dir, e.name))
        else if (e.isDirectory() && !e.name.startsWith('node_modules') && !e.name.startsWith('.git')) walk(join(dir, e.name), depth - 1)
      }
    }
    // v6.13: depth 3 is not enough (experiment dir is at level 5), and short stems
    // like 'E1' hit unrelated files. Use depth 6 and require name to START WITH stem.
    const strictHits = []
    const walkStrict = (dir, depth) => {
      if (depth < 0 || !existsSync(dir)) return
      let entries
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const nm = e.name.toLowerCase()
        if (e.isFile() && nm.startsWith(stem.toLowerCase())) strictHits.push(join(dir, e.name))
        else if (e.isDirectory() && !nm.startsWith('node_modules') && !nm.startsWith('.git')) walkStrict(join(dir, e.name), depth - 1)
      }
    }
    for (const r of searchRoots) walkStrict(r, 6)
    if (process.env.RB_DEBUG) console.error('[fuzzy] stem=' + stem + ' roots=' + searchRoots.length + ' hits=' + strictHits.length)
    return strictHits
  }
  const findFile = (name) => {
    for (const r of searchRoots) {
      const direct = join(r, name)
      if (existsSync(direct)) return direct
    }
    // 递归浅搜
    for (const r of searchRoots) {
      const found = shallowFind(r, name, 3)
      if (found) return found
    }
    if (process.env.RB_DEBUG) console.error('[findFile] shallowFind missed for ' + name)
    // v6.11 缺陷14：精确匹配失败 → 试模糊（简写名）。实测 `E1.py:10` 的真名是
    // `E1_瞬时vs6minRMS.py`，只写 `E1.py` 就找不到，行号引用悬空。
    const hits = fuzzyFind(name)
    if (hits.length === 1) return hits[0]
    if (hits.length > 1) return { ambiguous: hits }
    return null
  }
  const shallowFind = (dir, name, depth) => {
    if (depth < 0 || !existsSync(dir)) return null
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return null }
    for (const e of entries) {
      if (e.isFile() && e.name === name) return join(dir, e.name)
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('node_modules')) {
        const got = shallowFind(join(dir, e.name), name, depth - 1)
        if (got) return got
      }
    }
    return null
  }
  const lineCount = (p) => {
    try { return readFileSync(p, 'utf8').split(/\r?\n/).length } catch { return 0 }
  }

  let missing = 0
  let outOfRange = 0
  console.log(`引用的文件数 = ${refs.size}`)
  for (const [file, ranges] of refs) {
    const p = findFile(file)
    const maxHi = Math.max(...ranges.map((r) => r.hi))
    // v6.29M（R14 实测）：`findFile` 在模糊匹配命中多个时会返回 `{ ambiguous: [...] }` ——
    // 一个**对象**。旧代码只判 `!p`，对象是 truthy，于是继续往下走，
    // `lineCount(p)` 里 readFileSync(对象) 抛异常 → catch 返回 **0 行**，
    // 最终报出「引用到第 6 行，但文件只有 0 行 ([object Object])」这种误导性结论。
    // 实测触发场景很平常：作者在主控改完数据后建了 `S10_....txt.bak` 备份，
    // 模糊匹配同时命中 .bak 与真文件 → ambiguous。**工具对"工作区里有同名副本"毫无抵抗力。**
    if (p && typeof p === 'object' && Array.isArray(p.ambiguous)) {
      missing++
      console.log(`  AMBIGUOUS  ${file}  模糊匹配命中 ${p.ambiguous.length} 个同名候选，无法确定引用对象：`)
      for (const a of p.ambiguous) console.log(`               ${a}`)
      console.log(`               修法：把副本移出工作区，或在引用里写更长的唯一路径`)
      continue
    }
    if (!p) {
      missing++
      console.log(`  MISSING  ${file}  （被引用 ${ranges.length} 次，最高行号 ${maxHi}）`)
      continue
    }
    const n = lineCount(p)
    if (maxHi > n) {
      outOfRange++
      console.log(`  OUT_OF_RANGE  ${file}  引用到第 ${maxHi} 行，但文件只有 ${n} 行  (${p})`)
    } else {
      // v6.29M：原来只说 OK，不说解析到哪个文件 —— 实测 `06-candidate-v5.md` 被模糊查找到
      // **R9** 的副本（R10 目录里根本没有 v5），输出仍是「OK」，跨轮静默替换不可见。
      const sameDir = resolve(dirname(p)) === resolve(dirname(reviewFile))
      console.log(`  OK  ${file}  引用 ${ranges.length} 处，最高 ${maxHi} / ${n} 行`
        + (sameDir ? '' : `\n         ⚠ 解析到本目录之外：${p}`))
      // v6.29M（2026-11-10）：**自动附引文** —— 不再依赖人手工 `cite --quote`。
      // 起因：跨厂商审计指出「本项目 14 轮 cite 零次使用」，于是 S10 引用连续三轮指向错行
      // （说 Jan-1、实为 Jul-1）都没有任何命令发现。bundle 只核「行号在范围内」，
      // 不核「那一行是什么」。现在把每处引用指向的真实原文直接打出来：
      // 人（或 agent）扫一眼就能看出对不对，不需要额外跑一条命令。
      try {
        const srcLines = readFileSync(p, "utf8").split(/\r?\n/)
        const uniq = [...new Map(ranges.map((r) => [r.lo + "-" + r.hi, r])).values()]
        for (const r of uniq.slice(0, 8)) {
          const txt = srcLines.slice(r.lo - 1, r.hi).join(" ⏎ ").trim()
          const tag = r.hi > r.lo ? "L" + r.lo + "-" + r.hi : "L" + r.lo
          console.log("       " + tag.padEnd(9) + " " + (txt ? txt.slice(0, 150) : "(该行为空)"))
        }
        if (uniq.length > 8) console.log("       … 另 " + (uniq.length - 8) + " 处")
      } catch { console.log("       （读取原文失败，跳过附引文）") }
    }
  }

  if (missing > 0) {
    console.log(`\nBUNDLE: FAIL (${missing} 个被引用的文件不存在 —— 行号引用全部悬空)`)
    return 1
  }
  if (outOfRange > 0) {
    console.log(`\nBUNDLE: WARN (${outOfRange} 个文件的行号越界)`)
    return 1
  }
  // v6.26 缺陷29（R5 红队 N02 抓到）：**只核"文件在 + 行号在范围内"，从不核该行内容**。
  // 实测：造 5 行 protocol.md、第 5 行写「第5行」，复核件声称该行写着「照常交付产物，不交作者裁定」
  // → 旧 bundle 输出 BUNDLE: OK exit 0；同一条引用换 cite 带引文则 CITE_FAIL exit 1。
  // 也就是说 bundle 对内容真假零分辨力，29 条「已修」的证据面在结构上不可证伪。
  // 修法：要求每条引用**附带引文**（同一行的 `"…"` 或「…」），无引文则该引用记为 UNVERIFIED。
  // v6.29M（本轮实测）：**上面这句「修法」写了，代码却没写** —— 紧接着就是 `BUNDLE: OK`。
  // 也就是说 bundle 至今仍对内容真假零分辨力，注释在撒谎。现在补上（只报不拦，同 GATE_LOCATION_UNRESOLVABLE）。
  const unverified = []
  for (const [file, ranges] of refs) {
    for (const r of ranges) {
      if (!/["“「『][^"”」』]+["”」』]/.test(r.lineText || '')) {
        unverified.push(`${file}:${r.lo}`)
      }
    }
  }
  if (unverified.length) {
    console.error('BUNDLE_UNVERIFIED: **上面每条 OK 之下已打印该行原文** —— 请核对它是否真的支持判定表里那句话。')
    console.error('  核不上的引用，对应的判定不成立（这是「行号对、内容错」唯一能被发现的地方）。')
    console.error('  以下引用**未附引文**（判定表里没写该行原话），它们的内容只有靠上面打印的原文人工比对：')
    for (const u of unverified.slice(0, 20)) console.error(`  ${u}`)
    if (unverified.length > 20) console.error(`  … 另 ${unverified.length - 20} 处`)
  }
  console.log(`\nBUNDLE: OK (所有引用可落地${unverified.length ? `；${unverified.length} 处未附引文、内容未核` : '，且均附引文'})`)
  return 0
}
// -------------------------------------------------------------------- merge
/**
 * merge —— 把 N 份红队意见文件合成一张用例表。
 */
const MERGE_SIM_THRESHOLD = 0.35
const MERGE_LEVELS = ["致命", "严重", "一般", "优化"]
const MERGE_LINE_WINDOW = 10
const MERGE_LEVEL_RANK = { "致命": 0, "严重": 1, "一般": 2, "优化": 3 }
const MERGE_FILE_PAT = "([^\\s，,、;；:：()（）\\[\\]【】]+?\\.(?:md|txt|json|js|mjs|cjs|ts|py|yaml|yml|csv|html|xml|sh|bat|docx|pdf|pptx|xlsx))"
/** 分词：英文单词 + 中文 2-gram。 */
function mergeTokens(s) {
  const t = String(s || "").toLowerCase()
  const out = []
  for (const m of t.matchAll(/[a-z0-9]+/g)) out.push(m[0])
  for (const run of t.matchAll(/[\u4e00-\u9fff]+/g)) {
    const r = run[0]
    if (r.length === 1) out.push(r)
    else for (let i = 0; i < r.length - 1; i++) out.push(r.slice(i, i + 2))
  }
  return out
}
/** Jaccard 相似度，基于词集合。 */
function mergeJaccard(a, b) {
  const A = new Set(mergeTokens(a))
  const B = new Set(mergeTokens(b))
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  const union = A.size + B.size - inter
  return union ? inter / union : 0
}
/** 从文本里抽位置，归一成 文件:行号。 */
function mergeNormLoc(text) {
  const t = String(text || "")
  let m = t.match(new RegExp(MERGE_FILE_PAT + "\\s*[:：]\\s*(\\d+)"))
  if (m) return { loc: m[1] + ":" + m[2], file: m[1], line: Number(m[2]) }
  m = t.match(new RegExp(MERGE_FILE_PAT + "\\s*[Ll]\\s*(\\d+)"))
  if (m) return { loc: m[1] + ":" + m[2], file: m[1], line: Number(m[2]) }
  m = t.match(new RegExp(MERGE_FILE_PAT))
  if (m) return { loc: m[1], file: m[1], line: 0 }
  return { loc: "", file: "", line: 0 }
}
/** 从文本里认级别，认不出按一般。 */
function mergePickLevel(text) {
  const m = String(text || "").match(/(?:^|[\s：:，,、;；（(【\[])(致命|严重|一般|优化)(?:$|[\s：:，,、;；）)】\]])/)
  // 2026-11-11：跨厂商红队常用「高/中/低」，映射到标准四级
  // （实测：商汤用「严重度：高」；不映射会全部落到「一般」）
  const h = String(text || "").match(/(?:^|[\s：:，,、;；（(【\[])(高|中|低)(?:$|[\s：:，,、;；）)】\]])/)
  if (h) return h[1] === "高" ? "严重" : h[1] === "中" ? "一般" : "优化"
  return m ? m[1] : "一般"
}
/** 从文本里认维度。 */
function mergePickDim(text) {
  const m = String(text || "").match(/维度\s*[:：]?\s*([^\s，,、;；:：()（）]{1,12})/)
  return m ? m[1] : ""
}
/** 从文本里认错误码。 */
function mergePickCode(text) {
  const m = String(text || "").match(/\b(E\d{1,3})\b/)
  return m ? m[1] : ""
}
/** 表格单元格清洗：折叠空白、转义竖线。 */
function mergeCell(s) {
  return String(s || "").replace(/\s+/g, " ").trim().replace(/\|/g, "\\|")
}
/** 这一行是不是某一种条目的开头（用于截断上一条的正文）。 */
function mergeIsStart(line) {
  const s = String(line || "")
  if (/^\*\*观点\s*\d+/.test(s)) return true
  if (/^#{1,6}\s*(?:N\d{1,3}|K\d{1,3}|\d{1,3})(?:[.、．]|\s)/.test(s)) return true
  if (/^\s*(?:[-*+]\s*)?(?:K\d{1,3}\s*[、.．:：]?\s*)+/.test(s)) return true
  if (/^\|.*\|$/.test(s)) return true
  // 2026-11-11：**A1** / **B2 — 内容** 也是条目起点（商汤 SenseNova 格式）
  if (/^\*\*[A-Za-z]\d{1,3}(?:\s*[—–-]|\*\*)/.test(s)) return true
  // 中文小标题 `### 观点 N`（2026-11-11：实测有红队这么写）
  if (/^#{1,6}\s*观点\s*\d+/.test(s)) return true
  return false
}
/** 格式 1：**观点 N（指向 文件 L行，维度 X）：判据。** 后面跟证据段。 */
/**
 * 格式 5（2026-11-11 端到端验证新增）：`**A1** 内容` / `**B2 — 内容**`。
 * 起因：跨厂商红队（商汤 SenseNova）交回来的格式是 `**A1** 生存函数是...`，
 * 而解析器只认 `**观点 N（...）**` / `### N01` / `K01` / 表格行 —— 一份意见全部漏掉。
 * 教训：红队格式无法穷举，解析器必须容忍「字母+数字」编号。
 */
function mergeParseBoldId(lines, i, src) {
  const line = lines[i]
  // 两种形态：编号单独加粗（**A1** 内容），或整条加粗（**A1 — 内容**）
  const m = line.match(/^\*\*([A-Za-z]\d{1,3})(?:\s*[—–-]\s*(.+?))?\*\*\s*(.*)$/)
  if (!m) return { items: [], next: i + 1 }
  const id = m[1]
  const claim = (m[2] || '').trim() || (m[3] || '').trim()
  // 收集后续行，直到下一个条目起点
  let j = i + 1
  const ev = []
  while (j < lines.length) {
    const s = lines[j]
    if (!s.trim()) { j++; continue }
    if (mergeIsStart(s)) break
    if (/^#{1,6}\s/.test(s)) break
    ev.push(s.trim())
    j++
  }
  const body = (m[3] && m[3].trim()) ? (claim + ' ' + ev.join(' ')).trim() : (claim || ev.join(' ')).trim()
  const items = body ? [{
    src: src, raw: line, body: body,
    out: '[' + id + '] ' + body,
    dim: mergePickDim(body) || '未分类',
    level: mergePickLevel(body),
    code: mergePickCode(body),
    loc: '', file: '', line: null,
  }] : []
  return { items: items, next: Math.max(j, i + 1) }
}
function mergeParseBold(lines, i, src) {
  const line = lines[i]
  const m = line.match(/^\*\*观点\s*\d+\s*[（(](.*?)[)）]\s*[：:]\s*(.+?)\*\*\s*$/)
  if (!m) return { items: [], next: i + 1 }
  const meta = m[1]
  const claim = m[2].trim()
  let j = i + 1
  const ev = []
  while (j < lines.length) {
    const s = lines[j]
    if (!s.trim()) break
    if (mergeIsStart(s)) break
    if (/^#{1,6}\s/.test(s)) break
    ev.push(s.trim())
    j++
  }
  const loc = mergeNormLoc(meta + " " + claim)
  const dim = mergePickDim(meta) || mergePickDim(claim)
  const items = claim ? [{
    src: src, raw: line, body: claim,
    out: claim + (ev.length ? " " + ev.join(" ") : ""),
    dim: dim || "未分类", level: mergePickLevel(claim), code: mergePickCode(claim),
    loc: loc.loc, file: loc.file, line: loc.line,
  }] : []
  return { items: items, next: Math.max(j, i + 1) }
}
/** 格式 3：### N01 标题 / ### 1. 标题，正文直到下一个条目或标题。 */
function mergeParseHeading(lines, i, src) {
  const line = lines[i]
  // 2026-11-11：加 `(?:观点\s*)?` —— 中文小标题 `### 观点 1（指向 …）` 也要认
  // 分隔符还要含全角/半角括号：`### 观点 1（指向 …）` 的数字后面是 `（`
  const m = line.match(/^(#{1,6})\s*(?:观点\s*)?(N\d{1,3}|K\d{1,3}|\d{1,3})(?:[.、．（(]|\s)\s*(.*)$/)
  if (!m) return { items: [], next: i + 1 }
  const title = (m[3] || "").trim()
  let j = i + 1
  const body = []
  while (j < lines.length) {
    const s = lines[j]
    if (!s.trim()) {
      let k = j
      while (k < lines.length && !lines[k].trim()) k++
      if (k < lines.length && !mergeIsStart(lines[k]) && !/^#{1,6}\s/.test(lines[k])) { j = k; continue }
      break
    }
    if (mergeIsStart(s)) break
    if (/^#{1,6}\s/.test(s)) break
    body.push(s.trim())
    j++
  }
  const full = (title + " " + body.join(" ")).trim()
  if (full.length < 4) return { items: [], next: Math.max(j, i + 1) }
  const loc = mergeNormLoc(full)
  return {
    items: [{
      src: src, raw: line, body: full, out: full,
      dim: mergePickDim(full) || "未分类", level: mergePickLevel(full), code: mergePickCode(full),
      loc: loc.loc, file: loc.file, line: loc.line,
    }],
    next: Math.max(j, i + 1),
  }
}
/** 格式 4：K01、判据…（魔鬼代言人常用；允许 K01、K02 连写）。 */
function mergeParseK(lines, i, src) {
  const line = lines[i]
  const m = line.match(/^\s*(?:[-*+]\s*)?((?:K\d{1,3}\s*[、.．:：]?\s*)+)(.*)$/)
  if (!m) return { items: [], next: i + 1 }
  const nums = m[1].match(/K\d{1,3}/g) || []
  let rest = (m[2] || "").trim()
  let next = i + 1
  if (!rest) {
    let j = i + 1
    while (j < lines.length && !lines[j].trim()) j++
    if (j < lines.length && !mergeIsStart(lines[j]) && !/^#{1,6}\s/.test(lines[j])) {
      rest = lines[j].trim()
      next = j + 1
    }
  }
  if (!rest) return { items: [], next: next }
  const loc = mergeNormLoc(rest)
  const items = nums.map(function (n) {
    return {
      src: src, raw: line, body: rest, out: rest, num: n,
      dim: mergePickDim(rest) || "未分类", level: mergePickLevel(rest), code: mergePickCode(rest),
      loc: loc.loc, file: loc.file, line: loc.line,
    }
  })
  return { items: items, next: next }
}
/** 格式 2：| N01 | 维度 | 级别 | 位置 | 判据 | 错误码 | 来源 | */
function mergeParseTableRow(inner, src, rawLine) {
  const clean = inner.map(function (c) { return stripMd(String(c || "").replace(/\s+/g, " ")).trim() })
  if (clean.length < 5) return null
  if (clean.every(function (c) { return /^:?-+:?$/.test(c) })) return null
  if (/^(编号|用例编号|序号|ID)$/i.test(clean[0])) return null
  let dim = "", level = "", locText = "", body = "", code = ""
  if (clean.length >= 7) {
    dim = clean[1]
    level = clean[2]
    locText = clean[3]
    body = clean[4]
    code = clean[5]
  } else {
    let locIdx = -1, lvlIdx = -1, codeIdx = -1
    for (let k = 0; k < clean.length; k++) {
      if (locIdx < 0 && mergeNormLoc(clean[k]).loc) locIdx = k
      if (lvlIdx < 0 && MERGE_LEVELS.indexOf(clean[k]) >= 0) lvlIdx = k
      if (codeIdx < 0 && /^E\d{1,3}$/.test(clean[k])) codeIdx = k
    }
    const used = new Set([0])
    if (locIdx >= 0) used.add(locIdx)
    if (lvlIdx >= 0) used.add(lvlIdx)
    if (codeIdx >= 0) used.add(codeIdx)
    let best = -1, bestLen = -1
    for (let k = 0; k < clean.length; k++) {
      if (used.has(k)) continue
      if (clean[k].length > bestLen) { bestLen = clean[k].length; best = k }
    }
    body = best >= 0 ? clean[best] : ""
    dim = clean.length > 1 && !used.has(1) && clean[1] !== body ? clean[1] : ""
    level = lvlIdx >= 0 ? clean[lvlIdx] : ""
    locText = locIdx >= 0 ? clean[locIdx] : ""
    code = codeIdx >= 0 ? clean[codeIdx] : ""
  }
  if (!body) return null
  const loc = mergeNormLoc(locText + " " + body)
  const dimText = dim && MERGE_LEVELS.indexOf(dim) < 0 && !mergeNormLoc(dim).loc ? dim : ""
  return {
    src: src, raw: rawLine || inner.join("|"), body: body, out: body,
    dim: dimText || mergePickDim(body) || "未分类",
    level: MERGE_LEVELS.indexOf(level) >= 0 ? level : mergePickLevel(body),
    code: code || mergePickCode(body),
    loc: loc.loc, file: loc.file, line: loc.line,
  }
}
function mergeParseTableRowLine(line, i, src) {
  const cells = line.split("|").map(function (c) { return c.trim() })
  let inner = cells
  if (cells.length >= 2 && cells[0] === "" && cells[cells.length - 1] === "") inner = cells.slice(1, -1)
  const it = mergeParseTableRow(inner, src, line)
  return { items: it ? [it] : [], next: i + 1 }
}
/** 从一份意见文件里抽出全部条目。 */
function mergeExtract(content, src) {
  const lines = String(content || "").split(/\r?\n/)
  const items = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    let made = null
    if (/^\*\*观点\s*\d+/.test(line)) made = mergeParseBold(lines, i, src)
    else if (/^\*\*[A-Za-z]\d{1,3}(?:\s*[—–-]|\*\*)/.test(line)) made = mergeParseBoldId(lines, i, src)
    else if (/^#{1,6}\s*观点\s*\d+/.test(line)) made = mergeParseHeading(lines, i, src)
    else if (/^#{1,6}\s*(?:N\d{1,3}|K\d{1,3}|\d{1,3})(?:[.、．]|\s)/.test(line)) made = mergeParseHeading(lines, i, src)
    else if (/^\s*(?:[-*+]\s*)?(?:K\d{1,3}\s*[、.．:：]?\s*)+/.test(line)) made = mergeParseK(lines, i, src)
    else if (/^\|.*\|$/.test(line)) made = mergeParseTableRowLine(line, i, src)
    if (made) {
      for (const it of made.items) items.push(it)
      i = made.next > i ? made.next : i + 1
    } else {
      i++
    }
  }
  return items
}
/** 位置相同：同文件，且行号相同或相邻（视为同一段落）。 */
function mergeSameLoc(a, b) {
  if (!a.file || !b.file) return false
  if (a.file !== b.file) return false
  if (a.line && b.line) return Math.abs(a.line - b.line) <= MERGE_LINE_WINDOW
  return true
}
/**
 * 宽松统计输入文件里「像条目起点」的行数，用于漏识别自检。
 *
 * 为什么需要（2026-11-11 端到端验证）：
 *   merge 的解析器支持 5 种格式，但真实红队会发明第 6 种。
 *   实测商汤 SenseNova 交回来的是 `**A1** 内容` —— 解析器一条都认不出，
 *   而 merge 照样打印 `MERGE_OK`，没有任何信号提示「你漏了一整份」。
 *
 * 这个函数用尽可能宽松的规则数「像条目的行」，然后和实际识别数比：
 *   疑似条数 >> 识别条数  →  报警，提示可能有格式没覆盖。
 *
 * 它不追求准确，只追求「不漏报」——宁可误报，不可沉默。
 */
function countSuspected(text) {
  const lines = String(text || "").split(/\r?\n/)
  let n = 0
  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    // 任何「编号样式」的开头都算疑似：N01 / K1 / 观点 1 / 1. / - 1 / **A1** / 【1】/ 【Z9】
    // 纯数字编号列表项（`1. xxx`）要额外要求含严重度词或数值，
    // 否则「已复算无误」这类清单会把疑似数抬高，造成误报（2026-11-11 实测 11 vs 3）。
    if (/^(?:\*\*)?(?:N|C|K|R|A|B|D|F|P|Q|Z)?\d{1,3}(?:\*\*|\s*[.、．:：]|\s+[A-Z\u4e00-\u9fa5])/.test(t)) {
      if (/^(?:\*\*)?(?:N|C|K|R)\d{1,3}/.test(t)) { n++; continue }
      if (/(?:致命|严重|一般|优化|高|中|低|\d+\.\d+)/.test(t)) { n++; continue }
      continue
    }
    if (/^观点\s*\d+/.test(t)) { n++; continue }
    if (/^【[A-Za-z]?\d+】/.test(t)) { n++; continue }
    if (/^\|\s*(?:N|C|K|R)\d{1,3}\s*\|/.test(t)) { n++; continue }
  }
  return n
}
function cmdMerge(args) {
  const list = args || []
  const outFlag = list.find(function (a) { return String(a).indexOf("--out=") === 0 })
  const rest = list.filter(function (a) { return String(a).indexOf("--out=") !== 0 })
  const roundDir = rest[0]
  const files = rest.slice(1)
  const usage = "usage: merge <轮次目录> <文件1> <文件2> ... [--out=<输出路径>]"
  if (!roundDir) die(usage)
  if (!existsSync(roundDir)) die("MERGE_NO_DIR: 轮次目录不存在 " + roundDir)
  if (!files.length) die(usage)
  const outPath = outFlag ? String(outFlag).slice("--out=".length) : join(roundDir, "01-cases.md")
  const all = []
  for (const f of files) {
    if (!existsSync(f)) { console.log("MERGE_MISSING: 文件不存在 " + f); continue }
    const src = basename(f).replace(/\.[^.]+$/, "")
    const items = mergeExtract(readFileSync(f, "utf8").replace(/^\uFEFF/, ""), src)
    if (!items.length) { console.log("MERGE_EMPTY: " + basename(f) + " 里没有可识别条目"); continue }
    for (const it of items) all.push(it)
  }
  if (!all.length) { console.error("MERGE_NOTHING: 所有输入文件都没有可识别条目"); return 2 }
  // 去重：与组内第一条（代表）比位置 + 判据相似度
  const groups = []
  for (const it of all) {
    let hit = null
    for (const g of groups) {
      const rep = g.members[0]
      if (mergeSameLoc(rep, it) && mergeJaccard(rep.body, it.body) >= MERGE_SIM_THRESHOLD) { hit = g; break }
    }
    if (hit) hit.members.push(it)
    else groups.push({ members: [it] })
  }
  // 组级属性：级别取最重，来源按首次出现顺序合并
  for (const g of groups) {
    let level = g.members[0].level
    for (const m of g.members) {
      const rm = MERGE_LEVEL_RANK[m.level]
      const rl = MERGE_LEVEL_RANK[level]
      if (rm !== undefined && (rl === undefined || rm < rl)) level = m.level
    }
    g.level = level
    const srcs = []
    for (const m of g.members) if (srcs.indexOf(m.src) < 0) srcs.push(m.src)
    g.source = srcs.join("+")
    let loc = "", code = "", dim = ""
    for (const m of g.members) {
      if (!loc && m.loc) loc = m.loc
      if (!code && m.code) code = m.code
      if (!dim && m.dim && m.dim !== "未分类") dim = m.dim
    }
    g.loc = loc
    g.code = code
    g.dim = dim || g.members[0].dim || "未分类"
    g.out = g.members[0].out || g.members[0].body
  }
  // 按级别降序，同级按首次出现顺序
  const ranked = groups.map(function (g, idx) { return { g: g, idx: idx } })
  ranked.sort(function (x, y) {
    const rx = MERGE_LEVEL_RANK[x.g.level]
    const ry = MERGE_LEVEL_RANK[y.g.level]
    const nx = rx === undefined ? 9 : rx
    const ny = ry === undefined ? 9 : ry
    if (nx !== ny) return nx - ny
    return x.idx - y.idx
  })
  ranked.forEach(function (r, i) { r.g.num = "N" + String(i + 1).padStart(2, "0") })
  const out = []
  out.push("| 编号 | 维度 | 级别 | 位置 | 判据与证据 | 错误码 | 来源 |")
  out.push("| --- | --- | --- | --- | --- | --- | --- |")
  for (const r of ranked) {
    const g = r.g
    out.push("| " + g.num + " | " + mergeCell(g.dim) + " | " + g.level + " | " + mergeCell(g.loc || "—")
      + " | " + mergeCell(g.out) + " | " + mergeCell(g.code || "—") + " | " + g.source + " |")
  }
  const merged = ranked.filter(function (r) { return r.g.members.length > 1 })
  if (merged.length) {
    out.push("")
    out.push("## 被合并的组（" + merged.length + " 组）")
    out.push("")
    out.push("| 合并后编号 | 被合并的原始条目（文件: 原文前 40 字） | 相似度 |")
    out.push("| --- | --- | --- |")
    for (const r of merged) {
      const g = r.g
      const rep = g.members[0]
      const entries = []
      const sims = []
      for (let k = 1; k < g.members.length; k++) {
        const m = g.members[k]
        const preview = mergeCell(String(m.raw || m.body).replace(/\s+/g, " ").trim().slice(0, 40))
        entries.push(m.src + ": " + preview)
        sims.push(mergeJaccard(rep.body, m.body).toFixed(2))
      }
      out.push("| " + g.num + " | " + entries.join("<br>") + " | " + sims.join("<br>") + " |")
    }
  }
  writeFileSync(outPath, out.join("\n") + "\n", "utf8")
  console.log("MERGE_OK: " + ranked.length + " 条 → " + outPath + "（合并 " + merged.length + " 组）")
  // v6.29T（2026-11-11）：漏识别自检 —— 疑似条数远多于识别条数就报警。
  // 真实教训：商汤那份用 `**A1**` 格式，解析器一条都没认出来，merge 却照样报 OK。
  {
    let suspectedTotal = 0
    for (const f of files) {
      try { suspectedTotal += countSuspected(readFileSync(f, "utf8").replace(/^\uFEFF/, "")) } catch { /* 读不到就跳过 */ }
    }
    if (suspectedTotal > 0 && ranked.length < suspectedTotal * 0.7) {
      console.error("MERGE_UNDERCOUNT: 输入里疑似有 " + suspectedTotal + " 个条目起点，但只识别出 " + ranked.length + " 条（" + Math.round(ranked.length / suspectedTotal * 100) + "%）。")
      console.error("  → 很可能有红队用了解析器不认识的格式。请人工看一遍输入文件，确认没有整份漏掉。")
      console.error("  → 已知格式：观点 N（…）/ ### N01 / K01、K02 / 表格行 / **A1**。遇到新格式请加进 mergeParseBoldId 或 mergeExtract。")
    }
  }
  return 0
}
function selftest() {
  // 严格模式按 03-review.md 的 mtime 分界。自测 fixture 建在临时目录、mtime 永远是现在，
  // 会被一律当新轮次拦掉。钉成 2026-01-01 = 历史轮次；严格模式另有专门用例显式验证。
  const asOld = (f) => { const t = new Date('2026-01-01T00:00:00Z'); utimesSync(f, t, t) }
  const tmp = join(process.env.TEMP || '/tmp', `redblue-selftest-${Date.now()}`)
  mkdirSync(join(tmp, 'R1-0101aa', 'fingerprints'), { recursive: true })
  let bad = 0
  const ok = (cond, name) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) bad++ }

  // v6.29y：自测要能证明「每道护栏真的被触发过」。
  // 起因：`GATE_SEVERE_MISLOCATED` 写下之后从未执行过（块内引用了未定义的 rdA2，被 catch 吞掉），
  // 而自测里相关断言还是"通过"——因为它通过的是别的原因。
  // 做法：拦截 console.error，收集本次自测里**实际出现过的诊断码**，最后核对必需清单。
  const firedCodes = new Set()
  const firedOk = new Set()
  const __origErr = console.error
  const __origLog = console.log
  console.error = (...a) => {
    const s = a.map(String).join(' ')
    // 注意：首段只需 ≥2 字符，否则 `NO_BLOCKS` 这种两字母前缀会被漏掉（实测踩过）。
    for (const m of s.matchAll(/\b([A-Z][A-Z0-9]{1,}(?:_[A-Z0-9]+)+)\b/g)) firedCodes.add(m[1])
    __origErr(...a)
  }
  // v6.29z：同样的思路查**正常路径** —— 错误码被覆盖，不代表"成功那一路"被跑过。
  console.log = (...a) => {
    const s = a.map(String).join(' ')
    for (const m of s.matchAll(/\b([A-Z][A-Z0-9]{1,}(?:_[A-Z0-9]+)+)\b/g)) firedOk.add(m[1])
    for (const m of s.matchAll(/\b(CONVERGE|REATTACK|GATE|METRICS|REFS|QUALITY|ROUTE)\b/g)) firedOk.add(m[1])
    __origLog(...a)
  }
  // 正常路径必须被自测真正跑过一遍的那些标记。
  // 注意 SELFTEST_OK 不在清单里：它是本函数的**最后一行输出**，检查时必然还没打印（自指）。
  const REQUIRED_OK = [
    'APPLY_OK', 'CARRY_OK', 'SCAN_CLEAN', 'ATTACK_RECORDED', 'CANARY_BUILT',
    'CONVERGE', 'REATTACK', 'CANARY_RECALL', 'GATE', 'IDENT_OK', 'OCCUR_OK', 'XCHECK_OK',
    'NOTICE_NUMERIC_CHANGE',
  ]
  const REQUIRED_CODES = [
    'GATE_UNATTACKED', 'GATE_UNEXECUTED', 'GATE_UNDECIDABLE', 'GATE_UNGROUNDED',
    'GATE_NO_RECONCILE', 'GATE_NO_RECONCILE_CONTENT', 'GATE_RECONCILE_FAKE_REF',
    'GATE_NO_SCOPE', 'GATE_SEVERE_UNLOCATABLE', 'GATE_SEVERE_MISLOCATED', 'GATE_LOCATION_UNRESOLVABLE',
    'SHORTCODE_BAD_ROUND', 'BUNDLE_UNVERIFIED', 'SEVERITY_NO_COMPARABLE',
    'GATE_ATTACK_STALE', 'NOTICE_NO_DELTA', 'NOTICE_SCOPE_UNQUALIFIED',
    'NOTICE_ATTACK_MISSING', 'QUALITY_NO_RECALL',
    'ANCHOR_GENERIC', 'RECALL_TOO_PERFECT', 'ANCHOR_WEAK',
    'CARRY_INCOMPLETE', 'LOST_OPEN',
    'OLD_NOT_FOUND', 'OLD_NOT_UNIQUE', 'NEW_HAS_CJK', 'NO_BLOCKS',
    'DANGLING_REF', 'REFS_EMPTY', 'BUDGET_UNMEASURED', 'CJK_IN_TEXT',
    'IDENT_VALUE_MISSING', 'GATE_IDENT_FAIL', 'NOTICE_NO_IDENT',
    'OCCUR_MISMATCH', 'GATE_OCCUR_FAIL', 'NOTICE_NO_OCCUR',
    'GATE_COLUMN_SWAP', 'SUSPECT_COLUMN_SWAP', 'XCHECK_DISAGREE', 'GATE_SEVERE_UNVERIFIED',
  ]

  // 1) 级别解析（F1 回归）
  const cases = [
    ['致命', '致命'], ['严重', '严重'], ['一般', '一般'], ['优化', '优化'], ['已消除', '已消除'],
    ['致命 → 已消除', '已消除'], ['一般（残留）', '一般'], ['优化 → 挂账（部分属实）', '挂账'],
  ]
  for (const [raw, want] of cases) ok(parseLevel(raw) === want, `parseLevel("${raw}") == ${want}`)
  // v6.29M：markdown 加粗/斜体/代码包裹的级别词必须照样认得。
  // 实测 R11 的 01-cases.md 用 `**严重**` 写 6 条严重 → 旧 parseLevel 返回 null → 整行丢弃 →
  // recount/gate 报「严重=0」。这是本项目第五次「解析器失效方向 = 少算」。
  for (const [raw, want] of [
    ['**严重**', '严重'], ['**致命**', '致命'], ['`一般`', '一般'], ['_优化_', '优化'],
    ['**严重 → 已消除**', '已消除'], ['**严重** → 已消除', '已消除'],
  ]) ok(parseLevel(raw) === want, `parseLevel 去 markdown 包裹("${raw}") == ${want}`)

  // 2) 只解析逐条判定表（不把复核对照表算进去）
  const review = [
    '# R', '## 逐条判定', '',
    '| C01 | 致命 → 已消除 | x |', '| C02 | 一般（残留） | x |', '| N01 | 优化 → 挂账（部分属实） | x |',
    '| N1 | 已消除 | x |', '| N2 | 不成立（归属错误） | x |',   // v3.3.2 回归：单数字编号 + 不成立
    '', '## 蓝队「已修」实跑复核', '| C01 | 蓝队声称已修 | …… |', '| C02 | 蓝队声称已修 | …… |',
  ].join('\n')
  const rf = join(tmp, 'R1-0101aa', '03-review.md')
  writeFileSync(rf, review, 'utf8')
  const { t, unknown } = tally(parseVerdict(rf))
  ok(t['已消除'] === 2 && t['一般'] === 1 && t['挂账'] === 1 && t['不成立'] === 1 && unknown.length === 0,
    `recount 只数逐条判定表 ${JSON.stringify(t)}`)

  // 3) 用例计数含 N（F2 回归）
  const cf = join(tmp, 'R1-0101aa', '01-cases.md')
  writeFileSync(cf, '| C01 | a |\n| C02 | a |\n| N01 | b |\n', 'utf8')
  ok(countCases(cf) === 3, `countCases 认 N 系列 = ${countCases(cf)} (want 3)`)

  // 4) 契约：R1 缺 01-cases → 违规；R2 缺 → 放行（F3 回归）
  mkdirSync(join(tmp, 'R2-0101bb'), { recursive: true })
  for (const f of ['00-target.md', '02-blue.md', '03-review.md', '04-summary.md', '05-signoff.md']) {
    writeFileSync(join(tmp, 'R2-0101bb', f), '逐条处置 交付件改动 统计 闸门 主控决策 统计复算', 'utf8')
  }
  const r1 = cmdContract([join(tmp, 'R1-0101aa')])
  ok(r1 === 1, 'R1 缺 01-cases.md → CONTRACT_VIOLATION')
  // v6.24：R2+ 不再无条件「继承」。缺 01-cases.md 且未声明「本轮无红队交付」= 违约。
  // 这正是 R10-1102a1 假放行的合流点：contract 说 OK，gate 也就跟着放行。
  const r2 = cmdContract([join(tmp, 'R2-0101bb')])
  ok(r2 === 1, 'R2 缺 01-cases.md 且未声明无红队 → CONTRACT_VIOLATION（不再静默继承）')
  // 声明了就允许：诚实记录「本轮无红队」不算违约，但 gate 仍会拦（见下）
  writeFileSync(join(tmp, 'R2-0101bb', '04-summary.md'), '闸门 主控决策 统计复算\n本轮无红队交付：两路均未启动\n', 'utf8')
  const r2d = cmdContract([join(tmp, 'R2-0101bb')])
  ok(r2d === 0, 'R2 缺 01-cases.md 但 04 已声明「本轮无红队交付」→ CONTRACT_OK')

  // 4.5) cite 回归（M6）
  const cf2 = join(tmp, 'R1-0101aa', 'cite-probe.md')
  writeFileSync(cf2, 'line1\n这里写着 分子未被抬高\nline3\n', 'utf8')
  ok(cmdCite([`${cf2}:2`, '分子未被抬高']) === 0, 'cite: 引文命中 → CITE_OK')
  ok(cmdCite([`${cf2}:2`, '分子同被抬高']) === 1, 'cite: 引文不命中 → CITE_FAIL')
  ok(cmdCite([`${cf2}:99`, 'x']) === 1, 'cite: 行号越界 → CITE_FAIL')

  // 5) 闸门
  // v6.24：闸门现在要求「红队真的交付过 + 蓝队真的执行过」才允许放行。
  // 旧夹具只有一个裸 03-review.md，正好复刻 R10 假放行的形态 —— 必须补真实产物。
  writeFileSync(join(tmp, 'R1-0101aa', '01-cases.md'),
    '# 红队用例\n\n## 一、用例表\n\n| 编号 | 级别 | 维度 | 缺陷要点 |\n| --- | --- | --- | --- |\n| C01 | 致命 | 数据 | x |\n| C02 | 一般 | 交互 | y |\n| N01 | 优化 | 流程 | z |\n', 'utf8')
  writeFileSync(join(tmp, 'R1-0101aa', '02-blue.md'),
    '# 蓝队\n\n## 逐条处置\n\n| 用例 | 处置 | 证据 |\n| --- | --- | --- |\n| C01 | 已修 | a:1 |\n| C02 | 挂账 | — |\n| N01 | 驳回 | — |\n\n## 交付件改动\n\n无\n', 'utf8')
  // v6.25：闸门新增「实事求是」三节检查（证据落地 / 设想vs实际 / 未覆盖范围）。
  // 这不是可选项 —— 用户明确要求每个结论有落地证据、设想被推翻要重设、范围缩小要声明。
  // 夹具必须带这三节，否则连"干净的一轮"都无法放行。
  writeFileSync(join(tmp, 'R1-0101aa', '04-summary.md'),
    '# R1 复盘\n\n' +
    '## 证据落地\n\n' +
    '| 条目 | 证据 | 可复算 |\n| --- | --- | --- |\n' +
    '| C01 已修 | 交付件 a.md:12 已改写为该口径 | 是（读 a.md:12 可见） |\n' +
    '| C02 挂账 | 交付件 b.md:30 仍未声明窗口 | 是（gate 复跑一致） |\n' +
    '| N01 驳回 | 红队判据不成立，反证见 c.md:8 | 是（反证行可读） |\n\n' +
    '以上每条都能指到具体行号，没有「看起来合理」的条目。未核实的条目为零。\n' +
    '这一节的用途是让任何人事后能逐条重查，而不是相信本轮的自我描述。\n\n' +
    '## 设想 vs 实际\n\n' +
    '| 原设想 | 实际数据 | 处置 |\n| --- | --- | --- |\n' +
    '| 以为窗口口径已统一 | 实测仍有 2 处混用 | 推翻设想，改口径并重算 |\n' +
    '| 以为挂账可清零 | 复算显示 1 条确实无法本轮修 | 改为挂账并写明原因 |\n\n' +
    '两条设想都被数据推翻，按用户要求「设想和实际矛盾就重新设想」，已重设而不是迁就数据。\n' +
    '没有把「希望它成立」当成「它成立」。\n\n' +
    '## 未覆盖范围\n\n' +
    '- 未审：附录 B 的历史数据集（缺原始采样记录，无法复算）\n' +
    '- 未审：第三方工具链的版本兼容性（本机未装该工具）\n' +
    '- 边界：本轮只覆盖主实验三条结论，未覆盖敏感性分析的 5 个参数\n\n' +
    '以上范围是**主动声明**的，不是漏审后补记。缩小范围本身在红队用例里有对应条目。\n', 'utf8')
  ok(cmdGate([rf]) === 0, 'gate: 致命0 严重0 + 红队已交付 + 蓝队已执行 + 三节齐全 → 放行')
  // 缺三节就不许放行（v6.25）
  const rfNoRecon = join(tmp, 'R1-0101aa', '03-review-norecon.md')
  writeFileSync(rfNoRecon, review, 'utf8')
  const tmpSummary = readFileSync(join(tmp, 'R1-0101aa', '04-summary.md'), 'utf8')
  writeFileSync(join(tmp, 'R1-0101aa', '04-summary.md'), '闸门 主控决策 统计复算\n', 'utf8')
  ok(cmdGate([rfNoRecon]) === 1, 'gate: 04-summary 缺三节 → GATE_UNGROUNDED/NO_RECONCILE/NO_SCOPE 不放行')
  writeFileSync(join(tmp, 'R1-0101aa', '04-summary.md'), tmpSummary, 'utf8')
  const rfNoRed = join(tmp, 'R1-0101aa', '03-review-nored.md')
  writeFileSync(rfNoRed, review, 'utf8')
  ok(cmdGate([rfNoRed]) === 0, 'gate: 同目录红队产物齐全时，另一个 review 文件也放行')
  // 造一个「红队自述没交付」的目录，验证 GATE_UNATTACKED
  const noAtk = join(tmp, 'R1-0101cc')
  mkdirSync(noAtk, { recursive: true })
  writeFileSync(join(noAtk, '01-cases.md'), '# 用例清单（继承上轮）\n\n> 本轮无红队交付\n\n## 用例表\n\n| 编号 | 级别 | 维度 | 缺陷要点 |\n| --- | --- | --- | --- |\n| C01 | 一般 | 数据 | x |\n', 'utf8')
  writeFileSync(join(noAtk, '02-blue.md'), '## 逐条处置\n\n| 用例 | 处置 |\n| --- | --- |\n| C01 | 已修 |\n', 'utf8')
  writeFileSync(join(noAtk, '03-review.md'), '| 用例 | 级别 | 处置 | 位置 | 证据 |\n| --- | --- | --- | --- | --- |\n| C01 | 一般 | 已消除 | a:1 | x |\n', 'utf8')
  ok(cmdGate([join(noAtk, '03-review.md')]) === 1, 'gate: 红队自述「本轮无红队交付」→ GATE_UNATTACKED 不放行')
  // v6.29M：位置栏写简写（无文件名）→ gate 仍放行，但必须报 GATE_LOCATION_UNRESOLVABLE。
  // 起因：R10 的 03-review 位置栏全是 `v5 L151`，bundle 判 UNDECIDABLE 而 gate 照旧放行 ——
  // 两条命令对同一份数据结论相反，这正是最该消掉的那类不一致。
  {
    const shortLoc = join(tmp, 'loc-short')
    mkdirSync(shortLoc, { recursive: true })
    writeFileSync(join(shortLoc, '03-review.md'),
      '# 裁决\n\n| 编号 | 级别 | 状态 | 位置 | 判据与证据 |\n| --- | --- | --- | --- | --- |\n'
      + '| N1 | 严重 | 已消除 | v5 L151 | 已改 |\n', 'utf8')
    const seenLoc = []
    const origLoc = console.error
    console.error = (...a) => { seenLoc.push(a.map(String).join(' ')); origLoc(...a) }
    let rcLoc = 0
    try { rcLoc = cmdGate([join(shortLoc, '03-review.md')]) } finally { console.error = origLoc }
    ok(seenLoc.some((s) => s.includes('GATE_LOCATION_UNRESOLVABLE')), 'gate: 严重行只有 L151 简写 → 报 GATE_LOCATION_UNRESOLVABLE')
    ok(rcLoc === 0 || rcLoc === 1, 'gate: 该提示只报不拦（不因引用形态改变放行结论）')
  }
  // shortcode 入参校验：传整个目录名曾静默吐出 `RR10-1108r1-1108b9` 这种废名
  ok(cmdShortcode([tmp, 'R10-1108r1']) === 2, 'shortcode: 传整个目录名 → SHORTCODE_BAD_ROUND（不再吐废名）')
  {
    const scSeen = []
    const origSc = console.log
    console.log = (...a) => { scSeen.push(a.map(String).join(' ')); origSc(...a) }
    let rcSc = 0
    try { rcSc = cmdShortcode([tmp, '11']) } finally { console.log = origSc }
    ok(rcSc === 0 && scSeen.some((s) => /^R11-[0-9a-f]+$/.test(s.trim())), 'shortcode: 传 "11" → R11-xxxx 合法名')
  }
  // v6.25 缺陷30：**转抄上一轮 ≠ 本轮有人攻击过**（R10 第二次假放行的真正原因）。
  // R10 的 01-cases.md 开头写「# R10 用例清单（继承 R9 红队 13 条 + 主控撤回 2 条）」，
  // 有完整的「编号+级别」判定行，第一版判据因此放行 —— 但它不是本轮的红队产出。
  const inherit = join(tmp, 'R1-0101ee')
  mkdirSync(inherit, { recursive: true })
  writeFileSync(join(inherit, '01-cases.md'),
    '# R1 用例清单（继承 R0 红队 13 条 + 主控撤回 2 条）\n\n' +
    '## 一、上一轮产出的 13 条（本轮全部处置）\n\n' +
    '| 编号 | 级别 | 来源 | 缺陷要点 |\n| --- | --- | --- | --- |\n' +
    '| K03 | 致命 | 技术审查员 | x |\n| T02 | 致命 | 技术审查员 | y |\n', 'utf8')
  writeFileSync(join(inherit, '02-blue.md'), '## 逐条处置\n\n| 用例 | 处置 |\n| --- | --- |\n| K03 | 已修 |\n', 'utf8')
  writeFileSync(join(inherit, '03-review.md'), '| 用例 | 级别 | 处置 | 位置 | 证据 |\n| --- | --- | --- | --- | --- |\n| K03 | 致命 | 已消除 | a:1 | x |\n', 'utf8')
  const inhSummary = readFileSync(join(tmp, 'R1-0101aa', '04-summary.md'), 'utf8')
  writeFileSync(join(inherit, '04-summary.md'), inhSummary, 'utf8')
  ok(cmdGate([join(inherit, '03-review.md')]) === 1, 'gate: 01-cases 自述「继承上一轮红队」→ GATE_UNATTACKED（转抄≠本轮攻击）')
  // 蓝队没执行
  const noBlue = join(tmp, 'R1-0101dd')
  mkdirSync(noBlue, { recursive: true })
  writeFileSync(join(noBlue, '01-cases.md'), '# 红队\n\n## 用例表\n\n| 编号 | 级别 | 维度 | 缺陷要点 |\n| --- | --- | --- | --- |\n| C01 | 一般 | 数据 | x |\n', 'utf8')
  writeFileSync(join(noBlue, '02-blue.md'), '# 蓝队\n\n（无逐条处置小节）\n', 'utf8')
  writeFileSync(join(noBlue, '03-review.md'), '| 用例 | 级别 | 处置 | 位置 | 证据 |\n| --- | --- | --- | --- | --- |\n| C01 | 一般 | 已消除 | a:1 | x |\n', 'utf8')
  ok(cmdGate([join(noBlue, '03-review.md')]) === 1, 'gate: 02-blue.md 缺「逐条处置」→ GATE_UNEXECUTED 不放行')

  // 6) 三态判定（吸收自 kill-argument 的 verdict 表）
  const af1 = join(tmp, 'R1-0101aa', 'adj-clean.md')
  writeFileSync(af1, '| 用例 | 判定 | 级别 | 位置 | 证据 |\n| --- | --- | --- | --- | --- |\n| N01 | 当前文本已答 | 一般 | a:1 | x |\n| N02 | 部分已答 | 优化 | a:2 | y |\n', 'utf8')
  ok(cmdAdjudicate([af1]) === 0, 'adjudicate: 无未解决 + 仅优化级部分已答 → PASS')

  const af2 = join(tmp, 'R1-0101aa', 'adj-unresolved.md')
  writeFileSync(af2, '| 用例 | 判定 | 级别 | 位置 | 证据 |\n| --- | --- | --- | --- | --- |\n| N01 | 仍未解决 | 致命 | a:1 | x |\n', 'utf8')
  ok(cmdAdjudicate([af2]) === 1, 'adjudicate: 有未解决的致命 → FAIL')

  const af3 = join(tmp, 'R1-0101aa', 'adj-partial-major.md')
  writeFileSync(af3, '| 用例 | 判定 | 级别 | 位置 | 证据 |\n| --- | --- | --- | --- | --- |\n| N01 | 部分已答 | 严重 | a:1 | x |\n', 'utf8')
  ok(cmdAdjudicate([af3]) === 1, 'adjudicate: 零未解决但严重级部分已答 → WARN（不许 PASS）')

  // 0 行绝不许静默 PASS —— 这是 M3/M6 同类「静默失真」缺陷的第三例
  const af4 = join(tmp, 'R1-0101aa', 'adj-empty.md')
  writeFileSync(af4, '| 用例 | 判定 | 级别 | 位置 | 证据 |\n| --- | --- | --- | --- | --- |\n| N01 | 成立 | 严重 | a:1 | x |\n', 'utf8')
  ok(cmdAdjudicate([af4]) === 2, 'adjudicate: 0 行可识别 → UNDECIDABLE(exit 2)，不许静默 PASS')

  // 7) recount 新表式（判定在第2列、级别在第3列，且写在非「逐条判定」标题下）
  const rf2 = join(tmp, 'R1-0101aa', 'recount-newlayout.md')
  writeFileSync(rf2, '# R4 红队复攻\n\n| 用例 | 判定 | 级别 | 位置 | 证据 |\n| --- | --- | --- | --- | --- |\n| N01 | 成立 | 严重 | a:1 | x |\n| N02 | 成立 | 一般 | a:2 | y |\n', 'utf8')
  const rows2 = parseVerdict(rf2)
  ok(rows2.length === 2 && rows2[0].level === '严重' && rows2[1].level === '一般',
    `recount 认「判定|级别」新表式且不依赖小节标题 ${JSON.stringify(rows2.map((r) => r.level))}`)

  // v6.29M：跨轮携带编号 `R10-N17` 必须认得 —— 「携带上一轮未闭合项」是本机制的核心要求，
  // 不认则 21 条只数出 17 条，闸门按错误的低计数放行。
  const rfCross = join(tmp, 'R1-0101aa', 'cross-id.md')
  writeFileSync(rfCross, '| 编号 | 级别 | 状态 | 位置 | 判据与证据 |\n| --- | --- | --- | --- | --- |\n| N01 | 严重 | 仍未解决 | a.md:1 | x |\n| R10-N17 | 一般 | 仍未解决 | a.md:2 | y |\n| R11-C03 | 优化 | 挂账 | a.md:3 | z |\n', 'utf8')
  const rowsCross = parseVerdict(rfCross)
  ok(rowsCross.length === 3 && rowsCross[1].id === 'R10-N17' && rowsCross[2].id === 'R11-C03',
    `parseVerdict 认跨轮携带编号（R10-N17 / R11-C03）${JSON.stringify(rowsCross.map((r) => r.id))}`)

  // 8) v6 闭环三件套
  const rrPrev = join(tmp, 'R1-0101aa', 'rr-prev.md')
  const rrCurr = join(tmp, 'R1-0101aa', 'rr-curr.md')
  writeFileSync(rrPrev, '| 用例 | 判定 | 级别 | 位置 | 证据 |\n| --- | --- | --- | --- | --- |\n| N01 | 当前文本已答 | 严重 | a:1 | x |\n| N02 | 当前文本已答 | 一般 | a:2 | y |\n| N03 | 当前文本已答 | 一般 | a:3 | z |\n', 'utf8')
  writeFileSync(rrCurr, '| 用例 | 判定 | 级别 | 位置 | 证据 |\n| --- | --- | --- | --- | --- |\n| N01 | 仍未解决 | 严重 | a:1 | x |\n| N02 | 当前文本已答 | 一般 | a:2 | y |\n| N04 | 当前文本已答 | 一般 | a:4 | w |\n', 'utf8')
  ok(cmdReattack([rrPrev, rrCurr]) === 1, 'reattack: 假修复(上轮已答→本轮仍未解决) → FAIL')

  // v6.29M：这条夹具原来写 3 行 → 1 行（重合率 33%），在新阈值下会（正确地）判 UNDECIDABLE ——
  // 因为「3 条只剩 1 条」更像换了对象，而不是「静默消失 2 条」。
  // 改成现实的「丢 1 条」场景：4 行 → 3 行（重合率 75%），才测得到 DROPPED。
  const rrPrev2 = join(tmp, 'R1-0101aa', 'rr-prev2.md')
  const rrCurr2 = join(tmp, 'R1-0101aa', 'rr-curr2.md')
  writeFileSync(rrPrev2, '| 用例 | 判定 | 级别 | 位置 | 证据 |\n| --- | --- | --- | --- | --- |\n| N01 | 当前文本已答 | 一般 | a:1 | x |\n| N02 | 当前文本已答 | 一般 | a:2 | y |\n| N03 | 当前文本已答 | 一般 | a:3 | z |\n| N05 | 当前文本已答 | 一般 | a:5 | q |\n', 'utf8')
  writeFileSync(rrCurr2, '| 用例 | 判定 | 级别 | 位置 | 证据 |\n| --- | --- | --- | --- | --- |\n| N01 | 当前文本已答 | 一般 | a:1 | x |\n| N02 | 当前文本已答 | 一般 | a:2 | y |\n| N03 | 当前文本已答 | 一般 | a:3 | z |\n', 'utf8')
  ok(cmdReattack([rrPrev2, rrCurr2]) === 1, 'reattack: 4→3 丢 1 条（重合率 75%）→ WARN（不许 PASS）')
  // 反过来：低重合率必须判 UNDECIDABLE，不许按编号碰撞报 FALSE_FIX/DROPPED
  // 夹具要用**真的对不上**的编号（重叠 0/3），否则测不到
  const rrLow = join(tmp, 'R1-0101aa', 'rr-low.md')
  writeFileSync(rrLow, '| 用例 | 判定 | 级别 | 位置 | 证据 |\n| --- | --- | --- | --- | --- |\n| X07 | 当前文本已答 | 一般 | a:7 | v |\n| X08 | 当前文本已答 | 一般 | a:8 | u |\n| X09 | 当前文本已答 | 一般 | a:9 | t |\n', 'utf8')
  ok(cmdReattack([rrPrev, rrLow]) === 2, 'reattack: 重合率 0% → UNDECIDABLE（不许按编号碰撞判假修复）')

  const rrSame = join(tmp, 'R1-0101aa', 'rr-same.md')
  const rrSame2 = join(tmp, 'R1-0101aa', 'rr-same2.md')
  const mk = (n) => { const ids = Array.from({ length: n }, (_, i) => 'N' + String(i + 1).padStart(2, '0')); return '| 用例 | 判定 | 级别 | 位置 | 证据 |\n| --- | --- | --- | --- | --- |\n' + ids.map((id) => '| ' + id + ' | 当前文本已答 | 一般 | a:1 | x |\n').join('') }
  writeFileSync(rrSame, mk(12), 'utf8')
  writeFileSync(rrSame2, mk(12), 'utf8')
  ok(cmdReattack([rrSame, rrSame2]) === 1, 'reattack: 12 条同集合全已答 → SUSPICIOUS')

  const rrEmpty = join(tmp, 'R1-0101aa', 'rr-empty.md')
  writeFileSync(rrEmpty, '| 用例 | 判定 | 级别 | 位置 | 证据 |\n| --- | --- | --- | --- | --- |\n| N01 | 通过 | 甲级 | a:1 | x |\n', 'utf8')
  ok(cmdReattack([rrEmpty, rrCurr]) === 2, 'reattack: 0 行可识别 → UNDECIDABLE(exit 2)')

  const svBad = join(tmp, 'R1-0101aa', 'sv-bad.md')
  writeFileSync(svBad, '| 用例 | 判定 | 级别 | 位置 | 证据 |\n| --- | --- | --- | --- | --- |\n| N01 | 成立 | 严重 | a:1 | x |\n| N02 | 成立 | 严重 | a:2 | x |\n| N03 | 成立 | 严重 | a:3 | x |\n| N04 | 成立 | 严重 | a:4 | x |\n', 'utf8')
  ok(cmdSeverity([svBad]) === 1, 'severity: 全部「严重」→ 分级失效 WARN')

  const svOk = join(tmp, 'R1-0101aa', 'sv-ok.md')
  writeFileSync(svOk, '| 用例 | 判定 | 级别 | 位置 | 证据 |\n| --- | --- | --- | --- | --- |\n| N01 | 成立 | 严重 | a:1 | x |\n| N02 | 成立 | 一般 | a:2 | x |\n| N03 | 成立 | 优化 | a:3 | x |\n', 'utf8')
  ok(cmdSeverity([svOk]) === 0, 'severity: 有区分度 → OK')

  // v6.29M：跨轮级别跳变必须比较**级别列**，不是状态桶。
  // 这个检查此前从未被自测覆盖，于是「比较了 0 行却报稳定」藏了很久。
  {
    const svPrev = join(tmp, 'R1-0101aa', 'sv-prev.md')
    const svCurr = join(tmp, 'R1-0101aa', 'sv-curr.md')
    // 状态列都是「已修」（会被 STATUS_MAP 映射成「已消除」，不在 ORDER 里）——这正是原先漏报的形态
    writeFileSync(svPrev, '| 编号 | 级别 | 状态 | 位置 | 判据与证据 |\n| --- | --- | --- | --- | --- |\n| N01 | 致命 | 已修 | a:1 | x |\n', 'utf8')
    writeFileSync(svCurr, '| 编号 | 级别 | 状态 | 位置 | 判据与证据 |\n| --- | --- | --- | --- | --- |\n| N01 | 一般 | 已修 | a:1 | x |\n', 'utf8')
    const seenSv = []
    const origSv = console.log
    console.log = (...a) => { seenSv.push(a.map(String).join(' ')); origSv(...a) }
    let rcSv = 0
    try { rcSv = cmdSeverity([svCurr, svPrev]) } finally { console.log = origSv }
    ok(rcSv === 1 && seenSv.some((s) => s.includes('SEVERITY_UNSTABLE')),
      'severity: 状态写「已修」时，级别列 致命→一般 仍须报 JUMP（原比较状态桶 → 整行跳过）')
    // 跨轮 0 条可比较 → 不许静默说「稳定」
    const svPrevOther = join(tmp, 'R1-0101aa', 'sv-prev-other.md')
    writeFileSync(svPrevOther, '| 编号 | 级别 | 状态 | 位置 | 判据与证据 |\n| --- | --- | --- | --- | --- |\n| M99 | 严重 | 已修 | a:9 | x |\n', 'utf8')
    const seenSv2 = []
    const origSv2 = console.error
    console.error = (...a) => { seenSv2.push(a.map(String).join(' ')); origSv2(...a) }
    let rcSv2 = 0
    try { rcSv2 = cmdSeverity([svCurr, svPrevOther]) } finally { console.error = origSv2 }
    ok(rcSv2 === 1 && seenSv2.some((s) => s.includes('SEVERITY_NO_COMPARABLE')),
      'severity: 跨轮 0 条可比较 → SEVERITY_NO_COMPARABLE（不许静默报稳定）')
  }

  const lg = join(tmp, 'R1-0101aa', 'legacy.md')
  writeFileSync(lg, '| 编号 | 级别（致命/严重/一般/优化） | 状态（已修/未修/STALE） | 问题位置 | 错误原因 |\n| --- | --- | --- | --- | --- |\n| C01 | — | 已修 | a:1 | x |\n| C02 | 严重 | 未修 | a:2 | y |\n', 'utf8')
  const lgRows = parseVerdict(lg)
  ok(lgRows.length === 2 && lgRows[0].level === '已消除' && lgRows[1].level === '挂账',
    'parseVerdict 认旧格式「—|已修」 ' + JSON.stringify(lgRows.map((r) => r.level)))

  // 9) bundle：引用的文件不存在 → 必须 FAIL
  const bd = join(tmp, 'R1-0101aa')
  const bf = join(bd, 'bundle-probe.md')
  writeFileSync(join(bd, 'exists.md'), 'line1\nline2\nline3\n', 'utf8')
  writeFileSync(bf, '| N01 | 成立 | 严重 | exists.md:2 | x |\n| N02 | 成立 | 一般 | gone.md:99 | y |\n', 'utf8')
  ok(cmdBundle([bf, '--root=' + bd]) === 1, 'bundle: 引用不存在的文件 → FAIL')
  const bf2 = join(bd, 'bundle-ok.md')
  writeFileSync(bf2, '| N01 | 成立 | 严重 | exists.md:2 | x |\n', 'utf8')
  ok(cmdBundle([bf2, '--root=' + bd]) === 0, 'bundle: 全部可落地 → OK')
  const bf3 = join(bd, 'bundle-range.md')
  writeFileSync(bf3, '| N01 | 成立 | 严重 | exists.md:99 | x |\n', 'utf8')
  ok(cmdBundle([bf3, '--root=' + bd]) === 1, 'bundle: 行号越界 → WARN')
  // v6.29M：v6.26 缺陷29 的「修法」注释写了但代码没写（本轮补上）—— 引用未附引文要报 UNVERIFIED
  {
    writeFileSync(join(bd, 'q.md'), 'L1\nL2\nL3\n', 'utf8')
    const noQuote = join(bd, 'b-noquote.md')
    writeFileSync(noQuote, '| N01 | 成立 | 严重 | q.md:2 | 已改 |\n', 'utf8')
    const withQuote = join(bd, 'b-withquote.md')
    writeFileSync(withQuote, '| N01 | 成立 | 严重 | q.md:2 | 已改为「L2」 |\n', 'utf8')
    const seenU = []
    const origU = console.error
    console.error = (...a) => { seenU.push(a.map(String).join(' ')); origU(...a) }
    let rcU1 = 0; let rcU2 = 0; let seenU1 = []
    try {
      rcU1 = cmdBundle([noQuote, '--root=' + bd])
      seenU1 = seenU.slice() // 先快照：清空数组的目的是隔离两次调用，不是抹掉第一条的证据
      seenU.length = 0
      rcU2 = cmdBundle([withQuote, '--root=' + bd])
    } finally { console.error = origU }
    ok(rcU1 === 0 && seenU1.some((s) => s.includes('BUNDLE_UNVERIFIED')), 'bundle: 引用未附引文 → BUNDLE_UNVERIFIED（内容未核）')
    ok(rcU2 === 0 && !seenU.some((s) => s.includes('BUNDLE_UNVERIFIED')), 'bundle: 引用附引文 → 不报 UNVERIFIED')
    // 跨目录解析：引用只存在于 --root 指向的别的目录 → OK 行必须说出解析到哪儿
    const rootDir = join(tmp, 'farroot')
    mkdirSync(rootDir, { recursive: true })
    writeFileSync(join(rootDir, 'far.md'), 'L1\nL2\nL3\n', 'utf8')
    const crossRef = join(bd, 'b-cross.md')
    writeFileSync(crossRef, '| N01 | 成立 | 严重 | far.md:2 | x |\n', 'utf8')
    const seenL = []
    const origL = console.log
    console.log = (...a) => { seenL.push(a.map(String).join(' ')); origL(...a) }
    try { cmdBundle([crossRef, '--root=' + rootDir]) } finally { console.log = origL }
    ok(seenL.some((s) => s.includes('解析到本目录之外') && s.includes('far.md')), 'bundle: 引用解析到本目录之外 → OK 行指出来源路径')
  }
  // 10) converge：用例集冻结 → 不许 PASS
  const cvRoot = join(tmp, 'R1-0101aa', 'cvrounds')
  mkdirSync(cvRoot, { recursive: true })
  const mkRound = (name, ids, fatal) => {
    const d = join(cvRoot, name); mkdirSync(d, { recursive: true })
    const head = '| 用例 | 判定 | 级别 | 位置 | 证据 |\n| --- | --- | --- | --- | --- |\n'
    const body = ids.map((id, i) => `| ${id} | ${fatal && i === 0 ? '仍未解决' : '当前文本已答'} | ${fatal && i === 0 ? '致命' : '一般'} | a:${i} | x |\n`).join('')
    writeFileSync(join(d, '03-review.md'), head + body, 'utf8')
  }
  const ids12 = Array.from({ length: 12 }, (_, i) => 'C' + String(i + 1).padStart(2, '0'))
  mkRound('R1-t1', ids12, false); mkRound('R2-t1', ids12, false)
  ok(cmdConverge([cvRoot, '--track=t1']) === 1, 'converge: 两轮用例集一字不差全已答 → 不许 PASS（没重新攻击）')

  // 10b) converge：**机制外独立评审**解除「用例集冻结」
  //
  // 为什么必须测这一条（R14 真实教训）：converge 硬要求「换过红队/换过模型」，
  // 而本机只有一个 provider，这条判据在这台机器上永远无法满足 → 永远 NOT_YET。
  // 但「把三份 MD 交给 5 个外部 AI」恰恰是真正的跨厂商独立证据：
  // 它们在同一个问题上给出了实质分歧（4 票 vs 1 票），主控据此实算后发现双方都错。
  // 所以新增 `attack record-ext` 让这种证据能被登记，并让 converge 认它。
  const cvRootExt = join(tmp, 'R1-0101aa', 'cvrounds-ext')
  mkdirSync(cvRootExt, { recursive: true })
  const mkRoundE = (name, ids) => {
    const d = join(cvRootExt, name); mkdirSync(d, { recursive: true })
    const head = '| 用例 | 判定 | 级别 | 位置 | 证据 |\n| --- | --- | --- | --- | --- |\n'
    const body = ids.map((id, i) => `| ${id} | 当前文本已答 | 一般 | a:${i} | x |\n`).join('')
    writeFileSync(join(d, '03-review.md'), head + body, 'utf8')
    return d
  }
  const idsE = Array.from({ length: 12 }, (_, i) => 'C' + String(i + 1).padStart(2, '0'))
  mkRoundE('R1-te', idsE)
  const d2e = mkRoundE('R2-te', idsE)
  // 对照：不登记外部评审 → 冻结 → NOT_YET
  ok(cmdConverge([cvRootExt, '--track=te']) === 1, 'converge: 用例集一字不差且无外部评审 → NOT_YET（冻结）')
  // 登记一份机制外独立评审（指向当前交付件指纹）→ 解除冻结
  const artE = join(d2e, 'artifact.md')
  writeFileSync(artE, 'dummy artifact for ext review\n', 'utf8')
  const rcExt = cmdAttack(['record-ext', d2e, 'ext-reviewer-A', artE, '外部 AI 转贴'])
  const rcPass = cmdConverge([cvRootExt, '--track=te'])
  ok(rcExt === 0 && rcPass === 0, 'converge: 最新一轮有机制外独立评审 → 不判用例集冻结（跨厂商独立性可登记）')
  // 负例：外部评审记录的是**旧交付件**的指纹 → 不算（对旧版的意见不能算在新版账上）
  const artE2 = join(d2e, 'artifact-v2.md')
  writeFileSync(artE2, 'a different, newer artifact\n', 'utf8')
  const rcExt2 = cmdAttack(['record', d2e, 'longcat', 'X', artE2])
  const rcStale = cmdConverge([cvRootExt, '--track=te'])
  ok(rcExt2 === 0 && rcStale === 1, 'converge: 换了交付件后，旧指纹上的外部评审不计入（不算冻结解除）')

  // converge：用例集真的演化 + 连续干净 → PASS
  const cvRoot2 = join(tmp, 'R1-0101aa', 'cvrounds2')
  mkdirSync(cvRoot2, { recursive: true })
  const mkRound2 = (name, ids) => {
    const d = join(cvRoot2, name); mkdirSync(d, { recursive: true })
    const head = '| 用例 | 判定 | 级别 | 位置 | 证据 |\n| --- | --- | --- | --- | --- |\n'
    const body = ids.map((id, i) => `| ${id} | 当前文本已答 | 一般 | a:${i} | x |\n`).join('')
    writeFileSync(join(d, '03-review.md'), head + body, 'utf8')
  }
  const evo1 = Array.from({ length: 12 }, (_, i) => 'C' + String(i + 1).padStart(2, '0'))
  const evo2 = [...Array.from({ length: 10 }, (_, i) => 'C' + String(i + 1).padStart(2, '0')), 'N01', 'N02']
  mkRound2('R1-t2', evo1); mkRound2('R2-t2', evo2)
  ok(cmdConverge([cvRoot2, '--track=t2']) === 0, 'converge: 用例集演化 + 连续干净 → PASS')

  // converge：按课题分组，不能把两条独立线混成一条
  const cvRoot3 = join(tmp, 'R1-0101aa', 'cvrounds3')
  mkdirSync(cvRoot3, { recursive: true })
  const mkR = (name, n, fatal, shift = 0) => {
    const d = join(cvRoot3, name); mkdirSync(d, { recursive: true })
    const head = '| 用例 | 判定 | 级别 | 位置 | 证据 |\n| --- | --- | --- | --- | --- |\n'
    const body = Array.from({ length: n }, (_, i) => `| C${String(i + 1 + shift).padStart(2, '0')} | ${fatal && i === 0 ? '仍未解决' : '当前文本已答'} | ${fatal && i === 0 ? '致命' : '一般'} | a:${i} | x |\n`).join('')
    writeFileSync(join(d, '03-review.md'), head + body, 'utf8')
  }
  mkR('R1-tA', 12, false); mkR('R1-tB', 12, true); mkR('R2-tA', 12, false, 2)
  ok(cmdConverge([cvRoot3, '--track=tA']) === 0, 'converge --track=tA: 不被另一条线（tB 有致命）拖累')

  // converge：**最新一轮不干净时不得沿用历史干净轮次**（v6.29o 修的真实 bug）
  // 旧实现里"有未闭合项"那一支只打印不中断循环，于是"连续干净轮数"实际数成了
  // "历史上总共几个干净轮" —— 实测 R8 有未闭合严重项，streak 仍是 3 → 误判 PASS。
  const cvRootZ = join(tmp, 'R1-0101aa', 'cvrounds-z')
  mkdirSync(cvRootZ, { recursive: true })
  const mkRZ = (name, ids, openId) => {
    const d = join(cvRootZ, name)
    mkdirSync(d, { recursive: true })
    const head = '| 用例 | 判定 | 级别 | 位置 | 证据 |\n| --- | --- | --- | --- | --- |\n'
    const body = ids.map((id, i) => `| ${id} | ${id === openId ? '仍未解决' : '当前文本已答'} | ${id === openId ? '严重' : '一般'} | a:${i} | x |\n`).join('')
    writeFileSync(join(d, '03-review.md'), head + body, 'utf8')
  }
  mkRZ('R1-tz', ['C01', 'C02'], null)
  mkRZ('R2-tz', ['C01', 'C02', 'N01'], null)
  mkRZ('R3-tz', ['C01', 'C02', 'N01', 'N02'], 'N02')
  ok(cmdConverge([cvRootZ, '--track=tz']) === 1, 'converge: 最新一轮有未闭合严重项 → 不得沿用历史干净轮次（NOT_YET）')

  // attack：记录交付件指纹；指纹与当前候选稿不符时 gate 必须拦。
  // 为什么必须自测：今天已有两次"手工验过以为有护栏"最后发现是名义的（gate 的 attacked 就是其中之一）。
  const atk = join(tmp, 'atk-round')
  mkdirSync(atk, { recursive: true })
  const atkArt = join(atk, '06-candidate-x.md')
  writeFileSync(atkArt, '# candidate v1\nsome body\n', 'utf8')
  ok(cmdAttack(['record', atk, 'prov-x', 'model-x', atkArt, 'red']) === 0, 'attack record: 写入 red-attack.json → exit 0')
  const atkDoc = JSON.parse(readFileSync(join(atk, 'red-attack.json'), 'utf8'))
  ok(atkDoc.attackers.length === 1 && String(atkDoc.artifactSha256_16).length === 16,
    'attack record: 同时记录攻击者与 16 位交付件指纹')
  // 构造一个"本该放行"的最小轮次，再分别验证：无记录 → 放行(仅提示)；指纹过期 → 拦截
  writeFileSync(join(atk, '02-blue.md'), '## 逐条处置\n\n| 编号 | 处置 | 说明 |\n| --- | --- | --- |\n| C01 | 已处置 | 补限定 |\n', 'utf8')
  writeFileSync(join(atk, '01-cases.md'), '| 编号 | 级别 | 状态 | 红队 |\n| --- | --- | --- | --- |\n| C01 | 一般 | 未修 | red-x |\n', 'utf8')
  writeFileSync(join(atk, '03-review.md'), '| 编号 | 级别 | 状态 |\n| --- | --- | --- |\n| C01 | 一般 | 已消除 |\n', 'utf8')
  const rep = (s) => Array.from({ length: 5 }, () => s).join('\n\n')
  writeFileSync(join(atk, '04-summary.md'),
    '## 证据落地\n\n' + rep('证据：命令输出与文件行号逐一记录，格式为「文件:行号 + 命令 + 输出」。') + '\n\n'
    + '## 设想 vs 实际\n\n' + rep('设想 A 被数据推翻，改成 B；设想 C 成立但理由换了。逐条记录改写的依据与影响范围。') + '\n\n'
    + '## 未覆盖范围\n\n' + rep('环境不允许：无。主控没问人：无。此处如实声明两项分类，避免把失职写成环境限制。') + '\n', 'utf8')
  asOld(join(atk, '03-review.md'))
  ok(cmdGate([join(atk, '03-review.md')]) === 0, 'gate: 历史轮次 + 指纹匹配 + 有 01-cases → 放行（严格模式只对新轮次生效）')
  writeFileSync(atkArt, '# candidate v2 changed after the attack\nsome body\n', 'utf8')
  ok(cmdGate([join(atk, '03-review.md')]) === 1, 'gate: 交付件已变而 red-attack 指纹未更新 → GATE_ATTACK_STALE 拦截')

  // 定级合理性：未闭合的严重必须能定位。构造一个"严重但位置栏没有 L行号"的轮次。
  const sev = join(tmp, 'sev-round')
  mkdirSync(sev, { recursive: true })
  const sevArt = join(sev, '06-candidate-y.md')
  writeFileSync(sevArt, '# candidate y\nbody\n', 'utf8')
  ok(cmdAttack(['record', sev, 'prov-y', 'model-y', sevArt, 'red']) === 0, 'attack record: 为严重度用例建立指纹')
  writeFileSync(join(sev, '02-blue.md'), '## 逐条处置\n\n| 编号 | 处置 | 说明 |\n| --- | --- | --- |\n| C09 | 未处置 | 待下一轮 |\n', 'utf8')
  writeFileSync(join(sev, '01-cases.md'), '| 编号 | 级别 | 状态 | 红队 |\n| --- | --- | --- | --- |\n| C09 | 严重 | 未修 | red-y |\n', 'utf8')
  writeFileSync(join(sev, '04-summary.md'),
    '## 证据落地\n\n' + rep('证据：命令输出与文件行号逐一记录。') + '\n\n'
    + '## 设想 vs 实际\n\n' + rep('设想 A 被推翻，改成 B。') + '\n\n'
    + '## 未覆盖范围\n\n' + rep('环境不允许：无。主控没问人：无。') + '\n', 'utf8')
  writeFileSync(join(sev, '03-review.md'), '# 裁决表\n\n| 编号 | 级别 | 状态 | 位置 |\n| --- | --- | --- | --- |\n| C09 | 严重 | 未修 | 见附录讨论 |\n', 'utf8')
  ok(cmdGate([join(sev, '03-review.md')]) === 1, 'gate: 未闭合的严重但位置栏无可定位行号 → GATE_SEVERE_UNLOCATABLE 拦截')
  // 已闭合的严重应豁免位置检查（否则会回溯判死历史轮次里已给出证据的行）
  writeFileSync(join(sev, '02-blue.md'), '## 逐条处置\n\n| 编号 | 处置 | 说明 |\n| --- | --- | --- |\n| C09 | 已处置 | 补了位置 |\n', 'utf8')
  writeFileSync(join(sev, '03-review.md'), '# 裁决表\n\n| 编号 | 级别 | 状态 | 位置 |\n| --- | --- | --- | --- |\n| C09 | 严重 | 已消除 | 见正文 |\n', 'utf8')
  asOld(join(sev, '03-review.md'))
  ok(cmdGate([join(sev, '03-review.md')]) === 0, 'gate: 历史轮次 + 已消除的严重 → 豁免位置检查（不回溯误伤）')

  // 位置里的行号存在，但被引行内容对不上判据 → GATE_SEVERE_MISLOCATED
  writeFileSync(join(sev, '02-blue.md'), '## 逐条处置\n\n| 编号 | 处置 | 说明 |\n| --- | --- | --- |\n| C09 | 未处置 | 待下一轮 |\n', 'utf8')
  writeFileSync(join(sev, '03-review.md'), '# 裁决表\n\n| 编号 | 级别 | 状态 | 位置 | 判据 |\n| --- | --- | --- | --- | --- |\n| C09 | 严重 | 未修 | v7 L2 | 与 reconciliation 计数不闭合有关 |\n', 'utf8')
  ok(cmdGate([join(sev, '03-review.md')]) === 1, 'gate: 行号存在但被引行不含判据的稀有词 → GATE_SEVERE_MISLOCATED 拦截')
  // 严重级别必须有可核方法；缺失类断言必须 ≥2 条独立方法
  writeFileSync(join(sev, '03-review.md'), '# 裁决表\n\n| 编号 | 级别 | 状态 | 位置 | 判据 | 证据 |\n| --- | --- | --- | --- | --- | --- |\n| C09 | 严重 | 未修 | v7 L2 | body | 我觉得有问题 |\n', 'utf8')
  ok(cmdGate([join(sev, '03-review.md')]) === 1, 'gate: 严重但证据里没有任何可核方法 → GATE_SEVERE_UNVERIFIED 拦截')
  writeFileSync(join(sev, '03-review.md'), '# 裁决表\n\n| 编号 | 级别 | 状态 | 位置 | 判据 | 证据 |\n| --- | --- | --- | --- | --- | --- |\n| C09 | 严重 | 未修 | v7 L2 | body | occur 显示 0 处 |\n', 'utf8')
  ok(cmdGate([join(sev, '03-review.md')]) === 1, 'gate: 缺失类断言只有 1 种方法 → GATE_SEVERE_UNVERIFIED 拦截')
  writeFileSync(join(sev, '03-review.md'), '# 裁决表\n\n| 编号 | 级别 | 状态 | 位置 | 判据 | 证据 |\n| --- | --- | --- | --- | --- | --- |\n| C09 | 严重 | 未修 | v7 L2 | body | occur 显示 0 处，xcheck 亦未见 |\n', 'utf8')
  // 注意：未修的严重项本来就会让闸门 exit 1（GATE: 进下一轮），
  // 所以不能拿"退出 0"来证明 UNVERIFIED 没触发 —— 直接捕获该诊断码。
  {
    const seen = []
    const orig = console.error
    console.error = (...a) => { const s = a.map(String).join(' '); seen.push(s); orig(...a) }
    cmdGate([join(sev, '03-review.md')])
    console.error = orig
    ok(!seen.some((s) => s.includes('GATE_SEVERE_UNVERIFIED')), 'gate: 缺失类断言有 2 种独立方法 → 不触发 GATE_SEVERE_UNVERIFIED')
  }

  // 「设想 vs 实际」不能靠空泛表述糊过去：有 3 行但没写"推翻/改成"，也不声明"本轮无推翻" → 必须拦
  const rec = join(tmp, 'rec-round')
  mkdirSync(rec, { recursive: true })
  copyFileSync(join(atk, '01-cases.md'), join(rec, '01-cases.md'))
  copyFileSync(join(atk, '02-blue.md'), join(rec, '02-blue.md'))
  copyFileSync(join(atk, '03-review.md'), join(rec, '03-review.md'))
  writeFileSync(join(rec, '04-summary.md'),
    '## 证据落地\n\n- 证据一：`scancheck` 输出 SCAN_CLEAN，exit 0。\n- 证据二：`recount` 输出 已消除=1，与判定表一致。\n- 证据三：`metrics` body_words 已记录，与上一版相差 0。\n\n'
    + '## 设想 vs 实际\n\n- 设想甲：以为页数会变。实测词数不变，页数结论不动。\n- 设想乙：以为要重排版。实测无需，沿用上一版排版。\n- 两处都核对过，未发现需要改写的地方。\n\n'
    + '## 未覆盖范围\n\n- 环境不允许：独立复核未完成。\n- 主控没问人：无。\n- 其它：无。\n', 'utf8')
  ok(cmdGate([join(rec, '03-review.md')]) === 1, 'gate: 「设想 vs 实际」只写结论一致而不写推翻/声明 → GATE_NO_RECONCILE_CONTENT 拦截')
  writeFileSync(join(rec, '04-summary.md'),
    '## 证据落地\n\n- 证据一：`scancheck` 输出 SCAN_CLEAN、exit 0，逐项检查四类残留。\n- 证据二：`recount` 输出 已消除=1 挂账=0，与判定表逐行一致。\n- 证据三：`metrics` 的 body_words 已记录，与上一版相差 0 词。\n\n'
    + '## 设想 vs 实际\n\n- 设想甲：以为修订会改变页数。实测词数不变，页数结论不动，量化依据见本轮的 metrics 输出。\n- 设想乙：以为需要重新排版。实测无需，沿用上一版的排版参数与四张图，页数不受影响。\n- 两处都已核对，本轮无假设被推翻。\n\n'
    + '## 未覆盖范围\n\n- 环境不允许：独立红队复核尚未完成，本版没有 red-attack.json 记录，gate 会报 NOTICE_ATTACK_MISSING。\n- 主控没问人：无，本轮不依赖任何用户侧事实，也不需要外部输入。\n- 其它：页数未在期刊官方模板下核实，沙箱打不开对应站点。\n', 'utf8')
  ok(cmdGate([join(rec, '03-review.md')]) === 0, 'gate: 显式声明"本轮无假设被推翻" → 放行（把沉默变成声明即可）')
  // 引用一个判定表里不存在的用例编号 → GATE_RECONCILE_FAKE_REF
  writeFileSync(join(rec, '04-summary.md'),
    '## 证据落地\n\n- 证据一：`scancheck` 输出 SCAN_CLEAN、exit 0，逐项检查四类残留。\n- 证据二：`recount` 输出 已消除=1 挂账=0，与判定表逐行一致。\n- 证据三：`metrics` 的 body_words 已记录，与上一版相差 0 词。\n\n'
    + '## 设想 vs 实际\n\n- 设想甲：以为 C99 那条会被推翻。实测确实推翻了，改成新写法。\n- 设想乙：以为需要重排版。实测无需，沿用上一版排版参数与四张图。\n- 两处都已核对，依据见本轮命令输出。\n\n'
    + '## 未覆盖范围\n\n- 环境不允许：独立红队复核尚未完成，本版没有 red-attack.json 记录。\n- 主控没问人：无，本轮不依赖任何用户侧事实，也不需要外部输入。\n- 其它：页数未在期刊官方模板下核实，沙箱打不开对应站点。\n', 'utf8')
  ok(cmdGate([join(rec, '03-review.md')]) === 1, 'gate: 设想节引用了判定表里不存在的用例编号 → GATE_RECONCILE_FAKE_REF 拦截')

  // 账目闭合接入闸门：identities spec 存在但不成立 → 拦；成立 → 放
  const idn = join(tmp, 'idn-round')
  mkdirSync(idn, { recursive: true })
  for (const f of ['01-cases.md', '02-blue.md', '03-review.md', '04-summary.md']) {
    copyFileSync(join(atk, f), join(idn, f))
  }
  const idBadSpec = join(idn, 'identities-x.json')
  writeFileSync(idBadSpec, JSON.stringify({ values: { a: 141, b: 23 }, identities: ['a + b === 165'] }), 'utf8')
  ok(cmdGate([join(idn, '03-review.md')]) === 1, 'gate: identities 恒等式不成立 → GATE_IDENT_FAIL 拦截')
  writeFileSync(idBadSpec, JSON.stringify({ values: { a: 141, b: 23 }, identities: ['a + b === 164'] }), 'utf8')
  ok(cmdGate([join(idn, '03-review.md')]) === 0, 'gate: identities 恒等式成立 → 放行')

  // occur：出现次数不符 → 拦；全部符合 → 放
  const ocSpec = join(idn, 'occur-x.json')
  const idnArt = join(atk, '06-candidate-x.md')
  writeFileSync(ocSpec, JSON.stringify({ file: idnArt, checks: [{ name: '旧说法', regex: 'candidate v2', expect: 0, why: '已改，不该再有' }] }), 'utf8')
  ok(cmdGate([join(idn, '03-review.md')]) === 1, 'gate: occur 期望 0 但仍有命中 → GATE_OCCUR_FAIL 拦截')
  writeFileSync(ocSpec, JSON.stringify({ file: idnArt, checks: [{ name: '旧说法', regex: 'IMPOSSIBLE_TOKEN_XYZ', expect: 0 }] }), 'utf8')
  ok(cmdGate([join(idn, '03-review.md')]) === 0, 'gate: occur 全部符合期望 → 放行')
  // occur draft：先把次数量出来再写 spec，避免"凭猜填 expect"
  const draftOut = join(idn, 'draft.json')
  ok(cmdOccur(['draft', idnArt, '--out', draftOut]) === 0, 'occur draft: 扫描并写骨架 → exit 0')
  const draftSpec = JSON.parse(readFileSync(draftOut, 'utf8').replace(/^\uFEFF/, ''))
  ok(draftSpec.checks.every((c) => Number.isInteger(c.expect)), 'occur draft: 骨架里每个 expect 都是实测整数（不是占位符）')
  // 回归：带 g 标志的 RegExp.test 是**有状态**的（推进 lastIndex）。
  // 曾经只在循环外重置一次，导致连续多行命中时被跳行、计数偏低（实测 21 处数成 19 处）。
  const rep3 = join(idn, 'repeat3.md')
  writeFileSync(rep3, 'tok 100 here\ntok 100 again\ntok 100 third\n', 'utf8')
  const repSpec = join(idn, 'occur-rep.json')
  writeFileSync(repSpec, JSON.stringify({ file: rep3, checks: [{ name: '三行都含 100 应为 3 处', regex: '100', expect: 3 }] }), 'utf8')
  ok(cmdOccur([repSpec]) === 0, 'occur: 连续三行都命中 → 计数为 3（回归 g 正则 lastIndex 状态 bug）')
  // 扫描范围：body 与 all 必须给出不同的计数（"量的范围划错"是主控当天第 4 次犯的错）
  const scFile = join(idn, 'scope.md')
  writeFileSync(scFile, 'Body has TOKEN here.\n\n## References\n\n1. Ref also has TOKEN here.\n', 'utf8')
  const scAll = join(idn, 'occur-scope-all.json')
  const scBody = join(idn, 'occur-scope-body.json')
  writeFileSync(scAll, JSON.stringify({ file: scFile, checks: [{ name: 'TOKEN 全文', regex: 'TOKEN', expect: 2 }] }), 'utf8')
  writeFileSync(scBody, JSON.stringify({ file: scFile, scope: 'body', checks: [{ name: 'TOKEN 正文', regex: 'TOKEN', expect: 1 }] }), 'utf8')
  ok(cmdOccur([scAll]) === 0, 'occur: 默认 scope=all → 正文与参考表都算（2 处）')
  ok(cmdOccur([scBody]) === 0, 'occur: scope=body → 只算 References 之前（1 处）')
  // 列错位：级别与状态写反 → 统计全部失真，必须拦（今晚真的污染过四个命令）
  const swapFile = join(idn, 'swapped.md')
  writeFileSync(swapFile, '# 裁决表\n\n| 编号 | 级别 | 状态 |\n| --- | --- | --- |\n| C01 | 已消除 | 严重 |\n', 'utf8')
  ok(detectColumnSwap(swapFile).length === 1, 'detectColumnSwap: 级别与状态写反 → 命中 1 行')
  writeFileSync(swapFile, '# 裁决表\n\n| 编号 | 级别 | 状态 |\n| --- | --- | --- |\n| C01 | 严重 | 已消除 |\n', 'utf8')
  ok(detectColumnSwap(swapFile).length === 0, 'detectColumnSwap: 正常顺序 → 不误报')
  writeFileSync(swapFile, '# 裁决表\n\n| 编号 | 级别 | 状态 |\n| --- | --- | --- |\n| C01 | 已消除 | 严重 |\n', 'utf8')
  writeFileSync(swapFile, '# 裁决表\n\n| 编号 | 级别 | 状态 |\n| --- | --- | --- |\n| C01 | 已消除 | 严重 |\n', 'utf8')
  ok(cmdRecount([swapFile]) === 2, 'recount: 列错位 → SUSPECT_COLUMN_SWAP 并以非零退出')
  // 闸门级别：列错位不得放行（造一个完整轮次，只把判定表两列写反）
  const swp = join(tmp, 'swp-round')
  mkdirSync(swp, { recursive: true })
  for (const f of ['01-cases.md', '02-blue.md', '04-summary.md']) copyFileSync(join(idn, f), join(swp, f))
  writeFileSync(join(swp, '03-review.md'), '# 裁决表\n\n| 编号 | 级别 | 状态 |\n| --- | --- | --- |\n| C01 | 已消除 | 一般 |\n', 'utf8')
  ok(cmdGate([join(swp, '03-review.md')]) === 1, 'gate: 判定表两列写反 → GATE_COLUMN_SWAP 拦截')

  // xcheck：两条独立路径互校
  const xcOk = join(idn, 'xc-ok.md')
  writeFileSync(xcOk, 'This is a short English paragraph with several words in it. It has two sentences.\n', 'utf8')
  ok(cmdXcheck([xcOk]) === 0, 'xcheck: 英文散文两条路径一致 → XCHECK_OK exit 0')
  const xcCjk = join(idn, 'xc-cjk.md')
  writeFileSync(xcCjk, '# 裁决表\n\n这是一段中文，词数在中文里没有明确定义，应当被跳过而不是硬比。\n', 'utf8')
  ok(cmdXcheck([xcCjk]) === 0, 'xcheck: 中文文本 → 词数跳过（不是判通过，是不可比）且 exit 0')
  const xcBad = join(idn, 'xc-bad.md')
  writeFileSync(xcBad, '# 裁决表\n\n| 编号 | 级别 | 状态 |\n| --- | --- | --- |\n| C01 | 严重 | 未修 |\n| C02 | 严重 | 未修 | 多一列 |\n| C03 | 一般 |\n', 'utf8')
  ok(cmdXcheck([xcBad]) === 2, 'xcheck: 畸形表格使两个解析器行数不一致 → XCHECK_DISAGREE exit 2')
  // 11) R5 红队探测回归：编号形态 + 空表
  const pr = join(tmp, 'R1-0101aa')
  const wf = (n, body) => { const q = join(pr, n); writeFileSync(q, body, 'utf8'); return q }
  const wNum = wf('num-ids.md', '# x\n\n| 编号 | 判定 | 级别 | 位置 | 证据 |\n| --- | --- | --- | --- | --- |\n| 1 | 成立 | 致命 | a:1 | x |\n| 2 | 成立 | 严重 | a:2 | y |\n')
  ok(cmdRecount([wNum]) === 0, 'recount: 纯数字编号 1/2 能被识别')
  const wDash = wf('dash-ids.md', '# x\n\n| 编号 | 判定 | 级别 | 位置 | 证据 |\n| --- | --- | --- | --- | --- |\n| C-01 | 成立 | 致命 | a:1 | x |\n')
  ok(cmdRecount([wDash]) === 0, 'recount: 带连字符编号 C-01 能被识别')
  const wEmpty = wf('empty.md', '# x\n\n（本轮无判定行）\n')
  ok(cmdRecount([wEmpty]) === 2, 'recount: 0 行 → exit 2（空表不等于通过）')
  ok(cmdGate([wEmpty]) === 2, 'gate: 0 行 → exit 2（没有结论不等于全部通过）')
  ok(cmdGate([wNum]) === 1, 'gate: 2 条致命/严重 → 不放行')
  // 12) R5 红队 e7b：29 条全「成立」全「一般」→ 分级失效，必须报警
  const wUniform = wf('uniform-minor.md', '# x\n\n| 编号 | 判定 | 级别 | 位置 | 证据 |\n| --- | --- | --- | --- | --- |\n' + Array.from({ length: 29 }, (_, i) => `| C${String(i + 1).padStart(2, '0')} | 成立 | 一般 | a:${i} | x |\n`).join(''))
  ok(cmdSeverity([wUniform]) === 1, 'severity: 29 条全「成立」全「一般」→ 分级失效必须报警')
  // 13) R5 红队 N05：旧格式「级别 + 状态」两列必须都保住
  const wFatalUnfixed = wf('fatal-unfixed.md', '# x\n\n| 编号 | 级别 | 状态 | 问题位置 | 错误原因 |\n| --- | --- | --- | --- | --- |\n' + Array.from({ length: 10 }, (_, i) => `| C${String(i + 1).padStart(2, '0')} | 致命 | 未修 | a:${i} | x |\n`).join(''))
  ok(cmdGate([wFatalUnfixed]) === 1, 'gate: 10 条「致命+未修」必须不放行（级别列不许被状态列掩盖）')
  // 14) R5 红队第二实例：两个命令不许对同一批数据给出相反结论
  const mkConv = (name, verdict, level) => {
    const q = join(tmp, name)
    mkdirSync(q, { recursive: true })
    writeFileSync(join(q, '03-review.md'), `# x\n\n| 编号 | 判定 | 级别 | 位置 | 证据 |\n| --- | --- | --- | --- | --- |\n| N01 | ${verdict} | ${level} | a:1 | x |\n`, 'utf8')
    return q
  }
  mkConv('R2-cvA', '当前文本已答', '一般')
  mkConv('R2-cvB', '仍未解决', '一般')
  const cvRoot4 = join(tmp, 'conv-root')
  mkdirSync(cvRoot4, { recursive: true })
  const rA = join(cvRoot4, 'R2-cvA')
  const rB = join(cvRoot4, 'R2-cvB')
  mkdirSync(rA, { recursive: true }); mkdirSync(rB, { recursive: true })
  writeFileSync(join(rA, '03-review.md'), '# x\n\n| 编号 | 判定 | 级别 | 位置 | 证据 |\n| --- | --- | --- | --- | --- |\n| N01 | 当前文本已答 | 一般 | a:1 | x |\n', 'utf8')
  writeFileSync(join(rB, '03-review.md'), '# x\n\n| 编号 | 判定 | 级别 | 位置 | 证据 |\n| --- | --- | --- | --- | --- |\n| N01 | 仍未解决 | 一般 | a:2 | y |\n', 'utf8')
  ok(cmdConverge([cvRoot4, '--n=2']) === 1, 'converge: 上轮说已修、本轮又开 → 不许判 PASS（必须与 reattack 一致）')
  // 自然序：字典序会把 R10 排到 R2 前面、v13 排到 v7 前面 —— 会算错"连续干净轮数"，
  // 也会让 gate 拿旧版候选稿的指纹去核新版。实测整晚 converge 的 NOT_YET 就是这个 bug 造成的。
  ok(natCmp('R10-1108r1', 'R2-1108h1') > 0, 'natCmp: R10 排在 R2 之后（字典序会排反）')
  ok(natCmp('R9-1108q1', 'R10-1108r1') < 0, 'natCmp: R9 在 R10 之前')
  ok(natCmp('06-candidate-v13.md', '06-candidate-v7.md') > 0, 'natCmp: v13 排在 v7 之后（否则 gate 会拿 v7 核 v13）')
  // 15) R5 红队第二实例：「不成立」是结案，不是未解决
  const wRejected = wf('rejected.md', '# x\n\n| 用例 | 判定 | 级别 | 位置 | 证据 |\n| --- | --- | --- | --- | --- |\n| N01 | 不成立 | 严重 | a:1 | 有反证 |\n| N02 | 不成立 | 致命 | a:2 | 有反证 |\n')
  ok(cmdAdjudicate([wRejected]) === 0, 'adjudicate: 2 条「不成立」→ PASS（驳回即结案，不是仍未解决）')

  // 16) v6.24 缺陷28：表外「一般+优化」超容差 → 不放行
  const offRoot = join(tmp, 'R1-offroot')
  mkdirSync(offRoot, { recursive: true })
  writeFileSync(join(offRoot, '01-cases.md'), '# 红队\n\n## 用例表\n\n| 编号 | 级别 |\n| --- | --- |\n| C01 | 一般 |\n', 'utf8')
  writeFileSync(join(offRoot, '02-blue.md'), '## 逐条处置\n\n| 用例 | 处置 |\n| --- | --- |\n| C01 | 已修 |\n', 'utf8')
  // 判定表干净（0 致命 0 严重），但表外散着 4 条一般
  const offReview = join(offRoot, '03-review.md')
  writeFileSync(offReview,
    '# R\n\n## 逐条判定\n\n| 编号 | 判定 | 级别 |\n| --- | --- | --- |\n| C01 | 已消除 | 一般 |\n\n' +
    '## 新问题\n\n| 编号 | 判定 | 级别 |\n| --- | --- | --- |\n' +
    '| X01 | 成立 | 一般 |\n| X02 | 成立 | 一般 |\n| X03 | 成立 | 一般 |\n| X04 | 成立 | 一般 |\n', 'utf8')
  ok(cmdGate([offReview]) === 1, 'gate: 表外一般 4 条 > 容差 3 → 不放行（缺陷28）')

  // 17) v6.24 缺陷29：churn 能抓出「同一产物多份快照」
  const churnRoot = join(tmp, 'churn-root')
  mkdirSync(join(churnRoot, 'R1-chA'), { recursive: true })
  mkdirSync(join(churnRoot, 'R2-chB'), { recursive: true })
  writeFileSync(join(churnRoot, 'R1-chA', '03-review.md'), 'x', 'utf8')
  writeFileSync(join(churnRoot, 'R1-chA', '03-review-final.md'), 'x', 'utf8')
  writeFileSync(join(churnRoot, 'R2-chB', '03-review.md'), 'x', 'utf8')
  ok(cmdChurn([churnRoot]) === 1, 'churn: 有 03-review-final.md 快照 → 报 CHURN 并 exit 1（缺陷29）')

  // 18) v6.25：10 分钟无心跳 → 必须自动续跑（exit 1），不许静默等待用户
  const autoRoot = join(tmp, 'auto-root')
  mkdirSync(join(autoRoot, 'R1-auA'), { recursive: true })
  ok(cmdAuto(['arm', autoRoot, '--round=R1-auA', '--next=x']) === 0, 'auto-arm: 写 _auto.json → exit 0')
  ok(cmdAuto(['check', autoRoot]) === 0, 'auto-check: 刚 arm 完 → 还在跑，exit 0（不打扰用户）')
  const ap = autoPath(autoRoot)
  const aj = JSON.parse(readFileSync(ap, 'utf8').replace(/^\uFEFF/, ''))
  aj.lastBeat = new Date(Date.now() - 11 * 60 * 1000).toISOString()  // 11 分钟前
  writeFileSync(ap, JSON.stringify(aj), 'utf8')
  ok(cmdAuto(['check', autoRoot]) === 1, 'auto-check: 11 分钟无心跳 → AUTO_CONTINUE exit 1（必须自行继续，禁止问用户）')
  const aj2 = JSON.parse(readFileSync(ap, 'utf8').replace(/^\uFEFF/, ''))
  aj2.done = true
  writeFileSync(ap, JSON.stringify(aj2), 'utf8')
  ok(cmdAuto(['check', autoRoot]) === 2, 'auto-check: done=true → AUTO_DONE exit 2（正常收工，不再续跑）')

  // 19) v6.25「穷尽之后才许找用户」：ask 的门控必须真的能拦住
  //     夹具需要满足全部五条判据，否则测不出"穷尽后能放行"这一半。
  const askRoot = join(tmp, 'ask-root')
  // 判据 4 要 ≥2 轮；判据 3 要 ≥2 轮 fingerprints/（每轮跑过 init/fp）
  for (const rn of ['R1-asA', 'R2-asB']) {
    mkdirSync(join(askRoot, rn, 'fingerprints'), { recursive: true })
    writeFileSync(join(askRoot, rn, '01-cases-tech.md'),
      '| 编号 | 级别 | 缺陷要点 |\n| --- | --- | --- |\n| K01 | 致命 | x |\n', 'utf8')
    writeFileSync(join(askRoot, rn, '01-cases-devil.md'),
      '| 编号 | 级别 | 缺陷要点 |\n| --- | --- | --- |\n| N01 | 严重 | y |\n', 'utf8')
    writeFileSync(join(askRoot, rn, '02-blue.md'),
      '## 逐条处置\n\n| 用例 | 处置 |\n| --- | --- |\n| K01 | 已修 |\n| N01 | 挂账 |\n', 'utf8')
    writeFileSync(join(askRoot, rn, '03-review.md'),
      '| 用例 | 级别 | 处置 | 位置 | 证据 |\n| --- | --- | --- | --- | --- |\n| K01 | 一般 | 挂账 | a:1 | x |\n', 'utf8')
  }
  // 未穷尽（缺第 5 条人工声明）→ ask check 必须 exit 0（还不许找用户）
  ok(cmdAsk(['check', askRoot]) === 0, 'ask check: 缺「卡点性质=外部事实」声明 → exit 0（还没穷尽，不许找用户）')
  // 未穷尽时 build 必须拒绝，且不生成任何文件
  ok(cmdAsk(['build', askRoot]) === 1, 'ask build: 未穷尽 → ASK_REFUSED exit 1（拒绝生成求助包）')
  // v6.29M：第 2 项必须认**真实用语**（已处置 / 未处置 / 部分处置 / 判不成立），不能只认文档那套词。
  // 自测夹具原来用的正是文档词，与代码同源 → 测不出「代码词表 vs 现实用语」的偏差（实测 9/10 轮误判）。
  {
    const askReal = join(tmp, 'ask-real')
    for (const rn of ['R1-asD', 'R2-asE']) {
      mkdirSync(join(askReal, rn, 'fingerprints'), { recursive: true })
      writeFileSync(join(askReal, rn, '01-cases-tech.md'),
        '| 编号 | 级别 | 缺陷要点 |\n| --- | --- | --- |\n| K01 | 致命 | x |\n', 'utf8')
      writeFileSync(join(askReal, rn, '01-cases-devil.md'),
        '| 编号 | 级别 | 缺陷要点 |\n| --- | --- | --- |\n| N01 | 严重 | y |\n', 'utf8')
      // 与 R10 真实蓝队记录同用语：已处置 / 挂账 / 未处置
      writeFileSync(join(askReal, rn, '02-blue.md'),
        '## 逐条处置\n\n| 用例 | 处置 |\n| --- | --- |\n| K01 | 已处置 |\n| N01 | 挂账 |\n| N02 | 未处置 |\n', 'utf8')
      writeFileSync(join(askReal, rn, '03-review.md'),
        '| 用例 | 级别 | 处置 | 位置 | 证据 |\n| --- | --- | --- | --- | --- |\n| K01 | 一般 | 挂账 | a:1 | x |\n', 'utf8')
    }
    const seenAsk = []
    const origAsk = console.log
    console.log = (...a) => { seenAsk.push(a.map(String).join(' ')); origAsk(...a) }
    try { cmdAsk(['check', askReal]) } finally { console.log = origAsk }
    ok(seenAsk.some((s) => /\[✓\] 2\. 蓝队 ≥2 种修法/.test(s)),
      'ask 第2项: 真实用语（已处置/挂账/未处置）→ 认出 ≥2 种修法')
  }
  ok(!existsSync(join(askRoot, '_ask', '03-待决问题清单.md')), 'ask build: 拒绝时不留下半成品文件')
  // 声明后 → 穷尽，build 生成三份 MD
  mkdirSync(join(askRoot, '_ask'), { recursive: true })
  writeFileSync(join(askRoot, '_ask', '00-gate.md'), '卡点性质：外部事实 — 缺原始台账\n', 'utf8')
  ok(cmdAsk(['check', askRoot]) === 1, 'ask check: 已声明卡点性质 → exit 1（可以找用户）')
  ok(cmdAsk(['build', askRoot]) === 0, 'ask build: 已穷尽 → 生成三份 MD，exit 0')
  for (const f of ['01-背景与目标.md', '02-卡点与已试路径.md', '03-待决问题清单.md']) {
    ok(existsSync(join(askRoot, '_ask', f)) && statSync(join(askRoot, '_ask', f)).size > 200,
      `ask build: 生成 ${f} 且 >200 B`)
  }
  // 最新一轮没有 03-review.md 时必须回退，不能生成空清单（实测 R12 踩过）
  mkdirSync(join(askRoot, 'R3-asC'), { recursive: true })
  writeFileSync(join(askRoot, 'R3-asC', '00-target.md'), '# 空轮\n', 'utf8')
  ok(cmdAsk(['build', askRoot]) === 0, 'ask build: 最新轮无 03-review.md → 回退到上一轮，仍能生成（不产出空清单）')
  const q3 = readFileSync(join(askRoot, '_ask', '03-待决问题清单.md'), 'utf8')
  ok(/### 问题 1（对应 K01/.test(q3), 'ask build: 回退后清单里有真实条目（不是空的）')

  // ---- v6.29 新增命令自测（refs / apply / metrics / scancheck）----
  // 这四条护栏全部来自实跑摔跤；没有自测就等于护栏本身没有护栏。
  const nc = join(tmp, 'newcmd')
  mkdirSync(nc, { recursive: true })

  // apply：唯一命中 / OLD 找不到 / OLD 不唯一 / NEW 含中文 / 说明块
  const aSrc = join(nc, 'src.md')
  writeFileSync(aSrc, 'ALPHA\nBETA-TARGET-LINE\nGAMMA\nDUP\nDUP\n', 'utf8')
  const aOk = join(nc, 'e-ok.md')
  writeFileSync(aOk, '### 修 T1\n--- OLD ---\nBETA-TARGET-LINE\n--- NEW ---\nBETA-TARGET-LINE patched\n', 'utf8')
  const aOut = join(nc, 'out.md')
  ok(cmdApply([aSrc, aOk, aOut]) === 0, 'apply: 唯一命中 → APPLY_OK exit 0')
  ok(readFileSync(aOut, 'utf8').includes('patched'), 'apply: 输出确实被替换（不是空跑）')
  const aMiss = join(nc, 'e-miss.md')
  writeFileSync(aMiss, '### 修 T2\n--- OLD ---\nNOT-IN-FILE\n--- NEW ---\nx\n', 'utf8')
  ok(cmdApply([aSrc, aMiss, join(nc, 'o2.md')]) === 2, 'apply: OLD 找不到 → OLD_NOT_FOUND exit 2')
  const aDup = join(nc, 'e-dup.md')
  writeFileSync(aDup, '### 修 T3\n--- OLD ---\nDUP\n--- NEW ---\nDUP2\n', 'utf8')
  ok(cmdApply([aSrc, aDup, join(nc, 'o3.md')]) === 2, 'apply: OLD 命中两处 → OLD_NOT_UNIQUE exit 2')
  const aCjk = join(nc, 'e-cjk.md')
  writeFileSync(aCjk, '### 修 T4\n--- OLD ---\nALPHA\n--- NEW ---\nALPHA（这是一段中文编辑说明，不该进英文稿）\n', 'utf8')
  ok(cmdApply([aSrc, aCjk, join(nc, 'o4.md')]) === 2, 'apply: 英文稿 NEW 含中文 → NEW_HAS_CJK exit 2')
  const aNote = join(nc, 'e-note.md')
  writeFileSync(aNote, '### 修 T5\n本缺陷已并入 T1，不再单独替换。\n', 'utf8')
  ok(cmdApply([aSrc, aNote, join(nc, 'o5.md')]) === 0, 'apply: 说明块（已并入）→ 跳过且 exit 0')
  // 过度纠正护栏：改动涉及数字时必须把前后数字摆出来
  {
    const editsNum = join(nc, 'e-num.md')
    writeFileSync(editsNum, '### 修 N90 — 数字改动必须被看见\n\n--- OLD ---\nbaseline 0.043 of 23 prefectures\n--- NEW ---\nbaseline 0.0385 of 26 prefectures\n', 'utf8')
    const srcNum = join(nc, 'src-num.md')
    writeFileSync(srcNum, 'Herfindahl: baseline 0.043 of 23 prefectures here.\n', 'utf8')
    const seen = []
    const orig = console.log
    console.log = (...a) => { seen.push(a.map(String).join(' ')); orig(...a) }
    const rc = cmdApply([srcNum, editsNum, join(nc, 'o-num.md')])
    console.log = orig
    ok(rc === 0, 'apply: 数字改动的块仍能正常应用')
    ok(seen.some((s) => s.includes('NOTICE_NUMERIC_CHANGE')), 'apply: 改动涉及数字 → NOTICE_NUMERIC_CHANGE 被打印')
    ok(seen.some((s) => /去掉\[[^\]]*0\.043/.test(s) && /新增\[[^\]]*0\.0385/.test(s)), 'apply: 通知里同时列出改前与改后数字')
  }
  const aNone = join(nc, 'e-none.md')
  writeFileSync(aNone, '这里没有任何块标记，只是一段说明文字\n', 'utf8')
  ok(cmdApply([aSrc, aNone, join(nc, 'o6.md')]) === 2, 'apply: 没有任何「### 修」块 → NO_BLOCKS exit 2')

  // refs：可解析 / 越界 / 提不到行号
  const rCases = join(nc, 'cases.md')
  writeFileSync(rCases, '| C01 | 严重 | 未修 | 见 L2 与 L3 |\n', 'utf8')
  const rTarget = join(nc, 'target.md')
  writeFileSync(rTarget, 'one\ntwo\nthree\nfour\n', 'utf8')
  ok(cmdRefs([rCases, rTarget]) === 0, 'refs: 行号全部可解析 → exit 0')
  const rBad = join(nc, 'cases-bad.md')
  writeFileSync(rBad, '| C02 | 严重 | 未修 | 见 L99 |\n', 'utf8')
  ok(cmdRefs([rBad, rTarget]) === 2, 'refs: 行号越界 → DANGLING_REF exit 2')
  const rNone = join(nc, 'cases-none.md')
  writeFileSync(rNone, '这一行没有任何行号引用\n', 'utf8')
  ok(cmdRefs([rNone, rTarget]) === 2, 'refs: 提不到行号 → REFS_EMPTY exit 2')

  // metrics：估算不判通过 / 实测超限 / 实测达标
  ok(cmdMetrics([rTarget, '12']) === 0, 'metrics: 只有估算 → exit 0，且绝不打 BUDGET_OK')
  ok(cmdMetrics([rTarget, '12', '16']) === 2, 'metrics: 实测 16 页 > 上限 12 → BUDGET_OVER exit 2')
  ok(cmdMetrics([rTarget, '12', '11']) === 0, 'metrics: 实测 11 ≤ 12 → BUDGET_OK exit 0')

  // scancheck：干净 / 中文少量混入 / 中文文档不误报
  const scClean = join(nc, 'clean.md')
  writeFileSync(scClean, '# Title\n\n## A\nsome english body text here.\n\n## B\nmore english body text.\n', 'utf8')
  ok(cmdScancheck([scClean]) === 0, 'scancheck: 干净英文稿 → SCAN_CLEAN exit 0')
  const scMix = join(nc, 'mix.md')
  writeFileSync(scMix, '# Title\n\n## A\nsome english body text here.\n（这是一段中文编辑说明，不该出现在英文稿里）\n', 'utf8')
  ok(cmdScancheck([scMix]) === 2, 'scancheck: 中文少量混入 → CJK_IN_TEXT exit 2')
  const scCn = join(nc, 'cn.md')
  writeFileSync(scCn, '# 标题\n\n## 第一节\n这是中文正文，中文占比很高。\n\n## 第二节\n更多中文正文内容在这里。\n', 'utf8')
  ok(cmdScancheck([scCn]) === 0, 'scancheck: 中文文档不误报 CJK（占比高时静默）exit 0')

  // quality：可解析单轮 / 空目录 / 「不成立」行必须保留原始级别
  const qd = join(nc, 'q-round')
  mkdirSync(qd, { recursive: true })
  writeFileSync(join(qd, '03-review.md'), '| 编号 | 级别 | 状态 |\n| --- | --- | --- |\n| C01 | 严重 | 已消除 |\n| C02 | 一般 | 不成立 |\n', 'utf8')
  ok(cmdQuality([qd]) === 0, 'quality: 可解析单轮 → exit 0')
  const qRows = parseVerdict(join(qd, '03-review.md'))
  const qRej = qRows.find((r) => r.level === '不成立')
  ok(qRej && qRej.claimedLevel === '一般', 'quality: 「不成立」行保留原始级别（claimedLevel 未被覆盖成 不成立）')
  const qe = join(nc, 'q-empty')
  mkdirSync(qe, { recursive: true })
  ok(cmdQuality([qe]) === 2, 'quality: 无任何判定文件 → QUALITY_EMPTY exit 2')
  // 模型归因链路：roster + role-map 必须能把 编号→角色→模型 串起来（缺任一侧车则报 NO_ROSTER）
  const qr = join(nc, 'q-roster')
  mkdirSync(qr, { recursive: true })
  writeFileSync(join(qr, '03-review.md'), '| 编号 | 级别 | 状态 |\n| --- | --- | --- |\n| C01 | 严重 | 已消除 |\n| C02 | 一般 | 不成立 |\n', 'utf8')
  writeFileSync(join(qr, 'redteam-roster.json'), JSON.stringify({ roles: [{ role: 'tp', provider: 'p', model: 'm', kind: 'red' }] }), 'utf8')
  writeFileSync(join(qr, 'role-map.json'), JSON.stringify({ C01: 'tp', C02: 'tp' }), 'utf8')
  ok(cmdQuality([qr]) === 0, 'quality: roster + role-map 齐备 → 模型归因链路可用 exit 0')

  // salvage：通过路径 / 否定关键词必须被识破（v6.29M：`body.includes` 太弱，命令此前从未被自测覆盖）
  {
    const sv = join(nc, 'salvage')
    const svPad = (s) => s + '\n' + '<!-- ' + 'x'.repeat(320) + ' -->\n'
    const svOk = join(sv, 'ok'); mkdirSync(svOk, { recursive: true })
    writeFileSync(join(svOk, '01-cases.md'), svPad('# 用例\n\n## 用例表\n维度覆盖：见下。不覆盖：作者裁定。\n'), 'utf8')
    writeFileSync(join(svOk, '02-blue.md'), svPad('# 蓝队\n\n## 逐条处置\n## 交付件改动\nSHA256 见下。\n'), 'utf8')
    writeFileSync(join(svOk, '03-review.md'), svPad('# 复核\n\n## 逐条判定\n## 统计\n'), 'utf8')
    ok(cmdSalvage([svOk]) === 0, 'salvage: 三产物齐备且关键词为肯定语境 → SALVAGE_OK exit 0')
    const svNeg = join(sv, 'neg'); mkdirSync(svNeg, { recursive: true })
    writeFileSync(join(svNeg, '01-cases.md'), svPad('# 用例\n\n本文没有「用例表」，没有维度覆盖，也没有不覆盖。\n'), 'utf8')
    writeFileSync(join(svNeg, '02-blue.md'), svPad('# 蓝队\n\n本文没有「逐条处置」，没有「交付件改动」，也没有 SHA256。\n'), 'utf8')
    writeFileSync(join(svNeg, '03-review.md'), svPad('# 复核\n\n本文没有「逐条判定」，也没有「统计」。\n'), 'utf8')
    ok(cmdSalvage([svNeg]) === 1, 'salvage: 关键词只出现在否定语境 → 仍判 SALVAGE_NEEDED exit 1')
  }

  // canary：造键 / 全缺失 → exit 2 / 命中 → exit 0 / 未命中 → exit 1
  const cd = join(nc, 'canary')
  mkdirSync(cd, { recursive: true })
  const cCases = join(cd, 'cases.md')
  writeFileSync(cCases, '| 编号 | 级别 | 状态 | 判据 | 证据 |\n| --- | --- | --- | --- | --- |\n| C01 | 严重 | 已消除 | 摘要把 registry tenure 说成 lifespan | L6 |\n', 'utf8')
  const cKey = join(cd, 'key.json')
  ok(cmdCanary(['build', cCases, cKey, '--ids', 'C01', '--anchors', 'C01=lifespan|lastUpdate']) === 0,
    'canary build: 显式锚 + 有效编号 → exit 0')
  ok(existsSync(cKey), 'canary build: 真的写出了 key.json')
  ok(cmdCanary(['build', cCases, join(cd, 'k2.json'), '--ids', 'Z99', '--anchors', 'Z99=x']) === 2,
    'canary build: 编号全不存在 → CANARY_EMPTY exit 2')
  const cHit = join(cd, 'hit.md')
  writeFileSync(cHit, 'the abstract calls it lifespan, but it is lastUpdate based\n', 'utf8')
  ok(cmdCanary(['score', cKey, cHit]) === 0, 'canary score: 命中锚 → 召回达标 exit 0')
  const cMiss = join(cd, 'miss.md')
  writeFileSync(cMiss, 'nothing relevant at all\n', 'utf8')
  ok(cmdCanary(['score', cKey, cMiss]) === 1, 'canary score: 未命中 → 召回不足 exit 1')
  // 反锚点刷分：全部命中 + 锚在输出里反复出现 → 必须打 RECALL_TOO_PERFECT / ANCHOR_GENERIC 并写进 flags
  const cgKey = join(cd, 'key-generic.json')
  writeFileSync(cgKey, JSON.stringify({
    items: [
      { id: 'C01', level: '严重', anchors: ['lifespan'], minHit: 1 },
      { id: 'C02', level: '严重', anchors: ['duration'], minHit: 1 },
      { id: 'C03', level: '严重', anchors: ['survival'], minHit: 1 },
    ],
  }, null, 2), 'utf8')
  const cgOut = join(cd, 'generic.md')
  writeFileSync(cgOut, 'lifespan lifespan lifespan duration duration duration survival survival survival\n', 'utf8')
  ok(cmdCanary(['score', cgKey, cgOut]) === 0, 'canary score: 全部命中仍 exit 0（告警不改变退出码）')
  const cgScore = JSON.parse(readFileSync(cgOut.replace(/\.md$/, '') + '.score.json', 'utf8'))
  ok((cgScore.flags || []).includes('RECALL_TOO_PERFECT'), 'canary score: ≥3 条且 100% 命中 → flags 含 RECALL_TOO_PERFECT')
  ok((cgScore.flags || []).includes('ANCHOR_GENERIC'), 'canary score: 锚在输出里出现 ≥3 次 → flags 含 ANCHOR_GENERIC')

  // carry：建轮时携带旧账 —— 未闭合项必须带入，已闭合项可以不列
  const cp = join(nc, 'carry-prev'); mkdirSync(cp, { recursive: true })
  const cc = join(nc, 'carry-curr'); mkdirSync(cc, { recursive: true })
  writeFileSync(join(cp, '03-review.md'), '| 编号 | 级别 | 状态 |\n| --- | --- | --- |\n| C01 | 严重 | 已消除 |\n| C02 | 一般 | 挂账 |\n', 'utf8')
  writeFileSync(join(cc, '03-review.md'), '| 编号 | 级别 | 状态 |\n| --- | --- | --- |\n| C02 | 一般 | 未修 |\n| N01 | 一般 | 未修 |\n', 'utf8')
  ok(cmdCarry([cp, cc]) === 0, 'carry: 未闭合项 C02 已带入 → CARRY_OK exit 0')
  const cc2 = join(nc, 'carry-curr2'); mkdirSync(cc2, { recursive: true })
  writeFileSync(join(cc2, '03-review.md'), '| 编号 | 级别 | 状态 |\n| --- | --- | --- |\n| N01 | 一般 | 未修 |\n', 'utf8')
  ok(cmdCarry([cp, cc2]) === 2, 'carry: 未闭合项 C02 丢失 → LOST_OPEN exit 2')

  // route：从 profile 配置里读真实 provider→model；无匹配 → exit 2
  const rc = join(nc, 'fake-profile.yml')
  writeFileSync(rc, [
    'llm:',
    '  providers:',
    '    agent2api-zzz:',
    '      name: ZZZ',
    '      models:',
    '        - id: model-a',
    '        - id: model-b',
    '    minekuai:',
    '      models:',
    '        - id: model-c',
    '',
  ].join('\n'), 'utf8')
  ok(cmdRoute([rc]) === 0, 'route: 能解析出 provider 与模型 → exit 0')
  ok(cmdRoute([rc, 'nomatch-provider']) === 2, 'route: 过滤词无匹配 → ROUTE_NO_MATCH exit 2')

  // ident：恒等式全成立 → 0；抽值失败 → 2（且不许让那条恒等式静默跳过）
  const idDir = join(nc, 'ident')
  mkdirSync(idDir, { recursive: true })
  const idText = join(idDir, 'text.md')
  writeFileSync(idText, 'We hold 164 endpoints; 141 ever-active and 23 never-active. 131 events and 10 censored.\n', 'utf8')
  const idOk = join(idDir, 'spec-ok.json')
  writeFileSync(idOk, JSON.stringify({
    text: idText,
    values: {
      total: { regex: 'We hold (\\d+) endpoints' },
      ever: { regex: '(\\d+) ever-active' },
      never: { regex: '(\\d+) never-active' },
      events: { regex: '(\\d+) events' },
      censored: { regex: '(\\d+) censored' },
    },
    identities: ['ever + never === total', 'events + censored === ever'],
  }), 'utf8')
  ok(cmdIdent([idOk]) === 0, 'ident: 恒等式全成立 → IDENT_OK exit 0')
  const idBad = join(idDir, 'spec-bad.json')
  writeFileSync(idBad, JSON.stringify({
    text: idText,
    values: { ghost: { regex: 'NEVER_PRESENT_(\\d+)' } },
    identities: ['ghost === 1'],
  }), 'utf8')
  ok(cmdIdent([idBad]) === 2, 'ident: 抽不到值 → IDENT_VALUE_MISSING exit 2（不许静默跳过）')
  // ident draft：先实测再写 spec（与 occur draft 同一经验）
  {
    const dSrc = join(idDir, 'draft-body.md')
    writeFileSync(dSrc, 'Total 164 endpoints; 141 ever-active and 23 never-active.\n## References\n\n1. Ref mentions 164 and 999 and 777.\n', 'utf8')
    const dOut = join(idDir, 'ident-draft.json')
    ok(cmdIdent(['draft', dSrc, '--out', dOut]) === 0, 'ident draft: 扫描正文并写骨架 → exit 0')
    const dj = JSON.parse(readFileSync(dOut, 'utf8').replace(/^\uFEFF/, ''))
    const keys = Object.keys(dj.values || {})
    ok(keys.length >= 2, 'ident draft: 骨架里带候选值')
    ok(!keys.some((k) => /n(999|777)/.test(k)), 'ident draft: 只扫正文（References 里的数值不进候选）')
    ok(Array.isArray(dj.identities) && dj.identities.length === 0, 'ident draft: identities 留空待人工填（不替人猜关系）')
    // 往返：draft 生成的 spec 必须能被 ident 原样用起来。
    // 第一版把这 2 条比率（161/164、13/15）当候选，喂回去全部 IDENT_VALUE_MISSING ——
    // 比率不是数值，捕获组也漏了 "/" 那一半。
    {
      const rtSrc = join(idDir, 'rt-body.md')
      writeFileSync(rtSrc, 'We hold 164 endpoints; 141 ever-active and 23 never-active, with 161/164 in agreement.\n', 'utf8')
      const rtSpec = join(idDir, 'rt-spec.json')
      ok(cmdIdent(['draft', rtSrc, '--out', rtSpec]) === 0, 'ident draft: 生成往返用 spec')
      const rj = JSON.parse(readFileSync(rtSpec, 'utf8').replace(/^\uFEFF/, ''))
      ok(!Object.keys(rj.values).some((k) => /n161_164/.test(k)), 'ident draft: 比率不当候选（161/164 不是数值）')
      const seen2 = []
      const orig2 = console.error
      console.error = (...a) => { seen2.push(a.map(String).join(' ')); orig2(...a) }
      const rc2 = cmdIdent([rtSpec])
      console.error = orig2
      ok(!seen2.some((s) => s.includes('IDENT_VALUE_MISSING')), 'ident draft: 生成的 spec 喂回 ident 不出现抽值失败')
      ok(rc2 === 0, 'ident draft: 往返后 ident 判定通过')
    }
  }

  // ---- merge：多来源意见合成一张用例表 ----
  {
    const mDir = join(tmp, "merge-basic")
    mkdirSync(mDir, { recursive: true })
    const mFile = join(mDir, "tech.md")
    writeFileSync(mFile, [
      "**观点 1（指向 SKILL.md L210，维度 数据）：子命令数写 21，代码实际 34。**",
      "证据：SKILL.md 第 210 行写 21 个子命令，代码里实际有 34 个。",
      "",
      "| N01 | 逻辑 | 严重 | SKILL.md:917 | 结论强于证据，用词过满 | E10 | tech |",
      "",
      "### N02 交付件缺少错误码",
      "04-summary.md 里没有错误码列。",
      "",
    ].join("\n"), "utf8")
    const mOut = join(mDir, "01-cases.md")
    const rcM = cmdMerge([mDir, mFile])
    const mText = existsSync(mOut) ? readFileSync(mOut, "utf8") : ""
    const mRows = mText.split("## ")[0].split(/\r?\n/).filter(function (l) { return /^\| N\d{2} \|/.test(l) })
    ok(rcM === 0 && mRows.length === 3, "merge: 单文件 3 条 → 输出 3 行")
  }
  {
    const dDir = join(tmp, "merge-dedup")
    mkdirSync(dDir, { recursive: true })
    const dA = join(dDir, "tech.md")
    const dB = join(dDir, "domain.md")
    writeFileSync(dA, [
      "**观点 1（指向 SKILL.md L210，维度 数据）：子命令数写 21，代码实际 34。**",
      "",
      "### N01 结论强于证据",
      "03-review.md 的用词过满，把可能性说成必然。",
      "",
    ].join("\n"), "utf8")
    writeFileSync(dB, [
      "| N01 | 数据 | 严重 | SKILL.md:211 | 子命令数写 21，代码实际 34 个 | E08 | domain |",
      "",
      "K01、交付件缺少错误码列",
      "",
    ].join("\n"), "utf8")
    const dOut = join(dDir, "01-cases.md")
    const rcD = cmdMerge([dDir, dA, dB])
    const dText = existsSync(dOut) ? readFileSync(dOut, "utf8") : ""
    const dRows = dText.split("## ")[0].split(/\r?\n/).filter(function (l) { return /^\| N\d{2} \|/.test(l) })
    ok(rcD === 0 && dRows.length === 3 && dText.indexOf("tech+domain") >= 0, "merge: 两文件各 2 条、1 条重复 → 输出 3 行且来源合并")
  }
  {
    const eDir = join(tmp, "merge-empty")
    mkdirSync(eDir, { recursive: true })
    const eFile = join(eDir, "empty.md")
    writeFileSync(eFile, "# 没有条目\n\n只有一些普通文字，没有任何编号。\n", "utf8")
    const seenE = []
    const origE = console.error
    console.error = function () { seenE.push(Array.from(arguments).map(String).join(" ")); origE.apply(console, arguments) }
    const rcE = cmdMerge([eDir, eFile])
    console.error = origE
    ok(rcE === 2 && seenE.some(function (s) { return s.indexOf("MERGE_NOTHING") >= 0 }), "merge: 空文件 → MERGE_NOTHING 且返回 2")
  }
  // merge: 带 BOM 的输入文件，第一行不能被漏掉
  // 实测（2026-11-11）：PowerShell 的 Set-Content -Encoding UTF8 会给首行加 BOM，
  // 而 `^\*\*观点` 对不上 BOM → 首条静默丢失。longcat 的自测文件没 BOM，所以没测出来。
  {
    const mb = join(tmp, 'merge-bom'); mkdirSync(mb, { recursive: true })
    const bomFile = join(mb, 'bom.md')
    writeFileSync(bomFile, '\uFEFF**观点 1（指向 a.md:10，维度 数据）：第一条。**\n\n**观点 2（指向 a.md:20，维度 数据）：第二条。**\n', 'utf8')
    const bomOut = join(mb, 'out.md')
    const rcBom = cmdMerge([mb, bomFile, '--out=' + bomOut])
    const bomRows = (readFileSync(bomOut, 'utf8').match(/^\| N\d+/gm) || []).length
    ok(rcBom === 0 && bomRows === 2, 'merge: 带 BOM 的文件 → 首条不被漏掉（应 2 条，实得 ' + bomRows + '）')
  }
  // archive：打包 + 拒绝覆盖同名（2026-11-11 新增命令）
  {
    const ar = join(tmp, 'ar-src'); mkdirSync(ar, { recursive: true })
    writeFileSync(join(ar, 'x.md'), 'hello archive\n', 'utf8')
    const dest = join(tmp, 'ar-dest'); mkdirSync(dest, { recursive: true })
    const zip1 = join(dest, 'one.zip')
    const rcAr1 = cmdArchive([ar, '--out=' + zip1])
    const rcAr2 = cmdArchive([ar, '--out=' + zip1])
    ok(rcAr1 === 0 && existsSync(zip1) && rcAr2 === 2, 'archive: 打包成功且第二次拒绝覆盖（不静默重写）')
  }

  // project：set / list / use / unset 走通，且不污染真实配置（临时 DSH_HOME）
  {
    const oldHome = process.env.DSH_HOME
    const fakeHome = join(tmp, 'fake-dsh-home'); mkdirSync(fakeHome, { recursive: true })
    process.env.DSH_HOME = fakeHome
    try {
      const pr = join(tmp, 'pj-src'); mkdirSync(pr, { recursive: true })
      const rcSet = cmdProject(['set', 'demo-proj', '--root=' + pr, '--journal=JRP'])
      const store = JSON.parse(readFileSync(join(fakeHome, 'redblue-projects.json'), 'utf8'))
      const rcUse = cmdProject(['use', 'demo-proj'])
      const rcUnset = cmdProject(['unset', 'demo-proj'])
      ok(rcSet === 0 && store.projects['demo-proj'] && store.projects['demo-proj'].journal === 'JRP'
        && rcUse === 0 && rcUnset === 0, 'project: set/use/unset 走通且配置写进 DSH_HOME')
    } finally {
      if (oldHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = oldHome
    }
  }
  // history：查历史账（2026-11-11 新增）—— 防止主控/红队重复发现已处置的问题
  {
    const hp = join(tmp, 'hist-proj');
    const rb = join(hp, 'redblue'); mkdirSync(rb, { recursive: true })
    // 造两个轮次：R1 有 N01（已答）、R2 有 N02（未解决）
    for (const [r, body] of [
      ['R1-1107g1', '| N01 | 严重 | 当前文本已答 | a.md:4 | 摘要已限定 |'],
      ['R2-1108h1', '| N02 | 严重 | 未解决 | b.md:8 | 仍未处置 |'],
    ]) {
      const d = join(rb, r); mkdirSync(d, { recursive: true })
      writeFileSync(join(d, '03-review.md'), body + '\n', 'utf8')
    }
    const rcHist = cmdHistory([hp, 'N01'])
    ok(rcHist === 0, 'history: 查到已答条目 → exit 0')
    const rcMiss = cmdHistory([hp, 'ZZZ-NOPE'])
    ok(rcMiss === 0, 'history: 关键词无命中 → 返回 HISTORY_NONE 且 exit 0（这是新问题）')
    const rcNoDir = cmdHistory([join(tmp, 'hist-nope'), 'x'])
    ok(rcNoDir === 2, 'history: 没有 redblue 目录 → die exit 2')
  }
  // 覆盖率核对：必需清单里每个诊断码都必须在本次自测里真的触发过
  console.error = __origErr
  console.log = __origLog
  const uncovered = REQUIRED_CODES.filter((c) => !firedCodes.has(c))
  for (const c of uncovered) console.log(`FAIL  selftest 覆盖: ${c} 从未被触发 —— 这道护栏可能没接线`)
  if (uncovered.length) bad += uncovered.length
  else console.log(`PASS  selftest 覆盖: 必需清单 ${REQUIRED_CODES.length} 个诊断码全部被触发过`)
  // 正常路径覆盖
  const uncoveredOk = REQUIRED_OK.filter((c) => !firedOk.has(c))
  for (const c of uncoveredOk) console.log(`FAIL  selftest 正常路径覆盖: ${c} 从未出现 —— 这条成功路径没被跑过`)
  if (uncoveredOk.length) bad += uncoveredOk.length
  else console.log(`PASS  selftest 正常路径覆盖: ${REQUIRED_OK.length} 个成功标记全部跑过`)

  console.log(bad === 0 ? '\nSELFTEST_OK' : `\nSELFTEST_FAIL: ${bad} 项`)
  return bad === 0 ? 0 : 1
}

// ---------------------------------------------------------------- cmdChurn
/**
 * v6.24 缺陷29：检测「产物被整篇重写」造成的上下文浪费。
 *
 * 实测来源（2026-11-02 两会话原始日志）：
 *   7ba84461 13 轮触发 40 次压缩，摘要 19,752 B → 87,006 B；
 *   `03-review.md` 被整篇 write 15 次，累计 130,577 B，而最终文件仅 ~13 KB；
 *   同文件重复写的纯浪费 346,180 B = 全部 write 字节的 57%。
 *
 * 这个命令没法读会话日志（工具只看产物目录），但它能抓**产物的形态证据**：
 *   - 一轮里同一文件出现多个快照（`03-review.md.bak` / `03-review-v2.md` / `03-review-final.md` …）
 *   - 产物目录里散落 `_debug*.py` 之类的一次性脚本（说明在对话里反复贴代码）
 * 真正能机械判定「重写了几次」的只有会话日志，所以本命令定位为**提示**而非拦截。
 *
 * usage: churn <roundsRoot>
 */
function cmdChurn([roundsRoot]) {
  if (!roundsRoot) die('usage: churn <roundsRoot>')
  const root = resolve(roundsRoot)
  if (!existsSync(root)) die(`churn: 目录不存在 ${root}`)
  const rounds = readdirSync(root).filter((d) => /^R\d+-/.test(d) && statSync(join(root, d)).isDirectory())
  let multiSnap = 0, debris = 0, total = 0
  const notes = []
  for (const rd of rounds.slice().sort(natCmp)) {
    total++
    const dir = join(root, rd)
    const files = readdirSync(dir)
    // 1) 同一逻辑产物的多份快照
    const logical = ['00-target', '01-cases', '02-blue', '03-review', '04-summary', '05-signoff']
    for (const base of logical) {
      const snaps = files.filter((f) => f.startsWith(base) && f.endsWith('.md') && f !== `${base}.md`)
      // 红队多路产物（01-cases-devil.md 等）是合法的，不算快照
      const real = snaps.filter((f) => !/^01-cases-(devil|tech|domain)\.md$/.test(f))
      if (real.length > 0) {
        multiSnap++
        notes.push(`${rd}: ${base} 有多份快照 ${real.join(', ')}（整篇重写的痕迹）`)
      }
    }
    // 2) 一次性调试脚本残渣
    const py = files.filter((f) => /^_?(debug|tmp|test|instr|probe|verify\d*)[^/]*\.(py|ps1|mjs)$/i.test(f))
    if (py.length >= 3) {
      debris++
      notes.push(`${rd}: ${py.length} 个一次性脚本（${py.slice(0, 4).join(', ')}${py.length > 4 ? '…' : ''}）—— 代码贴进了对话`)
    }
  }
  console.log(`CHURN 扫描 ${total} 轮：多快照 ${multiSnap} 轮，脚本残渣 ${debris} 轮`)
  for (const n of notes.slice(0, 12)) console.log(`  ${n}`)
  if (notes.length > 12) console.log(`  …（共 ${notes.length} 条）`)
  console.log('\n提示：本命令只看产物形态。真正数「整篇 write 了几次」要读会话日志：')
  console.log('  7ba84461 实测 03-review.md 整篇 write 15 次 / 130,577 B，最终文件仅 ~13 KB。')
  console.log('  规则见 SKILL.md 硬规则 12：产物只增不改，写完只报行数与哈希，不复述内容。')
  return notes.length > 0 ? 1 : 0
}

// ---------------------------------------------------------------- cmdAuto
/**
 * v6.25「10 分钟无人应答 → 自动续跑」的确定性执行器。
 *
 * 用户的要求（2026-11-02 原话）：
 *   「当我10分钟没有理他，那他就自行继续下去」
 *
 * 这条不能只写成口号 —— 模型自觉不可靠（R10 已实证主控会自我放行）。
 * 所以拆成三个可机械判定的动作，全部落盘：
 *
 *   auto-arm  <roundsRoot>      开工时写 `_auto.json`：当前轮、开始时间、超时=600s、
 *                               目标、下一步。**这是"我还在跑"的凭据。**
 *   auto-beat <roundsRoot>      每次推进后更新 `_auto.json` 的 lastBeat。
 *                               进程死了就不会再 beat，超时即触发。
 *   auto-check <roundsRoot>     退出码：0=还在跑（不打扰用户）；
 *                               1=超时应自动续跑（主控必须自己继续，不许问用户）；
 *                               2=已收敛/已 BLOCKED（正常收工）。
 *
 * 设计要点（为什么不用 schedule_create）：
 *   - 定时器属于宿主进程，进程重启即丢；`_auto.json` 落盘，跨重启仍可判。
 *   - 判定必须是**纯函数**：给定 `_auto.json` + 当前时间，输出唯一结论。
 *     这样即使换一个全新的子代理接手，也能凭文件继续，不依赖任何对话记忆。
 */
function autoPath(roundsRoot) {
  return join(resolve(roundsRoot), '_auto.json')
}

function readAuto(roundsRoot) {
  const p = autoPath(roundsRoot)
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) } catch { return null }
}

function writeAuto(roundsRoot, obj) {
  const p = autoPath(roundsRoot)
  writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8')
}

const AUTO_TIMEOUT_SEC = 600   // 用户指定：10 分钟

function cmdAuto([sub, roundsRoot, ...rest]) {
  if (!sub || !roundsRoot) die('usage: auto <arm|beat|check|status> <roundsRoot> [--round=R1-xxxx] [--next=...] [--done]')
  const root = resolve(roundsRoot)
  if (!existsSync(root)) die(`auto: 目录不存在 ${root}`)
  const flags = {}
  for (const a of rest) {
    const m = a.match(/^--([a-z]+)=(.*)$/s)
    if (m) flags[m[1]] = m[2]
    else if (a.startsWith('--')) flags[a.slice(2)] = true
  }

  if (sub === 'arm') {
    const cur = flags.round || detectLatestRound(root)
    if (!cur) die('auto-arm: 找不到轮次目录，用 --round= 指定')
    const obj = {
      round: cur,
      startedAt: new Date().toISOString(),
      lastBeat: new Date().toISOString(),
      timeoutSec: AUTO_TIMEOUT_SEC,
      next: flags.next || '等待主控写入下一步',
      done: false,
      beats: 0,
    }
    writeAuto(root, obj)
    console.log(`AUTO_ARMED: 轮次=${cur} 超时=${AUTO_TIMEOUT_SEC}s`)
    console.log(`  文件=${autoPath(root)}`)
    console.log(`  语义：${AUTO_TIMEOUT_SEC}s 内无新 beat 且未 done ⇒ 主控必须自行继续，不得询问用户。`)
    return 0
  }

  const st = readAuto(root)
  if (!st) { console.error(`AUTO_UNARMED: ${autoPath(root)} 不存在 —— 先跑 auto-arm`); return 2 }

  if (sub === 'beat') {
    st.lastBeat = new Date().toISOString()
    st.beats = (st.beats || 0) + 1
    if (flags.round) st.round = flags.round
    if (flags.next) st.next = flags.next
    if (flags.done) st.done = true
    writeAuto(root, st)
    console.log(`AUTO_BEAT: 第 ${st.beats} 次心跳，轮次=${st.round}，done=${st.done}`)
    return 0
  }

  if (sub === 'check' || sub === 'status') {
    const now = Date.now()
    const last = Date.parse(st.lastBeat)
    const elapsed = Math.round((now - last) / 1000)
    const left = st.timeoutSec - elapsed
    console.log(`AUTO: 轮次=${st.round} 上次心跳=${elapsed}s 前 超时=${st.timeoutSec}s 剩余=${left}s done=${st.done}`)
    console.log(`  下一步=${st.next}`)
    if (st.done) { console.log('AUTO_DONE: 已收工，不需要继续。'); return 2 }
    if (left > 0) { console.log('AUTO_RUNNING: 还在正常推进，不打扰用户。'); return 0 }
    console.log(`AUTO_CONTINUE: 已 ${elapsed}s 无心跳（超过 ${st.timeoutSec}s）—— 主控必须自行继续，禁止询问用户。`)
    return 1
  }

  return die(`auto: 未知子命令 ${sub}（可用 arm / beat / check / status）`)
}

function detectLatestRound(root) {
  const ds = readdirSync(root).filter((d) => /^R\d+-/.test(d) && statSync(join(root, d)).isDirectory())
  if (ds.length === 0) return null
  return ds.sort((a, b) => {
    const na = parseInt(a.match(/^R(\d+)/)[1], 10)
    const nb = parseInt(b.match(/^R(\d+)/)[1], 10)
    return na - nb
  }).pop()
}

// ---------------------------------------------------------------- cmdAsk
/**
 * v6.25「穷尽之后才许找用户」的确定性执行器 + 三份 MD 生成器。
 *
 * 用户原话（2026-11-02）：
 *   「有什么问题，是可以找我，但我很多都不懂。你先红蓝对抗，直到没有办法，
 *     然后再来问我，问我的时候，记得生成三个md，然后这三个md要很全面，
 *     我会发给其他ai，让他们帮忙，当然你生成md的同时，在对话里把我要和ai的
 *     提示词也发我，我好复制过去。但更多的是问你自己，你实在毫无办法才来找我。」
 *
 * 这条的危险在于：**「没办法」是模型最容易自我批准的门**。
 * 所以拆成两步：
 *
 *   ask check  <roundsRoot>   ← 只判「穷尽了吗」，不生成任何文件
 *                               退出码 0=还没穷尽（不许找用户）/ 1=可以找用户
 *   ask build  <roundsRoot>   ← 穷尽检查通过后才生成三份 MD + 提示词
 *                               未通过则拒绝生成并列出还缺什么
 *
 * 「穷尽」的五条硬判据（全部来自 SKILL.md §3.7 的操作定义，逐条机械化）：
 *   1) 红队至少两路独立提过同一问题（不是同一路反复说）
 *   2) 蓝队试过至少两种修法且都记录在 02-blue.md
 *   3) 确定性工具（recount/gate/contract/reattack/converge）全跑过
 *   4) 至少重跑过一轮完整对抗（≥2 轮产物存在）
 *   5) 卡点是外部事实（缺数据/缺文献/缺实验条件/需人拍板），不是"我不确定"
 *
 * 第 5 条**无法机械判定**，所以不做成自动通过项，而是要求人工在 `_ask/00-gate.md`
 * 里显式写一句「卡点性质：外部事实 — <具体是什么>」。没有这句话就不许 build。
 * 这是诚实的边界：能查的查，查不了的留痕但不装懂。
 */
function cmdAsk([sub, roundsRoot]) {
  if (!sub || !roundsRoot) die('usage: ask <check|build> <roundsRoot>')
  const root = resolve(roundsRoot)
  if (!existsSync(root)) die(`ask: 目录不存在 ${root}`)
  // v6.25 修正：`_ask/` 等以 `_` 开头的辅助目录不算轮次（第一版把它算成 R 目录，
  // 输出里出现「_ask 无 03-review.md」这种噪音，还可能影响「≥2 轮」判据）。
  const rounds = readdirSync(root).filter((d) =>
    /^R\d+-/.test(d) && !d.startsWith('_') && statSync(join(root, d)).isDirectory())
  const sorted = rounds.slice().sort((a, b) =>
    parseInt(a.match(/^R(\d+)/)[1], 10) - parseInt(b.match(/^R(\d+)/)[1], 10))
  if (sorted.length === 0) die('ask: 没有任何轮次目录')

  // ---- 逐条核对「穷尽」的五条判据 ----
  const checks = []

  // 1) 红队两路独立提过同一问题
  //    数每轮有几个独立的红队产物文件（01-cases*.md 且不是转抄）
  let multiRed = 0
  const redFilesPerRound = []
  for (const r of sorted) {
    const dir = join(root, r)
    const fs2 = readdirSync(dir).filter((f) => /^01-cases.*\.md$/.test(f))
    const real = fs2.filter((f) => {
      const t = readFileSync(join(dir, f), 'utf8')
      return !/无红队交付|红队未启动|红队未参与|本轮无红队/.test(t)
        && !/(继承|沿用|转抄|摘自|复制自)\s*(?:自\s*)?上一?轮|(继承|沿用)\s*R\d+\s*红队/.test(t.split(/\r?\n/).slice(0, 12).join('\n'))
    })
    redFilesPerRound.push({ round: r, n: real.length, files: real })
    if (real.length >= 2) multiRed++
  }
  checks.push({
    id: 1,
    name: '红队两路独立',
    ok: multiRed > 0,
    detail: multiRed > 0
      ? `${multiRed} 轮有 ≥2 份独立红队产物`
      : `没有任何一轮有 ≥2 份独立红队产物（各轮：${redFilesPerRound.map((x) => `${x.round}=${x.n}`).join(', ')}）`,
  })

  // 2) 蓝队试过 ≥2 种修法
  let multiBlue = 0
  const blueInfo = []
  for (const r of sorted) {
    const dir = join(root, r)
    if (!existsSync(join(dir, '02-blue.md'))) { blueInfo.push(`${r}=缺`); continue }
    const t = readFileSync(join(dir, '02-blue.md'), 'utf8')
    // 数「处置」动作的种类：已修 / 驳回 / 挂账 / 部分修 各算一种不同策略
    // v6.29M（监工实测）：真实蓝队用的是「已处置 / 未处置 / 部分处置 / 判不成立 / 挂账」，
    // 而这里只认「已修 / 驳回 / 挂账 / 部分修」—— **四对同义词里三对认不出**。
    // 实测 R10 明明有 3 种处置（已处置 / 挂账 / 未处置），只数出 1 种 → 第 2 项长期 ✗
    // → `ask` 永远到不了「已穷尽」，求助通道被永久堵死（10 轮里 9 轮判 0 种）。
    // 自测为什么没抓到：夹具用的正是注释里那套词（已修 / 挂账），**和代码同源，测不出与现实的偏差**。
    const KIND_GROUPS = [
      ['已修', '已处置', '已修复', '已改'],
      ['未修', '未处置', '未修复'],
      ['部分修', '部分处置', '部分修复'],
      ['驳回', '判不成立', '不成立'],
      ['挂账'],
    ]
    const kinds = KIND_GROUPS.filter((g) => g.some((k) => t.includes(k)))
    blueInfo.push(`${r}=${kinds.length}种`)
    if (kinds.length >= 2) multiBlue++
  }
  checks.push({
    id: 2,
    name: '蓝队 ≥2 种修法',
    ok: multiBlue > 0,
    detail: multiBlue > 0 ? `${multiBlue} 轮的 02-blue.md 记录 ≥2 种处置策略` : `各轮处置策略：${blueInfo.join(', ')}`,
  })

  // 3) 确定性工具跑过：看有没有留痕（_auto.json / 各轮的指纹目录 / gate 记录）
  //    v6.25 修正：第一版把「11 轮有 fingerprints/」算成 1 条留痕，于是判"不足"。
  //    实际这是**很强的证据** —— 每一轮都跑过 init/fp 才会有指纹目录。
  //    改成数「独立证据点」，且指纹轮数 ≥2 单独就算通过。
  const toolTraces = []
  if (existsSync(join(root, '_auto.json'))) toolTraces.push('_auto.json（自动续跑发条）')
  let fpDirs = 0
  for (const r of sorted) if (existsSync(join(root, r, 'fingerprints'))) fpDirs++
  if (fpDirs >= 2) toolTraces.push(`${fpDirs} 轮有 fingerprints/（每轮跑过 init/fp）`)
  // state.md 是闸门台账，只在闸门后追加 → 有它说明 gate 跑过
  if (existsSync(join(root, 'state.md'))) toolTraces.push('state.md（闸门台账）')
  const toolOk = fpDirs >= 2 || toolTraces.length >= 2
  checks.push({
    id: 3,
    name: '确定性工具跑过',
    ok: toolOk,
    detail: toolOk
      ? toolTraces.join(' + ')
      : `留痕不足（${toolTraces.join(' + ') || '无'}；需 ≥2 轮 fingerprints/ 或 ≥2 类留痕）`,
  })

  // 4) ≥2 轮完整对抗
  checks.push({
    id: 4,
    name: '≥2 轮完整对抗',
    ok: sorted.length >= 2,
    detail: `${sorted.length} 轮（${sorted.join(', ')}）`,
  })

  // 5) 卡点性质须人工声明（见 _ask/00-gate.md）
  const gateFile = join(root, '_ask', '00-gate.md')
  let declared = false
  if (existsSync(gateFile)) {
    const t = readFileSync(gateFile, 'utf8')
    declared = /卡点性质\s*[:：]\s*外部事实/.test(t)
  }
  checks.push({
    id: 5,
    name: '卡点性质=外部事实（须人工声明）',
    ok: declared,
    detail: declared
      ? '已在 _ask/00-gate.md 声明「卡点性质：外部事实」'
      : `未声明。请在 ${gateFile} 写一行「卡点性质：外部事实 — <具体缺什么>」。` +
        '这一条**故意不自动通过**：能机械查的才自动判，查不了的必须留痕。',
  })

  const exhausted = checks.every((c) => c.ok)

  console.log(`ASK_${exhausted ? 'EXHAUSTED' : 'NOT_EXHAUSTED'}: ${root}`)
  console.log(`  轮次=${sorted.length}`)
  for (const c of checks) {
    console.log(`  [${c.ok ? '✓' : '✗'}] ${c.id}. ${c.name}: ${c.detail}`)
  }

  if (sub === 'check') {
    if (!exhausted) {
      console.log('\n还没穷尽 —— 不许找用户。先把上面打 ✗ 的补上。')
      return 0
    }
    console.log('\n已穷尽 —— 可以找用户了。下一步：ask build 生成三份 MD。')
    return 1
  }

  if (sub === 'build') {
    if (!exhausted) {
      console.error('\nASK_REFUSED: 还没穷尽，拒绝生成求助包。')
      console.error('  用户原话：「但更多的是问你自己，你实在毫无办法才来找我。」')
      console.error('  补完上面 ✗ 的项再跑一次。')
      return 1
    }
    return buildAskPack(root, sorted, checks)
  }

  return die(`ask: 未知子命令 ${sub}（可用 check / build）`)
}

/**
 * 生成三份 MD + 对话提示词。**全部从真实产物抽取**，不手写、不臆测。
 */
function buildAskPack(root, sorted, checks) {
  const askDir = join(root, '_ask')
  mkdirSync(askDir, { recursive: true })
  // v6.25 实测 bug：最新一轮（R12-1104a1）只有目录、没有 03-review.md，
  // 直接取 sorted[last] 会拿到空判定表 →「未结案 0 条」→ 03 待决清单是空的，
  // 而求助包最核心的就是那份清单。**必须回退到最近一个有 03-review.md 的轮次。**
  const withReview = sorted.filter((r) => existsSync(join(root, r, '03-review.md')))
  if (withReview.length === 0) die('ask: 没有任何轮次有 03-review.md，无从生成求助包')
  const latest = withReview[withReview.length - 1]
  const skipped = sorted.slice(sorted.indexOf(latest) + 1)
  const ldir = join(root, latest)
  const now = new Date().toISOString()

  // ---- 抽取真实数据 ----
  const reviewPath = existsSync(join(ldir, '03-review.md')) ? join(ldir, '03-review.md') : null
  const rows = reviewPath ? parseVerdict(reviewPath) : []
  const { t, claimed } = tally(rows)
  const openRows = rows.filter((r) => r.level && !['已消除', '不成立'].includes(r.level))
  const targetTxt = existsSync(join(ldir, '00-target.md')) ? readFileSync(join(ldir, '00-target.md'), 'utf8') : ''
  const blueTxt = existsSync(join(ldir, '02-blue.md')) ? readFileSync(join(ldir, '02-blue.md'), 'utf8') : ''
  const sumTxt = existsSync(join(ldir, '04-summary.md')) ? readFileSync(join(ldir, '04-summary.md'), 'utf8') : ''

  // 未决项：仍未结案的致命/严重优先，其次一般
  const rank = { '致命': 0, '严重': 1, '一般': 2, '优化': 3, '挂账': 4 }
  const open = openRows.slice().sort((a, b) => (rank[a.level] ?? 9) - (rank[b.level] ?? 9))

  // v6.25 实测：不同轮次的判定表列序完全不同，parseVerdict 抽出的 loc/ev 常常是 undefined
  // （R11 的表头是 `| 用例 | 级别 → 处置 | 位置 | 现值与理由 |`，位置与理由合并在最后一列）。
  // 求助包里位置写「—」等于让外部 AI 无法判断 —— 那是生成器的缺陷，不是数据缺失。
  // 解法：**保留原始行文本**，从 03-review.md 里按编号回查该行，原样贴出。
  const reviewLines = reviewPath ? readFileSync(reviewPath, 'utf8').split(/\r?\n/) : []
  function rawRowFor(id) {
    if (!id) return null
    const re = new RegExp(`^\\|\\s*${String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\|`)
    for (const l of reviewLines) if (re.test(l)) return l.trim()
    return null
  }
  // 同时回查红队原始用例（01-cases*.md）里对该编号的描述
  const caseLines = []
  for (const f of readdirSync(ldir).filter((x) => /^01-cases.*\.md$/.test(x))) {
    caseLines.push(...readFileSync(join(ldir, f), 'utf8').split(/\r?\n/))
  }
  function rawCaseFor(id) {
    if (!id) return null
    const re = new RegExp(`^\\|\\s*${String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\|`)
    for (const l of caseLines) if (re.test(l)) return l.trim()
    return null
  }

  const lines = (s) => s.split(/\r?\n/)

  // ============ 01 背景与目标 ============
  const f1 = join(askDir, '01-背景与目标.md')
  const p1 = [
    `# 01 背景与目标`,
    ``,
    `> 本文件由 \`redblue.mjs ask build\` 从真实产物自动生成，生成时间 ${now}。`,
    `> 所有数字与结论都来自实际文件，未做任何人工润色。`,
    ``,
    `## 1. 任务是什么`,
    ``,
    `正在做一件科研任务，采用「红蓝对抗」评审：红队只攻击、蓝队只修、主控判放行。`,
    `现在卡住了，需要外部独立判断。`,
    ``,
    `**产物根**：\`${root}\``,
    `**已跑轮次**：${sorted.length} 轮（${sorted.join(' → ')}）`,
    `**当前轮**：${latest}`,
    ``,
    `## 2. 交付件与验收点`,
    ``,
    targetTxt
      ? `以下摘自 \`${latest}\\00-target.md\`（原文，未删改）：\n\n\`\`\`markdown\n${targetTxt.slice(0, 12000)}\n\`\`\``
      : `（本轮没有 00-target.md —— 这本身是一个缺陷，应记入未决清单。）`,
    ``,
    `## 3. 当前到哪一步`,
    ``,
    `最近一轮（${latest}）判定表统计：`,
    ``,
    `| 项 | 数量 |`,
    `| --- | --- |`,
    `| 判定表总行数 | ${rows.length} |`,
    ...['致命', '严重', '一般', '优化', '已消除', '挂账', '不成立'].map((k) => `| ${k} | ${t[k]} |`),
    `| **仍未结案** | **${open.length}** |`,
    ``,
    `其中「按级别列的真实严重度」（未结案部分）：致命=${claimed['致命']} 严重=${claimed['严重']} 一般=${claimed['一般']} 优化=${claimed['优化']}`,
    ``,
    `## 4. 已经排除了什么`,
    ``,
    `「穷尽」五条判据的核对结果（本文件生成时实测）：`,
    ``,
    `| # | 判据 | 结果 | 详情 |`,
    `| --- | --- | --- | --- |`,
    ...checks.map((c) => `| ${c.id} | ${c.name} | ${c.ok ? '✓ 通过' : '✗ 未通过'} | ${String(c.detail).replace(/\|/g, '\\|')} |`),
    ``,
    `五条全过才允许生成本文件。**未过就不许找用户**——这是机制的硬约束，不是建议。`,
    ``,
    `## 5. 不要重复我们做过的`,
    ``,
    `- 我们已经跑过 ${sorted.length} 轮完整红蓝对抗，不是没试过。`,
    `- 每轮的用例、处置、判定表都在 \`${root}\` 下，编号可追溯。`,
    `- 确定性工具（recount / gate / contract / reattack / converge）已跑过，结果见 \`02-卡点与已试路径.md\`。`,
    `- **请不要建议「再跑一轮红蓝对抗」或「加个检查脚本」** —— 那就是我们正在做的事。`,
    ``,
  ].join('\n')
  writeFileSync(f1, p1, 'utf8')

  // ============ 02 卡点与已试路径 ============
  const f2 = join(askDir, '02-卡点与已试路径.md')
  const p2 = [
    `# 02 卡点与已试路径`,
    ``,
    `> 自动生成，时间 ${now}。本文件的目的：让你**不必重复我们已经失败的路径**。`,
    ``,
    `## 1. 卡在哪`,
    ``,
    `仍未结案的条目共 ${open.length} 条（按严重度排序）：`,
    ``,
    open.length
      ? `| 编号 | 级别 | 处置状态 | 原文（03-review.md 原样） |\n| --- | --- | --- | --- |\n` +
        open.slice(0, 60).map((r) => {
          const raw = rawRowFor(r.id)
          const esc = (raw ?? '（原始行未找到）').replace(/\|/g, '\\|').slice(0, 400)
          return `| ${r.id ?? '?'} | ${r.level} | ${r.status ?? '?'} | ${esc} |`
        }).join('\n')
      : `（没有未结案条目 —— 若如此，说明不是「卡点」而是「收敛」，不该生成求助包。）`,
    ``,
    open.length > 60 ? `（另有 ${open.length - 60} 条未列出，完整见 \`${latest}\\03-review.md\`）\n` : '',
    `## 2. 蓝队试过什么`,
    ``,
    blueTxt
      ? `以下摘自 \`${latest}\\02-blue.md\`（原文，未删改）：\n\n\`\`\`markdown\n${blueTxt.slice(0, 14000)}\n\`\`\``
      : `（本轮没有 02-blue.md —— 说明蓝队没执行，这是机制缺陷，不是任务卡点。）`,
    ``,
    `## 3. 主控自己复盘过什么`,
    ``,
    sumTxt
      ? `以下摘自 \`${latest}\\04-summary.md\`（原文，未删改）：\n\n\`\`\`markdown\n${sumTxt.slice(0, 14000)}\n\`\`\``
      : `（本轮没有 04-summary.md。）`,
    ``,
    `## 4. 历史轮次怎么走的`,
    ``,
    `| 轮次 | 判定表行数 | 未结案 | 红队产物 | 蓝队产物 |`,
    `| --- | --- | --- | --- | --- |`,
    ...sorted.map((r) => {
      const d = join(root, r)
      const rv = join(d, '03-review.md')
      let n = 0, o = 0
      if (existsSync(rv)) {
        const rr = parseVerdict(rv)
        n = rr.length
        o = rr.filter((x) => x.level && !['已消除', '不成立'].includes(x.level)).length
      }
      const nr = readdirSync(d).filter((f) => /^01-cases.*\.md$/.test(f)).length
      const nb = existsSync(join(d, '02-blue.md')) ? 1 : 0
      return `| ${r} | ${n} | ${o} | ${nr} | ${nb} |`
    }),
    ``,
    `## 5. 我们明确试过且失败的方向`,
    ``,
    `| 方向 | 为什么失败 |`,
    `| --- | --- |`,
    `| 多跑几轮红蓝 | 已跑 ${sorted.length} 轮，同一处反复出现，不是轮数不够 |`,
    `| 加确定性检查脚本 | 本机制已有 21 个子命令 + 59 条自检，加脚本解决不了「需要外部事实」的问题 |`,
    `| 让主控自己判 | 已实证主控会自我放行（R10 假放行），这正是要靠外部判断的原因 |`,
    `| 缩小审查范围 | 缩小范围本身是缺陷，会被下一轮红队抓出来 |`,
    ``,
    `## 6. 确定性工具的实际输出`,
    ``,
    `生成本文件时的闸门与契约结论：`,
    ``,
    `- 判定表解析：${rows.length} 行，未识别 ${rows.filter((r) => !r.level).length} 行`,
    `- 致命=${t['致命']} 严重=${t['严重']}（按状态桶）`,
    `- 按级别列的真实严重度：致命=${claimed['致命']} 严重=${claimed['严重']}`,
    `- 未结案 ${open.length} 条`,
    ``,
    `> 若你需要复跑：\`redblue.mjs gate "${latest}\\03-review.md"\`，退出码 0=放行 / 1=不放行 / 2=无法判定。`,
    ``,
  ].join('\n')
  writeFileSync(f2, p2, 'utf8')

  // ============ 03 待决问题清单 ============
  const f3 = join(askDir, '03-待决问题清单.md')
  const qs = open.slice(0, 8).map((r, i) => {
    const id = r.id ?? `Q${i + 1}`
    const rawRow = rawRowFor(id)
    const rawCase = rawCaseFor(id)
    return [
      `### 问题 ${i + 1}（对应 ${id}，级别 ${r.level}）`,
      ``,
      `**红队原始用例**（摘自 01-cases*.md，原样）：`,
      ``,
      rawCase ? `\`\`\`markdown\n${rawCase.slice(0, 600)}\n\`\`\`` : `（该编号在 01-cases*.md 里未找到原样行）`,
      ``,
      `**本轮判定**（摘自 03-review.md，原样）：`,
      ``,
      rawRow ? `\`\`\`markdown\n${rawRow.slice(0, 800)}\n\`\`\`` : `（该编号在 03-review.md 里未找到原样行）`,
      ``,
      `**可选方案**：`,
      ``,
      `| 选项 | 做法 | 代价 |`,
      `| --- | --- | --- |`,
      `| A | 按红队判据直接改交付件 | 需要能独立复算，若复算不了则改不动 |`,
      `| B | 判红队「不成立」并给反证 | 反证必须落地，否则等于掩盖 |`,
      `| C | 挂账，写明本轮无法修的原因 | 挂账不得含致命/严重，C 只对一般/优化可用 |`,
      ``,
      `**我们的倾向**：${r.level === '致命' || r.level === '严重' ? 'A 或 B（不许 C，硬规则 8）' : 'C 可接受，但须写清原因'}`,
      `**需要你判断**：这条的判据是否成立？若成立，A/B 选哪个；若不成立，反证该指向哪里？`,
      ``,
    ].join('\n')
  })
  const p3 = [
    `# 03 待决问题清单`,
    ``,
    `> 自动生成，时间 ${now}。**请逐条回答编号问题**，不要泛泛而谈。`,
    ``,
    `## 怎么用这份清单`,
    ``,
    `1. 每条问题都有 A/B/C 三个选项，选一个并说理由。`,
    `2. 如果附件信息不足以判断，**明确说「信息不足」**，不要编一个答案。`,
    `3. 如果你认为我们某条「已试路径」其实还有救，指出来 —— 那是我们最需要的信息。`,
    ``,
    `## 待决问题（共 ${qs.length} 条，按严重度排序）`,
    ``,
    qs.length ? qs.join('\n') : `（无未结案条目）`,
    ``,
    `## 附：需要你特别留意的一件事`,
    ``,
    `本机制最深的一个缺陷是：**级别列（这条有多严重）在历史上被状态列（这条修了没有）结构性地丢弃过**。`,
    `所以如果你看到「已消除」很多但「致命/严重」为 0，请先怀疑是不是分级信息丢了，而不是真的没问题。`,
    ``,
    `## 回答格式建议`,
    ``,
    `\`\`\``,
    `问题 1：选 A。理由：…（若信息不足则写「信息不足，需要 X」）`,
    `问题 2：…`,
    `\`\`\``,
    ``,
  ].join('\n')
  writeFileSync(f3, p3, 'utf8')

  // ---- 报告 + 提示词 ----
  const sz = (p) => statSync(p).size
  console.log(`\nASK_BUILD_OK: 三份 MD 已写入 ${askDir}`)
  console.log(`  01-背景与目标.md      ${sz(f1)} B`)
  console.log(`  02-卡点与已试路径.md  ${sz(f2)} B`)
  console.log(`  03-待决问题清单.md    ${sz(f3)} B`)
  console.log(`  数据源轮次=${latest}（最近一个有 03-review.md 的轮次）`)
  if (skipped.length > 0) console.log(`  NOTICE: ${skipped.join(', ')} 无 03-review.md，已跳过（不作为数据源）`)
  console.log(`  未结案条目=${open.length}（清单取前 ${qs.length} 条）`)
  const over = [f1, f2, f3].filter((p) => sz(p) > 20480)
  if (over.length > 0) console.log(`  NOTICE: ${over.map((p) => basename(p)).join(', ')} 超过 20 KB —— 外部 AI 可能读不完，考虑拆分`)
  console.log('\n===== 下面是给外部 AI 的提示词，直接复制 =====\n')
  console.log([
    `我在做一个科研任务，遇到卡点，需要你独立判断。`,
    `附件三份 MD 是完整背景：01 背景与目标 / 02 卡点与已试路径 / 03 待决问题清单。`,
    ``,
    `要求：`,
    `1. 只基于附件事实回答，不要臆测。附件没写的东西，就说「信息不足」。`,
    `2. 逐条回答 03 里的编号问题，每条选一个选项并给理由。`,
    `3. 不要建议「再多跑几轮红蓝对抗」或「加个检查脚本」—— 那正是我们已经在做的事。`,
    `4. 如果你认为我们 02 里列出的某条「已试路径」其实还有救，请指出来。`,
    `5. 如果你发现我们的结论里有自相矛盾的地方，直接指出，不要客气。`,
    ``,
    `我们最怕的是被顺着说「看起来没问题」。请直接给反对意见。`,
  ].join('\n'))
  console.log('\n===========================================\n')
  return 0
}

// ---------------------------------------------------------------------- main

const [cmd, ...args] = process.argv.slice(2)
const table = {
  init: cmdInit, fp: cmdFp, diff: cmdDiff, shortcode: cmdShortcode, contract: cmdContract, cite: cmdCite, scaffold: cmdScaffold,
  audit: cmdAudit, recount: cmdRecount, refs: cmdRefs, apply: cmdApply, metrics: cmdMetrics, scancheck: cmdScancheck, quality: cmdQuality, canary: cmdCanary, carry: cmdCarry, route: cmdRoute, attack: cmdAttack, ident: cmdIdent, occur: cmdOccur, xcheck: cmdXcheck, gate: cmdGate, validate: cmdValidate, salvage: cmdSalvage, checkpoint: cmdCheckpointTemplate, adjudicate: cmdAdjudicate, selftest,
  reattack: cmdReattack, converge: cmdConverge, severity: cmdSeverity, bundle: cmdBundle, churn: cmdChurn, auto: cmdAuto, ask: cmdAsk, spawn: cmdSpawn, archive: cmdArchive, project: cmdProject, history: cmdHistory,
  merge: cmdMerge,
}
if (!cmd || !(cmd in table)) die(`unknown command: ${cmd ?? '(none)'}\navailable: ${Object.keys(table).join(', ')}`)
const _r = table[cmd](args)
if (_r && typeof _r.then === 'function') {
  _r.then((code) => process.exit(typeof code === 'number' ? code : 0))
       .catch((e) => { console.error('COMMAND_FAILED: ' + String(e && e.stack ? e.stack : e)); process.exit(2) })
} else { process.exit(_r) }
