# opclaude-plugin

给 Magpie 用的 provider 插件。它让 Magpie 经**宿主机上已登录的 OpusClaude**调用 Claude 模型。OpusClaude 与 Magpie 运行在同一台主机、同一个系统用户下时，插件走 OpusClaude 的本机代理。另一台机器上的 Magpie 可以通过 Remote magpie 使用它（见「从另一台机器使用」）。

- provider ID：`opclaude`。Magpie 里显示为 `OpusClaude（本机代理）`
- 协议：原生 Anthropic Messages
- 模型在 Magpie 里写作 `opclaude/<模型 ID>`，例如 `opclaude/claude-fable-5-2`

本插件的实现依据是 OpusClaude 官方安装脚本 <https://claude.opusapi.xyz/install.sh> 里的 `opclaude` 启动器。OpusClaude 没有面向第三方的正式 SDK，下面的行为属于按安装脚本实现的内部契约。OpusClaude 或 opclauded 升级后，请重新运行「验证」里的命令，确认仍然通过。

## 工作方式

每次调用和每次模型发现，插件都运行宿主机的 `opclauded launch --home <OpusClaude home> --min-protocol 1`，从输出里取当前代理地址、票据和设备 ID。请求只发往这次 launch 给出的本机回环地址（`http://127.0.0.1:18827`–`18836`）。

- 转发的请求是 `POST /v1/messages`（含流式 SSE 与工具事件）和 `POST /v1/messages/count_tokens`
- 发往代理的鉴权头是 `Authorization: Bearer <票据>` 和 `X-OpusClaude-Device: <设备 ID>`。Magpie 自己的鉴权头，以及请求方自带的 `X-OpusClaude-Device`，都会先去掉再按当次运行态设置
- 上游 `~/.opusclaude/config` 里的登录凭据由 opclauded 自己管理，插件只使用 launch 交给它的本机票据
- 票据只留在当次请求的内存里。日志、错误信息、响应和 Magpie 的登录记录里都没有它
- 上游返回错误时，插件保留状态码和重试相关的头，正文里的敏感头和票据会被换成固定的 Anthropic 错误

线路切换、重新授权、代理换端口之后都能直接继续使用，每个请求都会重新解析运行态。

## 前置条件

1. 已按官方方式装好 OpusClaude，`opclaude` 能正常使用，本机代理处于开启状态。
2. 知道两个绝对路径。一个是 `opclauded` 可执行文件，通常在 `~/.opusclaude/opclauded/<版本>/opclauded`。另一个是 OpusClaude home，默认是 `~/.opusclaude`。
3. Magpie 与 OpusClaude 由同一个系统用户运行。
4. Magpie 的插件宿主使用 Bun 1.4.3 或更高版本。插件的请求只走本机回环，票据不能经过环境里配置的 HTTP 代理，而 `fetch` 的 `proxy: false` 从 Bun 1.4.3 正式版起才生效（见 [Bun 1.4.3 发布说明](https://bun.com/blog/release-notes/bun-v1.4.3)）。低于 1.4.3 的预发布版本（例如 1.4.3-canary.1）同样不接受。宿主是更早的版本时，插件在发送任何票据之前拒绝工作，登录与每次请求都会返回 `[opclaude:runtime_unsupported]`。Magpie 0.1.4749 默认下载的是 Bun 1.4.2，请把 `MAGPIE_BUN` 指向兼容的 Bun（例如 `~/.cache/magpie/bun/1.4.5/magpie-bun`），或者升级到自带兼容 Bun 的 Magpie：

```sh
export MAGPIE_BUN="$HOME/.cache/magpie/bun/1.4.5/magpie-bun"
magpie plugin
```

## 添加并登录

```sh
magpie plugin add /path/to/opclaude-plugin
magpie plugin login opclaude
magpie plugin
magpie models
```

`magpie plugin login opclaude` 会询问 `opclauded` 路径和 OpusClaude home，然后真实运行一次 `opclauded launch` 做校验。代理模式、回环地址、有效票据都满足时登录成功，Magpie 里保存一个固定的本地标记 `opclaude-local-proxy`，这个标记不会发往任何地方。校验不通过时，登录失败并给出带错误码的原因，例如 `[opclaude:sha256_mismatch]`。

以后再次登录时，已经保存的选项直接生效，对应的路径不再询问。

路径也可以用插件选项保存。对从目录添加的插件，使用 `magpie plugin add` 时填写的目录作为标识。选项已给出的路径在登录时直接校验。

```sh
magpie plugin options /path/to/opclaude-plugin '{"opclauded":"/Users/<用户>/.opusclaude/opclauded/<版本>/opclauded","opusHome":"/Users/<用户>/.opusclaude","opclaudedSha256":"<64 位小写十六进制>"}'
```

| 选项 | 必填 | 说明 |
| --- | --- | --- |
| `opclauded` | 是，也可在登录时填写 | 可执行文件的绝对路径。它必须是普通文件，并且可执行 |
| `opusHome` | 是，也可在登录时填写 | OpusClaude home 的绝对路径 |
| `opclaudedSha256` | 否 | 给出后，执行前先核对文件指纹 |
| `proxyHome` | 否 | 作为 `OPCLAUDE_PROXY_HOME` 传给 opclauded |

## 从另一台机器使用

插件装在运行 OpusClaude 的那台机器上（下称「主机」）。另一台机器（下称「本地」）的 Magpie 通过 Remote magpie 调用它。两台机器在同一局域网内。

在主机上：

1. 添加并登录本插件，步骤同上一节。
2. 在 Magpie 的 Settings → Network and sharing 里打开 Share on local network。
3. 创建一个 Gateway Key，并记下主机的局域网 IP：

```sh
magpie gateway-key add "Laptop"
```

在本地，打开 Providers，添加 **Remote magpie** 并填写主机的共享地址和 Gateway Key。若希望用 CLI 并指定远端 ID，可先在当前 shell 设置 `REMOTE_MAGPIE_URL` 和 `REMOTE_MAGPIE_KEY`，再执行以下命令。

```sh
magpie provider add remote-magpie "$REMOTE_MAGPIE_KEY" "url=$REMOTE_MAGPIE_URL" id=office
magpie models claude
magpie claude office/opclaude/claude-fable-5-2
magpie claude run
```

Remote magpie 上的模型带远端名字前缀，这里是 `office/`。把 `office` 换成你在 `id=` 里填的名字，把 `claude-fable-5-2` 换成 `magpie models claude` 列出的模型。`magpie claude default` 可以恢复 Claude Code 原来的模型选择。

## 出错时

错误形如 `[opclaude:<错误码>] …`，只含错误码和固定文案。调用方会立刻收到它（HTTP 400 的 Anthropic 错误对象），不会生成请求，也不会退回公网。修好原因后，下一条请求照常工作。

| 错误码 | 含义 |
| --- | --- |
| `runtime_unsupported` | Magpie 的插件宿主用的 Bun 低于 1.4.3，插件已拒绝发送。设置 `MAGPIE_BUN` 指向兼容的 Bun |
| `not_configured`、`path_invalid`、`home_invalid` | 还没有给出 `opclauded` 路径或 home，或者不是绝对路径 |
| `option_invalid`、`sha256_invalid`、`proxy_home_invalid` | 插件选项的格式不对 |
| `binary_missing`、`binary_not_regular`、`binary_not_executable`、`binary_unreadable`、`sha256_mismatch` | 可执行文件校验未通过，opclauded 没有运行 |
| `launch_timeout`、`launch_aborted`、`launch_failed`、`launch_output_invalid` | `opclauded launch` 没有给出可用结果 |
| `protocol_mismatch` | opclauded 声明的代理协议与本插件不兼容 |
| `install_busy`、`txn_recovery_failed`、`config_invalid`、`gateway_untrusted` | OpusClaude 正在更新，或配置需要修复 |
| `mode_direct` | opclauded 处于 direct 直连公网模式。运行 `opclaude` 修复本机代理后即可使用 |
| `base_url_rejected`、`credential_invalid`、`target_rejected` | launch 给出的地址或票据不符合约定，或者请求的目标不是本插件的端点 |
| `proxy_unreachable`、`redirect_refused` | 本机代理连不上，或者返回了跳转 |
| `upstream_error` | 本机代理返回了错误，正文换成了固定文案。状态码和重试信息保留。正文带着票据或设备 ID、不是可识别的 JSON 错误、超过 64 KiB，或者 10 秒内读不完时，都会换成它 |
| `models_failed`、`models_invalid` | `/v1/models` 失败或内容无法识别，Magpie 继续使用已有的模型清单 |

本机代理返回 401 时，插件附带 `X-Magpie-Sign-In: kept`。票据问题在 OpusClaude 一侧处理，Magpie 的登录状态保持不变。

## 验证

全部验证都使用假的 `opclauded`、本机回环上的模拟代理和模拟票据。三条命令都需要 Bun 1.4.3 或更高版本：

```sh
export MAGPIE_BUN="$HOME/.cache/magpie/bun/1.4.5/magpie-bun"
"$MAGPIE_BUN" test
"$MAGPIE_BUN" scripts/check.mjs
MAGPIE_BUN="$MAGPIE_BUN" python3 scripts/e2e-magpie.py
```

- `test`：57 个用例，覆盖 launch 输出解析与协议校验、可执行文件校验、请求转发、`Request` 与 `init` 的原生合并、设备头、成功与失败响应的脱敏、失败响应的期限、模型发现的期限与大小上限、请求取消、SSE 工具事件拼接、401 处理、端点白名单与跳转、环境代理零命中、端口并发、Bun 版本守卫（含预发布版本）。
- `scripts/check.mjs`：按 Magpie 加载插件的方式从目录加载，逐个检查各个钩子。
- `scripts/e2e-magpie.py`：用本机的 Magpie CLI 与网关做端到端验证。它需要 `MAGPIE_BUN` 指向兼容的 Bun，默认使用 macOS 应用内的 Magpie CLI（其他安装方式用 `MAGPIE_BIN` 指定）。

用更早的 Bun 运行时，这三条命令都会直接说明需要 Bun 1.4.3 或更高版本，然后以非零状态退出。

`e2e-magpie.py` 的隔离方式：

- 每次运行用新的临时目录，里面有独立的 `HOME` 与 `XDG_*` 目录，端口都是当时空闲的回环端口，结束后清理进程
- 临时目录的 `bin` 放在测试 `PATH` 的首位，里面的 `security` 和 `secret-tool` 是无操作的替身。Magpie 子进程对钥匙串的调用会被它们接住，不会落到系统的钥匙串工具上
- 沙箱里的进程都被告知一个环境代理探针。发往回环地址的请求一次也不能经过它。脚本自己连回环地址时不走代理，所以运行脚本的父进程设置了不可达的 `HTTP_PROXY`、`NO_PROXY` 为空时，33 项检查照样跑完

`e2e-magpie.py` 在 Magpie 0.1.4749 上 33 项检查全部通过，结果如下：

- 插件选项给出路径后，登录不再询问路径
- 指纹不符时登录被拒绝，期间模拟代理零次生成请求
- `magpie models` 列出来自模拟代理的模型
- 网关的流式响应是真实的 SSE，`tool_use` 的参数完整到达，以 `message_stop` 结束，只产生一次生成请求
- 网关把 `count_tokens` 交给插件，模拟代理返回 `input_tokens: 98`
- direct 模式、不兼容的协议、白名单外的地址、代理未运行这四种情况下，调用方在 2 秒内收到带固定错误码的 Anthropic 错误，模拟代理零次生成请求，恢复后下一条请求成功
- 回显票据的上游错误不会到达调用方，网关日志里没有票据
- 钥匙串工具解析到替身，发往回环地址的请求没有经过环境代理

选择 HTTP 400 的依据来自同一版本的实测：网关把 4xx 立即交给调用方，对 5xx 会先把同一账号重试约 33 秒。

## 已知范围

以下几项还没有在真实环境里验证，升级 OpusClaude 后也需要复验：

- 真实的 OpusClaude 订阅与真实 opclauded。目前所有结果都来自模拟代理
- 跨机器的 Remote magpie 链路
- `/v1/models` 的返回格式。已确认的只有 `data[].id`。`display_name` 和 `name` 是可选的兼容字段，插件读到时用作显示名。上下文长度、输出上限等能力字段尚未确认，所以插件不填写这些元数据
- `opclauded account` 的输出格式，因此插件没有实现用量显示
- 宿主机对 `127.0.0.1` 设置了代理时，需确认 `NO_PROXY` 放行回环地址

本仓库不包含部署、推送或发布步骤。
