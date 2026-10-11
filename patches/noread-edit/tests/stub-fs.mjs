// 供被 esm 单测直接加载的最小 FsError（与 @deepseek-ai/dsh-fs 的形态一致：message + code + cause）。
export class FsError extends Error {
  constructor(message, code, options) {
    super(message, options)
    this.code = code
  }
}
