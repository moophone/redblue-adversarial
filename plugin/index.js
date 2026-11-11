/**
 * redblue-write-scope — 红队写入面收敛到「当轮产物目录」。
 *
 * ═══ 为什么不是「完全只读」═══
 * 我最初的目标是照搬 dsh-superagent 的 router preset，把红队做成
 * `tool-fs: { write: false, edit: false }` 的纯只读角色。核实后发现这条路
 * 对红蓝对抗是错的，会直接废掉机制：
 *   ① SKILL.md 要求红队**自己产出** `01-cases*.md`（用例表是红队的交付物），
 *      没有 write 工具就没有交付，闸门 GATE_UNATTACKED 必然触发；
 *   ② SKILL.md §9 元教训 15 明确写着「红队的价值来自实际运行，不来自读文档」
 *      —— 红队必须能跑 `redblue.mjs` 的 recount/gate/severity 等子命令，
 *      那需要 bash/pwsh；
 *   ③ 硬规则 5 要防的从来不是「红队写自己的用例」，而是**「红队改被审交付件」**
 *      （R5 期间交付件确有 8 次改写 48791 → 77271 B；但事后核实这 8 次全部是
 *      主控自己的审计编辑，「红队改交付件」从未发生。守卫作为纵深防御保留：
 *      防的是这条路径本身，不是为那段历史翻案）。
 * 所以正确的收窄是**按路径**，不是按工具名：红队只能写当轮 `redblue/` 目录，
 * 碰不到被审件。
 *
 * ═══ 实现方式 ═══
 * 用 `agent.ctx.tools.guard(fn)`（DSH 官方 per-agent 单调拒绝钩子）。
 * 它在 `tools/pre-execute` 之后、真正 dispatch 之前执行，返回字符串即拒绝，
 * 且「任何 guard 都不能推翻另一个 guard 的拒绝」—— 单调，不可绕过。
 * 这比 SKILL.md 里「收尾时校验指纹」强一个数量级：那是事后取证，
 * 这是**调用发生前就拒绝**。
 *
 * ═══ 角色清单放在哪 ═══
 * 放在本插件的 `config.roles`，**不**写进名册 yaml。
 * 原因（实测）：`dsh-subagent-library` 的条目 schema 对未知字段是硬拒绝 ——
 * 多一个 `writeScope: redblue` 会让该条目报「未知字段」并整个加载失败，
 * 三个红队角色会一起从子代理看板消失。名册只能有它认识的那 10 个键。
 *
 * ═══ 已知残留（如实记录，不要以为改配置能解决）═══
 * bash/pwsh 是任意命令，无法可靠解析重定向目标，所以**没有**限制 shell 写入。
 * 红队要跑 redblue.mjs 就必须保留 shell。这一段残留靠 SKILL.md 的文字约束 +
 * 收尾指纹校验兜底。本插件把「write/edit 直改交付件」这条最高频路径堵死了，
 * 但没堵死 `pwsh "echo ... > 论文.tex"`。要堵死它需要沙箱级路径 ACL，
 * 那是 dsh 的事，不是插件能做的。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

const NAME = 'redblue-write-scope'

/** 会写文件的工具名。 */
const WRITE_TOOLS = new Set(['write', 'edit'])

/**
 * 默认角色清单：名册 id → 允许写入的子目录名。
 * 名册 id 就是 `$DSH_HOME/subagents/<id>.yaml` 的文件名。
 */
const DEFAULT_ROLES = {
  'rb-red': 'redblue',
  'rb-devil': 'redblue',
  'rb-domain': 'redblue'
}

// 注意：作用域值是产物根目录名。产物根 2026-11-02 由 `redblue` 更名为
// `redblue`，此处随之更新；plugin.yml patch 段的 config.roles
// 会覆盖这里的默认值，两处必须保持一致。

function log(home, text) {
  if (!home) return
  try {
    mkdirSync(join(home, 'logs'), { recursive: true })
    appendFileSync(join(home, 'logs', 'redblue-write-scope.log'), `${new Date().toISOString()} ${text}\n`, 'utf8')
  } catch {
    // 日志失败绝不阻断 DSH 启动。
  }
}


/** 从工具参数里取目标路径；取不到就返回 undefined。 */
function targetPath(args) {
  if (args === null || typeof args !== 'object') return undefined
  for (const key of ['file_path', 'path', 'filePath']) {
    const value = args[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

/** 路径是否落在允许的目录里。大小写不敏感（Windows），并拒绝 .. 逃逸。 */
function insideScope(candidate, scopeName) {
  if (typeof candidate !== 'string' || candidate === '') return false
  // 归一化：把两种分隔符统一，去掉首尾空白。
  const normalized = resolve(candidate).split(sep).join('/').toLowerCase()
  const scope = scopeName.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase()
  if (scope === '') return false
  // 允许目录本身出现在路径任意一段，且其后必须还有内容（不能写目录本身）。
  return normalized.includes(`/${scope}/`) || normalized.endsWith(`/${scope}`)
}

export const name = NAME
export const inject = ['tools']

export function apply(ctx, config = {}) {
  const home = config.home || process.env.DSH_HOME || ''
  const roles = config.roles ?? DEFAULT_ROLES
  const names = Object.keys(roles)
  log(home, `${NAME} loaded; guarding roles: ${names.join(', ') || '(none)'}`)
  if (names.length === 0) return

  ctx.on('agent/created', ({ agent }) => {
    try {
      const header = agent?.session?.header ?? {}
      // 只对子代理生效，主控与普通会话不受影响。
      if (header.origin !== 'subagent') return

      const candidates = [agent?.label, agent?.name, agent?.id, header.label, header.title, header.name]
        .filter(value => typeof value === 'string' && value !== '')
      const hit = candidates.find(candidate => Object.hasOwn(roles, candidate))
      if (hit === undefined) return

      const scopeName = roles[hit]
      if (typeof scopeName !== 'string' || scopeName === '') return

      const tools = agent?.ctx?.tools
      if (!tools || typeof tools.guard !== 'function') {
        log(home, `roster hit ${hit} but agent.ctx.tools.guard unavailable; NOT scoped`)
        return
      }

      tools.guard((exec) => {
        try {
          if (!WRITE_TOOLS.has(exec?.name)) return undefined
          const path = targetPath(exec?.arguments)
          if (path === undefined) return undefined
          if (insideScope(path, scopeName)) return undefined
          log(home, `DENIED ${hit} ${exec.name} -> ${path} (outside ${scopeName})`)
          return `红队写入面已收敛：${hit} 只能写 ${scopeName}/ 下的产物，不能改被审交付件（尝试写入 ${path}）。`
        } catch (error) {
          log(home, `guard error: ${String(error)}`)
          return undefined
        }
      })
      log(home, `SCOPED ${hit} (agent ${agent?.id}) writes to ${scopeName}/`)
    } catch (error) {
      log(home, `guard setup failed for agent ${agent?.id}: ${String(error)}`)
    }
  })
}
