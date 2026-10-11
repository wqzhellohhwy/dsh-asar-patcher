# DSH「编辑前必须先读」限制解除补丁

对 `app.asar` 的等长原地补丁：让 DSH 的 `edit` / `write` **不再要求先读过目标文件**，
同时保留「读过后文件被外部改动 ⇒ 拒绝写入」的版本新鲜度保护。

- 目标归档：`C:\Users\53518\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`
- 补丁前 SHA256：`CCC131125B99D2472A1A648C5F83EE5F6EEE1C144F62625CF080D0EF5521666C`
- 补丁后 SHA256：`0121BA169D0534ADD83035C7DF5A3A717C05D1E1DE6112C9AF951745D54FF8D2`
- 修改前完整备份：`app.asar.20261011-noread-patch`（另有每次落盘时的 `app.asar.bak-asar-patcher-*`）

## 症状与根因

症状：模型用 `edit` 改一个文件时被拒绝 —— `cannot modify "<path>": file has not been read — read the file, then retry`；即便只是改一行，也必须先把整个文件 `read` 进来，Token 成本随文件体积线性上涨。

根因在策略插件 `@deepseek-ai/dsh-fs-observation-policy`（事件门禁，不是工具本身）：

```js
// dsh/node_modules/@deepseek-ai/dsh-fs-observation-policy/lib/index.js（原始）
editIntent(target, actor) {
    const owner = this.owner(actor);
    const prior = owner ? this.get(owner, target.targetKey) : void 0;
    if (!owner || prior === void 0) throw new FsError(`edit requires reading "${target.displayPath}" first`, "FS_NOT_OBSERVED");
    if (prior.kind === "absent") throw new FsError(`cannot edit "${target.displayPath}": not found`, "FS_NOT_FOUND");
    return { version: prior.version };
}
```

同样的机制也让 `write` 在"没读过"时退化成 `{ kind: "createIfAbsent" }`，于是覆盖已存在文件被 provider 以
`cannot overwrite existing "<path>" without reading it first` 拦下。

关键事实：`fs/*-intent` 是**单槽瀑布事件**，工具侧的调用是

```js
const intent = await ctx.waterfall("fs/edit-intent", target, exec, () => void 0);
```

也就是说监听器**返回 `undefined` 是合法结果**，此时 provider 用自己刚刚 `stat` 到的新鲜版本，或走无守卫路径：

```js
// dsh-fs-local：expected === undefined 时两条守卫都不生效
async writeText(target, content, expected, signal) {
    ...
    if (expected?.kind === "replaceIfVersion") { ... }
    else if (expected?.kind === "createIfAbsent" && existing) throw ...
}
async editText(target, edit, expected, signal) {
    if (expected && existing.version !== expected.version) throw ... FS_STALE_VERSION
}
```

所以"未观察"不该抛错，而应"不提供守卫"。

## 补丁内容（4 处，全部等长原位替换）

| # | 条目 | 位置 | 改动 |
|---|---|---|---|
| 1 | `dsh-fs-observation-policy/lib/index.js` | 条目内偏移 1838（418 字节） | `writeIntent`：未见/确认缺失 ⇒ `void 0`（无守卫），原为 `{ kind: "createIfAbsent" }` |
| 2 | 同上 | 条目内偏移 2257（610 字节） | `editIntent`：删掉两条 `throw`，未见/缺失 ⇒ `void 0`；已观察 present ⇒ 仍返回 `{ version }` |
| 3 | `dsh-tool-fs/lib/index.js` | 条目内偏移 21231（272 字节） | `write` 的系统提示改为「No prior read is required…」 |
| 4 | 同上 | 条目内偏移 26248（204 字节） | `edit` 的系统提示同上 |

补丁片段见 `patch/*.old` / `patch/*.new`（每对字节数完全相同，`patch/` 目录内的 `pad:` 注释行是为凑齐
字节数而补的填充，无副作用）。片段按归档内的 LF 切出，仓库里用 `patches/noread-edit/.gitattributes`
的 `* -text` 禁用行尾转换 —— 一旦被转成 CRLF 就再也对不上归档。

## 验证证据（三层，全部通过）

1. **归档完整性**（`tools/verify_asar.py`）
   - 归档体积 121348951 字节不变；数据区起点 3392064 不变；**JSON 索引逐字节不变**；
   - 全文件差异区间仅落在两个目标条目内（其余 1.2 亿字节零差异）；
   - 两个条目读回内容 == 「备份条目 + 补丁片段」逐字节一致。
2. **行为单测**（`tests/test.mjs`，19 项 PASS，真实源码 + 新旧对照）
   - 打补丁后：未见 `edit-intent` 返回 `undefined`、未见 `write-intent` 返回 `undefined`、确认缺失不再抛 `FS_NOT_FOUND`、无 agent 会话的调用者也能编辑；
   - 备份原版：同样调用抛 `FS_NOT_OBSERVED` / `FS_NOT_FOUND` / 返回 `createIfAbsent`（复现旧行为）；
   - provider 守卫**逐字执行** `dsh-fs-local` 源码片段：`expected === undefined` 时 write/edit 均放行；`createIfAbsent` 仍拦覆盖；陈旧版本仍抛 `FS_STALE_VERSION`。
3. **真实端到端**（`tools/e2e.mjs`，10 项 PASS，Electron 的 node 模式加载 asar 内真实模块）
   - 真实 `Context` + 真实 `LocalFileSystem` + **当前 asar 内打补丁后的策略**，对 node 自己创建、DSH 从未观察过的真实文件：
     `edit-intent → undefined → fs.editText(...)` 真的把 `alpha\nbeta\n` 改成了 `alpha\nBETA\n`；
     `write-intent → undefined → fs.writeText(...)` 真的覆盖成功；
   - 同一脚本换用备份里的原版策略：`edit-intent` 真的抛 `FS_NOT_OBSERVED`，`createIfAbsent` 真的拦住覆盖。

## 生效条件（重要）

运行中的 DSH 已把旧模块读进内存，**必须重启 DSH 才生效**。重启前在主会话里编辑未读文件仍会被拒
（实测：`cannot modify "…\probe.txt": file has not been read`）。

## 回滚

```powershell
# 方式一：插件自带的还原（还原前会另存 pre-restore 存档）
node C:\Users\53518\dsh-plugins\dsh-asar-patcher\bin\dsh-asar.mjs restore bak-asar-patcher-20261011143851
# 或
node C:\Users\53518\dsh-plugins\dsh-asar-patcher\bin\dsh-asar.mjs restore 20261011-noread-patch
```

## DSH 升级后重打

`app.asar` 被升级覆盖后，用同一套片段重打（内容定位，偏移变了也没关系；文本变了会直接报错拒改）：

```powershell
node tools\apply.mjs              # 干运行：只 plan，列出每个补丁的定位与问题
node tools\apply.mjs --write      # 落盘（自动备份 + 写后逐字节复核）
```

重打后建议再跑一次：`py -X utf8 tools\verify_asar.py`、`py -X utf8 tools\gen_test.py && node tests\test.mjs`。

## 目录

```text
patch/               4 对等长替换片段（*.old / *.new）；result.*.mjs 是复核脚本读回的补丁后条目快照
tools/apply.mjs      一键干运行/落盘
tools/make_patch.py  从当前 asar 重新生成片段（并打印 diff）
tools/verify_asar.py 归档完整性三层复核
tools/gen_test.py    生成单测素材（原版/补丁版源码 + provider 守卫片段）
tools/gen_e2e.py     生成原版策略模块（供 e2e 对照）
tools/e2e.mjs        真实模块级端到端测试
tests/test.mjs       行为单测（19 项）
tests/stub-fs.mjs    单测用的最小 FsError
```
