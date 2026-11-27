# opclaude-plugin

给 Magpie 用的 provider 插件。它让 Magpie 经**宿主机上已登录的 OpusClaude**调用 Claude 模型。OpusClaude 与 Magpie 运行在同一台主机、同一个系统用户下时，插件走 OpusClaude 的本机代理。另一台机器上的 Magpie 可以通过 Remote magpie 使用它（见「从另一台机器使用」）。

- provider ID：`opclaude`。Magpie 里显示为 `OpusClaude（本机代理）`
- 协议：原生 Anthropic Messages
- 模型在 Magpie 里写作 `opclaude/<模型 ID>`，例如 `opclaude/claude-fable-5-2`

装好 OpusClaude 之后不需要填任何路径：插件自己找到官方的 `opclaude` 启动器，从它那里读出 `opclauded` 的位置和指纹，再用启动器的 `opclaude version` 读出宿主机 Claude Code 的实际版本。发往本机代理的请求一律自称这个宿主机版本。

本插件的实现依据是 OpusClaude 官方安装脚本 <https://claude.opusapi.xyz/install.sh> 里的 `opclaude` 启动器。OpusClaude 没有面向第三方的正式 SDK，下面的行为属于按安装脚本实现的内部契约。OpusClaude 或 opclauded 升级后，请重新运行「验证」里的命令，确认仍然通过。

## 工作方式

### 找到宿主机上的 OpusClaude（默认）

插件与 OpusClaude 由同一个系统用户运行，所以默认什么路径都不用配。Magpie 以同一个用户启动时，每次调用按下面的顺序确定运行态：

1. **找启动器。** 依次看 `~/.local/bin/opclaude` 和 `/usr/local/bin/opclaude`，用第一份通过全部校验的。启动器必须是普通文件。
2. **读启动器里的两个定值。** `OPCLAUDED_BIN` 是 opclauded 的绝对路径，`OPCLAUDED_SHA256` 是它的指纹。两个值都只按字面读取（只还原安装器写出的 `\\`、`\"`、`\$`、`` \` `` 四种转义），插件不执行也不 source 启动器。启动器里 `OPCLAUDED_BIN` 为空，说明安装时没有启用本机代理，插件报 `proxy_disabled`。
3. **核对位置。** 启动器选定的 opclauded 必须就是当前安装里的那一份：取它的物理路径，要求相对确认的物理 OpusClaude home 逐级是 `opclauded/<版本>/opclauded`。home 取 `OPUSCLAUDE_HOME`，没有设置时是 `~/.opusclaude`。中间任何一级是符号链接、指向别处，或者被普通文件占住，都拒绝（`launcher_home_mismatch` 或 `binary_missing`），不会改用别的版本。确认后的物理 home 也会用于读 `config`、定位工具与传给子进程，避免软链与 `..` 折叠前后不一致。

   路径按原本的写法从根逐级、逐分量核对到终点，与内核解析路径的方式一致：相对符号链接目标从链接父目录逐分量解析（不提前折叠 `..`），符号链接每跳一次，链接所在的目录、目标路径上的每一级目录都要过下一节的属主与权限要求；遇到 `..` 退回上一物理目录时同步撤销已离开的私有祖先保护，只看最终的物理路径或单调累加保护都不够。
4. **把启动器绑定到这个安装，并先确认它不受信任之外的人改动。** 安装器把成品启动器的摘要记在确认物理 `<home>/config`（权限 600）的 `LAUNCHER_SHA` 里，而启动器自己的 `version` 子命令在它的自校验之前就退出了，所以由插件来做。启动器只打开一次（不跟随符号链接，非阻塞打开），大小、属主和全部字节都取自同一个文件描述符。启动器或 `config` 的位置上是 FIFO、设备文件这类非普通文件时，按损坏或不受信任处理，不会卡在打开上。之后逐项核对：
   - 启动器、它所在的目录、OpusClaude home、`config`，以及它们路径上的每一级目录：属主只能是 root 或当前用户，并且不能被组或其他用户改动。唯一的例外是 root 所有的带 sticky 位的目录（`/tmp` 这一类），别的用户在那里删不掉也换不了条目。有一处不符合就是 `host_path_untrusted`。
   - 启动器字节的摘要等于同一安装的 `config` 所记的 `LAUNCHER_SHA`，否则是 `launcher_untrusted`。

   用户目录那份被改动时改看 `/usr/local/bin` 那份，后者要过同样的校验。插件只从 `config` 里取 `LAUNCHER_SHA` 这一行：`config` 按字节分块扫描，只把以 `LAUNCHER_SHA=` 开头的那一行解码，存着登录凭据的其余各行不会被读成文本，也不输出。
5. **读宿主机 Claude Code 的版本。** 运行启动器的 `opclaude version`，从 `Claude Code：<版本>` 一行取实际版本，只取这一行里“推荐”之前的版本号。执行的是上一步核对过摘要的那些字节，不再读一次启动器文件，所以定位之后启动器被升级或改动都影响不到这一次运行；下一次请求重新定位、重新核对。官方启动器有 150 KB 以上，超过 Linux 单个参数 131072 字节的上限，所以既不放命令行也不写临时文件：字节直接通过标准输入交给绝对路径 `/bin/sh -s -- version`，不依赖 `TMPDIR` 的可写或可执行权限，也不受运行中 `TMPDIR` 只读阻断。插件只用最小环境（`HOME`、`LANG`、`LC_ALL`、`TMPDIR`、`PATH`）运行这一个子命令，不联网，不运行 `status`、`update` 或交互模式。工作目录固定为根目录。启动器连带要做的事也在运行之前核对：
   - **选哪一份 `claude`。** 启动器按固定顺序挑第一份可执行的 `claude`：`~/.local/bin`、`~/.claude/local`、`/opt/homebrew/bin`、`/usr/local/bin`，然后是 `PATH` 上第一个命中的，再是 `~/.local/share/claude/versions/<启动器钉死的版本>`、`~/.npm-global/bin`、`npm` 所在的目录。插件按同一顺序找出这一份，核对它本身（含链接目标）和它路径上的每一级目录，属主与权限要求和上面一样，否则是 `host_path_untrusted`，启动器不会被运行。没被选中的位置不核对：升级留下的失效链接、旧副本不影响使用。
   - **`PATH` 的先后与缺省处理。** 宿主未设置 `PATH` 时，从最小环境的实际 `/bin/sh` 确定默认搜索路径并做同样的信任检查；显式设置 `PATH=""` 时保持为空，不补默认路径。交给启动器的 `PATH` 只有其中受信任的绝对路径项，保持原有先后，启动器自己把 `~/.local/bin` 放到最前（这个目录必须受信任）。插件不补任何额外目录：宿主 `PATH` 里没有的目录，官方启动器也不会去那里找 `claude`，补进来会让官方不会选的那一份被选中、发出错误的版本。`PATH=/usr/bin:/bin:/usr/sbin:/sbin` 这样的系统目录路径照常可用。
   - **哪些目录不进 `PATH`。** 空项、`.`、相对项、不受信任的目录，以及 Magpie 的当前项目目录及其子目录都去掉（仓库里的文件可以自带可执行位）。当前目录就是 `HOME` 或 `HOME` 的上级时不排除任何东西，否则从 `HOME` 启动会把 `~/.nvm` 这类安装目录一并排除。
   - **启动器会用到的工具。** 按启动器实际执行的两段 `PATH` 核对，每段都是那一段上第一个命中的文件：前置 `~/.local/bin` 之前用的是宿主 `PATH` 上的 `tr`、`mkdir`；之后是 `sed`（读这个安装的 `config`）、`head`、`grep`、`basename`、`dirname`。有一份别的用户能改动就是 `host_path_untrusted`，启动器不会被运行。

   启动器连同它拉起的 `claude --version` 在独立的进程组里，超时、取消或输出超限时整组结束。读不到版本时拒绝发送（`version_unknown`），请求、`count_tokens` 与模型发现三条出站路径都一样。
6. **取运行态。** 运行 `opclauded launch --home <确认的物理 OpusClaude home> --min-protocol 1`，从输出里取当前代理地址、票据和设备 ID。第 5、6 步同时进行。执行的 opclauded 不是安装里的那个路径（它在核对之后可能被升级或修复换掉），而是核对过内容的绑定副本：第 3 步从一个文件描述符核对属主、权限和指纹，再把同一个描述符里的字节复制到本用户已验可信、可执行的稳定私有位置（首选 `<确认物理 OpusClaude home>/.plugin-bin-<uid>/<指纹>/opclauded/<版本>/opclauded`，与安装程序同一可执行文件系统，不依赖 `TMPDIR` 的执行权限；不可写或不可执行时再尝试经过同样物理祖先与权限验证的 `~/.cache/opclaude-plugin-bin-<uid>` 或按用户命名的临时目录，绝不以未核对的安装路径兜底）。副本在同目录独立暂存写完并核对摘要及可执行位后通过硬链接原子无覆盖发布，竞争者核对现有成品并复用，不覆盖已在运行的正确副本。macOS、Linux、二进制、脚本走的都是这一条路，执行的就是核对过的字节。程序自己的位置（`argv[0]`、所在目录）是这个副本，安装目录以 `--home` 给出。旧的显式配置不经过这里，见下文。

插件不猜测版本号最高的目录，也不在登录时把路径或指纹存下来。OpusClaude 升级之后，下一次请求按新的启动器重新发现，不需要重新登录。

### 宿主环境里的两个官方变量

| 变量 | 插件的行为 |
| --- | --- |
| `OPUSCLAUDE_HOME` | 非默认位置安装的 home。启动器选定的 opclauded 必须在它之下 |
| `OPUSCLAUDE_PROXY=0` | 宿主明确关闭了官方本机代理。插件报 `proxy_disabled`，不改用别的运行态 |
| `OPCLAUDE_PROXY_HOME` | 代理状态目录。优先级：旧的显式 `proxyHome` > 这个变量 > 不传（opclauded 用它自己的默认值）。只把校验过的绝对路径交给 `opclauded launch`；不是绝对路径时报 `proxy_home_invalid` |

这两个设置只认 Magpie 进程自己的环境。请求方给不了。

### 发往本机代理的请求

每次调用和每次模型发现，插件都运行宿主机的 `opclauded launch`（见上），请求只发往这次 launch 给出的本机回环地址（`http://127.0.0.1:18827`–`18836`）。

- 转发的请求是 `POST /v1/messages`（含流式 SSE 与工具事件）和 `POST /v1/messages/count_tokens`
- 发往代理的请求头固定为 `User-Agent: claude-cli/<宿主机 Claude Code 版本> (external, cli)` 和 `X-App: cli`。请求方自带的 `User-Agent` 和 `X-App` 会先去掉，所以另一台机器上较旧或较新的 Claude Code 不影响发往代理的身份。生成请求、`count_tokens` 和模型发现（`GET /v1/models`）这三条出站路径用的是同一套请求头；读不到宿主机版本时三条路径都不发送。正文原样转发
- 发往代理的鉴权头是 `Authorization: Bearer <票据>` 和 `X-OpusClaude-Device: <设备 ID>`。Magpie 自己的鉴权头，以及请求方自带的 `X-OpusClaude-Device`，都会先去掉再按当次运行态设置
- 上游 `~/.opusclaude/config` 里的登录凭据由 opclauded 自己管理，插件只使用 launch 交给它的本机票据
- 票据只留在当次请求的内存里。日志、错误信息、响应和 Magpie 的登录记录里都没有它
- 上游返回错误时，插件保留状态码和重试相关的头，正文里的敏感头和票据会被换成固定的 Anthropic 错误

线路切换、重新授权、代理换端口之后都能直接继续使用，每个请求都会重新解析运行态。

OpusClaude 后台按这个请求头如何记录或展示请求，只能在真实的订阅上确认，目前还没有验证（见「已知范围」）。

### 套餐与周额度（Magpie 的「用量」）

插件实现了 Magpie 自己的 `auth.usage` 钩子，所以 Magpie「用量」页里 OpusClaude 账号的额度卡片和 `magpie quota opclaude` 会显示：

- 套餐名（`plan_name`）
- 「本周额度」窗口的已用百分比（`weekly_pct`）。剩余由 Magpie 按已用算出，不是插件给出的
- 套餐本周不限额度时（`weekly_unlimited`），窗口写的是「本周额度不限」，不给百分比。Magpie 0.1.4936 把这种只带 `display` 的窗口当文字窗口显示（`--json` 里标 `text: true`）；它在 `--json` 里同时补了 `used: 0` / `remaining: 100`，这是 Magpie 对文字窗口的统一处理，不是插件给出的读数

数据来源只有一个：宿主机官方 `opclaude status` 查套餐时用的同一条命令，即 `opclauded account`（不带参数），读它标准输出上的 JSON。依据是官方安装脚本的 `oc_plan_json` / `oc_plan_print`。插件只读上面三个字段和 `ok`，不读钱包余额、到期时间，也不读 `message`。不需要填写任何新的凭据或选项。

剩余百分比按 Magpie 的原生口径查看，各处显示的不一样：

| 在哪里看 | 显示什么 |
| --- | --- |
| `magpie quota opclaude`（普通文本） | 套餐名和每个窗口的已用，取整到整数百分比，例如「本周额度 42%」。不列剩余 |
| `magpie quota opclaude --json`、网关的 `GET /v1/magpie/quotas` | 每个窗口的 `used` 和 Magpie 推得的 `remaining`，例如 `42.5` 与 `57.5` |
| Magpie「用量」页的账号卡片 | 默认是 Used（已用）；切到 Left 显示剩余 |

| 情况 | Magpie 里看到的 |
| --- | --- |
| `weekly_pct` 是数字或数字字符串（含 `0`） | 套餐名，本周已用 N%；剩余为 100−N%，在 `--json`、额度 API 与页面的 Left 里查看 |
| `weekly_unlimited` 为真 | 套餐名，「本周额度不限」 |
| 有套餐名，但 `weekly_pct` 缺失或不是数字 | 只有套餐名。不填 0%，也不显示剩余 |
| `ok` 为 `false`、命令退出码非零、超时、输出不是合法 JSON，或找不到宿主机安装 | 卡片上一句固定提示（见下表的 `account_*`），没有额度窗口。账号仍是已登录，请求照常可用 |

几点约定：

- **这个窗口只用于展示。** 插件把它标成 `aside: true`，Magpie 的路由不读它：即使显示已用 100%，Magpie 也不会因此停用账号或提前拦截请求，额度和余额续用由 OpusClaude 自己决定。Magpie 0.1.4936 的 `magpie quota --json` 和网关的 `GET /v1/magpie/quotas` 不回传 `aside` 字段，它在路由内部生效。
- **本周已用不是现金余额。** 插件不填写 `balance`，卡片上不要把它当作钱包余量。
- **和请求用同一个程序、同一份状态。** 查询执行的就是发请求时那一个 opclauded：默认流程下是启动器选定、核对过指纹的执行副本，旧的显式配置下是给出的那一个。代理状态目录与官方一致，默认流程和旧的显式配置走同一个优先级：插件选项里的 `proxyHome` > 宿主环境的 `OPCLAUDE_PROXY_HOME` > 不指定。不指定时，`launch` 不传这个变量（交给 opclauded 自己的默认值），`account` 按官方启动器的规则用 `<OpusClaude home>/proxy`。请求与额度查的是同一份状态：宿主环境或选项把代理目录指到别处时，两条路径一起改读那一处。这个 home 和请求路径用的是同一个确认过的物理目录：旧的显式 `opusHome` 里即使有符号链接后接 `..`，也按文件系统实际解析到的安装来取，不会落到另一个安装的状态目录。环境同样最小（`HOME`、`LANG`、`LC_ALL`、`TMPDIR`、`PATH`），不交出任何 `ANTHROPIC_*` 凭据，12 秒内有界。
- **Magpie 保留上一次读到的套餐名。** 查询失败时卡片上可能仍是上次的套餐名，旁边是这次的提示。
- 宿主进程设了 `OPUSCLAUDE_PROXY=0` 时和请求一样报 `proxy_disabled`。还没登录时不去探测宿主机。

公开的安装脚本没有给出可用的重置时刻，所以窗口不带重置时间；`days_left` 只是近似天数，插件不采用。

## 前置条件

1. 已按官方方式装好 OpusClaude，`opclaude` 能正常使用，本机代理处于开启状态。安装后 `opclaude version` 能在 `Claude Code：` 一行里显示版本号。显示“未找到”时，先把 Claude Code 装到 `opclaude` 能找到的位置。
2. Magpie 与 OpusClaude 由同一个系统用户运行。OpusClaude 装在别的用户或别的 home 下时，请用下面「旧的显式配置」的方式给出路径。
3. OpusClaude 装在非默认位置时，给 Magpie 进程设置 `OPUSCLAUDE_HOME`。插件和启动器都认这个变量。
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

登录不再询问任何 OpusClaude 的路径、密钥或版本。Magpie 0.1.4777 仍然要求登录时给它一个非空的密钥行（空行或直接结束输入都会被它自己拒绝），输入任意内容（例如 `1`）回车即可。插件随后按上面的默认流程找到 OpusClaude，真实运行一次 `opclauded launch` 做校验。代理模式、回环地址、有效票据都满足时登录成功，Magpie 里只保存一个固定的本地标记 `opclaude-local-proxy`，这个标记不会发往任何地方。路径和指纹都不保存。校验不通过时，登录失败并给出带错误码的原因，例如 `[opclaude:sha256_mismatch]`。

### 旧的显式配置（兼容）

早期版本要求填写 `opclauded` 路径和 OpusClaude home。这些设置原样保留，已经填过的安装不用改动：

```sh
magpie plugin options /path/to/opclaude-plugin '{"opclauded":"/Users/<用户>/.opusclaude/opclauded/<版本>/opclauded","opusHome":"/Users/<用户>/.opusclaude"}'
```

| 设置 | 必填 | 说明 |
| --- | --- | --- |
| `opclauded` | 与 `opusHome` 同时给出 | 可执行文件的绝对路径。它必须是普通文件，并且可执行 |
| `opusHome` | 与 `opclauded` 同时给出 | OpusClaude home 的绝对路径 |
| `opclaudedSha256` | 否 | 给出后，执行前先核对文件指纹 |
| `proxyHome` | 否 | 作为 `OPCLAUDE_PROXY_HOME` 传给 opclauded，优先于宿主环境里的同名变量。默认流程下不需要 |

`opclauded` 和 `opusHome` 按项取值，与早期版本一致：以前登录时保存的值优先于插件选项里的同名值，没有保存的项取插件选项。两项都有来源时按显式路径执行，两项都没有时走自动发现。

| 来源 | 早期版本登录时填过 | 现在 |
| --- | --- | --- |
| 插件选项两项都空 | 用登录时保存的一对 | 自动发现。重新登录后不再保存路径 |
| 插件选项给出完整的一对 | 插件选项补足没保存的项 | 按给出的一对执行 |
| 只有一项有值（任何来源） | 拒绝：`legacy_incomplete` | 拒绝：`legacy_incomplete`，不拿自动发现的值来补 |

显式配置生效时，插件只运行给出的那一个 opclauded，不使用启动器选定的程序和指纹，两者不会混在一起。宿主机 Claude Code 的版本仍然通过启动器的 `opclaude version` 读取，所以启动器仍然必须存在。

`opclaudedSha256` 只能在成对时附带，否则同样报 `legacy_incomplete`。

想改用默认流程时，清空插件选项并重新登录。重新登录后不再保存路径，下一次请求起走自动发现：

```sh
magpie plugin options /path/to/opclaude-plugin 'off'
magpie plugin login opclaude
```

## 从另一台机器使用

插件装在运行 OpusClaude 的那台机器上（下称「主机」）。另一台机器（下称「本地」）的 Magpie 通过 Remote magpie 调用它。两台机器在同一局域网内。

在主机上：

1. 添加并登录本插件，步骤同上一节。
2. 在 Magpie 的 Settings → Network and sharing 里打开 Share on local network。
3. 创建一个 Gateway Key，并记下主机的局域网 IP：

```sh
magpie gateway-key add "Laptop"
```

在本地，打开 Providers，添加 **Remote magpie** 并填写主机的共享地址和 Gateway Key。若希望用 CLI 并指定远端 ID，可先在当前 shell 设置 `REMOTE_MAGPIE_URL` 和 `REMOTE_MAGPIE_KEY`，再执行以下命令（第二、三条命令在 Magpie 0.1.4777 的两套隔离实例之间验证过，地址是回环地址）。

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
| `launcher_not_found` | 在 `~/.local/bin/opclaude` 和 `/usr/local/bin/opclaude` 都找不到官方启动器。按官方方式安装 OpusClaude |
| `launcher_invalid` | 启动器的内容无法识别（`OPCLAUDED_BIN` 或 `OPCLAUDED_SHA256` 缺失或格式异常），已拒绝使用。重新运行官方安装命令 |
| `launcher_home_mismatch` | 启动器选定的 opclauded 不是当前 OpusClaude home 里 `opclauded/<版本>/opclauded` 那一份（中间有符号链接指向别处，或 home 的位置不是目录）。检查 `OPUSCLAUDE_HOME`，或重新运行官方安装命令 |
| `launcher_untrusted` | 启动器与当前安装对不上：启动器字节的摘要不等于 `<home>/config` 记的 `LAUNCHER_SHA`。通常是启动器装好后被改过，或安装用的是较早的版本、`config` 里还没有 `LAUNCHER_SHA`。重新运行官方安装命令 |
| `host_path_untrusted` | 宿主机上启动器、`config`、OpusClaude home、Claude Code 候选位置（如 `~/.local/bin` 及其中的 `claude`）或它们路径上的某一级目录，属主不是 root 或当前用户，或者能被组或其他用户改动。在运行任何东西之前拒绝。修复方法见下方“目录权限” |
| `proxy_disabled` | 本机代理未启用：启动器安装时没有启用，或 Magpie 进程的环境里设了 `OPUSCLAUDE_PROXY=0`。启用后即可使用 |
| `version_failed`、`version_timeout`、`version_aborted` | `opclaude version` 没能运行完、10 秒内没有结束，或者请求已被取消。请确认 `opclaude version` 能正常输出 |
| `version_output_invalid` | `opclaude version` 的输出超过 64 KiB，已拒绝使用 |
| `version_unknown` | `opclaude version` 没有给出宿主机 Claude Code 的版本号（显示“未找到”或格式无法识别），已拒绝发送 |
| `legacy_incomplete` | 旧的显式配置只填了一半，或没有成对就带了指纹。补全或全部清空 |
| `not_configured`、`path_invalid`、`home_invalid` | 显式配置的 `opclauded` 路径或 home 不是绝对路径 |
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
| `account_unavailable`、`account_failed`、`account_timeout`、`account_aborted`、`account_output_invalid` | 只影响「用量」里的周额度显示：`opclauded account` 报告未成功、退出码非零、超时、被取消或输出无法识别。卡片上是一句固定提示，不影响请求，账号也不会被标成需要重新登录。定位宿主机时的错误（如 `launcher_not_found`、`proxy_disabled`）同样只显示为提示 |

`auth.usage` 的失败只在额度卡片上显示，不进入请求路径。

本机代理返回 401 时，插件附带 `X-Magpie-Sign-In: kept`。票据问题在 OpusClaude 一侧处理，Magpie 的登录状态保持不变。

## 验证

全部验证都使用假的 `opclauded`、本机回环上的模拟代理和模拟票据。三条命令都需要 Bun 1.4.3 或更高版本：

```sh
export MAGPIE_BUN="$HOME/.cache/magpie/bun/1.4.5/magpie-bun"
"$MAGPIE_BUN" test
"$MAGPIE_BUN" scripts/check.mjs
MAGPIE_BUN="$MAGPIE_BUN" python3 scripts/e2e-magpie.py
```

- `test`：周额度加入之前 macOS 159 个用例 / Linux 160 个用例（含 Linux `/proc/<pid>/exe` 实进程检查，其中使用自有 157426 字节等尺寸离线夹具测试两阶段 `PATH`、候选顺序与 `PATH` 缺省/显式为空，并通过沙箱路径注入控制固定系统 Claude 候选），覆盖启动器的静态解析（含官方四种转义）与默认发现、启动器与所属安装的绑定、目录属主与权限的逐级核对与 `prot` 栈出栈、只执行核对过的字节与原子无覆盖复用、确认物理位置、`OPUSCLAUDE_HOME` 与两个官方代理变量、宿主机版本经 `stdin` 读取的只读 `TMPDIR` 兼容与整组清理、固定临时名被占用时多路并发原子收敛到同一回退根、定位失败不外传原始异常、三条出站路径的身份头、旧配置兼容（含非默认的显式 home），以及 launch 输出解析与协议校验、可执行文件校验、请求转发、`Request` 与 `init` 的原生合并、设备头、成功与失败响应的脱敏、失败响应的期限、模型发现的期限与大小上限、请求取消、SSE 工具事件拼接、401 处理、端点白名单与跳转、环境代理零命中、端口并发、Bun 版本守卫（含预发布版本），以及周额度（`test/account.test.mjs`，23 个用例：`account-status` JSON 的解析、已用 0 与不限套餐、缺失与非数字不填 0、`ok:false` / 非零退出 / 超时 / 非法输出的固定文案、自动发现与旧的显式路径、`proxyHome` 的取舍、代理禁用与未登录、带 `LC_ALL` 与不带 `LC_ALL` 的最小环境、显式 home 含符号链接后接 `..` 时的双账号回归（A 为 42.5%、B 为 95%：先确认折叠出的目录确实读到 B，再确认插件读到 A；宿主环境把请求与额度一起指向 B，选项再覆盖回 A）。加上周额度后 macOS 上是 182 个用例；Linux 上还没有重跑。
- `scripts/verify-official-template.mjs` 按 SHA-256（`4371431b202dd47cce643ecade756f3524af55e123e55262431edff3db642be7`）核验外部官方启动器模板并用模拟安装对照。下方的断网容器分别验证固定系统位置为空和有已知 Claude 替身两种情况。
- `scripts/check.mjs`：按 Magpie 加载插件的方式从目录加载，逐个检查各个钩子，包括 `auth.usage`。整个检查在空的 `HOME` 下运行，不看这台机器上真实的 OpusClaude 安装；没有安装时，请求返回 `launcher_not_found`。
- `scripts/e2e-magpie.py`：用本机的 Magpie CLI 与网关做端到端验证，86 项检查。它需要 `MAGPIE_BUN` 指向兼容的 Bun，默认使用 macOS 应用内的 Magpie CLI（其他安装方式用 `MAGPIE_BIN` 指定）。

用更早的 Bun 运行时，这三条命令都会直接说明需要 Bun 1.4.3 或更高版本，然后以非零状态退出。

同一套 `test` 还要在 Linux（4 KiB 页）上跑一遍：官方启动器的实际大小在 Linux 上超过单个参数的上限，macOS 复现不了。在 `debian:bookworm-slim` 容器里以普通用户运行（工作树只读挂载，`/tmp` 是 root 所有的 sticky 目录）：

```sh
docker run --rm -v "$PWD":/w:ro -v "$HOME/.cache/linux-bun":/bun:ro debian:bookworm-slim bash -c \
  'useradd -m -u 1000 tester; su tester -c "cd /w && /bun/bun test"'
```

`/bun/bun` 是 Linux 版的 Bun 1.4.5。2026 年 11 月在 `bun-linux-aarch64` 1.4.5 上 160 个用例全部通过，退出码 0；完整大小的启动器（157 KB）经标准输入交给 `/bin/sh -s -- version` 读出版本 2.1.284，而同样内容作为单个命令行参数交给 `sh` 会得到 `E2BIG`。另在 `/tmp` 挂载为 `0555` 只读（`TMPDIR=/tmp`）以及 `/tmp` 挂载为 `noexec`、安装目录可执行的容器中复验零配置登录、请求、绑定副本冷启动、并发无覆盖复用与官方 `stop` 均通过。

### 完整官方启动器对照

在项目目录中执行以下命令。将 `LINUX_BUN_DIR` 指向包含 Linux 版 `bun` 的目录，将 `OPCLAUDE_INSTALL_SH` 指向已下载的官方安装脚本。两次运行分别断言选中 PATH 里的 2.1.300 和固定位置的 2.1.100。

```sh
(
  set -eu
  : "${LINUX_BUN_DIR:?指定包含 Linux 版 bun 的目录}"
  : "${OPCLAUDE_INSTALL_SH:?指定已下载的官方安装脚本}"
  fixture_dir=$(mktemp -d)
  trap 'rm -f "$fixture_dir/claude"; rmdir "$fixture_dir"' EXIT
  chmod 755 "$fixture_dir"
  printf '%s\n' '#!/usr/bin/env sh' '[ "$1" = "--version" ] && echo "2.1.100 (Claude Code)"' > "$fixture_dir/claude"
  chmod 755 "$fixture_dir/claude"

  verify_template() {
    docker run --rm --network none --read-only --user 1000:1000 \
      --tmpfs /tmp:rw,exec,mode=1777 \
      --tmpfs /home/tester:rw,uid=1000,gid=1000,mode=0755 \
      -e HOME=/home/tester -w /w \
      -v "$PWD:/w:ro" -v "$LINUX_BUN_DIR:/bun:ro" \
      -v "$OPCLAUDE_INSTALL_SH:/upstream-install.sh:ro" "$@" \
      debian:bookworm-slim /bun/bun scripts/verify-official-template.mjs --install-sh /upstream-install.sh
  }

  verify_template
  verify_template -e OPCLAUDE_VERIFY_FIXED_CLAUDE=1 \
    -v "$fixture_dir/claude:/usr/local/bin/claude:ro"
)
```

`e2e-magpie.py` 的隔离方式：

- 每次运行用新的临时目录，里面有独立的 `HOME` 与 `XDG_*` 目录，端口都是当时空闲的回环端口，结束后清理进程
- 临时目录的 `bin` 放在测试 `PATH` 的首位，里面的 `security` 和 `secret-tool` 是无操作的替身。Magpie 子进程对钥匙串的调用会被它们接住，不会落到系统的钥匙串工具上
- 沙箱里的进程都被告知一个环境代理探针。发往回环地址的请求一次也不能经过它。脚本自己连回环地址时不走代理，所以运行脚本的父进程设置了不可达的 `HTTP_PROXY`、`NO_PROXY` 为空时，全部检查照样跑完

`e2e-magpie.py` 起两套互相隔离的 Magpie。主机那套装了本插件和一套模拟安装：仿官方的 `opclaude` 启动器、假的 `claude`、假的 `opclauded`。另一套不装插件，经 Remote magpie 调用主机，相当于另一台机器。两个模拟客户端的自称版本（2.1.100 与 2.1.90）都与主机不同。

`e2e-magpie.py` 在 Magpie 0.1.4936 上 86 项检查全部通过，2026 年 11 月在 0.1.4938 上重跑也通过（原有的 68 项在 Magpie 0.1.4781 上通过；加上周额度与普通文本 CLI 的断言后在 0.1.4936、0.1.4938 上通过）。0.1.4938 上四次运行中有一次，原有的「旧的显式配置成对时可用」一项返回 404（网关一时不认识模型），紧接着重跑两次都通过，这一项与周额度无关，原因没有查清。结果如下：

- 不设任何插件选项即可登录。登录不询问路径、密钥或版本，Magpie 的插件设置里只有插件目录
- `magpie models` 列出来自模拟代理的模型
- 网关的流式响应是真实的 SSE，`tool_use` 的参数完整到达，以 `message_stop` 结束，只产生一次生成请求
- 网关把 `count_tokens` 交给插件，模拟代理返回 `input_tokens: 98`
- 直连客户端的每一个生成类请求都带着主机的版本和 `X-App: cli`，客户端自己的版本没有到达代理
- 模型发现（`GET /v1/models`）到达模拟代理时带的也是主机的版本和 `X-App: cli`，与生成类请求一致
- 普通文本的 `magpie quota opclaude` 显示套餐与「本周额度 42%」（42.5 取整；Magpie 的普通文本只列已用）；`weekly_pct` 非数字时只有套餐，没有额度窗口行
- `magpie quota opclaude --json` 和网关的 `GET /v1/magpie/quotas` 显示套餐与「本周额度」已用 42.5%、剩余 57.5%（剩余由 Magpie 按 used 算出）。查询执行的是核对过的执行副本，不带参数，代理状态目录是 `<home>/proxy`。零用量（数字字符串 `"0"`）显示已用 0%、剩余 100%；不限套餐显示「本周额度不限」而没有百分比；`weekly_pct` 非数字时只有套餐名
- `opclauded account` 退出码非零、`ok:false`、输出不是 JSON 时，`magpie quota` 给出对应的固定提示和空的窗口，输出里没有模拟的密钥、状态目录路径或沙箱 home；账号仍是 `signed in`，下一条请求照常成功
- 宿主环境设了 `OPCLAUDE_PROXY_HOME` 时，请求与周额度都从同一个代理状态目录读取；旧的显式配置成对时，周额度经显式给出的那个 opclauded 读取，代理目录的取舍（选项 > 宿主环境 > 默认）与默认流程相同
- 宿主机升级（假的 `claude` 改报新版本）后，不重新登录，下一条请求即成功，请求头跟着变成新版本
- 另一套 Magpie 经 Remote magpie 列出 `office/opclaude/…` 模型并发送成功。它的请求和 `count_tokens` 到达代理时带的仍是主机的版本。客户端版本不同，代理上看到的都只是主机当时的版本
- 读不到宿主机版本时报 `version_unknown`，恢复后下一条请求成功
- 安装目录里的 opclauded 被换掉、与启动器记的指纹不符时报 `sha256_mismatch`，登录也被拒绝。程序恢复后下一条请求成功
- 模拟安装的 `config`（权限 600）里记着启动器的摘要。启动器装好后被改动时报 `launcher_untrusted`，登录也被拒绝，错误里没有安装路径和 `config` 的内容。启动器恢复后下一条请求成功
- Magpie 进程的环境里设了 `OPUSCLAUDE_PROXY=0` 时，登录与请求都报 `proxy_disabled`，模拟代理零次生成请求。环境恢复后下一条请求成功
- Magpie 进程的环境里设了 `OPCLAUDE_PROXY_HOME` 时，请求照常成功，只有 opclauded 收到它，启动器和 `claude` 的环境里没有它。不设时 opclauded 收到的是空值
- `~/.local/bin/claude` 变成所有人可写时报 `host_path_untrusted`，启动器和 `claude` 都没有运行，模拟代理零次生成请求。权限修复后下一条请求成功
- 旧的显式配置只填一半时，登录与请求都报 `legacy_incomplete`。成对时照旧可用，清空后回到自动发现
- direct 模式、不兼容的协议、白名单外的地址、代理未运行这四种情况下，调用方立刻收到带固定错误码的 Anthropic 错误，模拟代理零次生成请求，恢复后下一条请求成功
- 回显票据的上游错误不会到达调用方，状态码保留。网关与模拟代理的日志里没有任何模拟密钥
- 假的 `claude` 只被以 `--version` 调用过，启动器从未被要求交互式启动 Claude Code
- 钥匙串工具解析到替身，发往回环地址的请求没有经过环境代理

选择 HTTP 400 的依据来自同一版本的实测：网关把 4xx 立即交给调用方，对 5xx 会先把同一账号重试约 33 秒。

## 目录权限

插件在运行任何东西之前逐级核对属主与权限，判断的只有一件事：别的用户能不能换掉这一项。规则如下，覆盖启动器、`<home>/config`、OpusClaude home、opclauded、启动器实际会执行的那份 `claude`、它用到的每个工具，以及它们路径上的每一级（含符号链接每一跳经过的目录）：

- 属主必须是 root 或当前用户；其他用户可写（`o+w`）一律拒绝。
- root 所有的带 sticky 位的目录（例如 `/tmp`）可以接受：别的用户删不掉、换不了里面已有的条目。
- 组可写分三种情况：
  - 上面有一级别的用户进不来的私有目录（`chmod go-x`，比如 `0700` 的用户目录，或其中组只有受信任的用户）：可以接受，组可写的东西别的用户根本够不着。
  - 这个组里只有受信任的用户：可以接受。目前只认 Linux 的用户私有组约定，并且要查得到才算：`/etc/group` 里这个组与本用户同名、没有并列成员，`/etc/passwd` 里也没有别的用户以它为主组。它是不是本用户的主组本身不算证明。
  - 其余情况（macOS 的 `staff`、`admin`，查不到的组）都当作共享组：拒绝。

所以 Linux 上常见的“用户主组、目录 `0775`”在私有用户目录里可以照常使用，不用改权限。被拒绝时报 `host_path_untrusted`，修复示例：

```sh
chmod go-w ~/.local ~/.local/bin ~/.local/bin/opclaude ~/.local/bin/claude ~/.opusclaude ~/.opusclaude/config
```

不想改权限时，把 Claude Code 装到用户目录（`~/.local/bin`）并确保它不是组可写的即可；只有 `chmod go-w` 之后的目录才够。

## 已知范围

以下几项还没有在真实环境里验证，升级 OpusClaude 后也需要复验：

- 真实的 OpusClaude 订阅与真实 opclauded。目前所有结果都来自模拟安装与模拟代理，没有读取过任何真实的 OpusClaude 配置或令牌
- 真实安装写出的 `opclaude` 启动器、`config` 里的 `LAUNCHER_SHA` 和 `opclaude version` 的输出。解析规则依据的是官方安装脚本的文本。较早的安装没有 `LAUNCHER_SHA`，重新运行官方安装命令会补上
- 真实安装的目录权限是否都能通过逐级核对（见上一节“目录权限”）。macOS 上本地用户都在 `staff` 组，不在 `/etc/group` 里，一律当作共享组；`/opt/homebrew` 下有些目录被设成 `admin` 组可写或所有人可写，这时装在 `/opt/homebrew/bin/claude` 的 Claude Code 会被拒绝
- 真实的 opclauded 以内容绑定副本运行之后的行为。副本保留了文件名与 `opclauded/<版本>/opclauded` 的层级，安装目录经 `--home` 给出；如果真实的程序或它拉起的守护进程要按自己的位置找安装里的其他文件（而不是按 `--home`），需要部署时确认。目前只在模拟程序上验证过（`--home` 照常收到，按位置往上两级能找到以指纹命名的那一级）
- 真实安装里的 `claude`、`npm` 与辅助工具的形态。官方启动器全文已在断网的 Linux 容器和 macOS 上用模拟安装对照过（`PATH` 命中、钉死的版本文件、`npm` 目录三种候选，官方与插件选出同一份），真实的 Claude Code 可执行文件还没有试过
- 绑定副本目录 `<OpusClaude home>/.plugin-bin-<uid>/`（或经验证的按用户回退目录）按内容寻址累积，插件不清理旧指纹的副本（运行中的程序可能还在用）；升级后可手动删除已不再使用的旧指纹子目录
- OpusClaude 后台是否按 `claude-cli/<宿主机版本> (external, cli)` 与 `X-App: cli` 记录请求。插件能保证的只是发往本机代理的请求头，后台的展示属于部署验收项
- 真实安装的 `opclaude version` 会在 OpusClaude home 下建 `claude-env` 目录。它不联网，但这是一次写入
- 真实机器之间跨网络的 Remote magpie 链路（验证用的是同一台机器上的两套隔离 Magpie，回环地址）
- `/v1/models` 的返回格式。已确认的只有 `data[].id`。`display_name` 和 `name` 是可选的兼容字段，插件读到时用作显示名。上下文长度、输出上限等能力字段尚未确认，所以插件不填写这些元数据
- 真实 `opclauded account` 的行为。周额度的字段依据是官方安装脚本的 `oc_plan_json` / `oc_plan_print`（`plan_name`、`weekly_pct`、`weekly_unlimited`、`ok`、`days_left`），只在按它写的模拟程序上验证过。插件按官方的调用方式不带参数，并把 `OPCLAUDE_PROXY_HOME` 设为显式值或 `<home>/proxy`；真实程序以内容绑定副本运行时能否据此找到现有代理的状态，还没有在真实安装上确认。真实输出若带有脚本没有展示的字段，插件也不会读取
- 宿主机对 `127.0.0.1` 设置了代理时，需确认 `NO_PROXY` 放行回环地址

本仓库不包含部署、推送或发布步骤。
