// 宿主机 opclauded 的运行态解析。
//
// 契约来自 OpusClaude 官方安装脚本（https://claude.opusapi.xyz/install.sh）里的 opclaude 启动器：
//   opclauded launch --home <opusHome> --min-protocol 1
// 在 stdout 上按行打印 KEY='值'（单引号用 '\'' 转义），代理模式只认
// http://127.0.0.1:18827-18836。没有正式第三方 SDK：这是内部契约，升级后需复验。
// 这里只做有界的静态解析，绝不 eval / source。
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { access, lstat } from "node:fs/promises"
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
function childEnv(proxyHome) {
  const env = {}
  for (const k of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"]) {
    if (process.env[k]) env[k] = process.env[k]
  }
  if (proxyHome) env.OPCLAUDE_PROXY_HOME = proxyHome
  return env
}

export async function runLaunch(settings, { timeoutMs = 15000, signal } = {}) {
  const s = validateSettings(settings)
  await verifyBinary(s.opclauded, s.opclaudedSha256)
  if (signal?.aborted) throw new SafeError("launch_aborted")

  return await new Promise((resolve, reject) => {
    let settled = false
    const done = (fn, arg) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener?.("abort", onAbort); fn(arg) }
    let out = ""
    let errOut = ""
    let overflow = false
    let child
    try {
      child = spawn(s.opclauded, LAUNCH_ARGS(s.opusHome), { stdio: ["ignore", "pipe", "pipe"], env: childEnv(s.proxyHome), windowsHide: true })
    } catch { return reject(new SafeError("launch_failed")) }

    const stop = () => { try { child.kill("SIGKILL") } catch {} }
    const onAbort = () => { stop(); done(reject, new SafeError("launch_aborted")) }
    const timer = setTimeout(() => { stop(); done(reject, new SafeError("launch_timeout")) }, timeoutMs)
    signal?.addEventListener?.("abort", onAbort, { once: true })

    child.stdout.on("data", (d) => {
      if (overflow) return
      out += d.toString("utf8")
      if (out.length > MAX_OUTPUT) { overflow = true; stop() }
    })
    child.stderr.on("data", (d) => {
      if (errOut.length < MAX_STDERR) errOut += d.toString("utf8").slice(0, MAX_STDERR)
    })
    child.on("error", () => done(reject, new SafeError("launch_failed")))
    child.on("close", (code) => {
      if (overflow) return done(reject, new SafeError("launch_output_invalid"))
      if (code !== 0) {
        const first = errOut.split("\n")[0].trim()
        const cls = first.length <= 64 ? STDERR_CLASSES[first] : undefined
        return done(reject, new SafeError(cls ?? "launch_failed", cls ? "" : `（exit ${typeof code === "number" ? code : "signal"}）`))
      }
      let state
      try { state = parseLaunchOutput(out) } catch (e) { return done(reject, e) }
      done(resolve, state)
    })
  })
}
