// 安全错误：只带错误码和固定文案，绝不夹带 launch 输出、票据或子进程 stderr。
export const TEXT = {
  runtime_unsupported: "当前 Bun 版本不能保证请求绕过环境代理，已拒绝发送。请让 Magpie 使用 Bun 1.4.3 或更高版本（MAGPIE_BUN）",
  not_configured: "未配置宿主机 opclauded：请设置插件选项 opclauded 与 opusHome，或重新登录并按提示填写",
  path_invalid: "opclauded 路径无效：必须是绝对路径",
  home_invalid: "OpusClaude home 无效：必须是绝对路径",
  option_invalid: "插件选项格式无效：opclauded、opusHome、proxyHome、opclaudedSha256 须为字符串",
  sha256_invalid: "opclaudedSha256 无效：须为 64 位小写十六进制",
  proxy_home_invalid: "proxyHome 无效：必须是绝对路径（插件选项 proxyHome 或宿主环境的 OPCLAUDE_PROXY_HOME）",
  binary_missing: "找不到 opclauded 可执行文件",
  binary_not_regular: "opclauded 不是普通文件（不接受目录），已拒绝执行",
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
  launcher_not_found: "找不到官方 opclaude 启动器：请按官方方式安装 OpusClaude（~/.local/bin/opclaude 或 /usr/local/bin/opclaude）",
  launcher_invalid: "opclaude 启动器的内容无法识别（OPCLAUDED_BIN / OPCLAUDED_SHA256 缺失、重复或格式异常），已拒绝使用。请重新运行官方安装命令",
  launcher_home_mismatch: "opclaude 启动器选定的 opclauded 不在当前的 OpusClaude home（OPUSCLAUDE_HOME，默认 ~/.opusclaude）的 opclauded/<版本>/ 之下，已拒绝执行",
  launcher_untrusted: "opclaude 启动器与当前 OpusClaude 安装对不上（与 config 记录的摘要不符），已拒绝运行。请重新运行官方安装命令",
  host_path_untrusted: "宿主机上 opclaude、Claude Code 或 OpusClaude 安装所在的目录能被其他用户改动（属主或权限不受信任），已拒绝运行。请修复该目录的属主与权限后重试",
  proxy_disabled: "OpusClaude 本机代理未启用（直连安装，或宿主环境设置了 OPUSCLAUDE_PROXY=0）。启用本机代理后即可使用",
  legacy_incomplete: "旧的显式配置不完整：opclauded 与 opusHome 必须同时给出（此时才可带 opclaudedSha256），否则请全部留空改用自动发现",
  version_failed: "无法运行 opclaude version 读取宿主机 Claude Code 版本。请确认 opclaude 能正常使用",
  version_timeout: "opclaude version 超时，未能读到宿主机 Claude Code 版本",
  version_aborted: "读取宿主机 Claude Code 版本已取消",
  version_output_invalid: "opclaude version 的输出超过上限，已拒绝使用",
  version_unknown: "读不到宿主机 Claude Code 的实际版本（未找到或格式无法识别），已拒绝发送。请运行 opclaude version 检查",
  account_unavailable: "暂时查不到 OpusClaude 套餐状态（账号查询未成功），可稍后重试或运行 opclaude status 查看",
  account_failed: "OpusClaude 套餐状态查询失败，可稍后重试或运行 opclaude status 查看",
  account_timeout: "OpusClaude 套餐状态查询超时，可稍后重试",
  account_aborted: "OpusClaude 套餐状态查询已取消",
  account_output_invalid: "OpusClaude 套餐状态输出无法识别，协议可能已变化",
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
