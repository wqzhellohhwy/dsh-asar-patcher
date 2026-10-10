/**
 * 清单验收：按 DSH 装配插件时真正会用到的字段，逐条核对本包。
 *
 * 为什么要这个脚本：包一旦缺少 `dsh.bundle.patch`，profile 的 `dsh.profile.bundles`
 * 仍会把它列进去，但它只是「幽灵 entry」—— 插件列表里出现却没有元数据（标题/描述），
 * 设置页会把卡片标成异常。静态把这几条卡住，比"重启 DSH 再看一眼"便宜得多。
 *
 * 用法：node scripts/check-manifest.mjs [--root <插件目录>]
 *      （--root 可对任意 DSH 插件目录跑同一套判定；缺省为脚本的上级目录）
 * 退出码非 0 表示验收失败。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootAt = process.argv.indexOf('--root')
const ROOT = rootAt === -1
  ? resolve(dirname(fileURLToPath(import.meta.url)), '..')
  : resolve(process.argv[rootAt + 1])
const failures = []
const notes = []

/** 断言小工具：记录失败原因而不是抛异常，便于一次报全。 */
function check(ok, label, detail = '') {
  if (ok) notes.push(`✔ ${label}`)
  else failures.push(`✖ ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

const manifestPath = join(ROOT, 'package.json')
check(existsSync(manifestPath), 'package.json 存在')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

// ── 基础身份：DSH 与 npm 都要求 ─────────────────────────────────────────────
check(typeof manifest.name === 'string' && manifest.name !== '', 'name 非空')
check(typeof manifest.version === 'string' && manifest.version !== '', 'version 非空')
check(typeof manifest.description === 'string' && manifest.description.trim() !== '', 'description 非空（插件卡片的描述就来自它）')

// ── 入口存在性 ──────────────────────────────────────────────────────────────
const main = manifest.main ?? './lib/index.js'
check(existsSync(join(ROOT, main)), `main 指向的文件存在（${main}）`)
for (const [key, target] of Object.entries(manifest.exports ?? {})) {
  if (key === './package.json' || typeof target !== 'string') continue
  if (target.includes('*')) continue // 通配子路径导出（如 ./locale/*.json）不做存在性检查
  check(existsSync(join(ROOT, target)), `exports["${key}"] 指向的文件存在（${target}）`)
}
for (const [name, target] of Object.entries(manifest.bin ?? {})) {
  check(existsSync(join(ROOT, target)), `bin["${name}"] 指向的文件存在（${target}）`)
}

// ── DSH 装配字段：这一组是"幽灵 entry"的分水岭 ──────────────────────────────
check(manifest.dsh !== undefined && typeof manifest.dsh === 'object', 'dsh 字段存在（缺失即幽灵 entry）')
if (manifest.dsh?.manifestVersion !== undefined) {
  check(manifest.dsh.manifestVersion === 1, 'dsh.manifestVersion 为已声明的格式 1')
}
const patch = manifest.dsh?.bundle?.patch
check(typeof patch === 'string' && patch !== '', 'dsh.bundle.patch 已声明')
if (typeof patch === 'string') {
  const patchPath = join(ROOT, patch)
  check(existsSync(patchPath), `dsh.bundle.patch 指向的文件存在（${patch}）`)
  if (existsSync(patchPath)) {
    const text = readFileSync(patchPath, 'utf8')
    // 极简解析（不引依赖）：取出 insert 列表里的 name 行
    const names = [...text.matchAll(/^\s*name:\s*['"]?([^'"\n]+)['"]?\s*$/gm)].map((m) => m[1].trim())
    check(names.length > 0, 'patch 里能解析出至少一个 name 行')
    check(
      names.includes(manifest.name),
      `patch 里的 name 与包名一致（${manifest.name}）`,
      `解析到：${names.join(', ') || '（空）'}`,
    )
    const ids = [...text.matchAll(/^\s*-\s*id:\s*['"]?([^'"\n]+)['"]?\s*$/gm)].map((m) => m[1].trim())
    check(ids.length > 0, 'patch 里能解析出 insert 的 id')
  }
}

// ── files 白名单：发布内容里的路径都应存在 ──────────────────────────────────
for (const entry of manifest.files ?? []) {
  if (entry.includes('*')) continue
  check(existsSync(join(ROOT, entry)), `files 里的路径存在（${entry}）`)
}

// ── 报告 ────────────────────────────────────────────────────────────────────
console.log(notes.join('\n'))
if (failures.length > 0) {
  console.error(`\n${failures.join('\n')}`)
  console.error(`\n验收失败：${failures.length} 项`)
  process.exit(1)
}
console.log(`\n验收通过：${notes.length} 项检查全部满足（含 DSH 装配所需的 dsh.bundle.patch）。`)
