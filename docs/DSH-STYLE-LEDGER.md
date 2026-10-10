# DSH 客户端样式账本：为什么"点一下记忆，整页 UI 变成了裸控件"

> 2026-10-10 定位并修复。本文记录机制、证据、两侧修复与自查方法。
> 涉及 `@deepseek-ai/dsh-client-modules`（DSH 0.2.0-rc.2 桌面版）。

## 一、症状

用户视角：在记忆面板上动了点什么（新建/删除条目、或让 AI 写记忆），**页面突然变成
没有 CSS 的裸控件** —— 标签页成了带黑框的原生按钮、侧栏没了背景、卡片变纯文本。
但：

- **页面结构还在**（左栏/主区/输入框位置都对），只是"外观全没了"；
- **刷新或重启就恢复**；
- 桌面版尤其容易遇到。

关键鉴别点：`<link>` 引入的 shell 基础样式**没丢**，丢的是**运行时注入的 `<style>`**。
而现代 DSH 的可见 UI（侧栏、会话、输入栏、各插件面板）几乎全部由**客户端插件**渲染、
并由各插件在浏览器里注入样式 —— 所以"插件样式被删"在视觉上就等于"整页没样式"。

## 二、机制：`data-plugin` 是样式归属账本

`@deepseek-ai/dsh-client-modules` 的浏览器半侧（`lib/client.js`）维护一张样式账本，
键就是每个 `<style>` 上的 `data-plugin` 属性：

```js
// 物化（materialize）一个插件 bundle 之后立即调用：
const claimStyles = (id) => {
  if (typeof document === 'undefined') return []
  // ⚠ 认领页面上**所有**没有 data-plugin 的 <style>
  for (const el of document.querySelectorAll('style:not([data-plugin])'))
    el.setAttribute('data-plugin', id)
  const owned = []
  for (const el of document.querySelectorAll(`style[data-plugin=${JSON.stringify(id)}]`))
    owned.push(el.getAttribute('data-plugin-css') ?? id)
  return owned
}

// 该插件被 HMR 重载 / 图重组回收时调用：
function removeOwnedStyles(id) {
  for (const el of document.querySelectorAll('style[data-plugin]'))
    if (el.getAttribute('data-plugin') === id) el.remove()
}
```

`claimStyles` 的调用点在 `materialize()` 里（紧跟 factory 执行之后）；`removeOwnedStyles`
有六处调用点：`reload`/`replace`（代码替换）、`materialize` 的 catch（factory 抛错）、
`updateManifest`（图里行的 rev 变化）、`prune`（行已不在图中）。

### 官方插件为什么安全

DSH 官方的客户端插件在 **bundle 顶层（factory 执行期）**注入样式，并且在注入时**自己写归属**：

```js
const tag = document.createElement('style')
tag.dataset.plugin = '@deepseek-ai/dsh-client-ui-conversation'   // ← 归属
tag.dataset.pluginCss = tagId
tag.textContent = css
document.head.appendChild(tag)
```

于是：注入发生在 `claimStyles(自己)` 之前、且已经带 `data-plugin` → 它不在"无主集合"里，
既不会被别人认领，`removeOwnedStyles(自己)` 也只删自己的。

### 不守约插件为什么致命

如果插件在**运行时**（`apply()`、组件 `render`、`useEffect`）注入 `<style>` 却**不写 `data-plugin`**，
那就同时踩两个坑：

1. **自己的样式成为"无主标签"** → 被**随后物化的任意插件**认领；那个插件一旦重载/回收，
   `removeOwnedStyles(那个插件)` 就把这里的样式**一起删掉**，而且**不会恢复**：插件的注入守卫
   （`querySelector('style[data-…]') === null` 才注入）已经认为"注入过了"。
2. **反向污染**：本插件物化时 `claimStyles` 会把页面上**所有**无主标签（其它不守约插件的样式）
   认领到自己名下 → **本插件一重载，就把别人的样式一起删掉**。

于是"某个插件重建/热重载"这个高频动作，会随机地删掉一片**不属于它**的样式。

## 三、触发链

```text
任何让插件 bundle 变化的动作
  ├─ HMR rebuilt（bundle 文件的 mtime/ctime/size 变化 → 客户端 entries.reload(id, rev)）
  ├─ 插件热重载器（本机 @dsh-external/dsh-super-injector 的"热重载"直接调
  │    clientModules.rebuilt(name) 与 compose()/notifyGraphChanged()）
  └─ Loader 图重组（enable/disable 插件 → 行消失 → prune()）
        ↓
  客户端 ClientEntries.reload → replace(entry, id, rev)
        ↓
  removeOwnedStyles(id)   ← 删除该 id 名下所有 <style>（包括误认领来的别人的样式）
        ↓
  页面大片失去样式（刷新/重启后恢复，因为重新物化时样式被重新注入）
```

本机的实锤：`dsh-super-injector` 的 `lib/index.js` 里有

```js
function notifyClientRebuilt(name) {
  const cm = ctx.get('clientModules')
  if (cm && typeof cm.rebuilt === 'function') cm.rebuilt(name)   // ← 触发上面的链
}
```

而 2026-10-10 凌晨，`dsh-memory-evolve/lib/client.js` 在 01:36 / 01:47 / 02:00 被反复重建，
`dsh-prompt/lib/client.js` 在 00:42 重建 —— 每次重建都会删掉一批被误认领的样式。
用户当时正在"改记忆插件 + 写记忆"，于是现象看起来像"添加记忆导致页面崩样式"。

## 四、自查（下次再遇到，三条命令定性）

在页面 DevTools Console：

```js
// 1) 是否还有"无主"样式标签（> 0 就说明账本仍会被污染；修复后应为 0）
document.querySelectorAll('style:not([data-plugin])').length

// 2) 看归属分布：某个插件名下若挂着一大堆不属于它的样式，就是"误认领"
[...document.querySelectorAll('style[data-plugin]')]
  .reduce((m, el) => ((m[el.getAttribute('data-plugin')] = (m[el.getAttribute('data-plugin')] ?? 0) + 1), m), {})

// 3) 页面无样式、且上面(2)里某插件名下的标签大量消失 → 就是本机制
```

`ctx.modules.entries.state`（客户端模块系统暴露的可订阅状态）与「设置 → 插件」页的
同步失败列表，也能看到 `client-modules` 的报错。

## 五、两侧修复

### 插件侧（治"污染源"）

**每个运行时注入的 `<style>` 都必须带 `data-plugin = 包名`**（= Loader 条目 id）。
本机 2026-10-10 修掉的四个插件：

| 插件 | 注入点 | 修法 |
|---|---|---|
| `dsh-memory-evolve` | 11 处（`apply()` 里 10 个 `ctx.effect` + 画板 `injectCanvasStyles`） | 新增 `src/client/style-tag.ts` 的 `injectOwnedStyle(marker, css)` 统一入口：注入即打标，命中"标签已存在"时**抢回归属**；11 处收敛为 2 处 |
| `dsh-prompt` | 5 处 | `tag.setAttribute('data-plugin', 'dsh-prompt')` |
| `@dsh-external/dsh-tool-manager` | 1 处（`useEffect`） | 同上 |
| `@dsh-external/dsh-super-injector` | 1 处（组件 `render`） | 同上 |

已经合规（不要动）：`dsh-smooth-stream`、`dsh-projectless`、`dsh-mcp-connector`、以及全部
`@deepseek-ai/dsh-client-ui-*` 官方插件。

**插件作者 checklist**

- [ ] 所有 `<style>` 注入（含运行时新建的）都 `setAttribute('data-plugin', '<包名>')`；
- [ ] 别用私有属性冒充归属（`data-xxx-css` 只用于自己的幂等守卫）；
- [ ] 守卫命中"标签已存在"时，顺手把归属抢回（防历史遗留的误认领）；
- [ ] 打包产物里搜一遍：每个 `createElement("style")` 附近都要有 `data-plugin`。

### DSH 侧（治"账本语义"）

**把 `claimStyles` 的认领范围从"所有无主标签"收窄为"打包器产物"**：

```diff
- for (const el of document.querySelectorAll("style:not([data-plugin])")) …
+ for (const el of document.querySelectorAll("style[data-plugin-css]:not([data-plugin])")) …
```

`data-plugin-css` 是打包器（tsdown/esbuild 的 `.module.css` 产物）注入时必写的 tagId 标记。
于是：

- **打包器产物但忘了打 `data-plugin`**（真正的兜底对象）→ 仍被认领 ✅
- **手写注入**（`data-memory-evolve-css`、`data-dsh-prompt-style`、或无属性）→ **不再被任何插件认领** ✅

这样即使将来又出现不守约的插件，**最多是它自己的样式没人记账（不再被清理），绝不会
连带删掉别人的样式** —— 从"跨插件互相伤害"退化为"局部失效"。

该补丁已用等长原地替换写进本机 `app.asar`（细节见 [`ASAR-PATCHING.md`](ASAR-PATCHING.md)），
偏移 15286309、614 → 614 字节、归档字节数与头部一字未动、备份
`app.asar.bak-style-ledger-20261010`。

**升级注意**：DSH 升级会覆盖 `app.asar`，本补丁需要用
`dsh-asar-patcher` 的 `plan → splice` 重打（`plan` 在产物已变时会明确报"旧内容找不到"）。

## 六、验证记录（2026-10-10）

| 环节 | 方法 | 结果 |
|---|---|---|
| 插件侧修复 | Node + 极简 DOM 跑旧/新产物，复刻账本语义 | 修复前 10/10 无归属、10/10 被别的插件认领；修复后 0/10、0/10 |
| DSH 侧补丁语义 | 抽出补丁前后的 `claimStyles`，在 Node + 最小 DOM 上对照 | 原版认领手写注入与无属性标签；补丁后只认领 `data-plugin-css`，其余不动 |
| 补丁写入 | `asar-splice`：等长校验 + 唯一性校验 + 写后读回逐字节复核 | `patched`，复核一致，sha256 `b630ec6a…` |
| 归档完整性 | `info` 自检 + 头/邻居不变断言 | 121348951 字节不变、头与其它条目逐字节不变、12967 条目不缺 |
| 幂等 | 用 `plan` 重跑同一补丁 | `oldMissing: true` + `newAlreadyPresent: true` → `already` |
| 插件侧护栏测试 | `dsh-memory-evolve/tests/client-style-owner.test.js` | 5 例；退回旧产物必失败 |
| 工具库回归 | `dsh-asar-patcher/tests/asar.test.js` | 6 例全绿 |
