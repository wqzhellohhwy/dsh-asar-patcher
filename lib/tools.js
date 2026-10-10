/**
 * dsh-asar-patcher — 面向模型的五个工具定义。
 *
 * 设计取向：这是「改 DSH 本体」的工具，所以每一步都偏保守 ——
 *   - 定位靠**唯一命中的路径片段**，不靠猜；
 *   - 替换**强制等长**，不等长就报差值并拒绝；
 *   - 写入**默认关闭**（`write: true` 才落盘），写入前自动备份，写入后读回复核；
 *   - 还原是独立工具，随时可退。
 *
 * @module dsh-asar-patcher/tools
 */

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
} from './asar.js'
import { writeFileSync } from 'node:fs'

/** 统一的参数片段：asar 路径（缺省自动探测）。 */
const ASAR_PARAM = {
  type: 'string',
  description: 'app.asar 绝对路径；缺省时按平台常见安装位置自动探测，也可用环境变量 DSH_ASAR 指定。',
}

/** 纯文本渲染。 */
const renderJson = (value) => [{ type: 'text', text: JSON.stringify(value, null, 1) }]

/** 工具输出 schema：宽松对象，保证 ok/message 始终存在。 */
const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: true,
    properties: {
      ok: { type: 'boolean' },
      message: { type: 'string' },
    },
    required: ['ok', 'message'],
  },
  render: (_args, value) => renderJson(value),
}

/**
 * `asar_info`：定位归档 + 结构自检 + 已有备份列表。
 * @param {{defaultAsar?: string}} config - 插件配置。
 * @returns {object} 工具定义。
 */
export function asarInfoTool(config) {
  return {
    name: 'asar_info',
    description: [
      '定位并自检 DeepSeek Harness 的 app.asar（归档头、条目数、数据区起点、体积一致性），',
      '同时列出已有的备份文件。改包前先跑一次，确认路径与结构正常。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: { asar: ASAR_PARAM },
      required: [],
    },
    output: OUTPUT,
    async execute(args) {
      const asar = detectAsar(args.asar ?? config.defaultAsar)
      if (asar === undefined) return { ok: false, message: '找不到 app.asar：请显式传 asar 参数，或设置 DSH_ASAR。' }
      const info = verifyArchive(asar)
      return {
        ok: !info.truncated,
        message: info.truncated
          ? `归档自检发现越界：声明 ${info.declaredBytes} 字节 > 实际 ${info.bytes} 字节`
          : `归档正常：${info.entries} 个条目（unpacked ${info.unpacked}），数据区起点 ${info.dataOffset}。`,
        info,
        backups: listBackups(asar),
      }
    },
  }
}

/**
 * `asar_entries`：列条目，或在条目内容里搜索字符串（定位补丁点）。
 * @param {{defaultAsar?: string}} config - 插件配置。
 * @returns {object} 工具定义。
 */
export function asarEntriesTool(config) {
  return {
    name: 'asar_entries',
    description: [
      '列出 asar 内的条目，或（给了 search 时）在命中条目里搜索字符串并返回「文件内偏移」。',
      '改包工作流：先用它确认目标文件路径与待替换文本的偏移，再用 asar_splice 写补丁。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        asar: ASAR_PARAM,
        path: { type: 'string', description: '路径片段过滤（如 dsh-client-modules/lib/client.js），省略即列全部条目。' },
        search: { type: 'string', description: '在条目内容里搜索的字符串（latin1 逐字节匹配，可搜非 ASCII 片段）。给了它就返回命中偏移。' },
        limit: { type: 'integer', description: '条目列表上限，缺省 200。' },
        maxHits: { type: 'integer', description: '搜索命中上限，缺省 50。' },
      },
      required: [],
    },
    output: OUTPUT,
    async execute(args) {
      const asar = detectAsar(args.asar ?? config.defaultAsar)
      if (asar === undefined) return { ok: false, message: '找不到 app.asar：请显式传 asar 参数，或设置 DSH_ASAR。' }
      const { fd, header, dataOffset } = openArchive(asar)
      try {
        const all = listEntries(header)
        const hits = findEntries(all, args.path)
        if (args.search === undefined) {
          const limit = args.limit ?? 200
          return {
            ok: true,
            message: `命中 ${hits.length} 个条目${hits.length > limit ? `（只列前 ${limit} 个）` : ''}。`,
            total: all.length,
            matched: hits.length,
            entries: hits.slice(0, limit).map((entry) => ({ path: entry.path, size: entry.size, offset: entry.offset })),
          }
        }
        const needle = Buffer.from(args.search, 'utf8')
        const maxHits = args.maxHits ?? 50
        const found = []
        for (const entry of hits) {
          if (entry.unpacked) continue
          if (found.length >= maxHits) break
          const buffer = readEntry(fd, dataOffset, entry)
          let from = 0
          while (found.length < maxHits) {
            const at = buffer.indexOf(needle, from)
            if (at === -1) break
            found.push({
              path: entry.path,
              offsetInFile: at,
              absoluteOffset: dataOffset + entry.offset + at,
              context: buffer.subarray(Math.max(0, at - 60), at + needle.length + 40).toString('utf8'),
            })
            from = at + 1
          }
        }
        return {
          ok: found.length > 0,
          message: found.length === 0 ? '未命中' : `命中 ${found.length} 处${found.length >= maxHits ? `（已达上限 ${maxHits}）` : ''}。`,
          hits: found,
        }
      } finally {
        closeArchive(fd)
      }
    },
  }
}

/**
 * `asar_read`：读条目内容（片段预览，或整段导出到文件）。
 * @param {{defaultAsar?: string}} config - 插件配置。
 * @returns {object} 工具定义。
 */
export function asarReadTool(config) {
  return {
    name: 'asar_read',
    description: [
      '从 asar 里读一个条目的内容：给 outFile 就整段导出到文件（大文件用这个），',
      '否则返回 [offset, offset+length) 的文本预览。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        asar: ASAR_PARAM,
        path: { type: 'string', description: '条目路径片段（必须唯一命中）。' },
        offset: { type: 'integer', description: '文件内起始偏移，缺省 0。' },
        length: { type: 'integer', description: '预览字节数，缺省 2000。' },
        outFile: { type: 'string', description: '整段导出到该绝对路径（与 offset/length 互斥）。' },
      },
      required: ['path'],
    },
    output: OUTPUT,
    async execute(args) {
      const asar = detectAsar(args.asar ?? config.defaultAsar)
      if (asar === undefined) return { ok: false, message: '找不到 app.asar：请显式传 asar 参数，或设置 DSH_ASAR。' }
      const { fd, header, dataOffset } = openArchive(asar)
      try {
        const hits = findEntries(listEntries(header), args.path)
        if (hits.length !== 1) return { ok: false, message: `路径片段命中 ${hits.length} 个条目（需恰好 1 个）`, hits: hits.slice(0, 10).map((entry) => entry.path) }
        const entry = hits[0]
        if (entry.unpacked) return { ok: false, message: '该条目 unpacked（内容在 app.asar.unpacked 下，请直接读那个目录）' }
        const buffer = readEntry(fd, dataOffset, entry)
        if (args.outFile !== undefined) {
          writeFileSync(args.outFile, buffer)
          return { ok: true, message: `已导出 ${entry.path}（${buffer.length} 字节）→ ${args.outFile}`, entry: entry.path, bytes: buffer.length, sha256: sha256(buffer) }
        }
        const offset = args.offset ?? 0
        const length = args.length ?? 2000
        const slice = buffer.subarray(offset, Math.min(buffer.length, offset + length))
        return {
          ok: true,
          message: `已读 ${entry.path} 的 [${offset}, ${offset + slice.length}) 共 ${slice.length} 字节（条目共 ${buffer.length} 字节）。`,
          entry: entry.path,
          entrySize: buffer.length,
          offset,
          bytes: slice.length,
          text: slice.toString('utf8'),
        }
      } finally {
        closeArchive(fd)
      }
    },
  }
}

/**
 * `asar_splice`：等长原地替换（默认干运行）。
 * @param {{defaultAsar?: string, allowWrite?: boolean}} config - 插件配置。
 * @returns {object} 工具定义。
 */
export function asarSpliceTool(config) {
  return {
    name: 'asar_splice',
    description: [
      '对 asar 内某个文件做「等长原地替换」：新旧内容字节数必须完全相同（否则直接拒绝并给出差值）。',
      '默认只干运行（返回计划与问题列表）；write=true 才落盘，落盘前自动备份、落盘后读回逐字节复核。',
      '等长是硬约束：若新内容更长，请把替换区向外扩大到包含相邻注释/空白，用它们抵消字节差。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        asar: ASAR_PARAM,
        path: { type: 'string', description: '条目路径片段（必须唯一命中）。' },
        oldFile: { type: 'string', description: '「旧内容」所在文件的绝对路径（内容必须能在条目里唯一命中）；与 oldText 二选一。' },
        newFile: { type: 'string', description: '「新内容」所在文件的绝对路径；与 newText 二选一。' },
        oldText: { type: 'string', description: '直接给旧内容文本（短补丁方便）；与 oldFile 二选一。' },
        newText: { type: 'string', description: '直接给新内容文本；与 newFile 二选一。' },
        write: { type: 'boolean', description: 'true 才真正落盘；缺省 false（干运行）。' },
        backupTag: { type: 'string', description: '备份后缀，缺省 bak-asar-patcher-<时间戳>；备份文件为 <asar>.<tag>。' },
      },
      required: ['path'],
    },
    output: OUTPUT,
    async execute(args) {
      const asar = detectAsar(args.asar ?? config.defaultAsar)
      if (asar === undefined) return { ok: false, message: '找不到 app.asar：请显式传 asar 参数，或设置 DSH_ASAR。' }
      const oldContent = args.oldFile !== undefined ? readBytes(args.oldFile) : Buffer.from(String(args.oldText ?? ''), 'utf8')
      const newContent = args.newFile !== undefined ? readBytes(args.newFile) : Buffer.from(String(args.newText ?? ''), 'utf8')
      if (oldContent.length === 0) return { ok: false, message: '缺少旧内容：请给 oldFile 或 oldText。' }
      if (newContent.length === 0) return { ok: false, message: '缺少新内容：请给 newFile 或 newText。' }

      const wantWrite = args.write === true
      if (wantWrite && config.allowWrite === false) {
        return { ok: false, message: '本插件配置为 allowWrite=false（只读模式），拒绝写入。' }
      }
      const result = wantWrite
        ? applySplice({ asar, fragment: args.path, oldContent, newContent, backupTag: args.backupTag })
        : { status: 'dry-run', plan: planSplice({ asar, fragment: args.path, oldContent, newContent }) }

      const plan = result.plan
      const problems = plan.problems ?? []
      const messages = {
        'dry-run': `干运行：${plan.entry ?? '(未定位)'}，替换偏移 ${plan.spliceAt ?? '-'}，${plan.oldBytes} → ${plan.newBytes} 字节。加 write=true 落盘。`,
        patched: `已打补丁：${plan.entry}（偏移 ${plan.spliceAt}，${plan.oldBytes} 字节等长替换）。备份：${result.backup?.path ?? '(已跳过)'}`,
        already: `目标内容已是新版（无需再打）。`,
        refused: `拒绝写入：${[result.reason, ...problems].filter(Boolean).join('；') || '计划校验未通过'}`,
      }
      return {
        ok: problems.length === 0 && result.status !== 'refused',
        message: messages[result.status] ?? result.status,
        status: result.status,
        plan,
        backup: result.backup,
        sha256After: result.sha256After,
        hint: problems.some((p) => p.includes('字节数不等'))
          ? '新旧长度不等：把替换区向两侧扩大（把相邻的注释、空白、或同函数里可压缩的写法一起纳入），使总字节数相同。'
          : undefined,
      }
    },
  }
}

/**
 * `asar_restore`：从备份还原归档。
 * @param {{defaultAsar?: string, allowWrite?: boolean}} config - 插件配置。
 * @returns {object} 工具定义。
 */
export function asarRestoreTool(config) {
  return {
    name: 'asar_restore',
    description: '用 asar 备份还原归档（还原前会把当前内容另存为 <asar>.pre-restore-<时间戳>，因此可反悔）。用 asar_info 看可用备份。',
    parameters: {
      type: 'object',
      properties: {
        asar: ASAR_PARAM,
        tag: { type: 'string', description: '备份后缀（asar_info 的 backups[].tag）。' },
      },
      required: ['tag'],
    },
    output: OUTPUT,
    async execute(args) {
      if (config.allowWrite === false) return { ok: false, message: '本插件配置为 allowWrite=false（只读模式），拒绝还原（还原也是写）。' }
      const asar = detectAsar(args.asar ?? config.defaultAsar)
      if (asar === undefined) return { ok: false, message: '找不到 app.asar：请显式传 asar 参数，或设置 DSH_ASAR。' }
      try {
        const result = restoreArchive(asar, args.tag)
        return {
          ok: true,
          message: `已从 ${result.restoredFrom} 还原；还原前的当前内容另存为 ${result.savedCurrent}。`,
          ...result,
        }
      } catch (error) {
        return { ok: false, message: String(error?.message ?? error) }
      }
    },
  }
}

/**
 * `asar_backup`：手动备份（打补丁之外的场合，例如准备重打包前的存档）。
 * @param {{defaultAsar?: string}} config - 插件配置。
 * @returns {object} 工具定义。
 */
export function asarBackupTool(config) {
  return {
    name: 'asar_backup',
    description: '把 app.asar 备份为 <asar>.<tag>（同名备份已存在时不覆盖）。',
    parameters: {
      type: 'object',
      properties: {
        asar: ASAR_PARAM,
        tag: { type: 'string', description: '备份后缀，缺省 manual-<时间戳>。' },
      },
      required: [],
    },
    output: OUTPUT,
    async execute(args) {
      const asar = detectAsar(args.asar ?? config.defaultAsar)
      if (asar === undefined) return { ok: false, message: '找不到 app.asar：请显式传 asar 参数，或设置 DSH_ASAR。' }
      const tag = args.tag ?? `manual-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`
      const result = backupArchive(asar, tag)
      return {
        ok: true,
        message: result.created ? `已备份 → ${result.path}（${result.size} 字节）` : `备份已存在，未覆盖：${result.path}`,
        ...result,
      }
    },
  }
}

/**
 * 组装全部工具。
 * @param {object} config - 插件配置（defaultAsar / allowWrite）。
 * @returns {object[]} 工具定义数组。
 */
export function buildTools(config) {
  return [
    asarInfoTool(config),
    asarEntriesTool(config),
    asarReadTool(config),
    asarSpliceTool(config),
    asarBackupTool(config),
    asarRestoreTool(config),
  ]
}
