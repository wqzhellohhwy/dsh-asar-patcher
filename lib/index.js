/**
 * dsh-asar-patcher — DSH 插件入口。
 *
 * 装上之后，模型会拿到一组 `asar_*` 工具：定位/自检 app.asar、列条目、搜字符串、
 * 读片段、**等长原地替换**、备份与还原。把「改 DSH 本体」这件事从"每次现写脚本"
 * 变成有护栏的标准动作。
 *
 * 配置（cordis 行 config，全部可选）：
 *   - `defaultAsar`：默认归档路径（缺省自动探测各平台安装位置 / 环境变量 DSH_ASAR）
 *   - `allowWrite`：false 时只读（asar_splice 的 write=true 与 asar_restore 一律拒绝）
 *
 * 安全默认：`asar_splice` 不带 `write: true` 时**只干运行**；写入前自动备份、
 * 写入后读回逐字节复核；还原工具会把当前内容另存为 `pre-restore-<时间戳>`。
 *
 * @module dsh-asar-patcher
 */
import { buildTools } from './tools.js'

/** Cordis 插件名。 */
export const name = 'asar-patcher'

/** 依赖 tools 服务（只注册工具，不注册任何模型可见的上下文）。 */
export const inject = ['tools']

/**
 * 注册全部 asar 工具。
 * @param {import('cordis').Context} ctx - 宿主上下文。
 * @param {{defaultAsar?: string, allowWrite?: boolean}} [config] - 插件配置。
 */
export function apply(ctx, config = {}) {
  for (const tool of buildTools(config)) {
    ctx.effect(() => ctx.tools.register(tool), `asar-patcher: ${tool.name}`)
  }
}

export { buildTools } from './tools.js'
