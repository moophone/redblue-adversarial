#!/usr/bin/env node
/**
 * 红蓝对抗 · 派工器
 *
 *   node rb-run.mjs <lc25|lc20> <任务包.md> <产物.md> [超时秒]
 *
 * 每个角色 = 一个独立的 headless DSH 进程，模型由 route-<name>.yml 钉死。
 * 改模型 = 改 route-*.yml；新增模型 = 复制一份改 provider/model。
 * 密钥从 <DSH_HOME>/.credentials.yaml 的 refs 里读，不进命令行、不落日志。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const [route, promptFile, outFile, timeoutArg] = process.argv.slice(2)
if (!route || !promptFile || !outFile) {
  console.error('usage: node rb-run.mjs <lc25|lc20> <任务包.md> <产物.md> [超时秒]')
  process.exit(2)
}
const here = dirname(fileURLToPath(import.meta.url))
const patch = join(here, `route-${route}.yml`)
if (!existsSync(patch)) { console.error(`路由不存在: ${patch}`); process.exit(2) }
if (!existsSync(promptFile)) { console.error(`任务包不存在: ${promptFile}`); process.exit(2) }

// 1) 取密钥：DSH 凭证文件的 refs + 本地 .keys.yaml，全部注入环境变量
const secrets = {}
const DSH_HOME = process.env.DSH_HOME || 'D:\\1a个人\\dsh-home'
const credPath = join(DSH_HOME, '.credentials.yaml')
if (existsSync(credPath)) {
  let inRefs = false
  for (const line of readFileSync(credPath, 'utf8').split(/\r?\n/)) {
    if (/^refs:\s*$/.test(line)) { inRefs = true; continue }
    if (inRefs) {
      const m = line.match(/^\s+([A-Za-z0-9_]+):\s*(\S+)\s*$/)
      if (m) secrets[m[1]] = m[2]
    }
  }
}
const keysPath = join(here, '.keys.yaml')
if (existsSync(keysPath)) {
  for (const line of readFileSync(keysPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+):\s*(\S+)\s*$/)
    if (m && !line.trimStart().startsWith('#')) secrets[m[1]] = m[2]
  }
}
if (Object.keys(secrets).length === 0) { console.error('没有找到任何可用密钥'); process.exit(2) }
const env = { ...process.env, ...secrets, AGENT2API_KEY: 'sk-local', DSH_DESKTOP_NODE_EXECUTABLE: 'D:\\dsh\\DeepSeek Harness.exe' }
const cli = 'D:\\dsh\\resources\\runtime\\cli\\bin\\dsh.cmd'
const task = readFileSync(promptFile, 'utf8')

// 2) 任务走 stdin（`-`），避免命令行长度与引号问题
const started = Date.now()
// Windows 下 .cmd 必须经 shell 执行（Node 24 起 spawnSync 直接调 .cmd 会 EINVAL）
const q = (s) => `"${s}"`
const cmdline = [q(cli), '--profile', 'headless', '--patch', q(patch), '-'].join(' ')
const r = spawnSync(cmdline, {
  input: task, encoding: 'utf8', env, timeout: Number(timeoutArg ?? 1800) * 1000,
  maxBuffer: 64 * 1024 * 1024, windowsHide: true, shell: true,
})
const elapsed = ((Date.now() - started) / 1000).toFixed(1)

if (r.stdout) writeFileSync(outFile, r.stdout, 'utf8')
console.log(`ROUTE=${route} EXIT=${r.status} ELAPSED=${elapsed}s OUT=${(r.stdout ?? '').length}B OUT_FILE=${outFile}`)
if (r.error) console.error('SPAWN_ERROR:', r.error.message)
if (r.status !== 0 && r.stderr) console.error('STDERR:', r.stderr.slice(0, 800))
process.exit(r.status ?? 1)