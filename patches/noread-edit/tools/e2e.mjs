// 真实端到端：真实 cordis 应用 + 真实 dsh-fs-local + 真实（打补丁后）dsh-fs-observation-policy，
// 对真实文件执行「完全没有读过的 edit / write」。用 Electron 的 node 模式运行。
import { Context } from 'file:///C:/Users/53518/AppData/Local/Programs/DeepSeek%20Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'
import LocalFileSystem from 'file:///C:/Users/53518/AppData/Local/Programs/DeepSeek%20Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-fs-local/lib/index.js'
import * as policyPatched from 'file:///C:/Users/53518/AppData/Local/Programs/DeepSeek%20Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-fs-observation-policy/lib/index.js'
import * as policyOrig from '../tests/policy-orig-real.mjs'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0, fail = 0
const log = []
function check(name, cond, detail = '') {
  if (cond) { pass++; log.push(`  PASS  ${name}`) }
  else { fail++; log.push(`  FAIL  ${name} :: ${detail}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function makeApp(policyModule) {
  const app = new Context()
  app.plugin(LocalFileSystem)
  for (let i = 0; i < 50 && !app.fs; i++) await sleep(20)
  if (!app.fs) throw new Error('ctx.fs not registered')
  if (policyModule) {
    app.plugin(policyModule)
    await sleep(50)
  }
  return app
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-noread-e2e-'))
const file = join(dir, 'target.txt')
writeFileSync(file, 'alpha\nbeta\n', 'utf8')       // 由 node 自己创建，dsh 侧从未观察过它
const actor = { agent: { session: { id: 'e2e-session' } } }
const signal = new AbortController().signal

// ---------- A. 打补丁后的策略：不读就改 ----------
{
  const app = await makeApp(policyPatched)
  const target = await app.fs.resolve(file)
  log.push(`  target = ${target.displayPath} key=${String(target.targetKey).slice(-24)}`)

  const intent = await app.waterfall('fs/edit-intent', target, actor, () => undefined)
  check('e2e patched: edit-intent without any prior read resolves (no FS_NOT_OBSERVED)',
    intent === undefined, JSON.stringify(intent))

  const outcome = await app.fs.editText(target, { oldString: 'beta', newString: 'BETA', replaceAll: false }, intent, signal)
  const after = readFileSync(file, 'utf8')
  check('e2e patched: editText really rewrote the unread file', after === 'alpha\nBETA\n', JSON.stringify(after))
  check('e2e patched: edit outcome carries before/after + version',
    !!outcome && outcome.before === 'alpha\nbeta\n' && outcome.after === 'alpha\nBETA\n' && typeof outcome.version !== 'undefined',
    JSON.stringify(outcome && { v: String(outcome.version), before: outcome.before, after: outcome.after }))

  // 全文件 write 覆盖一个同样未读的文件
  const intent2 = await app.waterfall('fs/write-intent', target, actor, () => undefined)
  check('e2e patched: write-intent without prior read resolves (no createIfAbsent)',
    intent2 === undefined, JSON.stringify(intent2))
  const wout = await app.fs.writeText(target, 'overwritten without reading\n', intent2, signal)
  const after2 = readFileSync(file, 'utf8')
  check('e2e patched: writeText overwrote the unread file', after2 === 'overwritten without reading\n', JSON.stringify(after2))
  check('e2e patched: write outcome operation=update', wout && wout.operation === 'update', JSON.stringify(wout && wout.operation))

  // 观察过之后，陈旧版本仍然被拦（保护网还在）
  app.emit('fs/observed', target, { kind: 'present', version: 'stale-version' }, actor)
  const intent3 = await app.waterfall('fs/edit-intent', target, actor, () => undefined)
  let stale = null
  try { await app.fs.editText(target, { oldString: 'overwritten', newString: 'X', replaceAll: false }, intent3, signal) }
  catch (error) { stale = error.code }
  check('e2e patched: stale observed version still rejected', stale === 'FS_STALE_VERSION', String(stale))
}

// ---------- B. 备份中的原版策略：复现「必须先读」 ----------
{
  writeFileSync(file, 'alpha\nbeta\n', 'utf8')
  const app = await makeApp(policyOrig)
  const target = await app.fs.resolve(file)
  let code = null
  try {
    await app.waterfall('fs/edit-intent', target, actor, () => undefined)
  } catch (error) { code = error.code }
  check('e2e orig: edit-intent without a prior read throws FS_NOT_OBSERVED', code === 'FS_NOT_OBSERVED', String(code))

  const wintent = await app.waterfall('fs/write-intent', target, actor, () => undefined)
  check('e2e orig: write-intent without a prior read resolves createIfAbsent',
    !!wintent && wintent.kind === 'createIfAbsent', JSON.stringify(wintent))
  let wcode = null
  try { await app.fs.writeText(target, 'blocked\n', wintent, signal) } catch (error) { wcode = error.code }
  check('e2e orig: that createIfAbsent really blocks overwriting', wcode === 'FS_NOT_OBSERVED', String(wcode))
}

rmSync(dir, { recursive: true, force: true })
console.log(log.join('\n'))
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
