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
