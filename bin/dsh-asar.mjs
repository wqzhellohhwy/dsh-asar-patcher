#!/usr/bin/env node
/**
 * dsh-asar-patcher 的命令行入口（不装插件也能用；插件工具是同一套核心库的薄封装）。
 *
 * 用法：
 *   node bin/dsh-asar.mjs info   [--asar <path>]
 *   node bin/dsh-asar.mjs list   [片段] [--asar <path>] [--limit N]
 *   node bin/dsh-asar.mjs find   <片段> <字符串> [--asar <path>] [--max N]
 *   node bin/dsh-asar.mjs read   <片段> [--out <文件>] [--offset N] [--length N]
 *   node bin/dsh-asar.mjs plan   <片段> --old <文件> --new <文件>
 *   node bin/dsh-asar.mjs splice <片段> --old <文件> --new <文件> [--write] [--tag X]
 *   node bin/dsh-asar.mjs backup [tag]
 *   node bin/dsh-asar.mjs restore <tag>
 *   node bin/dsh-asar.mjs verify
 *
 * 环境变量：DSH_ASAR 指定归档路径（等价于 --asar）。
 */
import { writeFileSync } from 'node:fs'
import {
  applySplice,
  backupArchive,
  closeArchive,
  detectAsar,
  findEntries,
  listBackups,
  listEntries,
  openArchive,
  planSplice,
  readBytes,
  readEntry,
  restoreArchive,
  sha256,
  verifyArchive,
} from '../lib/asar.js'

const argv = process.argv.slice(2)
const command = argv[0]

/** 取 `--flag value` 形式的参数。 */
function flag(name) {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? undefined : argv[at + 1]
}
/** 取位置参数（跳过命令名与所有 --flag 及其值）。 */
function positional() {
  const out = []
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) { i += 1; continue }
    out.push(argv[i])
  }
  return out
}

const asar = detectAsar(flag('asar'))
if (asar === undefined && command !== 'help') {
  console.error('找不到 app.asar：请用 --asar <path> 或设置 DSH_ASAR。')
  process.exit(2)
}
const pos = positional()
const say = (value) => console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 1))

if (command === 'info' || command === 'verify') {
  const info = verifyArchive(asar)
  say(info)
  say({ backups: listBackups(asar).map((b) => ({ tag: b.tag, size: b.size })) })
} else if (command === 'list') {
  const { fd, header } = openArchive(asar)
  try {
    const hits = findEntries(listEntries(header), pos[0])
    const limit = Number(flag('limit') ?? 200)
    say(`命中 ${hits.length} 个条目`)
    for (const entry of hits.slice(0, limit)) say(`${entry.size}\t${entry.offset}\t${entry.path}`)
  } finally { closeArchive(fd) }
} else if (command === 'find') {
  const [frag, needle] = pos
  if (!needle) { console.error('用法：find <片段> <字符串>'); process.exit(2) }
  const { fd, header, dataOffset } = openArchive(asar)
  try {
    const needleBuf = Buffer.from(needle, 'utf8')
    let hits = 0
    for (const entry of findEntries(listEntries(header), frag)) {
      if (entry.unpacked) continue
      const buffer = readEntry(fd, dataOffset, entry)
      let from = 0
      while (true) {
        const at = buffer.indexOf(needleBuf, from)
        if (at === -1) break
        hits += 1
        say(`${entry.path}  文件内 ${at}  绝对 ${dataOffset + entry.offset + at}`)
        say(`   …${buffer.subarray(Math.max(0, at - 60), at + needleBuf.length + 40).toString('utf8')}…`)
        from = at + 1
      }
    }
    if (hits === 0) say('未命中')
  } finally { closeArchive(fd) }
} else if (command === 'read') {
  const frag = pos[0]
  const { fd, header, dataOffset } = openArchive(asar)
  try {
    const hits = findEntries(listEntries(header), frag)
    if (hits.length !== 1) { console.error(`路径片段命中 ${hits.length} 个条目（需恰好 1 个）`); process.exit(1) }
    const buffer = readEntry(fd, dataOffset, hits[0])
    const out = flag('out')
    if (out !== undefined) {
      writeFileSync(out, buffer)
      say(`已导出 ${hits[0].path}（${buffer.length} 字节）→ ${out}`)
    } else {
      const offset = Number(flag('offset') ?? 0)
      const length = Number(flag('length') ?? 2000)
      say(buffer.subarray(offset, offset + length).toString('utf8'))
    }
  } finally { closeArchive(fd) }
} else if (command === 'plan' || command === 'splice') {
  const frag = pos[0]
  const oldFile = flag('old')
  const newFile = flag('new')
  if (!frag || !oldFile || !newFile) { console.error('用法：splice <片段> --old <文件> --new <文件> [--write] [--tag X]'); process.exit(2) }
  if (command === 'plan') {
    say(planSplice({ asar, fragment: frag, oldContent: readBytes(oldFile), newContent: readBytes(newFile) }))
  } else {
    const result = applySplice({
      asar,
      fragment: frag,
      oldContent: readBytes(oldFile),
      newContent: readBytes(newFile),
      backupTag: flag('tag'),
    })
    say(result)
    if (result.status === 'refused') process.exit(1)
  }
} else if (command === 'backup') {
  const tag = pos[0] ?? `manual-${Date.now()}`
  say(backupArchive(asar, tag))
} else if (command === 'restore') {
  const tag = pos[0]
  if (!tag) { console.error('用法：restore <tag>'); process.exit(2) }
  say(restoreArchive(asar, tag))
} else {
  say(`dsh-asar-patcher CLI
  info | verify                 归档自检 + 备份列表
  list [片段] [--limit N]       列条目
  find <片段> <字符串>           搜索字符串（返回文件内/绝对偏移）
  read <片段> [--out 文件|--offset N --length N]
  plan <片段> --old <文件> --new <文件>     干运行
  splice <片段> --old <文件> --new <文件> [--write] [--tag X]
  backup [tag] | restore <tag>
  通用参数：--asar <path>（或环境变量 DSH_ASAR）`)
  process.exit(command === undefined ? 2 : 0)
}
void sha256
