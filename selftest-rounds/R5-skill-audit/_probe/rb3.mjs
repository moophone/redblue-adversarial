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
    const m = line.match(/^\|\s*((?:[CNRr]\d{1,3})|(?:观点\s*\d{1,3})|(?:R[-\s]?\d{1,3}))\s*\|([^|]*)\|([^|]*)\|/)
    if (!m) continue
    // v6.4 缺陷9：raw 必须保存**判定词原文**，不能保存级别列。
    // 三态词（当前文本已答/部分已答/仍未解决）不在 LEVELS 里，parseLevel 返回 null，
    // 旧逻辑于是取第 3 列（级别）当 raw —— 三态信息整个丢失，reattack 无法判断
    // 「上一轮说已答、这一轮说仍未解决」。现在先认三态词，再认级别。
    const VERDICT_WORDS = /^(当前文本已答|部分已答|仍未解决|已修|未修|STALE|部分修|驳回|挂账|已消除|已答|成立|不成立)$/
    const strip = (s) => String(s).trim()
    const dashOnly = (s) => /^[—\-]+$/.test(strip(s))
    let rawCell = null
    let level = null

    // 优先：第 2 列是三态/状态词 → 它才是判定词，第 3 列是级别
    if (VERDICT_WORDS.test(strip(m[2]))) {
      rawCell = strip(m[2])
      level = parseLevel(m[3]) || parseLevel(m[2])
    } else if (dashOnly(m[2]) && VERDICT_WORDS.test(strip(m[3]))) {
      // 旧格式 `| 编号 | — | 已修 | 位置 |`
      rawCell = strip(m[3])
      const STATUS_MAP = { '已修': '已消除', '未修': '挂账', 'STALE': '挂账', '部分修': '挂账', '驳回': '不成立', '挂账': '挂账' }
      level = STATUS_MAP[rawCell] || parseLevel(m[2])
    } else if (parseLevel(m[2]) && VERDICT_WORDS.test(strip(m[3]))) {
      // 旧格式 `| 编号 | 级别 | 状态 |`：级别在前、状态在后
      rawCell = strip(m[3])
      const STATUS_MAP = { '已修': '已消除', '未修': '挂账', 'STALE': '挂账', '部分修': '挂账', '驳回': '不成立', '挂账': '挂账' }
      // 状态词是「当前是否修好」的事实，比级别列更能说明这一行的真实状态。
      // 但「已修」时级别列才是原始严重度 —— 两列都要留：level 用状态映射，raw 存状态词。
      level = STATUS_MAP[rawCell] || parseLevel(m[2])
    } else {
      // 新格式 `| 用例 | 判定 | 级别 | 位置 |`：第 2 列是「成立/不成立」这类非标准词
      const c2 = parseLevel(m[2])
      const c3 = parseLevel(m[3])
      level = c2 || c3
      rawCell = (c2 ? strip(m[2]) : strip(m[3]))
    }
    if (!level) continue
    rows.push({ id: m[1], level, raw: rawCell })
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
  return { t, unknown }
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
      if (required) { console.log(`CONTRACT_VIOLATION: missing ${f}`); fail = 1 }
      else console.log(`CONTRACT_OK(继承): ${f} 由上一轮提供`)
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
  if (!existsSync(file)) return { fatal: 0, serious: 0, rows: [] }
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
    rows,
  }
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
  const { t, unknown } = tally(rows)
  console.log(
    `致命=${t['致命']} 严重=${t['严重']} 一般=${t['一般']} 优化=${t['优化']} 已消除=${t['已消除']} 挂账=${t['挂账']} 不成立=${t['不成立']} 未识别=${unknown.length} 合计=${rows.length}`,
  )
  // v5.2 缺陷2：不只认「新问题」小节 —— 任何小节里出现 致命/严重 的表格行都要拦
  const off = scanOffTable(file)
  const stray = scanStraySeverity(file)
  if (off.rows.length > 0) console.log(`表外新问题: 致命=${off.fatal} 严重=${off.serious} 合计=${off.rows.length}（不计入上表，但闸门会看）`)
  for (const u of unknown) console.log(`UNKNOWN_LEVEL: ${u.id} raw=[${u.raw}]`)
  // 未识别 > 0 时以非零退出，避免"统计失真却静默通过"
  return unknown.length > 0 ? 1 : 0
}

function cmdGate([file]) {
  if (!file) die('usage: gate <03-review.md>')
  const rows = parseVerdict(file)
  const { t, unknown } = tally(rows)
  const fatal = t['致命']
  const severe = t['严重']
  console.log(`致命=${fatal} 严重=${severe} 一般=${t['一般']} 优化=${t['优化']} 已消除=${t['已消除']} 挂账=${t['挂账']} 不成立=${t['不成立']} 未识别=${unknown.length} 合计=${rows.length}`)
  if (t['挂账'] > 5) console.log('NOTICE: 挂账 > 5 条（不阻断，但记 04）')
  if (unknown.length > 0) { console.error(`GATE_UNDECIDABLE: ${unknown.length} 行级别无法解析，先修数据再判闸门`); return 2 }
  // v5.2 缺陷2：不只认「新问题」小节 —— 任何小节里出现 致命/严重 的表格行都要拦
  const off = scanOffTable(file)
  const stray = scanStraySeverity(file)
  if (off.rows.length > 0) console.log(`表外新问题: 致命=${off.fatal} 严重=${off.serious} 合计=${off.rows.length}`)
  if (fatal === 0 && severe === 0) {
    // v5.1：判定表干净但表外有致命/严重 ⇒ 不许放行（老会话的教训）
    if (off.fatal > 0 || off.serious > 0 || stray.length > 0) {
      const total = off.fatal + off.serious + stray.length
      console.log(`GATE: 不放行（表外还有 致命${off.fatal}/严重${off.serious}，散落未入表 ${stray.length} 条，共 ${total} 条，须先补进判定表再判）`)
      for (const s of stray.slice(0, 5)) console.log(`  STRAY: 行${s.line} ${s.text}`)
      return 1
    }
    console.log('GATE: 放行')
    return 0
  }
  console.log('GATE: 进下一轮')
  return 1
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
    const m = line.match(/^\|\s*((?:[CNRr]\d{1,3})|(?:观点\s*\d{1,3})|(?:R[-\s]?\d{1,3}))\s*\|([^|]*)\|([^|]*)\|([^|]*)\|/)
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
  if (/^(未修|仍未解决|不成立|驳回|挂账)/.test(s)) return '仍未解决'
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
  if (!q) { console.log(`CITE_LINE: ${target} = ${text.trim().slice(0, 140)}`); return 0 }
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
  const norm = (id) => {
    const m = String(id).match(/([A-Za-z])[-\s]?(\d{1,3})/)
    return m ? (m[1].toUpperCase() + String(Number(m[2])).padStart(2, '0')) : String(id)
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

  console.log(`上一轮=${prev.length} 行 本轮=${curr.length} 行 共同=${[...prevMap.keys()].filter((k) => currMap.has(k)).length}`)
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

  const pass = streak >= need && !shrink && !staticSet
  if (pass) { console.log('\nCONVERGE: PASS (converged)'); return 0 }
  const why = []
  if (streak < need) why.push(`连续干净轮数 ${streak} < ${need}`)
  if (shrink) why.push('用例萎缩')
  if (staticSet) why.push('用例集冻结（没重新攻击）')
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
  const sevRows = rows.filter((r) => r.level && r.level in ORDER)
  const dist = {}
  for (const r of sevRows) dist[r.level] = (dist[r.level] ?? 0) + 1
  console.log(`级别分布: ${Object.entries(dist).map(([k, v]) => `${k}=${v}`).join(' ')}  合计=${sevRows.length}`)

  let warn = 0
  if (sevRows.length >= 4 && Object.keys(dist).length === 1) {
    const only = Object.keys(dist)[0]
    if (only === '严重' || only === '致命') {
      console.log(`SEVERITY_NO_GRADATION: ${sevRows.length} 条全部是「${only}」——分级失效，红队可能在系统性强报`)
      warn = 1
    }
  }
  if (sevRows.length >= 4 && !dist['严重'] && !dist['致命'] && !dist['一般']) {
    console.log('SEVERITY_NO_GRADATION: 全部是「优化」——可能漏报，红队没找到实质问题')
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
  const refRe = /([\w.\-]+\.(?:md|mjs|js|py|json|txt|yml|yaml))\s*:\s*(\d+)(?:\s*[-–]\s*(\d+))?/g
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
  const searchRoots = [
    root,
    dirname(reviewFile),
    process.cwd(),
    'D:\\1a个人\\dsh-home\\skills',
  ].filter(Boolean)

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
  const r2 = cmdContract([join(tmp, 'R2-0101bb')])
  ok(r2 === 0, 'R2 无 01-cases.md → CONTRACT_OK（继承）')

  // 4.5) cite 回归（M6）
  const cf2 = join(tmp, 'R1-0101aa', 'cite-probe.md')
  writeFileSync(cf2, 'line1\n这里写着 分子未被抬高\nline3\n', 'utf8')
  ok(cmdCite([`${cf2}:2`, '分子未被抬高']) === 0, 'cite: 引文命中 → CITE_OK')
  ok(cmdCite([`${cf2}:2`, '分子同被抬高']) === 1, 'cite: 引文不命中 → CITE_FAIL')
  ok(cmdCite([`${cf2}:99`, 'x']) === 1, 'cite: 行号越界 → CITE_FAIL')

  // 5) 闸门
  ok(cmdGate([rf]) === 0, 'gate: 致命0 严重0 → 放行')

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
  const mkR = (name, n, fatal) => {
    const d = join(cvRoot3, name); mkdirSync(d, { recursive: true })
    const head = '| 用例 | 判定 | 级别 | 位置 | 证据 |\n| --- | --- | --- | --- | --- |\n'
    const body = Array.from({ length: n }, (_, i) => `| C${String(i + 1).padStart(2, '0')} | ${fatal && i === 0 ? '仍未解决' : '当前文本已答'} | ${fatal && i === 0 ? '致命' : '一般'} | a:${i} | x |\n`).join('')
    writeFileSync(join(d, '03-review.md'), head + body, 'utf8')
  }
  mkR('R1-tA', 12, false); mkR('R1-tB', 12, true); mkR('R2-tA', 12, false, 2)
  ok(cmdConverge([cvRoot3, '--track=tA']) === 0, 'converge --track=tA: 不被另一条线（tB 有致命）拖累')
  console.log(bad === 0 ? '\nSELFTEST_OK' : `\nSELFTEST_FAIL: ${bad} 项`)
  return bad === 0 ? 0 : 1
}

// ---------------------------------------------------------------------- main

const [cmd, ...args] = process.argv.slice(2)
const table = {
  init: cmdInit, fp: cmdFp, diff: cmdDiff, shortcode: cmdShortcode, contract: cmdContract, cite: cmdCite, scaffold: cmdScaffold,
  audit: cmdAudit, recount: cmdRecount, gate: cmdGate, validate: cmdValidate, salvage: cmdSalvage, checkpoint: cmdCheckpointTemplate, adjudicate: cmdAdjudicate, selftest,
  reattack: cmdReattack, converge: cmdConverge, severity: cmdSeverity, bundle: cmdBundle,
}
if (!cmd || !(cmd in table)) die(`unknown command: ${cmd ?? '(none)'}\navailable: ${Object.keys(table).join(', ')}`)
process.exit(table[cmd](args))
