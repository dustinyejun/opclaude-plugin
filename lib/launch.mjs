// 宿主机 opclauded 的运行态解析。
//
// 契约来自 OpusClaude 官方安装脚本（https://claude.opusapi.xyz/install.sh）里的 opclaude 启动器：
//   opclauded launch --home <opusHome> --min-protocol 1
//   opclauded account（见 runAccount）
// 在 stdout 上按行打印 KEY='值'（单引号用 '\'' 转义），代理模式只认
// http://127.0.0.1:18827-18836。没有正式第三方 SDK：这是内部契约，升级后需复验。
// 这里只做有界的静态解析，绝不 eval / source。
import { spawn } from "node:child_process"
import { constants } from "node:fs"
import { createHash } from "node:crypto"
import { closeSync, createReadStream } from "node:fs"
import { access, lstat, stat } from "node:fs/promises"
import path from "node:path"
import { SafeError } from "./errors.mjs"

export const LAUNCH_ARGS = (opusHome) => ["launch", "--home", opusHome, "--min-protocol", "1"]
export const PROXY_BASE_RE = /^http:\/\/127\.0\.0\.1:(?:1882[789]|1883[0-6])$/

const MAX_OUTPUT = 64 * 1024
const MAX_LINE = 8192
const MAX_LINES = 32
const MAX_STDERR = 4096
const VISIBLE = /^[\x20-\x7e]+$/

// stderr 第一行只按已知类别精确匹配，原文不外传。
const STDERR_CLASSES = {
  "opclauded: install_busy": "install_busy",
  "opclauded: txn_recovery_failed": "txn_recovery_failed",
  "opclauded: config_invalid": "config_invalid",
  "opclauded: gateway_untrusted": "gateway_untrusted",
}

const KEYS = new Set([
  "OC_RUN_MODE", "OC_BASE_URL", "OC_CREDENTIAL", "OC_DEVICE_ID", "OC_PROFILE",
  "OC_PROXY_COMPONENT", "OC_PROXY_PROTOCOL", "OC_FALLBACK", "OC_CLI_PKG_VERSION", "OC_LAUNCHER_SHA",
])

// 与安装脚本 oc_locked_direct 同一套单引号规则：只接受 '\'' 一种转义。
function unquote(inner) {
  let out = ""
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] !== "'") { out += inner[i]; continue }
    if (inner.startsWith("'\\''", i)) { out += "'"; i += 3; continue }
    throw new SafeError("launch_output_invalid")
  }
  return out
}

// 文本 -> { mode, baseUrl, credential, deviceId, component, protocol }
export function parseLaunchOutput(text) {
  const bad = () => new SafeError("launch_output_invalid")
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_OUTPUT) throw bad()
  if (text.includes("\r") || text.includes("\0")) throw bad()

  const lines = text.split("\n")
  if (lines[lines.length - 1] === "") lines.pop()
  if (lines.length === 0 || lines.length > MAX_LINES) throw bad()

  const vars = Object.create(null)
  for (const line of lines) {
    if (line.length > MAX_LINE) throw bad()
    const eq = line.indexOf("=")
    // 起止必须是两个不同的单引号：OC_X=' 这种只有一个引号的行不算空值。
    if (eq < 1 || line[eq + 1] !== "'" || line.length - 1 <= eq + 1 || line[line.length - 1] !== "'") throw bad()
    const key = line.slice(0, eq)
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(key) || Object.hasOwn(vars, key)) throw bad()
    const value = unquote(line.slice(eq + 2, -1))
    if (!VISIBLE.test(value) && value !== "") throw bad()
    vars[key] = value
  }

  // 代理程序声明的协议号：给了就必须是 ≥ 1 的整数（launch 以 --min-protocol 1 调用）。
  const protocol = vars.OC_PROXY_PROTOCOL
  if (protocol !== undefined && !/^[1-9][0-9]{0,5}$/.test(protocol)) throw new SafeError("protocol_mismatch")

  const mode = vars.OC_RUN_MODE
  if (mode === "direct") throw new SafeError("mode_direct")
  if (mode !== "proxy") throw new SafeError(mode === undefined ? "launch_output_invalid" : "mode_unsupported")

  const baseUrl = vars.OC_BASE_URL
  if (baseUrl === undefined) throw bad()
  if (!PROXY_BASE_RE.test(baseUrl)) throw new SafeError("base_url_rejected")

  const credential = vars.OC_CREDENTIAL
  if (credential === undefined) throw bad()
  if (credential === "" || credential.length > 4096 || !VISIBLE.test(credential)) throw new SafeError("credential_invalid")

  const deviceId = vars.OC_DEVICE_ID ?? ""
  if (deviceId.length > 512 || (deviceId !== "" && !VISIBLE.test(deviceId))) throw new SafeError("credential_invalid")

  return {
    mode,
    baseUrl,
    credential,
    deviceId,
    component: vars.OC_PROXY_COMPONENT ?? "",
    protocol: protocol ?? "",
  }
}

export function validateSettings(settings) {
  for (const k of ["opclauded", "opusHome", "proxyHome", "opclaudedSha256"]) {
    const v = settings?.[k]
    if (v !== undefined && v !== "" && typeof v !== "string") throw new SafeError("option_invalid")
  }
  const bin = settings?.opclauded
  const home = settings?.opusHome
  if (!bin || !home) throw new SafeError("not_configured")
  if (bin.includes("\0") || !path.isAbsolute(bin) || bin.length > 4096) throw new SafeError("path_invalid")
  if (home.includes("\0") || !path.isAbsolute(home) || home.length > 4096) throw new SafeError("home_invalid")
  const proxyHome = settings?.proxyHome
  if (proxyHome && (proxyHome.includes("\0") || !path.isAbsolute(proxyHome))) throw new SafeError("proxy_home_invalid")
  const sha = settings?.opclaudedSha256
  if (sha && !/^[0-9a-f]{64}$/.test(sha)) throw new SafeError("sha256_invalid")
  return { opclauded: bin, opusHome: home, proxyHome: proxyHome || "", opclaudedSha256: sha || "" }
}

// 只执行用户指定的绝对路径：普通文件、不是符号链接、可执行；给了指纹就先核对。
export async function verifyBinary(bin, sha256 = "") {
  let st
  try { st = await lstat(bin) } catch { throw new SafeError("binary_missing") }
  if (!st.isFile()) throw new SafeError("binary_not_regular")
  if (st.size === 0) throw new SafeError("binary_not_regular")
  try { await access(bin, 4 /* R_OK */) } catch { throw new SafeError("binary_unreadable") }
  try { await access(bin, 1 /* X_OK */) } catch { throw new SafeError("binary_not_executable") }
  if (sha256) {
    const h = createHash("sha256")
    try {
      for await (const chunk of createReadStream(bin)) h.update(chunk)
    } catch { throw new SafeError("binary_unreadable") }
    if (h.digest("hex") !== sha256) throw new SafeError("sha256_mismatch")
  }
  return true
}

// 最小环境：不把继承来的任何 ANTHROPIC_* / OPUSCLAUDE_* 凭据交给子进程。
export function childEnv(proxyHome, source = process.env) {
  const env = {}
  for (const k of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"]) {
    if (source[k]) env[k] = source[k]
  }
  if (proxyHome) env.OPCLAUDE_PROXY_HOME = proxyHome
  return env
}

// 运行一个本机程序并收集输出：最小环境、超时、调用方取消、输出有界、stdin 关闭。
// 只在子进程无法启动、超时、取消、输出超限时 reject；其余情况 resolve { code, out, err }。
// 子进程自成进程组：超时、取消、输出超限时结束整组，启动器再拉起的下级进程（如 claude --version）一并结束。
// 输出超限立即拒绝，不等直接子进程退出（它可能恰好正常退出）。输出按字节累计、结束时整体按 UTF-8 解码。
// 子进程的 stderr 原文只交回调用方分类，绝不放进错误信息。
// fds：额外交给子进程的文件描述符，子进程里从 3 起依次排列。每一项是号码，或带 fd 与 close 方法的对象。
// 号码由 capture 负责：子进程启动（或启动失败）之后本进程这一侧随即关闭。带 close 的对象由调用方自己关，capture 不碰它，
// 这样同一个描述符不会被关两次（重复关一个号码可能关掉恰好复用了它的别的描述符）。
export function capture({ bin, args, env, cwd, timeoutMs, signal, fds = [], stdin = null, codes: { failed, timeout, aborted, overflow: tooMuch } }) {
  // 进程启动之前（比如核对宿主机目录的时候）调用方就已经取消：不启动子进程，原样传播取消原因。
  if (signal?.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const closeFds = () => { for (const fd of fds) { if (typeof fd === "number") { try { closeSync(fd) } catch {} } } }
    let settled = false
    const done = (fn, arg) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener?.("abort", onAbort); fn(arg) }
    const out = []
    let outBytes = 0
    let errBytes = 0
    const errOut = []
    const inMode = stdin !== null && stdin !== undefined ? "pipe" : "ignore"
    let child
    try {
      child = spawn(bin, args, { stdio: [inMode, "pipe", "pipe", ...fds.map((f) => (typeof f === "number" ? f : f.fd))], env, cwd, detached: true, windowsHide: true })
    } catch { closeFds(); return reject(new SafeError(failed)) }
    // 本进程这一侧的描述符等子进程确实启动之后再关（spawn 不是同步完成的，马上关子进程可能拿不到）。
    child.once("spawn", closeFds)
    child.once("error", closeFds)

    // 负号：结束整个进程组。子进程已经自己退出时组可能已不存在，失败就算了。
    const stop = () => {
      try { child.stdin?.destroy() } catch {}
      try { process.kill(-child.pid, "SIGKILL") } catch { try { child.kill("SIGKILL") } catch {} }
    }
    const onAbort = () => { stop(); done(reject, new SafeError(aborted)) }
    const timer = setTimeout(() => { stop(); done(reject, new SafeError(timeout)) }, timeoutMs)
    signal?.addEventListener?.("abort", onAbort, { once: true })

    if (child.stdin) {
      // shell 在 version 分支提前 exit 0（或触发 set -e 退出）会关闭 stdin 并产生 EPIPE / ERR_STREAM_DESTROYED：
      // 不能作为未捕获异常抛出，也不能把本应由退出码判定的版本查询判成失败。
      child.stdin.on("error", (err) => {
        if (err?.code === "EPIPE" || err?.code === "ERR_STREAM_DESTROYED" || err?.code === "ECONNRESET") return
        stop()
        done(reject, new SafeError(failed))
      })
      try {
        child.stdin.end(stdin)
      } catch (err) {
        if (err?.code !== "EPIPE" && err?.code !== "ERR_STREAM_DESTROYED" && err?.code !== "ECONNRESET") {
          stop()
          done(reject, new SafeError(failed))
        }
      }
    }

    child.stdout.on("data", (d) => {
      if (outBytes > MAX_OUTPUT) return
      out.push(d)
      outBytes += d.length
      if (outBytes > MAX_OUTPUT) { out.pop(); stop(); done(reject, new SafeError(tooMuch)) }
    })
    child.stderr.on("data", (d) => {
      if (errBytes >= MAX_STDERR) return
      const part = d.subarray(0, MAX_STDERR - errBytes)
      errOut.push(part)
      errBytes += part.length
    })
    child.on("error", () => { closeFds(); done(reject, new SafeError(failed)) })
    child.on("close", (code) => done(resolve, { code, out: Buffer.concat(out).toString("utf8"), err: Buffer.concat(errOut).toString("utf8") }))
  })
}

// 自动发现选出的程序：openBinary 已经从同一个文件描述符核对了属主、权限和指纹，描述符还开着。
// 这里不运行安装里的那个路径（它在核对之后可能被升级或修复换掉），而是运行从该描述符复制出的内容绑定副本
// （见 host.mjs 的 materializeBinary）：macOS 与 Linux、二进制与脚本走的是同一条路，执行的就是核对过的字节。
// 旧的显式配置不经过这里：仍然是用户给出的路径，按原来的指纹语义核对后运行。
export async function runLaunch(settings, { timeoutMs = 15000, signal, source = process.env, executable } = {}) {
  const s = validateSettings(settings)
  if (executable) {
    try { return await launchBound(s, executable, { timeoutMs, signal, source }) } finally { await executable.close().catch(() => {}) }
  }
  await verifyBinary(s.opclauded, s.opclaudedSha256)
  if (signal?.aborted) throw new SafeError("launch_aborted")

  const { code, out, err } = await capture({
    bin: s.opclauded,
    args: LAUNCH_ARGS(s.opusHome),
    env: childEnv(s.proxyHome, source),
    timeoutMs,
    signal,
    codes: { failed: "launch_failed", timeout: "launch_timeout", aborted: "launch_aborted", overflow: "launch_output_invalid" },
  })
  return launchResult(code, out, err)
}

async function launchBound(s, exe, { timeoutMs, signal, source }) {
  if (signal?.aborted) throw new SafeError("launch_aborted")
  const bin = await exe.materialize()
  if (signal?.aborted) throw new SafeError("launch_aborted")
  const { code, out, err } = await capture({
    bin,
    args: LAUNCH_ARGS(s.opusHome),
    env: childEnv(s.proxyHome, source),
    cwd: "/",
    timeoutMs,
    signal,
    codes: { failed: "launch_failed", timeout: "launch_timeout", aborted: "launch_aborted", overflow: "launch_output_invalid" },
  })
  return launchResult(code, out, err)
}

// 套餐状态：与官方启动器 oc_plan_json proxy 同一调用，`opclauded account`（无参数），只读标准输出的 JSON。
// 只负责有界执行；退出码非零与输出超限时抛固定错误码，其余交给调用方解析。stderr 原文不外传。
export const ACCOUNT_TIMEOUT_MS = 12000
export async function runAccount(settings, { timeoutMs = ACCOUNT_TIMEOUT_MS, signal, source = process.env, executable, proxyHome } = {}) {
  const s = validateSettings(settings)
  const env = childEnv(proxyHome, source)
  const codes = { failed: "account_failed", timeout: "account_timeout", aborted: "account_aborted", overflow: "account_output_invalid" }
  const run = (bin, cwd) => capture({ bin, args: ["account"], env, cwd, timeoutMs, signal, codes })
  if (executable) {
    try {
      if (signal?.aborted) throw new SafeError("account_aborted")
      return await run(await executable.materialize(), "/")
    } finally { await executable.close().catch(() => {}) }
  }
  await verifyBinary(s.opclauded, s.opclaudedSha256)
  if (signal?.aborted) throw new SafeError("account_aborted")
  return await run(s.opclauded)
}

function launchResult(code, out, err) {
  if (code !== 0) {
    const first = err.split("\n")[0].trim()
    const cls = first.length <= 64 ? STDERR_CLASSES[first] : undefined
    throw new SafeError(cls ?? "launch_failed", cls ? "" : `（exit ${typeof code === "number" ? code : "signal"}）`)
  }
  return parseLaunchOutput(out)
}
