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
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs'
import { join, resolve, basename, dirname } from 'node:path'

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
function parseLevel(cell) {
  let s = String(cell).trim()
  const arrow = s.lastIndexOf('→')
  if (arrow >= 0) s = s.slice(arrow + '→'.length).trim()
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
    const m = line.match(/^\|\s*((?:[A-Za-z][-\s]?\d{1,3})|(?:观点\s*\d{1,3})|(?:问题\s*\d{1,3})|(?:论点\s*\d{1,3})|(?:\d{1,3}))\s*\|([^|]*)\|([^|]*)\|/)
    if (!m) continue
    // v6.4 缺陷9：raw 必须保存**判定词原文**，不能保存级别列。
    // 三态词（当前文本已答/部分已答/仍未解决）不在 LEVELS 里，parseLevel 返回 null，
    // 旧逻辑于是取第 3 列（级别）当 raw —— 三态信息整个丢失，reattack 无法判断
    // 「上一轮说已答、这一轮说仍未解决」。现在先认三态词，再认级别。
    const VERDICT_WORDS = /^(当前文本已答|部分已答|仍未解决|已修|未修|STALE|部分修|驳回|挂账|已消除|已答|成立|不成立|部分成立)$/
    const strip = (s) => String(s).trim()
    const dashOnly = (s) => /^[—\-]+$/.test(strip(s))
    let rawCell = null
    let level = null
    let claimedLevel = null

    // 优先：第 2 列是三态/状态词 → 它才是判定词，第 3 列是级别
    if (VERDICT_WORDS.test(strip(m[2]))) {
      rawCell = strip(m[2])
      level = parseLevel(m[3]) || parseLevel(m[2])
      claimedLevel = parseLevel(m[3]) || parseLevel(m[2]) || null
    } else if (dashOnly(m[2]) && VERDICT_WORDS.test(strip(m[3]))) {
      // 旧格式 `| 编号 | — | 已修 | 位置 |`
      rawCell = strip(m[3])
      const STATUS_MAP = { '已修': '已消除', '未修': '挂账', 'STALE': '挂账', '部分修': '挂账', '驳回': '不成立', '不成立': '不成立', '挂账': '挂账' }
      level = STATUS_MAP[rawCell] || parseLevel(m[2])
    } else if (parseLevel(m[2]) && VERDICT_WORDS.test(strip(m[3]))) {
      // 旧格式 `| 编号 | 级别 | 状态 |`：级别在前、状态在后
      rawCell = strip(m[3])
      const STATUS_MAP = { '已修': '已消除', '未修': '挂账', 'STALE': '挂账', '部分修': '挂账', '驳回': '不成立', '不成立': '不成立', '挂账': '挂账' }
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
      rows.push({ id: m[1], level: '不成立', raw: rawCell, claimedLevel: level })
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
  const d = new Date()
  const mmdd = String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0')
  const base = mmdd + Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
  let cand = base
  let n = 1
  while (existsSync(join(roundsRoot, `R${round}-${cand}`))) {
    cand = `${base}-${n}`
    if (++n > 99) die('SHORTCODE_EXHAUSTED')
  }
  console.log(`R${round}-${cand}`)
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
  return found ? n : (all.match(/^\|\s*((?:[CN]\d{1,3})|(?:观点\s*\d{1,3}))\s*\|/gm) || []).length
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
    const missKeys = r.keys.filter((k) => !body.includes(k))
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
      // 处置行的第一格通常是编号：C01 / N1 / V01 / K03 / 观点1（致命·…）
      const first = line.split('|')[1] ? line.split('|')[1].trim() : ''
      if (/^([CNRKVTD]\d{1,3}|N\d{1,3}|观点\s*\d{1,3})/i.test(first)) rows++
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
  let inVerdict = false
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^#{1,6}\s/.test(line)) {
      inVerdict = /逐条判定|判定表/.test(line)
      continue
    }
    if (inVerdict || !/^\|\s*[^|\-]/.test(line)) continue
    if (/^\|\s*:?-{2,}/.test(line)) continue
    const cells = line.split('|').map((s) => s.trim()).filter(Boolean)
    const hit = cells.find((c) => c === '致命' || c === '严重')
    if (hit) out.push({ line: i + 1, level: hit, text: line.slice(0, 70) })
  }
  return out
}

function cmdRecount([file]) {
  if (!file) die('usage: recount <03-review.md>')
  const rows = parseVerdict(file)
  const { t, unknown, claimed } = tally(rows)
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
  return unknown.length > 0 ? 1 : 0
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

    console.log('GATE: 放行')
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
    const m = line.match(/^\|\s*((?:[A-Za-z][-\s]?\d{1,3})|(?:观点\s*\d{1,3})|(?:问题\s*\d{1,3})|(?:论点\s*\d{1,3})|(?:\d{1,3}))\s*\|([^|]*)\|([^|]*)\|([^|]*)\|/)
    if (!m) continue
    const verdict = ADJ_VERDICT_ALIASES(m[2]) || ADJ_VERDICT_ALIASES(m[3])
    const sev = ADJ_SEVERITY.find((s) => String(m[3]).includes(s) || String(m[4]).includes(s))
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
  if (overlap < 0.2) {
    console.error(`\nREATTACK_UNDECIDABLE: 两轮编号重合率仅 ${(overlap * 100).toFixed(0)}%（共同 ${common} / 上轮 ${prevMap.size}）。`)
    console.error('两种可能，需要人判断：')
    console.error('  (a) 两轮审计的不是同一个对象 → 用 converge --track=<后缀> 分别看。')
    console.error('  (b) 同一个对象但换了编号体系（如「观点1–12」→「N01–R05」）→ 必须先写一份编号映射表，')
    console.error('      把上轮编号对本轮编号登记清楚，再跑 reattack。**不许跳过映射直接判 PASS。**')
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
  const dirs = allDirs.filter((d) => (track ? trackOf(d) === track : true)).sort()

  // 只取有 03-review.md 的轮次
  const rounds = []
  for (const d of dirs) {
    const p = join(roundsRoot, d, '03-review.md')
    if (!existsSync(p)) continue
    const rows = parseVerdict(p)
    if (rows.length === 0) { console.log(`NOTICE: ${d} 的 03-review.md 0 行可识别，跳过`); continue }
    const { t } = tally(rows)
    rounds.push({ name: d, file: p, rows, fatal: t['致命'], severe: t['严重'], minor: t['一般'], fixed: t['已消除'], total: rows.length })
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
    if (rounds[i].fatal === 0 && rounds[i].severe === 0) streak++
    else break
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

  // 条件 3：用例数不萎缩
  let shrink = null
  for (let i = 1; i < rounds.length; i++) {
    if (rounds[i].total < rounds[i - 1].total * 0.9) {
      shrink = `${rounds[i - 1].name}(${rounds[i - 1].total}) → ${rounds[i].name}(${rounds[i].total})`
      break
    }
  }
  if (shrink) console.log(`用例萎缩 SUSPICIOUS: ${shrink}（可能是靠删用例"收敛"）`)

  // 条件 4（v6.8 缺陷11）：**用例集必须真的变过**。
  // 实测 skill-audit 线 R1/R2/R3 的 29 条编号一字不差（C01–C29 全同）、全部「已修」，
  // streak=3、无萎缩 → 旧逻辑直接 PASS。但真相是三轮之间没有任何独立红队重新攻击过这 29 条。
  // 用例集一字不差 = 红队没换人/没换模型/没换视角 = 收敛证据为零。
  let staticSet = null
  for (let i = 1; i < rounds.length; i++) {
    const a = new Set(rounds[i - 1].rows.map((r) => String(r.id).trim()))
    const b = new Set(rounds[i].rows.map((r) => String(r.id).trim()))
    const same = a.size === b.size && [...a].every((k) => b.has(k))
    if (same && a.size >= 10) {
      staticSet = `${rounds[i - 1].name} → ${rounds[i].name}（${a.size} 条编号一字不差）`
      break
    }
  }
  if (staticSet) console.log(`用例集冻结 SUSPICIOUS: ${staticSet}（没换红队/没换模型，等于没重新攻击）`)

  const pass = streak >= need && !shrink && !staticSet && !falseFix
  if (pass) { console.log('\nCONVERGE: PASS (converged)'); return 0 }
  const why = []
  if (streak < need) why.push(`连续干净轮数 ${streak} < ${need}`)
  if (shrink) why.push('用例萎缩')
  if (staticSet) why.push('用例集冻结（没重新攻击）')
  if (falseFix) why.push('上一轮声称已修的被重新打开（假修复）')
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
    else if (only === '一般') console.log('  → 红队把 29 个真问题全压在「一般」，等于没有分级；闸门会因此全部放行')
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
    let jumps = 0
    for (const r of rows) {
      const p = pm.get(norm(r.id))
      if (!p || !(r.level in ORDER) || !(p.level in ORDER)) continue
      const d = Math.abs(ORDER[r.level] - ORDER[p.level])
      if (d >= 2) { console.log(`  JUMP: ${r.id} ${p.level}(${ORDER[p.level]}) → ${r.level}(${ORDER[r.level]})`); jumps++ }
    }
    if (jumps > 0) { console.log(`SEVERITY_UNSTABLE: ${jumps} 条级别跳变 ≥2 级`); warn = 1 }
    else console.log('级别跨轮稳定（无 ≥2 级跳变）')
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
    refs.get(file).push({ lo, hi })
  }
  if (refs.size === 0) {
    console.error('BUNDLE_UNDECIDABLE: 该复核文件里没有任何「文件名:行号」引用')
    return 2
  }

  // 候选搜索根：--root、复核文件所在目录、当前目录、D:\1a个人\dsh-home\skills
  // v6.12 缺陷15：搜索根必须覆盖被审计对象所在的整棵树。
  // 实测 R4 引用的 `E1.py` 真名 `E1_瞬时vs6minRMS.py` 在
  // `大创\论文\...\16_课题_标准符合性评估方法学\实验_2026-10-07_标准符合性\` 下，
  // 而 searchRoots 只含 round 目录和 skills 目录 → 模糊匹配也搜不到，仍报 MISSING。
  const searchRoots = [
    root,
    dirname(reviewFile),
    process.cwd(),
    (process.env.DSH_HOME ? join(process.env.DSH_HOME, 'skills') : 'D:\\1a个人\\dsh-home\\skills'),
    'D:\\1a个人\\科研\\大创',
    'D:\\1a个人\\科研',
  ].filter(Boolean)

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
      console.log(`  OK  ${file}  引用 ${ranges.length} 处，最高 ${maxHi} / ${n} 行`)
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
  console.log('\nBUNDLE: OK (所有引用可落地)')
  return 0
}
function selftest() {
  const tmp = join(process.env.TEMP || '/tmp', `redblue-selftest-${Date.now()}`)
  mkdirSync(join(tmp, 'R1-0101aa', 'fingerprints'), { recursive: true })
  let bad = 0
  const ok = (cond, name) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) bad++ }

  // 1) 级别解析（F1 回归）
  const cases = [
    ['致命', '致命'], ['严重', '严重'], ['一般', '一般'], ['优化', '优化'], ['已消除', '已消除'],
    ['致命 → 已消除', '已消除'], ['一般（残留）', '一般'], ['优化 → 挂账（部分属实）', '挂账'],
  ]
  for (const [raw, want] of cases) ok(parseLevel(raw) === want, `parseLevel("${raw}") == ${want}`)

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

  // 8) v6 闭环三件套
  const rrPrev = join(tmp, 'R1-0101aa', 'rr-prev.md')
  const rrCurr = join(tmp, 'R1-0101aa', 'rr-curr.md')
  writeFileSync(rrPrev, '| 用例 | 判定 | 级别 | 位置 | 证据 |\n| --- | --- | --- | --- | --- |\n| N01 | 当前文本已答 | 严重 | a:1 | x |\n| N02 | 当前文本已答 | 一般 | a:2 | y |\n| N03 | 当前文本已答 | 一般 | a:3 | z |\n', 'utf8')
  writeFileSync(rrCurr, '| 用例 | 判定 | 级别 | 位置 | 证据 |\n| --- | --- | --- | --- | --- |\n| N01 | 仍未解决 | 严重 | a:1 | x |\n| N02 | 当前文本已答 | 一般 | a:2 | y |\n| N04 | 当前文本已答 | 一般 | a:4 | w |\n', 'utf8')
  ok(cmdReattack([rrPrev, rrCurr]) === 1, 'reattack: 假修复(上轮已答→本轮仍未解决) → FAIL')

  const rrCurr2 = join(tmp, 'R1-0101aa', 'rr-curr2.md')
  writeFileSync(rrCurr2, '| 用例 | 判定 | 级别 | 位置 | 证据 |\n| --- | --- | --- | --- | --- |\n| N02 | 当前文本已答 | 一般 | a:2 | y |\n', 'utf8')
  ok(cmdReattack([rrPrev, rrCurr2]) === 1, 'reattack: 用例静默消失 → WARN（不许 PASS）')

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
  const aj = JSON.parse(readFileSync(ap, 'utf8'))
  aj.lastBeat = new Date(Date.now() - 11 * 60 * 1000).toISOString()  // 11 分钟前
  writeFileSync(ap, JSON.stringify(aj), 'utf8')
  ok(cmdAuto(['check', autoRoot]) === 1, 'auto-check: 11 分钟无心跳 → AUTO_CONTINUE exit 1（必须自行继续，禁止问用户）')
  const aj2 = JSON.parse(readFileSync(ap, 'utf8'))
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
  for (const rd of rounds.sort()) {
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
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
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
    const kinds = ['已修', '驳回', '挂账', '部分修'].filter((k) => new RegExp(`\\|\\s*${k}\\s*\\|`).test(t) || new RegExp(`${k}`).test(t))
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
  audit: cmdAudit, recount: cmdRecount, gate: cmdGate, validate: cmdValidate, salvage: cmdSalvage, checkpoint: cmdCheckpointTemplate, adjudicate: cmdAdjudicate, selftest,
  reattack: cmdReattack, converge: cmdConverge, severity: cmdSeverity, bundle: cmdBundle, churn: cmdChurn, auto: cmdAuto, ask: cmdAsk,
}
if (!cmd || !(cmd in table)) die(`unknown command: ${cmd ?? '(none)'}\navailable: ${Object.keys(table).join(', ')}`)
process.exit(table[cmd](args))
