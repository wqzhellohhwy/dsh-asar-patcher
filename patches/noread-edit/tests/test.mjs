// 行为单测：补丁前/后的 dsh-fs-observation-policy 真实源码 + dsh-fs-local 的守卫源码（逐字执行）。
// 用法：node test.mjs   （在 test 目录下运行）
import { readFileSync } from 'node:fs'
import { FsError } from './stub-fs.mjs'
import * as orig from './policy-orig.mjs'
import * as patched from './policy-patched.mjs'

const guards = JSON.parse(readFileSync(new URL('./guards.json', import.meta.url), 'utf8'))

let pass = 0, fail = 0
const results = []
function check(name, cond, detail = '') {
  if (cond) { pass++; results.push(`  PASS  ${name}`) }
  else { fail++; results.push(`  FAIL  ${name} ${detail}`) }
}

/** 模拟 cordis 上下文：收集 fs/* 监听器，effect 立即执行。 */
function makeCtx() {
  const listeners = new Map()
  const disposers = []
  const ctx = {
    effect(cb) { const d = cb(); if (typeof d === 'function') disposers.push(d) },
    on(event, fn) { listeners.set(event, fn) },
  }
  return { ctx, emit: (event, ...args) => listeners.get(event)(...args), disposers }
}

function load(mod) {
  const { ctx, emit, disposers } = makeCtx()
  mod.apply(ctx)
  return { emit, disposers, name: mod.name }
}

const session = { id: 'sess-1' }
const actor = { agent: { session } }
const target = { targetKey: 'C:\\tmp\\a.txt', displayPath: 'C:\\tmp\\a.txt' }

async function caught(fn) {
  try { return { value: await fn() } } catch (error) { return { error } }
}

// ---------- 1. 修复后的策略：编辑不再需要先前读取 ----------
{
  const p = load(patched)
  check('patched: plugin name preserved', p.name === 'fs-observation-policy')

  const edit = await caught(() => p.emit('fs/edit-intent', target, actor))
  check('patched: unobserved edit-intent returns undefined (no throw)',
    edit.error === undefined && edit.value === undefined,
    JSON.stringify(edit))

  const write = await caught(() => p.emit('fs/write-intent', target, actor))
  check('patched: unobserved write-intent returns undefined (unconditional overwrite allowed)',
    write.error === undefined && write.value === undefined,
    JSON.stringify(write))

  // 观察为 present 后仍提供 CAS 版本
  p.emit('fs/observed', target, { kind: 'present', version: 'v1' }, actor)
  const edit2 = await p.emit('fs/edit-intent', target, actor)
  check('patched: observed present edit-intent yields CAS version',
    edit2 && edit2.version === 'v1', JSON.stringify(edit2))
  const write2 = await p.emit('fs/write-intent', target, actor)
  check('patched: observed present write-intent keeps replaceIfVersion',
    write2 && write2.kind === 'replaceIfVersion' && write2.version === 'v1', JSON.stringify(write2))

  // 观察为 absent 也不再拦
  p.emit('fs/observed', target, { kind: 'absent' }, actor)
  const edit3 = await caught(() => p.emit('fs/edit-intent', target, actor))
  check('patched: confirmed-absent edit-intent no longer throws FS_NOT_FOUND',
    edit3.error === undefined && edit3.value === undefined, JSON.stringify(edit3))
  const write3 = await caught(() => p.emit('fs/write-intent', target, actor))
  check('patched: confirmed-absent write-intent no longer forces createIfAbsent',
    write3.error === undefined && write3.value === undefined, JSON.stringify(write3))

  // 无 agent 会话的 actor 同样不拦（原来是必然抛错）
  const edit4 = await caught(() => p.emit('fs/edit-intent', target, undefined))
  check('patched: owner-less actor also passes', edit4.error === undefined, JSON.stringify(edit4))

  // 观察状态按会话隔离：另一个 session 未观察
  const edit5 = await caught(() => p.emit('fs/edit-intent', target, { agent: { session: { id: 'other' } } }))
  check('patched: observation stays per-session', edit5.error === undefined, JSON.stringify(edit5))

  // dispose 后状态清空且不抛
  p.disposers.forEach((d) => d())
  const edit6 = await caught(() => p.emit('fs/edit-intent', target, actor))
  check('patched: teardown keeps gate permissive', edit6.error === undefined, JSON.stringify(edit6))
}

// ---------- 2. 修复前的策略：复现被拦（对照组） ----------
{
  const p = load(orig)
  const edit = await caught(() => p.emit('fs/edit-intent', target, actor))
  check('orig: unobserved edit-intent throws FS_NOT_OBSERVED',
    !!(edit.error && edit.error.code === 'FS_NOT_OBSERVED'), JSON.stringify(edit.error?.code ?? edit.value))

  const write = await p.emit('fs/write-intent', target, actor)
  check('orig: unobserved write-intent resolves createIfAbsent',
    write && write.kind === 'createIfAbsent', JSON.stringify(write))

  p.emit('fs/observed', target, { kind: 'absent' }, actor)
  const edit2 = await caught(() => p.emit('fs/edit-intent', target, actor))
  check('orig: confirmed-absent edit-intent throws FS_NOT_FOUND',
    !!(edit2.error && edit2.error.code === 'FS_NOT_FOUND'), JSON.stringify(edit2.error?.code ?? edit2.value))
}

// ---------- 3. provider 守卫：逐字执行 dsh-fs-local 源码片段 ----------
{
  const writeGuard = new Function('expected', 'existing', 'target', 'FsError',
    guards.writeGuard + '\nreturn true')
  const editGuard = new Function('expected', 'existing', 'target', 'FsError',
    guards.editGuard + '\nreturn true')

  const existingFile = { type: 'file', version: 'v9' }
  const t = { displayPath: 'C:\\tmp\\a.txt' }

  // 未见 → undefined intent：两条守卫都必须放行（这就是"不读也能改"的 provider 依据）
  let r = await caught(() => writeGuard(undefined, existingFile, t, FsError))
  check('provider: writeText with undefined intent overwrites existing file', r.error === undefined && r.value === true, JSON.stringify(r.error?.code))

  r = await caught(() => editGuard(undefined, existingFile, t, FsError))
  check('provider: editText with undefined intent edits existing file', r.error === undefined && r.value === true, JSON.stringify(r.error?.code))

  // 对照：旧的 createIfAbsent 会拦住覆盖（证明旧路径确实被拦）
  r = await caught(() => writeGuard({ kind: 'createIfAbsent' }, existingFile, t, FsError))
  check('provider: createIfAbsent still blocks overwrite (old behaviour reproduced)',
    !!(r.error && r.error.code === 'FS_NOT_OBSERVED'), JSON.stringify(r.error?.code))

  // 观察过再改，陈旧版本仍被拦（保留的安全网）
  r = await caught(() => editGuard({ version: 'v0' }, existingFile, t, FsError))
  check('provider: stale observed version still rejected (FS_STALE_VERSION)',
    !!(r.error && r.error.code === 'FS_STALE_VERSION'), JSON.stringify(r.error?.code))

  r = await caught(() => writeGuard({ kind: 'replaceIfVersion', version: 'v0' }, existingFile, t, FsError))
  check('provider: stale observed version still rejected on write',
    !!(r.error && r.error.code === 'FS_STALE_VERSION'), JSON.stringify(r.error?.code))

  r = await caught(() => editGuard(undefined, null, t, FsError))
  check('provider: editing a missing file still fails (FS_STALE_VERSION)',
    !!(r.error && r.error.code === 'FS_STALE_VERSION'), JSON.stringify(r.error?.code))
}

console.log(results.join('\n'))
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
