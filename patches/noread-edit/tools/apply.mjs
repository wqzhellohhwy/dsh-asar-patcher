/**
 * 一键重打「编辑前必须先读」补丁（DSH 升级覆盖 app.asar 之后用）。
 *
 *   node tools/apply.mjs            # 干运行：只 plan，打印定位与问题列表
 *   node tools/apply.mjs --write    # 落盘：自动备份 + 写后逐字节复核
 *
 * 依赖已安装的 dsh-asar-patcher（本机：C:\Users\53518\dsh-plugins\dsh-asar-patcher）。
 * 用环境变量 ASAR_PATCHER 可覆盖其路径。
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const PATCH = join(ROOT, 'patch')
const PATCHER = process.env.ASAR_PATCHER ?? 'C:/Users/53518/dsh-plugins/dsh-asar-patcher'
const LIB = pathToFileURL(join(PATCHER, 'lib/asar.js')).href

if (!existsSync(join(PATCHER, 'lib/asar.js'))) {
  console.error(`找不到 dsh-asar-patcher：${PATCHER}（用 ASAR_PATCHER 指定）`)
  process.exit(2)
}
const { detectAsar, planSplice, applySplice } = await import(LIB)

const write = process.argv.includes('--write')
const asar = detectAsar(process.env.DSH_ASAR)
if (!asar) { console.error('未找到 app.asar（用 DSH_ASAR 指定）'); process.exit(2) }
console.log('archive:', asar, write ? '(WRITE)' : '(dry-run)')

const PATCHES = [
  ['dsh-fs-observation-policy/lib/index.js', 'policy.writeIntent'],
  ['dsh-fs-observation-policy/lib/index.js', 'policy.editIntent'],
  ['dsh-tool-fs/lib/index.js', 'toolfs.writeGuidance'],
  ['dsh-tool-fs/lib/index.js', 'toolfs.editGuidance'],
]

let failed = 0
for (const [fragment, name] of PATCHES) {
  const oldContent = readFileSync(join(PATCH, `${name}.old`))
  const newContent = readFileSync(join(PATCH, `${name}.new`))
  const plan = planSplice({ asar, fragment, oldContent, newContent })
  const state = plan.problems.length === 0 ? 'ok' : `PROBLEMS: ${JSON.stringify(plan.problems)}`
  console.log(`\n== ${name} @ ${plan.entry ?? '?'} spliceAt=${plan.spliceAt ?? '?'} ${state}`)
  if (plan.problems.length > 0) { failed++; continue }
  if (!write) continue
  const result = applySplice({ asar, fragment, oldContent, newContent, backupTag: 'noread-edit' })
  console.log('   ->', result.status, 'sha256After=', result.sha256After ?? '')
}
console.log(failed === 0 ? '\n补丁片段全部可用' : `\n${failed} 个片段不可用（产物已变？改用 tools/make_patch.py 重新生成）`)
process.exit(failed === 0 ? 0 : 1)
