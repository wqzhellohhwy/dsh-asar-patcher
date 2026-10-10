# dsh-asar-patcher

给 **DeepSeek Harness 桌面版**打补丁的标准工具：定位 `app.asar`、读源码、做**等长原地替换**、备份与还原。
零依赖核心库 + DSH 插件（模型可直接调用 `asar_*` 工具）+ CLI，三态同一套实现。

```text
npm test                         # 6 例回归（含"替换只动目标条目"的边界断言）
node bin/dsh-asar.mjs info       # 定位归档 + 结构自检 + 备份列表
```

---

## 为什么需要它

DSH 桌面版把整个 Host 实现打包在 `resources/app.asar` 里，其中
`dsh/node_modules/@deepseek-ai/**` 是**保留了注释的可读 JS**（rolldown/tsdown 产物）。
要想修 DSH 自身的行为（而不是插件行为），只能改这个归档。

asar 的布局是 `[16 字节头][JSON 索引][数据区]`，数据区里每个文件按 `offset` 连续排布。
**任何改变文件长度的修改**都会推动其后所有文件的 offset、并让 JSON 索引与数据区起点
一起变化 —— 那等于重写一遍打包器。反过来，只要新旧内容**字节数完全相同**，
就可以直接写到数据区的对应位置：文件内偏移、归档头（size/offset/integrity）、
数据区起点**全部不动**。

本库把这条路做成有护栏的标准动作，而不是每次现写脚本。

## 装成 DSH 插件（可选，但推荐）

```jsonc
// ~/.dsh/profiles/<profile>/package.json
{
  "dependencies": { "dsh-asar-patcher": "link:C:/Users/<you>/dsh-plugins/dsh-asar-patcher" },
  "dsh": { "profile": { "bundles": ["dsh-asar-patcher"] } }
}
```

装好后模型会拿到这六个工具（`lib/tools.js`）：

| 工具 | 作用 |
|---|---|
| `asar_info` | 定位归档 + 结构自检（条目数、数据区起点、体积一致性）+ 列出备份 |
| `asar_entries` | 列条目；给了 `search` 就返回**字符串命中的文件内/绝对偏移** |
| `asar_read` | 读条目片段，或整段导出到文件 |
| `asar_splice` | **等长原地替换**：默认干运行，`write:true` 才落盘（落盘前备份、落盘后读回逐字节复核） |
| `asar_backup` | 手动备份为 `<asar>.<tag>`（同名不覆盖） |
| `asar_restore` | 用备份还原（还原前把当前内容另存为 `<asar>.pre-restore-<时间戳>`） |

插件配置（cordis 行 `config`，都可选）：

```yaml
- id: asar-patcher
  name: dsh-asar-patcher
  config:
    defaultAsar: C:/Users/you/AppData/Local/Programs/DeepSeek Harness/resources/app.asar
    allowWrite: true     # false = 只读：splice(write) 与 restore 一律拒绝
```

## CLI

```text
node bin/dsh-asar.mjs info                                  归档自检 + 备份列表
node bin/dsh-asar.mjs list [片段] [--limit N]               列条目
node bin/dsh-asar.mjs find <片段> <字符串>                   搜索（返回文件内/绝对偏移 + 上下文）
node bin/dsh-asar.mjs read <片段> [--out 文件] [--offset N --length N]
node bin/dsh-asar.mjs plan <片段> --old <文件> --new <文件>   干运行：只给计划与问题列表
node bin/dsh-asar.mjs splice <片段> --old <文件> --new <文件> [--write] [--tag X]
node bin/dsh-asar.mjs backup [tag] | restore <tag>
```

通用参数：`--asar <path>`，或环境变量 `DSH_ASAR`；都不给时按平台常见安装位置探测。

## 等长替换的硬约束（重要）

`plan` / `asar_splice` 会拒绝以下情况，并说明原因：

- 新旧内容**字节数不等** → 报差值与方向；
- 旧内容在目标条目里**找不到**（产物已变）或**出现多次**（定位不唯一，需把替换区扩大到含上下文）；
- 目标条目 `unpacked`（内容在 `app.asar.unpacked` 下，不走原地替换）。

**新内容更长时怎么办**：把替换区**向外扩大**，把相邻的注释、空白、或同函数里可压缩的
等价写法一起纳入，用它们抵消字节差。实例见 [`docs/ASAR-PATCHING.md`](docs/ASAR-PATCHING.md)
（`claimStyles` 补丁：把上方说明注释缩短，腾出的字节正好容纳新增的 CSS 属性选择器，
最终 614 → 614 字节，偏移 15286309，归档头一字未动）。

## 风险与回退

- 写入前**自动备份**（`<asar>.bak-asar-patcher-<时间戳>`）；已有 `<tag>` 不覆盖；
- 写入后**读回逐字节复核**（预期 = 原内容 + 替换片段），不一致立刻报告；
- 被拒绝的补丁**不落盘**（测试里有断言）；
- 还原：`asar_restore <tag>`（还原前先留 `pre-restore` 存档，可再退）；
- 改完**必须重启 DSH**才生效（运行中的进程已把旧代码读进内存）；
- 改了 `*.js` 补丁后，至少做一次 `node --check`（把条目 `read --out` 出来再检查语法）。

## 目录

```text
lib/asar.js      核心：定位/头解析/条目读写/等长 splice/备份/还原/自检（零依赖）
lib/tools.js     六个工具定义（模型面）
lib/index.js     Cordis 插件入口（注册工具）
bin/dsh-asar.mjs CLI
tests/asar.test.js  6 例回归：含"只动目标条目、头与其它条目逐字节不变"的边界断言
docs/ASAR-PATCHING.md    方法论 + 本次实例（含偏移/长度/校验全过程）
docs/DSH-STYLE-LEDGER.md DSH 客户端样式账本机制（"整页变裸控件"的根因与两侧修复）
```

## 历史工具对照

本机此前几次改 `app.asar` 的脚本，能力已被本库吸收并加护栏：

| 既有脚本 | 现状 |
|---|---|
| `C:/repository/dsh-projectless/tools/dsh-composer-gate/asar-patch.mjs` | 等长 splice + 备份/还原的思路来源；本库改为"文件对文件 + 写后复核" |
| `C:/repository/dsh-projectless/tools/dsh-composer-gate/dsh-asar.mjs` | 定位与头解析原语；本库把 `baseOffset` 与 pickle 字段关系写成 `openArchive` |
| `C:/repository/dsh-session-title-command-title-fix/asar-read.js` | 只读探测；本库的 `list` / `read` / `find` 覆盖 |
| `C:/repository/dsh-redteam-mode/scripts/asar-read.mjs` | 同上 |
| `C:/repository/codex-skip-connectivity-check/work/asar_*.js` | 早期解包脚本；本库不做"整包重打包"路线（等长替换不需要） |

## 许可

MIT。
