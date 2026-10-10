/**
 * dsh-asar-patcher 核心库回归测试。
 *
 * 关键断言不是"能读出自己写的东西"，而是**原地替换的边界**：
 * 替换目标条目之后，(a) 归档头逐字节不变、(b) 其它条目逐字节不变、
 * (c) 目标条目只有替换区那几个字节变了。这三条是"等长替换不改结构"的全部含义，
 * 也是它敢直接写在生产 app.asar 上的理由。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applySplice,
  backupArchive,
  closeArchive,
  findEntries,
  listBackups,
  listEntries,
  openArchive,
  planSplice,
  readEntry,
  restoreArchive,
  sha256,
  verifyArchive,
} from '../lib/asar.js'

/** 构造一个最小可读的 asar（头部布局与 @electron/asar 一致）。 */
function buildArchive(files) {
  const tree = { files: {} }
  const bodies = []
  let offset = 0
  for (const [path, content] of Object.entries(files)) {
    const buffer = Buffer.from(content, 'utf8')
    const parts = path.split('/')
    let node = tree
    for (const part of parts.slice(0, -1)) {
      node.files[part] ??= { files: {} }
      node = node.files[part]
    }
    node.files[parts.at(-1)] = { size: buffer.length, offset: String(offset) }
    bodies.push(buffer)
    offset += buffer.length
  }
  const json = Buffer.from(JSON.stringify(tree), 'utf8')
  const pad = (4 - (json.length % 4)) % 4
  const jsonSize = json.length
  const pickleSize = jsonSize + pad + 8
  const head = Buffer.alloc(16)
  head.writeUInt32LE(4, 0)
  head.writeUInt32LE(pickleSize, 4)
  head.writeUInt32LE(jsonSize + pad, 8)
  head.writeUInt32LE(jsonSize, 12)
  return Buffer.concat([head, json, Buffer.alloc(pad), ...bodies])
}

/** 在临时目录里落一个归档，返回路径。 */
function tempArchive(files) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-asar-test-'))
  const path = join(dir, 'app.asar')
  writeFileSync(path, buildArchive(files))
  return path
}

/** 目标条目样例：替换锚点偏移由代码算出，避免测试里硬编码偏移。 */
const CLIENT_SRC = 'const claimStyles = (id) => { /* A */ return id };\n// tail'
const A_AT = CLIENT_SRC.indexOf('/* A */')
const OTHER_SRC = 'export const marker = "untouched";\n'
const SAMPLE = {
  'dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/client.js': CLIENT_SRC,
  'dsh/node_modules/@deepseek-ai/other/lib/index.js': OTHER_SRC,
}
const CLIENT_FRAG = 'dsh-client-modules/lib/client.js'
const OTHER_FRAG = 'other/lib/index.js'

test('verifyArchive 自检通过，且条目数与体积一致', () => {
  const asar = tempArchive(SAMPLE)
  const info = verifyArchive(asar)
  assert.equal(info.truncated, false)
  assert.equal(info.entries, 2)
  assert.equal(info.unpacked, 0)
  assert.ok(info.dataOffset > 0)
})

test('listEntries / findEntries 能按片段定位唯一条目', () => {
  const asar = tempArchive(SAMPLE)
  const { fd, header } = openArchive(asar)
  try {
    const all = listEntries(header)
    assert.equal(all.length, 2)
    const hits = findEntries(all, CLIENT_FRAG)
    assert.equal(hits.length, 1)
    assert.equal(findEntries(all, OTHER_FRAG).length, 1)
  } finally { closeArchive(fd) }
})

test('planSplice：等长且唯一时无问题；不等长/找不到/不唯一时报告问题', () => {
  const asar = tempArchive(SAMPLE)
  const ok = planSplice({ asar, fragment: CLIENT_FRAG, oldContent: '/* A */', newContent: '/* B */' })
  assert.deepEqual(ok.problems, [], JSON.stringify(ok.problems))
  assert.equal(ok.spliceAt, A_AT)
  assert.equal(ok.equalLength, true)
  assert.equal(ok.oldMissing, false)
  assert.equal(ok.newAlreadyPresent, false)

  const longer = planSplice({ asar, fragment: CLIENT_FRAG, oldContent: '/* A */', newContent: '/* BB */' })
  assert.ok(longer.problems.some((p) => p.includes('字节数不等')))

  const missing = planSplice({ asar, fragment: CLIENT_FRAG, oldContent: '/* Z */', newContent: '/* Y */' })
  assert.ok(missing.problems.some((p) => p.includes('找不到')))
  assert.equal(missing.oldMissing, true)

  const ambiguous = planSplice({ asar, fragment: CLIENT_FRAG, oldContent: 'd', newContent: 'D' })
  assert.ok(ambiguous.problems.some((p) => p.includes('多次')))
})

test('applySplice：只改目标条目的替换区，归档头与其它条目逐字节不变', () => {
  const asar = tempArchive(SAMPLE)
  const beforeFile = readFileSync(asar)
  const beforeInfo = openArchive(asar)
  const entriesBefore = listEntries(beforeInfo.header)
  const targetEntry = findEntries(entriesBefore, CLIENT_FRAG)[0]
  const targetBefore = readEntry(beforeInfo.fd, beforeInfo.dataOffset, targetEntry)
  const otherBefore = readEntry(beforeInfo.fd, beforeInfo.dataOffset, findEntries(entriesBefore, OTHER_FRAG)[0])
  const headerBytesBefore = beforeFile.subarray(0, beforeInfo.dataOffset)
  closeArchive(beforeInfo.fd)

  const result = applySplice({
    asar,
    fragment: CLIENT_FRAG,
    oldContent: '/* A */',
    newContent: '/* B */',
    backupTag: 'test-backup',
  })
  assert.equal(result.status, 'patched')
  assert.equal(result.backup.tag, 'test-backup')

  const afterFile = readFileSync(asar)
  assert.equal(afterFile.length, beforeFile.length, '归档长度必须不变')
  const afterInfo = openArchive(asar)
  try {
    // (a) 归档头逐字节不变
    assert.equal(sha256(afterFile.subarray(0, afterInfo.dataOffset)), sha256(headerBytesBefore), '归档头不得变化')
    // (b) 其它条目逐字节不变
    const otherAfter = readEntry(afterInfo.fd, afterInfo.dataOffset, findEntries(listEntries(afterInfo.header), OTHER_FRAG)[0])
    assert.ok(otherAfter.equals(otherBefore), '其它条目不得变化')
    // (c) 目标条目只有替换区变化
    const targetAfter = readEntry(afterInfo.fd, afterInfo.dataOffset, findEntries(listEntries(afterInfo.header), CLIENT_FRAG)[0])
    const expected = Buffer.from(targetBefore)
    Buffer.from('/* B */').copy(expected, A_AT)
    assert.ok(targetAfter.equals(expected), `目标条目应只在偏移 ${A_AT} 处变化`)
    assert.equal(targetAfter.length, targetEntry.size)
  } finally { closeArchive(afterInfo.fd) }
})

test('applySplice：重复打同一补丁返回 already；不等长直接 refused 且不落盘', () => {
  const asar = tempArchive(SAMPLE)
  applySplice({ asar, fragment: CLIENT_FRAG, oldContent: '/* A */', newContent: '/* B */', backupTag: 'b1' })
  const again = applySplice({ asar, fragment: CLIENT_FRAG, oldContent: '/* A */', newContent: '/* B */', backupTag: 'b2' })
  assert.equal(again.status, 'already')

  const before = readFileSync(asar)
  const refused = applySplice({ asar, fragment: CLIENT_FRAG, oldContent: '/* B */', newContent: '/* longer */', backupTag: 'b3' })
  assert.equal(refused.status, 'refused')
  assert.ok(refused.plan.problems.some((p) => p.includes('字节数不等')))
  assert.ok(readFileSync(asar).equals(before), '被拒绝的补丁不得改动归档')
})

test('backupArchive 不覆盖同名备份；restoreArchive 可完整还原并留下 pre-restore 存档', () => {
  const asar = tempArchive(SAMPLE)
  const original = readFileSync(asar)
  const first = backupArchive(asar, 'keep')
  assert.equal(first.created, true)
  const second = backupArchive(asar, 'keep')
  assert.equal(second.created, false)

  applySplice({ asar, fragment: CLIENT_FRAG, oldContent: '/* A */', newContent: '/* B */', backupTag: 'keep' })
  assert.notEqual(sha256(readFileSync(asar)), sha256(original))

  const restored = restoreArchive(asar, 'keep')
  assert.ok(readFileSync(asar).equals(original), '还原后应与原始字节一致')
  assert.ok(readFileSync(restored.savedCurrent).length > 0)
  assert.ok(listBackups(asar).some((b) => b.tag === 'keep'))
})
