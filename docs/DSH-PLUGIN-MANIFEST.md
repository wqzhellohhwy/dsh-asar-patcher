# DSH 插件清单：为什么插件的卡片会显示「异常」且没有描述

> 2026-10-10 定位。适用于 DSH 0.2.0-rc.2。**一句话**：`package.json` 里少了
> `dsh.bundle.patch`（+ 对应的 `cordis.patch.yml`），插件就只是 profile 的
> 「幽灵 entry」—— 列表里看得见，但没有元数据，设置页把它标成异常。

## 症状

设置 → 插件里，某个插件的卡片：

- 名字后面挂着红色 **异常** 标签；
- **没有任何描述文字**（其它插件都有）；
- 开关在、能点，插件本身其实也在工作（它的工具/命令能用）。

## 机制

1. profile 的 `package.json` 里 `dsh.profile.bundles: ["my-plugin", …]` 让 DSH 加载该包；
2. 但"以标准插件身份装配"靠的是**包自己的组合包层声明** —— `package.json` 的
   `dsh.bundle.patch` 指向的 patch 文件（`cordis.patch.yml`）。DSH 按序应用它，
   于是插件得到一条正常的 Loader 行：出现在插件列表、启停入口、内置清单里，
   并且**能取到包元数据**（标题/描述）。
3. 没声明 `dsh.bundle.patch` 时，这条行不存在 —— 插件只以"幽灵 entry"的形态
   被引用，于是：
   - 清单读取方拿不到 `meta`（`title`/`description`），卡片没描述；
   - 卡片把它当作异常状态渲染。

链路（0.2.0-rc.2，可直接对照源码）：

| 环节 | 位置 |
|---|---|
| 清单读取 | `dsh-host-plugin-inventory/lib/index.js`：`meta = packages?.metaOf(entry.options.name, base)` |
| 卡片描述 | `dsh-client-ui-settings-plugin-inventory/lib/client.js`：`description: row.meta?.description === void 0 ? void 0 : resolveText(row.meta.description) \|\| void 0` |
| 异常标签 | 同文件：`TAG_TONES = { …, failed: "danger" }` / `StateTag` |

## 正确的最小写法

`package.json`：

```jsonc
{
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "插件卡片的描述就来自这里，别省。",
  "private": true,
  "type": "module",
  "main": "./lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./package.json": "./package.json"
  },
  "engines": { "node": ">=20" },
  "dsh": {
    "manifestVersion": 1,
    "bundle": { "patch": "./cordis.patch.yml" },   // ← 关键：缺它 = 幽灵 entry
    "engines": { "dsh": ">=0.2.0-rc.1" }
  }
}
```

`cordis.patch.yml`：

```yaml
# 该包在 profile 组合里的一层 patch：id 全 profile 唯一；name 必须等于包名。
- insert:
    - id: my-plugin
      name: 'my-plugin'
      config: {}
```

**只有宿主半侧的插件**（例如本仓库这种只注册工具的插件）**不要**声明 `dsh.client`；
有浏览器半侧的插件再加 `dsh.client: { platform: 'web', inject: [...], external: [...] }`。

## 验收（不必重启 DSH）

本仓库带一个清单验收脚本，可对**任意插件目录**跑：

```bash
node scripts/check-manifest.mjs                       # 检查本包
node scripts/check-manifest.mjs --root <插件目录>      # 检查别的插件
```

它按 DSH 装配真正会用到的字段逐条核对：`name`/`version`/`description` 非空、
`main` 与 `exports`/`bin` 指向的文件存在、**`dsh` 字段与 `dsh.bundle.patch` 已声明**、
patch 文件存在且其中的 `name` 与包名一致、`files` 白名单路径存在。

三种场景都实测过（这就是验收标准）：

| 场景 | 结果 |
|---|---|
| 本仓库（修复后） | 22 项全绿 |
| `dsh-focus-guard`（正常第三方插件） | 13 项全绿 |
| 同一份代码**去掉 `dsh` 字段** | 精确报红：`✖ dsh 字段存在（缺失即幽灵 entry）`、`✖ dsh.bundle.patch 已声明` |

最后一条是关键：它复现了本次「卡片异常 + 无描述」的判据，因此不需要靠"重启后看一眼"来验收。
