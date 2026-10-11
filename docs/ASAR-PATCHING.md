# 给 DeepSeek Harness 的 app.asar 打补丁

> 本文是**方法论 + 实例记录**。工具本体见仓库根 [`README.md`](../README.md)，
> 样式账本这**具体一例**的来龙去脉见 [`DSH-STYLE-LEDGER.md`](DSH-STYLE-LEDGER.md)。

## 一、归档长什么样

```text
offset 0   u32 = 4                  （pickle：下面这个 size 字段自身占 4 字节）
offset 4   u32 = headerPickleSize   （头部 pickle 总长）
offset 8   u32 = jsonSize + pad     （JSON 长度 + 对齐到 4 字节的填充）
offset 12  u32 = jsonSize           （JSON 精确长度）
offset 16  JSON 索引（jsonSize 字节，尾部补 0 到 4 字节对齐）
dataOffset = 8 + headerPickleSize   数据区起点
```

JSON 索引是一棵树：`{ files: { dsh: { files: { … } } } }`，叶子是
`{ size, offset, integrity? }`。`offset` 是**数据区内**的偏移。
本机这份归档（0.2.0-rc.2）：

```text
bytes      121348951
entries    12967（其中 1497 个 unpacked）
dataOffset 3392064
```

常见踩坑：把 `offset` 当成**文件绝对偏移**用。绝对偏移 = `dataOffset + entry.offset + offsetInFile`。

## 二、为什么选「等长原地替换」

| 路线 | 代价 |
|---|---|
| **重打包** | 要重建 JSON 索引、重排整个数据区、处理 `unpacked` 分离文件与 `integrity` 字段；121 MB 全量重写，一旦写坏就是安装损坏 |
| **等长原地替换** | 只要新旧字节数相同：文件内偏移、索引、数据区起点、`integrity` **全部不用动**，只 write 一小段 |

代价是"补丁必须凑成等长"。实践中的凑法（**从易到难**）：

1. **等价写法压缩**：`document === "undefined"` → `document==="undefined"`、`const owned = [];` → `const owned=[];`、`?? id` → `??id`；
2. **缩进**：把 `\t\t\t` 缩成 `\t`（JS 对空白不敏感），每行省 2 字节；
3. **把替换区向外扩大**：把紧邻的**说明注释**一起纳入替换区，注释可以重写得更短 —— 这是最好用的手段，
   而且顺便能把"这块被补丁改过"写进注释里；
4. **行尾空格**：差额最后用注释里的空格补齐（注释内空白无语义）。

> 规矩：**不要**为了凑长度去改语义（删分号凑 ASI 之类）。前面 3 条够用。

## 三、一次完整工作流

以本机 2026-10-10 的 `claimStyles` 补丁为例（目的是让 DSH **不再认领别人的孤儿样式**，
详见 [`DSH-STYLE-LEDGER.md`](DSH-STYLE-LEDGER.md)）。

```bash
# 1) 自检 + 看备份
node bin/dsh-asar.mjs info

# 2) 定位条目并搜到锚点（返回文件内偏移与上下文）
node bin/dsh-asar.mjs find "dsh-client-modules/lib/client.js" "style:not([data-plugin])"
#   → \dsh\node_modules\@deepseek-ai\dsh-client-modules\lib\client.js  文件内 21878 …

# 3) 把目标文件整段导出，在本地改（改完要保证字节数不变）
node bin/dsh-asar.mjs read "dsh-client-modules/lib/client.js" --out ./client.js

# 4) 干运行：先看计划（偏移、长度、问题列表），此时一个字节都不会写
node bin/dsh-asar.mjs plan "dsh-client-modules/lib/client.js" --old ./client.js --new ./client.patched.js
#   equalLength: true / unique: true / problems: []

# 5) 语法自检（必做：补丁写在 JS 里）
node --check ./client.patched.js

# 6) 落盘（自动备份 + 写后读回复核）
node bin/dsh-asar.mjs splice "dsh-client-modules/lib/client.js" \
  --old ./client.js --new ./client.patched.js --write --tag bak-style-ledger-20261010

# 7) 复核：从归档读回来，与本地补丁文件比对 sha256
node bin/dsh-asar.mjs read "dsh-client-modules/lib/client.js" --out ./verify.js
#   sha256(verify.js) === sha256(client.patched.js)

# 8) 重启 DSH 生效；出问题就还原
node bin/dsh-asar.mjs restore bak-style-ledger-20261010
```

本次实例的实际数字：

```text
条目            \dsh\node_modules\@deepseek-ai\dsh-client-modules\lib\client.js
entrySize       40277
entryOffset     15286309（数据区内）
dataOffset      3392064
替换区          文件内偏移 21502，长度 614 → 614（等长）
归档            bytes 121348951 → 121348951（一字未动）
sha256(补丁后)  b630ec6a963856f3204551cda81f70d828fb4caabe08f4f4a420d456c76269a3
备份            app.asar.bak-style-ledger-20261010
```

补丁本身（614 → 614 字节）：

```diff
  /**
- * Claim and inventory the <style> tags a factory injected during
- * materialization: preset-emitted tags arrive pre-tagged with data-plugin;
- * any untagged tag is claimed for the materializing plugin (HMR bookkeeping).
+ * Claim the <style> tags a factory injected during materialization.      ← 行尾空格补齐差额
+ * DSH-ASAR-PATCH: only bundler-emitted tags (data-plugin-css) count;
+ * hand-written ones stay untouched; presets arrive pre-tagged.
   */
  const claimStyles = (id) => {
-   if (typeof document === "undefined") return [];
-   for (const el of document.querySelectorAll("style:not([data-plugin])")) el.setAttribute("data-plugin", id);
-   const owned = [];
+   if (typeof document==="undefined") return [];
+   for(const el of document.querySelectorAll("style[data-plugin-css]:not([data-plugin])"))el.setAttribute("data-plugin",id);
+   const owned=[];
    for (const el of document.querySelectorAll(`style[data-plugin=${JSON.stringify(id)}]`)) owned.push(el.getAttribute("data-plugin-css") ??id);
    return owned;
  };
```

## 四、补丁的可验证性

改 `app.asar` 属于"动安装本体"，所以每次补丁都要留下**可复算的证据**：

1. **等长**：归档字节数不变（`info` 的 `bytes` 前后一致，`declaredBytes` 不变）；
2. **头不变**：`dataOffset` 之前的所有字节 sha256 不变（测试里有断言）；
3. **邻居不变**：其它条目的字节不变（测试里有断言）；
4. **内容可检**：补丁后能用 `find` 在归档里搜到新写法；
5. **幂等**：再打一次同一补丁 → `already`（`plan` 会给出 `oldMissing: true` + `newAlreadyPresent: true`）；
6. **语法**：导出条目 → `node --check`；
7. **行为**：把补丁后的函数抽出来跑单测（本次做法：抽 `claimStyles` 到 Node + 最小 DOM，
   断言"打包器产物被认领、手写注入/无属性标签不被认领"）。

## 五、什么时候**不要**用等长替换

- 需要**新增/删除文件**、或改动超过几条语句 → 等长凑不出来，应考虑重打包（本库不做）；
- 目标是 `app.asar.unpacked` 下的原生模块（`.node`）→ 直接改那个目录即可，归档里只是占位；
- 归档版本升级后补丁会被覆盖 → 把补丁做成**可重复执行的脚本/工具调用**（本库 + 一条 `plan`→`splice`
  的命令序列），升级后重跑；`plan` 在产物已变时会明确报"旧内容找不到"，不会瞎写。

## 六、踩坑实录：Host 跑在 Electron 主进程里，`node:fs` 被 asar 补丁污染（2026-10-11）

### 症状

`node bin/dsh-asar.mjs info` 一切正常，但模型面的 `asar_*` 工具**全部**返回：

```text
Error: ENOENT,  not found in C:\...\resources\app.asar
```

注意 `ENOENT,` 后面是**两个空格** —— 文件名是**空串**，不是路径被截断。

### 误判顺序（值得记住）

1. 先怀疑归档损坏 → 直接按 asar 格式手解头：`u32@0=4`、`headerPickle=3392056`、
   `jsonSize=3392048`，JSON `parse` 成功、12967 个叶子、**无空名条目**；
   与三个备份的前 16 字节逐字节一致 → **归档无辜**。
2. 再怀疑工具代码 → 同一个 `lib/asar.js` 在纯 Node 下跑 CLI 完全正常 → **代码无辜**。
3. 于是问题必然在**运行环境**：查进程命令行，看到 Host 是
   `"DeepSeek Harness.exe" --expose-internals "…\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\index.js" …`
   —— **Electron 主进程**，而 Electron 会包装主进程的 `node:fs`。

### 根因（一句话）

Electron 的 asar 补丁把「路径中出现 `.asar` 段」判定为归档访问，**该段之后的部分**才是归档内路径；
`…\resources\app.asar` 正好以 `.asar` 收尾、其后为空串 → 补丁拿空串去归档里查 → `notFoundError('')`。

### 判据（一次自查就能区分两种环境）

| 调用 | 纯 Node | Electron 主进程 |
|---|---|---|
| `fs.openSync(asar,'r')` | `fd=3` | **`ENOENT,  not found in …app.asar`** |
| `fs.readFileSync(asar)` | 121348951 字节 | **同款 ENOENT** |
| `fs.statSync(asar)` | `size=121348951` | **`size=0`, `isDirectory()===true`**（伪造成目录，不报错，最阴） |
| `fs.existsSync(asar)` | `true` | 不可靠 |

复现命令（无需改任何代码）：

```powershell
$env:ELECTRON_RUN_AS_NODE="1"; & "…\DeepSeek Harness.exe" scripts/check-electron-fs.mjs
node scripts/check-electron-fs.mjs      # 对照：纯 Node
```

### 修复

`lib/asar.js` 顶部建立「归档本体专用 fs 层」：Electron 下取 `original-fs`
（Electron 提供的**未打补丁** fs），纯 Node 下回退 `node:fs`，并把模块内用到的
`openSync/readSync/closeSync/statSync/readdirSync/existsSync/copyFileSync/readFileSync/writeSync`
统统绑到这层上；`lib/tools.js` 与 CLI 的 `writeFileSync` 也改走它。

### 教训

- 「同一个库，CLI 行、工具面上不行」——**先怀疑运行环境，再怀疑代码**：
  Electron 主进程的 `node:fs` ≠ 纯 Node 的 `node:fs`；凡是**以 `.asar` 结尾的路径**都会进补丁分支。
- 补丁面工具的报错文本要看**空格**：`ENOENT,  not found in …`（双空格）说明"文件名是空串"，
  与"文件不存在"是两回事。
- 新增插件后**必须重启 DSH** 才会加载新代码；重启前用 CLI 应急。
- 结论要落在"能不能复算"上：本次的定案证据是「同一份 `lib/asar.js`，纯 Node `PASS`、
  Electron `PASS（且 node:fs 那行明确报被拦截）`」这两条并排输出。

## 七、实例：解除「编辑前必须先读」（2026-10-11，0.2.0-rc.2）

补丁片段、复现脚本与三层验证见 [`patches/noread-edit/`](../patches/noread-edit/README.md)。

### 症状与根因

模型改一行也要先 `read` 整个文件，否则：

```text
cannot modify "<path>": file has not been read — read the file, then retry
```

拦人的不是工具，是策略插件 `@deepseek-ai/dsh-fs-observation-policy` 的 `fs/*` 事件门禁：
`editIntent` 在"本会话没观察过该路径"时直接抛 `FS_NOT_OBSERVED`；`writeIntent` 把"未观察"解析成
`{ kind: "createIfAbsent" }`，于是 `write` 覆盖已存在文件也会被 provider 顶回来。

关键在于 `fs/*-intent` 是**单槽瀑布事件**，工具侧的调用是
`ctx.waterfall("fs/edit-intent", target, exec, () => void 0)` —— **监听器返回 `undefined` 是合法结果**，
此时 provider 用自己刚 `stat` 到的新鲜版本或走无守卫路径（`dsh-fs-local` 里
`if (expected?.kind === …)` / `if (expected && …)` 都不成立）。所以"未观察"的正解是**不提供守卫**，
而不是抛错。

### 补丁（4 处，全部等长）

| 条目 | 文件内偏移 | 长度 | 改动 |
|---|---|---|---|
| `dsh-fs-observation-policy/lib/index.js` | 1838 | 418 → 418 | `writeIntent`：未见/确认缺失 ⇒ `void 0`（不再 `createIfAbsent`） |
| 同上 | 2257 | 610 → 610 | `editIntent`：删掉两条 `throw`，未见/缺失 ⇒ `void 0`；已观察 present 仍返回 `{ version }` |
| `dsh-tool-fs/lib/index.js` | 21231 | 272 → 272 | `write` 的系统提示改为"无需先读" |
| 同上 | 26248 | 204 → 204 | `edit` 的系统提示同上 |

```text
归档            bytes 121348951 → 121348951（头与 JSON 索引逐字节未动）
dataOffset      3392064 → 3392064
sha256(改前)    ccc131125b99d2472a1a648c5f83ee5f6eee1c144f62625cf080d0ef5521666c
sha256(改后)    0121ba169d0534add83035c7df5a3a717c05d1e1de6112c9af951745d54ff8d2
备份            app.asar.20261011-noread-patch
```

凑等长用的是第二节的手法 3+4：把 `writeIntent` / `editIntent` 上方的 JSDoc 一起纳入替换区，
重写成更短的 `// [dsh-local-patch] …` 注释，剩余差额用 `// pad: ----` 注释行补齐（注释内空白无语义）。

### 验证（三层，全部 PASS）

1. `tools/verify_asar.py` —— 归档字节数与 `dataOffset` 不变、**JSON 索引逐字节相同**、
   全文件差异区间仅落在两个目标条目内、条目读回 ==「备份条目 + 片段」逐字节一致；
2. `tests/test.mjs`（19 项）—— 真源码 + 新旧对照；并用 `new Function` **逐字执行** `dsh-fs-local`
   的守卫源码，证明 `expected === undefined` 时 write/edit 都放行，而 `createIfAbsent` 仍拦覆盖、
   陈旧版本仍抛 `FS_STALE_VERSION`；
3. `tools/e2e.mjs`（10 项）—— **用 Electron 的 node 模式直接 import asar 内的真实模块**
   （`Context` + `LocalFileSystem` + 补丁后的策略），对 DSH 从未观察过的真实文件真的改成功；
   换用备份里的原版策略则真的被 `FS_NOT_OBSERVED` 拦住。

> 顺带一个好用的技巧：`ELECTRON_RUN_AS_NODE=1 "...\DeepSeek Harness.exe" script.mjs`
> 能**直接 import asar 内的 ESM 模块**（连裸标识符依赖解析都可用），因此不必解包归档，
> 也能对归档里的真实代码做端到端测试。

### 生效与回退

改完**必须重启 DSH**（运行中的进程已把旧代码读进内存；重启前实测仍报 `file has not been read`）。
回退：`node bin/dsh-asar.mjs restore 20261011-noread-patch`。
升级覆盖后重打：`node patches/noread-edit/tools/apply.mjs [--write]` —— 内容定位，偏移变了也能打；
产物已变时 `plan` 会明确报"旧内容找不到"，不会瞎写。

### 风险提示（这是**放宽**，不是修复）

补丁后"没读过的文件也能被整文件覆盖"，这正是需求本身；剩下的安全网只有
"**读过之后**文件被外部改动 ⇒ `FS_STALE_VERSION`"。想恢复严格模式，用备份还原归档即可。
