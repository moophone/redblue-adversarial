// v6.29d：写「红队名册」与「用例→角色」侧车文件（不修改任何文档表格）。
// 为什么侧车而不是往表里加列：实测往多表文档加列会因「只认第一个表头」而错位，
// 且会污染已有文档。侧车文件对文档零侵入，机器可读，删了也不影响原稿。
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'D:\\1a个人\\科研\\大创\\论文\\课题方向\\待生成论文的课题\\30_课题_希腊网兴衰\\redblue';

// 每轮独立名册。provider/model 取自当时 redblue_delegate 的实际调用参数（实跑记录，非估计）。
const rosters = {
  'R1-1107g1': [
    { role: 'tech', provider: 'agent2api-raccoon', model: 'sn-kimi-k3', kind: 'red', task: '技术审查员' },
    { role: 'devil', provider: 'agent2api-raccoon', model: 'sn-sensenova-6-8-flash', kind: 'red', task: '魔鬼代言人' },
    { role: 'domain', provider: 'agent2api-loomy', model: 'qwen3.8-flash', kind: 'red', task: '领域审稿人' },
    { role: 'blue', provider: 'agent2api-loomy', model: 'qwen3.8-flash', kind: 'blue', task: '蓝队A答辩' },
    { role: 'blue-b', provider: 'agent2api-raccoon', model: 'sn-kimi-k3', kind: 'blue', task: '蓝队B答辩' },
    { role: 'rejected-route', provider: 'agent2api-workbuddy', model: 'deepseek-v4-pro', kind: 'red', task: '被路由预校验拦下（profile 未配），未起子代理' },
  ],
  'R2-1108h1': [
    { role: 'fixer', provider: 'agent2api-raccoon', model: 'sn-kimi-k3', kind: 'blue', task: '修订执行手（只出精确替换块）' },
    { role: 'red-r2', provider: 'agent2api-loomy', model: 'qwen3.8-flash', kind: 'red', task: '复核红队（只攻 7 条严重）' },
  ],
  'R3-1108i1': [
    { role: 'red-r3', provider: 'agent2api-raccoon', model: 'sn-sensenova-6-8-flash', kind: 'red', task: '复核红队（验 v2 + 专查主控手改）' },
  ],
};

// 用例 → 提出它的角色。依据是各红队产物文件里的编号（tech 的 F1–F9、devil 的 DEV-01..05、
// domain 的 C-1..C6），以及 N1–N3 出自 R2 复核红队、N4 出自 R3 复核红队。
const roleMap = {
  C01: 'devil', C02: 'devil', C03: 'devil', C04: 'devil', C05: 'devil', C06: 'devil',
  C07: 'tech', C08: 'tech', C09: 'tech', C10: 'tech', C11: 'tech',
  C12: 'domain', C13: 'domain', C14: 'domain', C15: 'domain', C16: 'domain', C17: 'domain',
  N1: 'red-r2', N2: 'red-r2', N3: 'red-r2', N4: 'red-r3',
};

for (const [round, roles] of Object.entries(rosters)) {
  const dir = join(BASE, round)
  writeFileSync(join(dir, 'redteam-roster.json'), JSON.stringify({ round, roles }, null, 2), 'utf8')
  writeFileSync(join(dir, 'role-map.json'), JSON.stringify(roleMap, null, 2), 'utf8')
  console.log(`WROTE ${round}: roster=${roles.length} roles, role-map=${Object.keys(roleMap).length} ids`)
}
