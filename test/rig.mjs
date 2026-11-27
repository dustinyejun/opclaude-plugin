// 测试台：假的 opclauded（bash 脚本）+ 仿官方 opclaude 启动器 + 假的 claude + 本机回环 mock 代理。
// 只用模拟票据，不碰任何真实凭据。
//
// 目录布局对应真实安装（dir 充当“系统用户”的 home）：
//   <dir>/.opusclaude/opclauded/0.5.1-test/opclauded   假的 opclauded，启动器里写死的就是这个路径
//   <dir>/state/                                        运行态（mode / ticket / port / ccVersion …）
//   <userHome>/.local/bin/opclaude                      仿官方启动器，userHome 省略时就是 dir
//   <userHome>/.local/bin/claude                        假的 claude，--version 读 state/ccVersion
import { access, chmod, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { MIN_BUN, bunSupportsProxyFalse } from "../lib/transport.mjs"

// 插件要求 Bun >= 1.4.3（fetch 的 proxy: false 才生效）。旧版本下不跑用例，直接说明原因。
if (!bunSupportsProxyFalse()) {
  console.error(`需要 Bun >= ${MIN_BUN}，当前 ${Bun.version}。请用兼容的 Bun 运行，例如 MAGPIE_BUN=... && "$MAGPIE_BUN" test`)
  process.exit(2)
}

export const PROXY_PORTS = Array.from({ length: 10 }, (_, i) => 18827 + i)
export const OPCLOUDED_VERSION = "0.5.1-test"
export const DEFAULT_CC_VERSION = "2.1.284"

const FAKE = `#!/bin/bash
d="$(cd "$(dirname "$0")/../../.." && pwd)/state"
# 真正的 opclauded 以 --home 为准（插件运行的是它的内容绑定副本，位置不在安装里）；没有可用的 --home 时才按自己的位置往上找三级。
if [ "$2" = --home ] && [ -d "$3" ]; then d="$(cd "$3/.." && pwd)/state"; fi
# 自定位：从自己所在位置往上两级，与安装里 opclauded/<版本>/opclauded 的层次一致。
_oc_l="$(cd "$(dirname "$0")/../.." && pwd)"; printf '%s\n' "\${_oc_l##*/}" > "$d/launched-layout"
mode="$(cat "$d/mode" 2>/dev/null || echo proxy)"
# 套餐状态：与官方 oc_plan_json proxy 同一调用（opclauded account，无参数，状态目录在 OPCLAUDE_PROXY_HOME）。
# 插件运行的是内容绑定副本，位置不在安装里，所以运行态按代理状态目录往上两级找，找不到再按自己的位置往上三级。
if [ "$1" = account ]; then
  if [ -n "\${OPCLAUDE_PROXY_HOME:-}" ]; then
    _oc_p="\${OPCLAUDE_PROXY_HOME%/}"; _oc_p="$(dirname "$(dirname "$_oc_p")")"
    [ -f "$_oc_p/state/account" ] && d="$_oc_p/state"
  fi
  # 没有可用的状态目录时依次按自己的位置往上三级、按用户目录找（只为让故障注入有地方可记）。
  if [ ! -f "$d/account" ]; then
    _oc_b="$(cd "$(dirname "$0")/../../.." 2>/dev/null && pwd)" && [ -f "$_oc_b/state/account" ] && d="$_oc_b/state"
  fi
  if [ ! -f "$d/account" ]; then d="$HOME/state"; fi
  printf '%s\n' "$*" > "$d/account-args"
  printf '%s\n' "$0" > "$d/account-bin"
  printf '%s\n' "\${OPCLAUDE_PROXY_HOME:-}" > "$d/account-proxy-home"
  env | cut -d= -f1 | sort > "$d/account-env"
  a="$(cat "$d/account" 2>/dev/null)"
  case "$a" in
    hang) exec sleep 30;;
    fail) printf 'opclauded: account failed for /private/secret/state with sk-SECRETSTDERR123456\\n' >&2; exit 1;;
    invalid) printf 'not json: %s /private/secret/state sk-SECRETSTDOUT123456\\n' "$d";;
    none) exit 0;;
    empty) : ;;
    *) printf '%s\\n' "$a" ;;
  esac
  exit 0
fi
if [ "$1" != launch ] || [ "$2" != --home ] || [ "$4" != --min-protocol ] || [ "$5" != 1 ]; then
  printf 'usage\\n' >&2; exit 64
fi
printf '%s|%s|%s|%s\\n' "$2" "$3" "$4" "$5" > "$d/last-args"
printf '%s\\n' "$0" > "$d/launched-bin"
printf '%s\\n' "\${OPCLAUDE_PROXY_HOME:-}" > "$d/proxy-home"
env | cut -d= -f1 | sort > "$d/last-env"
printf '%s\\n' "$2 $3" > "$d/launch-home"
port="$(cat "$d/port")"
line() { printf '%s\\n' "$1"; }
case "$mode" in
  proxy)      printf "OC_RUN_MODE='proxy'\\nOC_BASE_URL='http://127.0.0.1:%s'\\nOC_CREDENTIAL='%s'\\nOC_DEVICE_ID='%s'\\nOC_PROXY_COMPONENT='opclauded-test'\\nOC_PROXY_PROTOCOL='1'\\n" "$port" "$(cat "$d/ticket")" "$(cat "$d/device" 2>/dev/null)";;
  direct)     printf "OC_RUN_MODE='direct'\\nOC_BASE_URL='https://api.opusapi.xyz'\\nOC_CREDENTIAL='sk-upstream-fake'\\n";;
  badport)    printf "OC_RUN_MODE='proxy'\\nOC_BASE_URL='http://127.0.0.1:18826'\\nOC_CREDENTIAL='t'\\n";;
  localhost)  printf "OC_RUN_MODE='proxy'\\nOC_BASE_URL='http://localhost:18827'\\nOC_CREDENTIAL='t'\\n";;
  public)     printf "OC_RUN_MODE='proxy'\\nOC_BASE_URL='https://evil.example'\\nOC_CREDENTIAL='t'\\n";;
  proto0)     printf "OC_RUN_MODE='proxy'\\nOC_BASE_URL='http://127.0.0.1:%s'\\nOC_CREDENTIAL='t'\\nOC_PROXY_PROTOCOL='0'\\n" "$port";;
  proto2x)    printf "OC_RUN_MODE='proxy'\\nOC_BASE_URL='http://127.0.0.1:%s'\\nOC_CREDENTIAL='t'\\nOC_PROXY_PROTOCOL='2x'\\n" "$port";;
  singlequote) printf "OC_RUN_MODE='proxy'\\nOC_BASE_URL='http://127.0.0.1:%s'\\nOC_CREDENTIAL='t'\\nOC_DEVICE_ID='\\n" "$port";;
  nodevice)   printf "OC_RUN_MODE='proxy'\\nOC_BASE_URL='http://127.0.0.1:%s'\\nOC_CREDENTIAL='%s'\\n" "$port" "$(cat "$d/ticket")";;
  escaped)    printf "OC_RUN_MODE='proxy'\\nOC_BASE_URL='http://127.0.0.1:%s'\\nOC_CREDENTIAL='a'\\\\''b'\\nOC_DEVICE_ID='dev'\\n" "$port";;
  garbage)    printf "OC_RUN_MODE=proxy\\nrm -rf /\\n";;
  inject)     printf "OC_RUN_MODE='proxy'\\nOC_BASE_URL='http://127.0.0.1:%s'\\nX='\$(id)'\\n" "$port";;
  dup)        printf "OC_RUN_MODE='direct'\\nOC_RUN_MODE='proxy'\\n";;
  crlf)       printf "OC_RUN_MODE='proxy'\\r\\n";;
  nocred)     printf "OC_RUN_MODE='proxy'\\nOC_BASE_URL='http://127.0.0.1:18827'\\n";;
  credctl)    printf "OC_RUN_MODE='proxy'\\nOC_BASE_URL='http://127.0.0.1:18827'\\nOC_CREDENTIAL='a\\tb'\\n";;
  other)      printf "OC_RUN_MODE='tunnel'\\n";;
  huge)       head -c 200000 /dev/zero | tr '\\0' 'x';;
  hang)       exec sleep 30;;
  busy)       printf 'opclauded: install_busy\\n' >&2; exit 75;;
  txn)        printf 'opclauded: txn_recovery_failed\\n' >&2; exit 70;;
  proto)      printf 'opclauded: protocol 0 not supported SECRET-STDERR-TICKET\\n' >&2; exit 1;;
  *)          exit 1;;
esac
`

// 每个 SSE 事件以空行结尾。mock 代理按批次发送，调用方可以在响应结束前读到完整事件。
export const SSE_BATCHES = [
  [
    'event: message_start\n',
    'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-test","content":[],"stop_reason":null,"usage":{"input_tokens":10,"output_tokens":1}}}\n\n',
  ],
  [
    'event: content_block_start\n',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_time","input":{}}}\n\n',
    'event: content_block_delta\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"tz\\":"}}\n\n',
  ],
  [
    'event: content_block_delta\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"Asia/Shanghai\\"}"}}\n\n',
    'event: content_block_stop\n',
    'data: {"type":"content_block_stop","index":0}\n\n',
  ],
  [
    'event: message_delta\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":12}}\n\n',
    'event: message_stop\n',
    'data: {"type":"message_stop"}\n\n',
  ],
]
const SSE = SSE_BATCHES.flat().join("")

// 仿官方启动器：只保留与发现、版本有关的段落，函数与安装脚本的启动器逐字相同，
// 版本行的格式也相同（"Claude Code：<实际版本>（推荐 <钉死版本>）"）。字面量写成双引号，与安装器一致。
const LAUNCHER_SOURCE = `#!/bin/sh
# OpusClaude 启动器（测试替身）：Claude Code 定位与版本函数同官方安装脚本。
set -eu
OPUS_DIR="\${OPUSCLAUDE_HOME:-$HOME/.opusclaude}"
CONFIG="$OPUS_DIR/config"
OPCLAUDED_BIN="__OPUSCLAUDE_PROXY_BIN__"
OPCLAUDED_SHA256="__OPUSCLAUDE_PROXY_SHA__"   # 装机时核对过的代理程序指纹；对不上就不执行它
CLAUDE_ENV_DIR="$OPUS_DIR/claude-env"   # opclaude 专属 Claude 配置根（CLAUDE_CONFIG_DIR）
mkdir -p "$CLAUDE_ENV_DIR" 2>/dev/null || true
export PATH="$HOME/.local/bin:\${PATH:-}"
CLAUDE_PIN="2.1.284"
oc_claude_candidates(){
  _oc_seen="|"
  _oc_npmd="$(command -v npm 2>/dev/null || true)"
  case "$_oc_npmd" in /*) _oc_npmd="\${_oc_npmd%/*}/claude" ;; *) _oc_npmd="" ;; esac
  for _p in \\
    "$HOME/.local/bin/claude" \\
    "$HOME/.claude/local/claude" \\
    "__OPUSCLAUDE_SYS_CLAUDE_1__" \\
    "__OPUSCLAUDE_SYS_CLAUDE_2__" \\
    "$(command -v claude 2>/dev/null || true)" \\
    "$HOME/.local/share/claude/versions/\${CLAUDE_PIN:-none}" \\
    "$HOME/.npm-global/bin/claude" \\
    "$_oc_npmd"
  do
    [ -n "$_p" ] || continue
    [ -x "$_p" ] || continue
    [ -f "$_p" ] || [ -L "$_p" ] || continue
    case "$_p" in */Claude.app/*) continue ;; esac
    case "$_oc_seen" in *"|$_p|"*) continue ;; esac
    _oc_seen="$_oc_seen$_p|"
    printf '%s\\n' "$_p"
  done
  return 0
}
resolve_claude_bin(){
  _oc_all="$(oc_claude_candidates)"
  [ -n "$_oc_all" ] || return 1
  printf '%s\\n' "$_oc_all" | sed -n '1p'
}
claude_version(){
  _oc_b="\${1:-}"
  [ -n "$_oc_b" ] || return 0
  "$_oc_b" --version </dev/null 2>/dev/null | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+' | head -1 || true
}
if [ "\${1:-}" = version ]; then
  { env | cut -d= -f1 | sort > "$OPUS_DIR/launcher-env"; } 2>/dev/null || true
  printf '%s\\n' "$PATH" > "$OPUS_DIR/launcher-path"
  printf '%s\\n' "$PWD" > "$OPUS_DIR/launcher-cwd"
  printf '%s\\n' "$0" > "$OPUS_DIR/launcher-argv0"
  printf '%s\\n' "\${OPUSCLAUDE_HOME:-}" > "$OPUS_DIR/launcher-home"
  printf 'OpusClaude 接入包：%s\\n' "20261120.1"
  _v_cc=$(claude_version "$(resolve_claude_bin || true)")
  printf 'Claude Code：%s（推荐 %s）\\n' "\${_v_cc:-未找到}" "$CLAUDE_PIN"
  if [ -n "$OPCLAUDED_BIN" ]; then
    printf '本地代理：opclauded %s\\n' "$(basename "$(dirname "$OPCLAUDED_BIN")")"
  else
    printf '本地代理：未启用（直连）\\n'
  fi
  exit 0
fi
printf 'interactive launch is not available in the test stand-in\\n' >&2
exit 1
`

// 假的 claude：--version 的输出形如官方的 "2.1.284 (Claude Code)"。实际版本取自 state/ccVersion，
// 所以“宿主升级”只需要改这个文件，启动器不用动。其它子命令（status / update / 交互启动）记录后报错。
// ccVersion 为 missing（或读不到）时直接失败、不输出：模拟“这份 claude 跑不起来”。
// hang：--version 一直不结束；late：--version 挂 2 秒后写出完成标记 claude-late（用来确认超时 / 取消之后它确实没再运行）。
// 每次 --version 都把工作目录记到 claude-cwd。
// 注意不要删掉这个文件：启动器的候选顺序后面是 /opt/homebrew/bin/claude、/usr/local/bin/claude 等真实位置。
const CLAUDE = `#!/bin/sh
d="__STATE__"
printf '%s\\n' "$*" >> "$d/claude-args"
printf '%s\\n' "$PWD" > "$d/claude-cwd"
printf '%s\\n' "$PATH" > "$d/claude-path"
env | cut -d= -f1 | sort > "$d/claude-env"
case "$*" in
  --version) v="$(cat "$d/ccVersion" 2>/dev/null)"; case "$v" in ""|missing) exit 1 ;; broken) printf 'unknown build\\n' ;; hang) sleep 30 ;; late) sleep 2; printf done > "$d/claude-late" ;; *) printf '%s (Claude Code)\\n' "$v" ;; esac; exit 0 ;;
esac
exit 1
`

const encoder = new TextEncoder()
const sleep = (ms) => (ms ? Bun.sleep(ms) : Promise.resolve())

// 按块发送的正文：items 是字符串块，块之间停 delayMs。
function chunkedBody(items, delayMs) {
  let i = 0
  return new ReadableStream({
    async pull(c) {
      if (i >= items.length) { c.close(); return }
      c.enqueue(encoder.encode(items[i++]))
      await sleep(delayMs)
    },
  })
}

// 没有 Content-Length 的大正文：每块 64 KiB 空格，总共 size 字节。
function bigBody(size, delayMs) {
  const chunk = new Uint8Array(64 * 1024).fill(0x20)
  let sent = 0
  return new ReadableStream({
    async pull(c) {
      if (sent >= size) { c.close(); return }
      c.enqueue(chunk)
      sent += chunk.length
      await sleep(delayMs)
    },
  })
}

// dir 省略时建临时目录，scripts/mock-host.mjs 传入固定目录，供真实 Magpie 沙箱验证使用。
// dir 充当“系统用户”的 home，布局与真实安装一致：
//   <dir>/.opusclaude/                    OpusClaude home（默认位置）
//   <dir>/.local/bin/{opclaude,claude}    启动器与假的 claude
//   <dir>/state/                          测试台的运行态与记录
// launcherHome 可把启动器与假 claude 放到另一个用户目录（模拟另设 OPUSCLAUDE_HOME）。
// 别的用户进得来的临时目录（macOS / Linux 的 /tmp：root 所有、带 sticky 位）。权限类用例的沙箱要建在这里：
// 系统临时目录（macOS 的 /var/folders/…）本身是本用户 0700 的私有目录，里面的东西别的用户根本够不着，
// 插件据此接受其中组可写、所有人可写的目录项，在那里测不出“别的用户能改动”。
export async function sharedTmp() {
  try {
    if ((await stat("/tmp")).mode & 0o001 && (await access("/tmp", 2 /* W_OK */).then(() => true, () => false))) return "/tmp"
  } catch {}
  return tmpdir()
}

// private=true：dir 保持 mkdtemp 的 0700，当作“上级有私有目录”的安装位置；否则沙箱目录是 0755。
export async function makeRig({ dir = "", launcherHome = "", private: privateDir = false } = {}) {
  const own = !dir
  dir = path.resolve(dir || await mkdtemp(path.join(await sharedTmp(), "opclaude-rig-")))
  if (own && !privateDir) await chmod(dir, 0o755)
  // 测试台会往 <dir>/.local/bin 与 <dir>/.opusclaude 写文件。dir 等于 $HOME 时只允许它是系统临时目录之下的沙箱
  // （真实 Magpie 的端到端验证这样做），绝不指向用户自己真实使用的 home。
  if (dir === path.resolve(homedir()) && !(await realpath(dir)).startsWith((await realpath(tmpdir())) + path.sep) && !(await realpath(dir)).startsWith((await realpath("/tmp")) + path.sep)) throw new Error("refusing to build the test rig in the real user home")
  launcherHome = launcherHome || dir
  const opusHome = path.join(dir, ".opusclaude")
  const state = path.join(dir, "state")
  await mkdir(path.join(opusHome, "opclauded", OPCLOUDED_VERSION), { recursive: true })
  await mkdir(state, { recursive: true })
  const bin = path.join(opusHome, "opclauded", OPCLOUDED_VERSION, "opclauded")
  if (!process.env.OC_RIG_KEEP_BIN) await writeFile(bin, FAKE)
  await chmod(bin, 0o755)

  const claudes = [path.join(dir, "opt-homebrew", "bin", "claude"), path.join(dir, "usr-local", "bin", "claude")]
  // 写一份仿官方安装：启动器 + 假 claude。text 可替换启动器正文（故障注入），sha256 可把指纹改成错的。
  const install = async ({ home = launcherHome, text = "", sha256 = "" } = {}) => {
    const binDir = path.join(home, ".local", "bin")
    await mkdir(binDir, { recursive: true })
    const sum = sha256 || new Bun.CryptoHasher("sha256").update(new Uint8Array(await Bun.file(bin).arrayBuffer())).digest("hex")
    const body = (text || LAUNCHER_SOURCE)
      .replaceAll("__OPUSCLAUDE_PROXY_BIN__", bin)
      .replaceAll("__OPUSCLAUDE_PROXY_SHA__", sum)
      .replaceAll("__OPUSCLAUDE_SYS_CLAUDE_1__", claudes[0])
      .replaceAll("__OPUSCLAUDE_SYS_CLAUDE_2__", claudes[1])
    const launcher = path.join(binDir, "opclaude")
    await Bun.write(launcher, body)
    await chmod(launcher, 0o755)
    await writeConfig(new Bun.CryptoHasher("sha256").update(body).digest("hex"))
    await Bun.write(path.join(binDir, "claude"), CLAUDE.replaceAll("__STATE__", state))
    await chmod(path.join(binDir, "claude"), 0o755)
    return { launcher, sum }
  }
  // 仿官方安装器写出的 <home>/config：chmod 600，带一项假的票据，以及成品启动器的摘要 LAUNCHER_SHA。
  const config = path.join(opusHome, "config")
  const writeConfig = async (launcherSha, extra = "") => {
    await Bun.write(config, [
      "# OpusClaude 接入配置（自动生成，勿手改；chmod 600；卸载：install.sh --uninstall）",
      "ANTHROPIC_AUTH_TOKEN='ticket-config-fake'",
      "GATEWAY='https://api.opusapi.xyz'",
      "DEVICE_ID='device-fake'",
      "LAUNCHER_SHA='" + launcherSha + "'",
      "CLI_PKG_VERSION='20261120.1'",
      "OPCLAUDE_PROXY='1'",
      extra,
    ].join("\n") + "\n")
    await chmod(config, 0o600)
  }
  // 把假的 opclauded 恢复成原始内容与权限，并重写启动器（故障注入的用例之后调用）。
  const restore = async () => {
    await mkdir(path.dirname(bin), { recursive: true })
    await writeFile(bin, FAKE)
    await chmod(bin, 0o755)
    // 启动器可能是上个用例留下的符号链接：先删掉，免得写穿到别处。
    await rm(path.join(launcherHome, ".local", "bin", "opclaude"), { force: true })
    return await install()
  }
  await install()

  const st = {
    mode: "proxy",
    port: "",
    ticket: "ticket-A-fake",
    device: "device-fake",
    ccVersion: DEFAULT_CC_VERSION,
    // opclauded account 的标准输出（account-status JSON）；hang / fail / invalid / none / empty 是故障注入
    account: '{"ok":true,"plan_name":"Pro 周卡","weekly_pct":42.5}',
    delayMs: 0, // 响应头之前的延迟
    status: 200,
    redirect: 0,
    hang: 0,
    echoError: 0, // 失败响应回显票据与设备 ID
    bodyDelayMs: 0, // /v1/models 正文各块之间的延迟
    bigBody: 0, // /v1/models 正文大小（字节），0 为正常清单
    batchDelay: 0, // SSE 批次之间的延迟
    statusText: "", // 失败响应的状态文本（可用来回显）
    openError: 0, // 失败响应只发头，正文一直不结束
    jsonEsc: 0, // 普通 JSON 错误，原话里带引号包着的票据
    echoSuccess: 0, // 成功响应的头部与状态文本回显当次票据和设备 ID
  }
  const sync = async () => {
    for (const k of Object.keys(st)) await writeFile(path.join(state, k), String(st[k]))
  }
  await sync()

  const seen = { proxy: [], elsewhere: [], body: "", ua: [], bodies: [] }
  let hits = 0
  const names = (req) => [...req.headers.keys()].map((k) => k.toLowerCase()).sort()
  let elsewhere, server
  const handler = async (req) => {
    const url = new URL(req.url)
    const device = req.headers.get("x-opusclaude-device")
    const authed = req.headers.get("authorization") === `Bearer ${st.proxyTicket || st.ticket}`
    const ua = req.headers.get("user-agent")
    if (url.pathname !== "/v1/models") { seen.ua.push(ua); seen.bodies.push({ path: url.pathname + url.search, body: await req.text() }) }
    seen.proxy.push({ method: req.method, path: url.pathname + url.search, headers: names(req), authed, device, app: req.headers.get("x-app"), ua, model: "", port: server?.port })
    if (st.redirect) return new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${elsewhere.port}/stolen` } })
    if (!authed) {
      return new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "bad ticket, got " + (req.headers.get("authorization") ?? "") } }), {
        status: 401, headers: { "content-type": "application/json", "x-echo-ticket": req.headers.get("authorization") ?? "" },
      })
    }
    if (url.pathname === "/v1/models") {
      if (st.bigBody) return new Response(bigBody(st.bigBody, st.bodyDelayMs), { headers: { "content-type": "application/json" } })
      if (st.bodyDelayMs) {
        const parts = ['{"object":"list","data":[', '{"id":"claude-fable-5-2","display_name":"Fable 5.2"},', '{"id":"claude-sonnet-5-5"}]}']
        return new Response(chunkedBody(parts, st.bodyDelayMs), { headers: { "content-type": "application/json" } })
      }
      return Response.json({ object: "list", data: [{ id: "claude-fable-5-2", display_name: "Fable 5.2", created_at: "2026-01-01" }, { id: "claude-sonnet-5-5" }] })
    }
    if (st.status >= 400) {
      if (st.openError) return new Response(new ReadableStream({ start() {} }), { status: st.status, statusText: st.statusText, headers: { "content-type": "application/json", "retry-after": "7" } })
      if (st.jsonEsc) return new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: `plan "ticket-${st.ticket}" is busy`, extra: { note: `dev \"${st.device}\"` } }, request_id: "req_1" }), { status: st.status, statusText: st.statusText, headers: { "content-type": "application/json", "retry-after": "7" } })
      const echo = st.echoError ? `ticket=${st.ticket} device=${device}` : "the model is not available on this plan"
      const headers = { "content-type": "application/json", "retry-after": "7", "set-cookie": `sid=${st.ticket}`, "www-authenticate": `Bearer error="bad ${st.ticket}"` }
      return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: echo } }), { status: st.status, statusText: st.statusText, headers })
    }
    // 生成类请求计数落盘，供外部进程（真实 Magpie 沙箱验证）断言“零次生成请求”。
    if (url.pathname === "/v1/messages/count_tokens" || url.pathname === "/v1/messages") {
      hits += 1
      Bun.write(path.join(dir, "hits"), String(hits))
    }
    if (url.pathname === "/v1/messages/count_tokens") {
      return Response.json({ input_tokens: seen.bodies.at(-1).body.length })
    }
    if (st.hang) return new Response(new ReadableStream({ start(c) { c.enqueue(encoder.encode("event: message_start\ndata: {}\n\n")) } }), { headers: { "content-type": "text/event-stream" } })
    if (url.pathname === "/v1/messages") {
      seen.body = seen.bodies.at(-1).body
      const body = JSON.parse(seen.body)
      if (st.delayMs) await Bun.sleep(st.delayMs)
      seen.proxy.at(-1).model = String(body.model)
      const extra = st.echoSuccess ? { "x-echo-device": device ?? "(none)", "x-echo-ticket": `Bearer ${st.ticket}`, "x-upstream": "kept" } : {}
      const statusText = st.echoSuccess ? `ok ${st.ticket}` : ""
      if (body.stream) {
        const items = SSE_BATCHES.flat()
        const body = st.batchDelay ? chunkedBody(items, st.batchDelay) : SSE
        return new Response(body, { statusText, headers: { ...extra, "content-type": "text/event-stream" } })
      }
      return new Response(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }), { statusText, headers: { ...extra, "content-type": "application/json" } })
    }
    return new Response("nope", { status: 404 })
  }

  elsewhere = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      seen.elsewhere.push(req.url)
      return new Response("stolen")
    },
  })

  const serve = (port) => Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 60, fetch: handler })
  // 在白名单端口里用真实处理器直接绑定（排除 exclude），保留第一个绑成功的监听器。找不到返回 undefined。
  // 探测和正式绑定是同一步，并行测试不会选中同一个端口。
  async function listenFree(exclude = 0) {
    const order = PROXY_PORTS.filter((p) => p !== exclude)
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]] }
    for (const port of order) {
      try { return serve(port) } catch {}
    }
    return undefined
  }
  // 管理入口单独一个端口：模拟代理停掉时它仍然可用。
  const ctl = Bun.serve({
    hostname: "127.0.0.1", port: 0, idleTimeout: 30,
    async fetch(req) {
      const url = new URL(req.url)
      // 外部进程（真实 Magpie 沙箱验证）经此改运行态：GET /__ctl?mode=direct&status=503，改完落盘。
    if (url.pathname === "/__ctl") {
      for (const [k, v] of url.searchParams) if (k in st) st[k] = isNaN(Number(v)) || v.trim() === "" ? v : Number(v)
      // down=1 让模拟代理停掉（连接被拒）：先把 ok 应答发完，紧接着停。down=0 在原端口恢复。
      if (url.searchParams.get("down") === "1") {
        const was = server
        server = undefined
        return new Response(new ReadableStream({ start(c) { c.enqueue(encoder.encode("ok")); c.close(); setTimeout(() => was?.stop(true), 0) } }))
      }
      if (url.searchParams.get("down") === "0" && !server) {
        server = serve(Number(st.port))
      }
      await sync()
      return new Response("ok")
    }
    // 只读：外部进程（真实 Magpie 沙箱验证）经此取走代理见过的生成类请求：路径、User-Agent、X-App、是否带了当次票据、正文。
    // 同样只读：模型发现（GET /v1/models）见过的请求，用来核对它与生成类请求带同一套宿主机标识。
    if (url.pathname === "/__seen/models") {
      return Response.json(seen.proxy.filter((r) => r.path === "/v1/models").map((r) => ({ method: r.method, path: r.path, ua: r.ua, app: r.app, authed: r.authed })))
    }
    if (url.pathname === "/__seen") {
      const gen = seen.proxy.filter((r) => r.path !== "/v1/models")
      return Response.json(gen.map((r, i) => ({ method: r.method, path: r.path, ua: r.ua, app: r.app, authed: r.authed, body: seen.bodies[i]?.body ?? "" })))
    }
      return new Response("nope", { status: 404 })
    },
  })
  server = await listenFree()
  if (!server) throw new Error("no free proxy port in 18827-18836")
  st.port = String(server.port)
  await sync()

  return {
    // 插件执行的是 opclauded 的物理路径（macOS 的 /var 是 /private/var 的符号链接）。
    dir, state, bin, realBin: await realpath(bin), opusHome, realOpusHome: await realpath(opusHome), config, writeConfig, st, seen, sync, install, restore, fakeSource: FAKE, sse: SSE,
    ctlPort: ctl.port,
    // 这套假安装对应的进程环境：HOME 是启动器所在的用户目录，不带 OPUSCLAUDE_HOME（走默认 ~/.opusclaude）。
    get env() {
      const env = { ...process.env, HOME: launcherHome }
      delete env.OPUSCLAUDE_HOME
      return env
    },
    launcher: path.join(launcherHome, ".local", "bin", "opclaude"),
    // 插件查找启动器的位置（只供测试注入）：用户目录里的那份，加上沙箱里空的“/usr/local/bin”。
    // 不注入时插件会去看运行测试的机器上真实的 /usr/local/bin/opclaude。
    get dirs() { return [this.launcher, path.join(dir, "usr-local", "bin", "opclaude")] },
    // 固定系统 Claude 路径的沙箱替身（只供测试注入）：避免碰到运行测试机器上的 /opt/homebrew/bin/claude 与 /usr/local/bin/claude。
    get claudes() { return [...claudes] },
    /** 端口监听器：并发测试用它确认两个 rig 不会选中同一个端口。 */
    get listener() { return server },
    get port() { return server?.port ?? 0 },
    // dir 是“系统用户”的 home，dir/.opusclaude 是默认的 OpusClaude home（启动器里写死的 opclauded 在它之下）。
    opusHome,
    elsewhereUrl: `http://127.0.0.1:${elsewhere.port}`,
    /** 代理重启到白名单内另一个当前能绑定的端口：先绑好新监听器，再切换并关掉旧的。返回新端口，绑不到返回 0。 */
    async rebindFree() {
      const next = await listenFree(server?.port ?? 0)
      if (!next) return 0
      const old = server
      server = next
      st.port = String(next.port)
      await sync()
      old?.stop(true)
      return next.port
    },
    rebind(port) { server?.stop(true); server = serve(port) },
    stop() { server?.stop(true); server = undefined },
    async close() {
      server?.stop(true)
      elsewhere.stop(true)
      ctl.stop(true)
      if (process.env.OC_RIG_KEEP_DIR) return
      await Bun.$`rm -rf ${dir}`.quiet()
    },
  }
}
