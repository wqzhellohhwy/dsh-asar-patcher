/**
 * dsh-asar-patcher — DeepSeek Harness `app.asar` 的读写原语（零依赖）。
 *
 * ## 为什么需要它
 *
 * DSH 桌面版把整个 Host 实现打包在 `resources/app.asar` 里，其中
 * `dsh/node_modules/@deepseek-ai/**` 是可直接阅读的 JS 源码（rolldown/tsdown
 * 产物，保留了注释）。要修 DSH 自身的行为，只能改这个归档。
 *
 * ## 为什么是「等长原地替换」
 *
 * asar 的布局是：`[头][JSON 索引][数据区]`，数据区里每个文件按 `offset` 连续
 * 排布。任何**改变文件长度**的修改，都会推动其后所有文件的 offset，并让 JSON
 * 索引（以及数据区起点）一起变化 —— 那等于要重新实现一遍打包器。
 *
 * 反过来，只要新旧内容**字节数完全相同**，就可以直接 write 到数据区的对应
 * 位置：文件内偏移、归档头（size/offset/integrity）、数据区起点全部不动。
 * 这条路径已被本机多次改包验证（见 docs/ASAR-PATCHING.md）。
 *
 * 因此本库的 splice 只接受等长替换，并强制：
 *   1) 旧内容必须在目标条目里**出现且唯一**（防止打错位置）；
 *   2) 写入前自动备份归档；
 *   3) 写入后**读回逐字节复核**（预期 = 原内容 + 替换片段）。
 *
 * @module dsh-asar-patcher/asar
 */
import * as nodeFs from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

/**
 * 归档本体专用 fs 层：优先 `original-fs`（Electron 的未打补丁 fs），纯 Node 下回退 `node:fs`。
 *
 * ## 为什么不能用 `node:fs`
 *
 * Electron 主进程给 `node:fs` 打了 **asar 补丁**：路径里一旦出现以 `.asar` 结尾的段，
 * 该段之后的部分就被当作「归档内路径」。而 `…\resources\app.asar` 正好以 `.asar`
 * 收尾、其后是空串，补丁于是去归档里查一个空路径：
 *
 *   - `openSync` / `readFileSync` → 抛 `ENOENT,  not found in …\app.asar`
 *     （注意 `ENOENT,` 后面是**两个空格** —— 文件名是空串，不是文件名被吞了）；
 *   - `existsSync` / `accessSync` 同理不可靠；
 *   - `statSync` 更隐蔽：不报错，但把归档伪造成 `size=0` 的**目录**。
 *
 * 而 DSH 的 Host 就跑在 Electron 主进程里（进程命令行可见
 * `--expose-internals …\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\index.js`），
 * 所以插件面工具**必然**踩到这个坑；`bin/dsh-asar.mjs` 跑在纯 Node 下不受影响 ——
 * 这正是「CLI 一切正常、`asar_*` 工具全部报 ENOENT」的全部原因（2026-10-11 定位）。
 *
 * `original-fs` 是 Electron 提供的原始 fs，专供读写归档本体；普通文件（备份、导出目标、
 * old/new 文件、resources 目录）用它也完全正常。
 *
 * @type {typeof nodeFs}
 */
export const fs = (() => {
  if (process.versions.electron) {
    try { return createRequire(import.meta.url)('original-fs') } catch { /* 极端情况回退到打过补丁的 fs */ }
  }
  return nodeFs
})()

// 绑到本模块用到的几个函数上，函数体内照旧裸调用（避免处处写 fs.）。
const {
  closeSync,
  copyFileSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeSync,
} = fs

/** 归档所在的应用名（Win/mac/Linux 安装目录名一致）。 */
export const APP_NAME = 'DeepSeek Harness'

/** 归档头固定前缀长度：u32(4) + u32(headerPickleSize) + u32(jsonSize+4) + u32(jsonSize)。 */
const HEADER_PREFIX = 16

/**
 * 各平台常见的 asar 位置（顺序即优先级）。
 * @returns {string[]} 候选绝对路径。
 */
export function asarCandidates() {
  const list = []
  const app = APP_NAME
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA
    const pf = process.env.ProgramFiles
    const pf86 = process.env['ProgramFiles(x86)']
    if (local) list.push(join(local, 'Programs', app, 'resources', 'app.asar'))
    if (pf) list.push(join(pf, app, 'resources', 'app.asar'))
    if (pf86) list.push(join(pf86, app, 'resources', 'app.asar'))
  } else if (process.platform === 'darwin') {
    list.push(`/Applications/${app}.app/Contents/Resources/app.asar`)
    list.push(join(homedir(), 'Applications', `${app}.app`, 'Contents', 'Resources', 'app.asar'))
  } else {
    list.push(`/opt/${app}/resources/app.asar`)
    list.push(join(homedir(), '.local', 'share', app, 'resources', 'app.asar'))
    list.push(`/usr/lib/${app}/resources/app.asar`)
  }
  return list
}

/**
 * 定位 asar：显式路径优先（存在才采用），否则按平台候选探测。
 * @param {string} [explicit] - 调用方给出的路径（工具参数 / DSH_ASAR 环境变量）。
 * @returns {string | undefined} 绝对路径；找不到返回 undefined（由调用方决定怎么报错）。
 */
export function detectAsar(explicit) {
  const wanted = explicit ?? process.env.DSH_ASAR
  if (wanted !== undefined && wanted !== '') return existsSync(wanted) ? wanted : undefined
  return asarCandidates().find((candidate) => existsSync(candidate))
}

/**
 * 打开归档并解析头部索引。
 * @param {string} file - asar 绝对路径。
 * @param {boolean} [writable] - true 时以 'r+' 打开（写补丁必须）。
 * @returns {{fd: number, header: object, dataOffset: number}} 句柄、索引与数据区起点。
 */
export function openArchive(file, writable = false) {
  const fd = openSync(file, writable ? 'r+' : 'r')
  const head = Buffer.alloc(HEADER_PREFIX)
  readSync(fd, head, 0, HEADER_PREFIX, 0)
  // off 0 = 4（size 字段自身长度）、off 4 = header pickle 总长、
  // off 8 = JSON 长度 + 对齐、off 12 = JSON 精确长度。
  const pickleSize = head.readUInt32LE(4)
  const jsonSize = head.readUInt32LE(12)
  const raw = Buffer.alloc(jsonSize)
  readSync(fd, raw, 0, jsonSize, HEADER_PREFIX)
  return { fd, header: JSON.parse(raw.toString('utf8')), dataOffset: 8 + pickleSize }
}

/** 关闭归档句柄（忽略重复关闭）。 */
export function closeArchive(fd) {
  try { closeSync(fd) } catch { /* 已关闭 */ }
}

/**
 * 把索引树展开成条目列表。
 * @param {object} header - {@link openArchive} 返回的 header。
 * @returns {Array<{path: string, size: number, offset: number, unpacked: boolean}>} 条目（path 用归档自身的反斜杠形式）。
 */
export function listEntries(header) {
  const out = []
  const walk = (node, prefix) => {
    for (const [name, value] of Object.entries(node)) {
      if (value && typeof value === 'object' && value.files) walk(value.files, `${prefix}\\${name}`)
      else out.push({ path: `${prefix}\\${name}`, size: Number(value.size ?? 0), offset: Number(value.offset ?? 0), unpacked: value.unpacked === true })
    }
  }
  walk(header.files ?? header, '')
  return out
}

/**
 * 按路径片段筛选条目（`/` 与 `\` 等价）。片段为空则返回全部。
 * @param {ReturnType<typeof listEntries>} entries - 条目列表。
 * @param {string} [fragment] - 路径片段。
 * @returns {ReturnType<typeof listEntries>} 命中的条目。
 */
export function findEntries(entries, fragment) {
  if (fragment === undefined || fragment === '') return entries
  const needle = fragment.replace(/\//g, '\\')
  return entries.filter((entry) => entry.path.endsWith(needle) || entry.path.includes(needle))
}

/**
 * 读条目全部字节。
 * @param {number} fd - 归档句柄。
 * @param {number} dataOffset - 数据区起点。
 * @param {{size: number, offset: number}} entry - 目标条目。
 * @returns {Buffer} 条目内容。
 */
export function readEntry(fd, dataOffset, entry) {
  const buffer = Buffer.alloc(entry.size)
  readSync(fd, buffer, 0, entry.size, dataOffset + entry.offset)
  return buffer
}

/** 计算 Buffer 的 sha256（十六进制）。 */
export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** 列出某个归档已有备份（`<asar>.<tag>` 形态）。 */
export function listBackups(asar) {
  const dir = dirname(asar)
  const base = `${basename(asar)}.`
  return readdirSync(dir)
    .filter((name) => name.startsWith(base) && name !== basename(asar))
    .map((name) => {
      const full = join(dir, name)
      let size = 0
      try { size = statSync(full).size } catch { /* 忽略 */ }
      return { path: full, tag: name.slice(base.length), size }
    })
}

/**
 * 备份归档（已存在同名备份时不覆盖）。
 * @param {string} asar - 归档路径。
 * @param {string} tag - 备份后缀。
 * @returns {{path: string, created: boolean, size: number}} 备份结果。
 */
export function backupArchive(asar, tag) {
  const path = `${asar}.${tag}`
  if (existsSync(path)) return { path, tag, created: false, size: statSync(path).size }
  copyFileSync(asar, path)
  return { path, tag, created: true, size: statSync(path).size }
}

/**
 * 从备份还原归档（覆盖前会把「当前内容」另存为 `<archive>.pre-restore-<时间戳>`）。
 * @param {string} asar - 归档路径。
 * @param {string} tag - 备份后缀。
 * @returns {{restoredFrom: string, savedCurrent: string}} 还原结果。
 */
export function restoreArchive(asar, tag) {
  const path = `${asar}.${tag}`
  if (!existsSync(path)) throw new Error(`备份不存在：${path}`)
  const savedCurrent = `${asar}.pre-restore-${Date.now()}`
  copyFileSync(asar, savedCurrent)
  copyFileSync(path, asar)
  return { restoredFrom: path, savedCurrent }
}

/**
 * 归档结构自检：头部可解析、条目数与体积、数据区起点是否落在合理范围。
 * @param {string} asar - 归档路径。
 * @returns {{path: string, bytes: number, entries: number, unpacked: number, dataOffset: number, declaredBytes: number, truncated: boolean}} 自检结果。
 */
export function verifyArchive(asar) {
  const bytes = statSync(asar).size
  const { fd, header, dataOffset } = openArchive(asar)
  try {
    const entries = listEntries(header)
    const end = entries.reduce((max, entry) => Math.max(max, entry.unpacked ? 0 : entry.offset + entry.size), 0)
    return {
      path: asar,
      bytes,
      entries: entries.length,
      unpacked: entries.filter((entry) => entry.unpacked).length,
      dataOffset,
      declaredBytes: dataOffset + end,
      truncated: dataOffset + end > bytes,
    }
  } finally {
    closeArchive(fd)
  }
}

/**
 * 规划一次等长替换（只读：不写任何字节）。
 *
 * @param {object} options - 计划参数。
 * @param {string} options.asar - 归档路径。
 * @param {string} options.fragment - 目标条目路径片段（必须唯一命中）。
 * @param {Buffer|string} options.oldContent - 期望的旧内容（Buffer 或 utf8 字符串）。
 * @param {Buffer|string} options.newContent - 新内容（字节数必须与旧内容一致）。
 * @returns {object} 计划：命中条目、替换偏移、长度、问题列表；`problems` 非空即不可写。
 */
export function planSplice({ asar, fragment, oldContent, newContent }) {
  const oldBytes = Buffer.isBuffer(oldContent) ? oldContent : Buffer.from(String(oldContent), 'utf8')
  const newBytes = Buffer.isBuffer(newContent) ? newContent : Buffer.from(String(newContent), 'utf8')
  const { fd, header, dataOffset } = openArchive(asar)
  try {
    const entries = listEntries(header)
    const hits = findEntries(entries, fragment)
    const problems = []
    if (hits.length !== 1) {
      problems.push(`路径片段 ${JSON.stringify(fragment)} 命中 ${hits.length} 个条目（需恰好 1 个）`)
      return { archive: asar, problems, hits: hits.slice(0, 10).map((entry) => entry.path) }
    }
    const entry = hits[0]
    if (entry.unpacked) problems.push('该条目 unpacked（内容在 app.asar.unpacked 下），不走原地替换')
    const current = readEntry(fd, dataOffset, entry)
    const first = current.indexOf(oldBytes)
    const last = current.lastIndexOf(oldBytes)
    const firstNew = current.indexOf(newBytes)
    const lastNew = current.lastIndexOf(newBytes)
    if (oldBytes.length !== newBytes.length) problems.push(`新旧内容字节数不等：${oldBytes.length} vs ${newBytes.length}（等长是原地替换的前提）`)
    if (first === -1) problems.push('旧内容在该条目内找不到（产物已被改过？先用 asar_entries 搜索确认）')
    else if (first !== last) problems.push('旧内容在该条目内出现多次，定位不唯一（请把替换区扩大到包含上下文）')
    return {
      archive: asar,
      entry: entry.path,
      entrySize: entry.size,
      entryOffset: entry.offset,
      dataOffset,
      spliceAt: first === -1 ? null : first,
      absoluteOffset: first === -1 ? null : dataOffset + entry.offset + first,
      oldBytes: oldBytes.length,
      newBytes: newBytes.length,
      equalLength: oldBytes.length === newBytes.length,
      unique: first !== -1 && first === last,
      /** 旧内容已不在（补丁可能已经打过）。 */
      oldMissing: first === -1,
      /** 新内容已唯一就位（幂等信号：无需再打）。 */
      newAlreadyPresent: firstNew !== -1 && firstNew === lastNew,
      sha256Before: sha256(current),
      problems,
    }
  } finally {
    closeArchive(fd)
  }
}

/**
 * 执行等长替换：备份 → 写入 → 读回逐字节复核。
 *
 * @param {object} options - 与 {@link planSplice} 相同，外加：
 * @param {string} [options.backupTag] - 备份后缀（缺省 `bak-asar-patcher-<时间戳>`）。
 * @param {boolean} [options.skipBackup] - 明确跳过备份（默认 false；不建议）。
 * @returns {object} 结果：`status` 为 `patched` / `already` / `refused`，附计划与备份信息。
 */
export function applySplice({ asar, fragment, oldContent, newContent, backupTag, skipBackup = false }) {
  const oldBytes = Buffer.isBuffer(oldContent) ? oldContent : Buffer.from(String(oldContent), 'utf8')
  const newBytes = Buffer.isBuffer(newContent) ? newContent : Buffer.from(String(newContent), 'utf8')
  const plan = planSplice({ asar, fragment, oldContent: oldBytes, newContent: newBytes })
  // 幂等：目标位置已是新内容（旧内容不在了 + 新内容唯一就位）→ 视为已打过补丁。
  if (plan.oldMissing === true && plan.newAlreadyPresent === true) return { status: 'already', plan }
  if (plan.problems.length > 0) return { status: 'refused', plan }

  const tag = backupTag ?? `bak-asar-patcher-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`
  const backup = skipBackup ? undefined : backupArchive(asar, tag)

  const { fd, header, dataOffset } = openArchive(asar, true)
  try {
    const entry = findEntries(listEntries(header), fragment)[0]
    const current = readEntry(fd, dataOffset, entry)
    const first = current.indexOf(oldBytes)
    if (first === -1 || current.indexOf(oldBytes) !== current.lastIndexOf(oldBytes)) {
      return { status: 'refused', plan, reason: '写入前复核失败：定位不再唯一（文件在规划后被改动？）' }
    }
    const expected = Buffer.from(current)
    if (expected.slice(first, first + newBytes.length).equals(newBytes)) {
      return { status: 'already', plan, backup }
    }
    newBytes.copy(expected, first)
    writeSync(fd, newBytes, 0, newBytes.length, dataOffset + entry.offset + first)
    const verify = readEntry(fd, dataOffset, entry)
    if (!verify.equals(expected)) return { status: 'refused', plan, backup, reason: '写后复核不一致，已向调用方报告（可用 asar_restore 还原）' }
    return {
      status: 'patched',
      plan,
      backup,
      sha256After: sha256(verify),
    }
  } finally {
    closeArchive(fd)
  }
}

/** 读文本文件为 Buffer（供 CLI/工具把「old/new 文件」读进来）。 */
export function readBytes(file) {
  return readFileSync(file)
}
