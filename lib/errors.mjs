// 安全错误：只带错误码和固定文案，绝不夹带 launch 输出、票据或子进程 stderr。
export const TEXT = {
  runtime_unsupported: "当前 Bun 版本不能保证请求绕过环境代理，已拒绝发送。请让 Magpie 使用 Bun 1.4.3 或更高版本（MAGPIE_BUN）",
  not_configured: "未配置宿主机 opclauded：请设置插件选项 opclauded 与 opusHome，或重新登录并按提示填写",
  path_invalid: "opclauded 路径无效：必须是绝对路径",
  home_invalid: "OpusClaude home 无效：必须是绝对路径",
  option_invalid: "插件选项格式无效：opclauded、opusHome、proxyHome、opclaudedSha256 须为字符串",
  sha256_invalid: "opclaudedSha256 无效：须为 64 位小写十六进制",
  proxy_home_invalid: "proxyHome 无效：必须是绝对路径",
  binary_missing: "找不到 opclauded 可执行文件",
  binary_not_regular: "opclauded 不是普通文件（不接受符号链接或目录），已拒绝执行",
  binary_not_executable: "opclauded 不可执行",
  binary_unreadable: "opclauded 无法读取，已拒绝执行",
  sha256_mismatch: "opclauded 与 opclaudedSha256 不符，已拒绝执行",
  launch_timeout: "opclauded launch 超时",
  launch_aborted: "opclauded launch 已取消",
  install_busy: "OpusClaude 正在更新，请稍后重试",
  txn_recovery_failed: "OpusClaude 上次更新未完成，请重新运行其安装命令",
  config_invalid: "OpusClaude 配置异常，请重新运行 opclaude 修复",
  gateway_untrusted: "OpusClaude 配置中的服务地址不受信任，请重新运行 opclaude 修复",
  launch_failed: "opclauded launch 失败。退出码异常，可能是版本或协议不匹配",
  protocol_mismatch: "opclauded 声明的代理协议与本插件不兼容，已拒绝。升级后需复验",
  launch_output_invalid: "opclauded launch 输出无法识别。协议可能已变化，已拒绝使用",
  mode_direct: "opclauded 当前处于 direct 直连公网模式，已拒绝。请先运行 opclaude 修复本机代理",
  mode_unsupported: "opclauded 返回了不支持的运行模式，已拒绝",
  base_url_rejected: "opclauded 返回的代理地址不是允许的本机回环地址，已拒绝",
  credential_invalid: "opclauded 返回的票据格式无效，已拒绝",
  target_rejected: "请求目标不是本插件声明的本机回环端点，已拒绝",
  proxy_unreachable: "本机 opclauded 代理不可达。代理未运行、连接被拒或连接超时，不会退回公网",
  redirect_refused: "本机代理返回了 HTTP 跳转，已拒绝跟随",
  models_failed: "本机代理 /v1/models 请求失败",
  models_invalid: "本机代理 /v1/models 返回的内容无法识别",
}

export class SafeError extends Error {
  constructor(code, detail = "") {
    super(`[opclaude:${code}] ${TEXT[code] ?? "未知错误"}${detail}`, { cause: undefined })
    this.name = "OpclaudeError"
    this.code = code
  }
}

export function isSafeError(e) {
  return !!e && typeof e === "object" && e.name === "OpclaudeError" && typeof e.code === "string"
}
