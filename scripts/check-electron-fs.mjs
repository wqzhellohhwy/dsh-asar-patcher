/**
 * check-electron-fs.mjs — 验证「在 Electron 的 asar 补丁下」插件仍能正常工作。
 *
 * 背景：DSH 桌面版把 Host 跑在 Electron 主进程里，那里的 `node:fs` 会把
 * `…\resources\app.asar` 当成「归档内的空路径」，于是 `openSync`/`readFileSync`
 * 抛 `ENOENT,  not found in …app.asar`、`statSync` 返回 size=0 的假目录。
 * 插件必须走 `original-fs` 才能读写归档本体（见 lib/asar.js 顶部注释）。
 *
 * 用法（两种环境都跑一遍即可看出差别）：
 *   node scripts/check-electron-fs.mjs
 *   ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" scripts/check-electron-fs.mjs
 *
 * 断言：
 *   1) 本进程的 `node:fs` 是否被补丁污染（仅报告，Electron 下应为「是」）；
 *   2) 插件库自己的 fs 层必须能打开归档本体并读出完整字节；
 *   3) `asar_info` 工具必须返回 ok=true 且条目数与真实归档一致。
 */
import * as nodeFs from 'node:fs'
import { openArchive, closeArchive, verifyArchive, fs, detectAsar } from '../lib/asar.js'
import { buildTools } from '../lib/tools.js'

const label = process.versions.electron ? `Electron ${process.versions.electron} (fs 已打 asar 补丁)` : `纯 Node ${process.versions.node}`
console.log(`环境：${label}`)

const asar = detectAsar(process.env.DSH_ASAR)
if (asar === undefined) {
  console.error('找不到 app.asar：请设置 DSH_ASAR。')
  process.exit(2)
}
console.log(`归档：${asar}`)

// 1) 探测 node:fs 是否被污染（只报告）
let patched = '否'
try {
  const probeFd = nodeFs.openSync(asar, 'r')
  nodeFs.closeSync(probeFd)
} catch (error) {
  patched = `是 (${error.code}, ${error.message})`
}
console.log(`node:fs.openSync(归档) 被 asar 补丁拦截：${patched}`)

// 2) 插件 fs 层必须可用
const fd = openArchive(asar).fd
closeArchive(fd)
const bytes = fs.readFileSync(asar).length
const info = verifyArchive(asar)
console.log(`插件 fs 层：读回 ${bytes} 字节，${info.entries} 个条目，dataOffset=${info.dataOffset}，truncated=${info.truncated}`)

// 3) 工具面必须成功
const tool = buildTools({}).find((t) => t.name === 'asar_info')
const result = await tool.execute({})
console.log(`asar_info -> ok=${result.ok} | ${result.message}`)

const ok = result.ok === true && bytes > 0 && info.truncated === false && result.info.entries === info.entries
console.log(ok ? 'PASS' : 'FAIL')
process.exit(ok ? 0 : 1)
