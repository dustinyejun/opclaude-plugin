// 把 Magpie 网关交来的 Anthropic Messages 请求转发到本机 opclauded 代理。
// 每次调用都用同一次 launch 解析出的 { baseUrl, credential, deviceId }：地址与票据配套。
import { SafeError, TEXT } from "./errors.mjs"
import { PROXY_BASE_RE } from "./launch.mjs"

// 本插件的请求只走本机回环，票据不能经过环境里配置的 HTTP 代理。fetch 的 proxy: false 从 Bun 1.4.3 起才生效
// （https://bun.com/blog/release-notes/bun-v1.4.3），更早的版本会静默沿用环境代理。低于这个版本的宿主一律拒绝，不降级。
export const MIN_BUN = "1.4.3"
// 完整语义版本比较（主版本.次版本.修订号[-预发布][+构建]）。同版本的预发布低于正式版，解析不了的一律视为不支持。
// 这里只用简单的正则逐段校验：实测 Bun 1.4.5 对带嵌套可选分组的单条正则会给出错误结果。
const PART = /^[0-9A-Za-z-]+$/

function compareVersion(version, floor) {
  let prerelease = true
  if (typeof version !== "string") return false
  const text = version.trim()
  const core = /^([0-9]+)\.([0-9]+)\.([0-9]+)/.exec(text)
  if (!core) return false
  // 主版本、次版本、修订号都不带前导零
  if (core.slice(1, 4).some((n) => n.length > 1 && n[0] === "0")) return false
  let rest = text.slice(core[0].length)
  if (rest[0] === "-") {
    // 预发布标识不能为空，纯数字标识也不能带前导零。
    const pre = /^[0-9A-Za-z.-]+/.exec(rest.slice(1))?.[0] ?? ""
    if (!pre || pre.split(".").some((id) => !PART.test(id) || /^0[0-9]+$/.test(id))) return false
    rest = rest.slice(1 + pre.length)
  } else prerelease = false
  if (rest[0] === "+") {
    const build = /^[0-9A-Za-z.-]+/.exec(rest.slice(1))?.[0] ?? ""
    if (!build || build.split(".").some((id) => !PART.test(id))) return false
    rest = rest.slice(1 + build.length)
  }
  if (rest !== "") return false
  const theirs = core.slice(1, 4).map(Number)
  const mine = floor.split(".").map(Number)
  for (let i = 0; i < 3; i++) if (theirs[i] !== mine[i]) return theirs[i] > mine[i]
  return !prerelease
}
export function bunSupportsProxyFalse(version = Bun.version) {
  return compareVersion(version, MIN_BUN)
}
export function assertDirectFetch(version = Bun.version) {
  if (!bunSupportsProxyFalse(version)) throw new SafeError("runtime_unsupported", `（Bun ${version}）`)
}

// 占位地址：端口 1 是特权端口，普通用户进程无法监听。真正的目标只在 fetch 里按运行态替换，
// 这样即使有人绕过本插件的 fetch，也只会连到一个没人监听的回环地址，而不是公网。
export const PLACEHOLDER_BASE = "http://127.0.0.1:1/v1"

const ENDPOINTS = new Set(["/v1/messages", "/v1/messages/count_tokens"])
// Magpie 的鉴权、调用方信息头，以及请求方自带的设备头，一律去掉后按当次运行态重设。
const STRIP = new Set(["authorization", "x-api-key", "proxy-authorization", "cookie", "host", "x-opusclaude-device"])
const isMagpieHeader = (name) => name.startsWith("x-magpie-")

// 已确定的失败（配置、模式、代理不可达）以这个状态交还网关。实测 Magpie 0.1.4749：4xx 立即交付给调用方，
// 5xx 会先把同一账号重试约 33 秒。用 400 让调用方马上拿到固定错误，客户端也不会自动重试。
export const FAILURE_STATUS = 400
// 上游错误正文最多读这么多字节，超出就换成固定错误。
const MAX_ERROR_BODY = 64 * 1024
const ERROR_BODY_TIMEOUT = 10_000
// 失败响应只保留这些头。
const ERROR_HEADERS = ["retry-after", "request-id", "x-request-id", "anthropic-ratelimit-requests-limit", "anthropic-ratelimit-requests-remaining", "anthropic-ratelimit-requests-reset", "anthropic-ratelimit-tokens-limit", "anthropic-ratelimit-tokens-remaining", "anthropic-ratelimit-tokens-reset", "anthropic-ratelimit-input-tokens-limit", "anthropic-ratelimit-input-tokens-remaining", "anthropic-ratelimit-input-tokens-reset", "anthropic-ratelimit-output-tokens-limit", "anthropic-ratelimit-output-tokens-remaining", "anthropic-ratelimit-output-tokens-reset"]

const TYPES = { 400: "invalid_request_error", 401: "authentication_error", 403: "permission_error", 404: "not_found_error", 413: "request_too_large", 429: "rate_limit_error", 500: "api_error", 503: "api_error" }
const typeFor = (status) => TYPES[status] ?? "api_error"

export function errorBody(status, message) {
  return JSON.stringify({ type: "error", error: { type: typeFor(status), message } })
}

export function errorResponse(code, status = FAILURE_STATUS, detail = "") {
  return new Response(errorBody(status, `[opclaude:${code}] ${TEXT[code] ?? "未知错误"}${detail}`), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  })
}

const from = (r) => ({ __effective: true, url: r.url, method: r.method, headers: r.headers, body: r.body, signal: r.signal })

// 按 Fetch 语义合并 Request 与可选 init，得到实际生效的方法、头、正文和信号。
// 标准 Request 直接交给原生构造器合并：init 给出的头会整体替换旧头，init 给出的信号会替换旧信号，
// 与调用方自己写 new Request(request, init) 的结果一致。launch 之前就用合并后的信号判断调用方是否已取消。
export function effectiveRequest(input, init) {
  if (input?.__effective) return input
  if (typeof input === "object" && input !== null && typeof input.url === "string") {
    return from(init === undefined ? input : new Request(input, init))
  }
  // Magpie 传字符串地址 + init（也接受裸的头对象作为 input）。
  const i = init ?? {}
  const headers = new Headers(i.headers ?? (typeof input === "string" ? undefined : input))
  const method = String(i.method ?? "POST").toUpperCase()
  const body = method === "GET" || method === "HEAD" ? undefined : i.body
  return { __effective: true, url: String(input), method, headers, body, signal: i.signal }
}

// 请求只能发往插件自己声明的回环占位地址，请求方给不出任何其它目标。
export function resolveEndpoint(input, method) {
  const rejected = new SafeError("target_rejected")
  let url
  try { url = new URL(typeof input === "string" ? input : (input?.url ?? String(input))) } catch { throw rejected }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.port !== "1" || url.username || url.password) throw rejected
  if (!ENDPOINTS.has(url.pathname)) throw rejected
  if (String(method ?? "POST").toUpperCase() !== "POST") throw rejected
  return url
}

function credentialHeaders(target, state) {
  target.set("authorization", `Bearer ${state.credential}`)
  if (state.deviceId) target.set("x-opusclaude-device", state.deviceId)
  return target
}

export function buildHeaders(source, state) {
  const out = new Headers()
  for (const [name, value] of new Headers(source ?? {}).entries()) {
    const lower = name.toLowerCase()
    if (STRIP.has(lower) || isMagpieHeader(lower)) continue
    out.append(name, value)
  }
  return credentialHeaders(out, state)
}

const modelHeaders = (state) => credentialHeaders(new Headers(), state)

function isRedirectError(e) {
  return /redirect/i.test(String(e?.message ?? "")) || e?.code === "UnexpectedRedirect"
}

// 调用方的取消信号中继给本机请求。
function relay(signal, timeoutMs = 0) {
  const ctrl = new AbortController()
  let timedOut = false
  const onAbort = () => ctrl.abort(signal?.reason)
  signal?.addEventListener?.("abort", onAbort, { once: true })
  if (signal?.aborted) onAbort()
  const timer = timeoutMs ? setTimeout(() => { timedOut = true; ctrl.abort() }, timeoutMs) : null
  return { signal: ctrl.signal, timedOut: () => timedOut, done: () => { if (timer) clearTimeout(timer); signal?.removeEventListener?.("abort", onAbort) } }
}

async function cancelBody(res) {
  try { await res.body?.cancel() } catch {}
}

async function refused(res, code) {
  await cancelBody(res)
  throw new SafeError(code)
}

function leaked(text, state) {
  if (text.includes(state.credential)) return true
  return state.deviceId !== "" && text.includes(state.deviceId)
}

// 正文里的字符串值是否带着票据或设备 ID（JSON 解码之后再查，转义过的也算）。
function leaksValue(value, state) {
  if (typeof value === "string") return leaked(value, state)
  if (Array.isArray(value)) return value.some((v) => leaksValue(v, state))
  if (value && typeof value === "object") return Object.values(value).some((v) => leaksValue(v, state))
  return false
}
const ERROR_TYPES = new Set(["invalid_request_error", "authentication_error", "permission_error", "not_found_error", "request_too_large", "rate_limit_error", "overloaded_error", "api_error", "billing_error"])

// 重建允许交还的错误字段：只带上游的错误类型、原话和 request_id，其余字段一概不带。
function upstreamErrorBody(status, json, state) {
  const err = json?.error
  if (json?.type !== "error" || !err || typeof err !== "object" || typeof err.message !== "string" || !err.message.trim()) return null
  if (leaksValue(json, state)) return null
  const type = ERROR_TYPES.has(err.type) ? err.type : typeFor(status)
  const out = { type: "error", error: { type, message: err.message } }
  if (typeof json.request_id === "string" && json.request_id.length <= 200) out.request_id = json.request_id
  return JSON.stringify(out)
}

// 上游失败响应：正文有界读取，期限与调用方的取消都能打断正在等待的读取并释放流。
// 只有能解析的 JSON 错误可以交还原话，其它正文一律换成固定错误。上游的状态文本不交还。
// 头部只留重试与限流信息，带回显的头丢掉并让正文换成固定错误。
async function sanitizeError(res, state, callerSignal, timeoutMs = ERROR_BODY_TIMEOUT) {
  const ac = relay(callerSignal, timeoutMs)
  let reader
  let text = ""
  let tooLarge = false
  let interrupted = false
  let wake = () => {}
  const aborted = new Promise((_, reject) => { wake = () => reject(new Error("opclaude:error-body-aborted")) })
  ac.signal.addEventListener("abort", wake, { once: true })
  try {
    reader = res.body?.getReader()
    if (reader) {
      const decoder = new TextDecoder()
      let received = 0
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), aborted])
        if (done) { text += decoder.decode(); break }
        received += value.byteLength
        if (received > MAX_ERROR_BODY) { tooLarge = true; break }
        text += decoder.decode(value, { stream: true })
      }
    } else {
      text = await Promise.race([res.text(), aborted])
      tooLarge = text.length > MAX_ERROR_BODY
    }
  } catch (e) {
    // 期限到了、调用方取消、流中断或读取失败：拿不到完整正文就用固定错误。
    interrupted = true
    text = ""
  } finally {
    ac.done()
    ac.signal.removeEventListener("abort", wake)
    await reader?.cancel().catch(() => {})
  }
  // 调用方取消了：保持取消语义，原样上抛原因。
  if (callerSignal?.aborted && !ac.timedOut()) throw callerSignal.reason
  // 期限到了或流自己断了：固定安全错误。
  const fixed = errorBody(res.status, `[opclaude:upstream_error] 本机代理返回 HTTP ${res.status}`)
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" })
  let headerLeak = false
  for (const name of ERROR_HEADERS) {
    const value = res.headers.get(name)
    if (value == null) continue
    if (value.includes(state.credential) || (state.deviceId !== "" && value.includes(state.deviceId))) { headerLeak = true; continue }
    headers.append(name, value)
  }
  let body = fixed
  if (!tooLarge && !headerLeak && !interrupted && text.trim()) {
    let json
    try { json = JSON.parse(text) } catch { json = undefined }
    // 不是 JSON 错误的正文无法可靠判定，用固定错误。
    body = (json && upstreamErrorBody(res.status, json, state)) || fixed
  }
  return new Response(body, { status: res.status, headers })
}

// 成功响应用原正文流重建，不缓冲：带着当次票据或设备 ID 的响应头和状态文本不交还调用方。
function cleanSuccess(res, state) {
  const headers = new Headers()
  res.headers.forEach((value, name) => {
    if (!leaked(value, state)) headers.append(name, value)
  })
  return new Response(res.body, { status: res.status, statusText: leaked(res.statusText, state) ? "" : res.statusText, headers })
}

// 生成请求与 count_tokens：状态码、头和正文流原样交还，由 Magpie 逐块转发给调用方。
// 生成请求只受调用方取消信号约束，不设首包超时：长提示预处理和长生成由调用方的期限决定。
export async function forward({ input, init, state, fetchImpl = fetch, errorBodyTimeoutMs }) {
  assertDirectFetch()
  const req = effectiveRequest(input, init)
  const url = resolveEndpoint(req, req.method)
  if (!PROXY_BASE_RE.test(state?.baseUrl) || !state?.credential) throw new SafeError("base_url_rejected")
  // 调用方已经取消：不连代理。
  if (req.signal?.aborted) throw req.signal.reason
  const ac = relay(req.signal)
  let res
  try {
    res = await fetchImpl(state.baseUrl + url.pathname + url.search, {
      method: "POST",
      headers: buildHeaders(req.headers, state),
      body: req.body,
      // 正文是流时按 Fetch 语义要求 duplex。
      ...(req.body?.getReader ? { duplex: "half" } : {}),
      signal: ac.signal,
      redirect: "error",
      // 显式不走环境代理：票据只能到达本机回环地址。
      proxy: false,
    })
  } catch (e) {
    if (req.signal?.aborted) throw req.signal.reason
    // 连接被拒、代理未运行、连接被重置，或 Bun 因 redirect:"error" 拒绝了跳转，都走这里。
    throw new SafeError(isRedirectError(e) ? "redirect_refused" : "proxy_unreachable")
  }
  if (req.signal?.aborted) {
    ac.done()
    void cancelBody(res)
    throw req.signal.reason
  }
  if (res.status >= 300 && res.status < 400) return refused(res, "redirect_refused")
  if (res.status >= 400) {
    const out = await sanitizeError(res, state, req.signal, errorBodyTimeoutMs)
    if (res.status === 401) out.headers.set("x-magpie-sign-in", "kept")
    return out
  }
  return cleanSuccess(res, state)
}

const MAX_MODELS_BODY = 1024 * 1024
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export function parseModels(json) {
  const bad = () => new SafeError("models_invalid")
  if (!json || !Array.isArray(json.data)) throw bad()
  if (json.data.length > 1000) throw bad()
  const seen = new Set()
  const out = {}
  for (const m of json.data) {
    const id = m?.id
    if (typeof id !== "string" || !MODEL_ID.test(id) || seen.has(id)) throw bad()
    seen.add(id)
    // display_name / name 是兼容读取的可选显示名，没有就用 id。
    const label = m.display_name ?? m.name
    const name = typeof label === "string" && label.length > 0 && label.length <= 200 ? label : id
    out[id] = { id, name }
  }
  return out
}

// 模型发现：GET <代理>/v1/models，与安装脚本的探活同口径（Bearer 票据 + 设备头）。
// 期限覆盖响应头和整个正文。正文按实际收到的字节数累计，超过上限立刻取消流。
export async function listModels({ state, fetchImpl = fetch, signal, timeoutMs = 15000 }) {
  assertDirectFetch()
  if (!PROXY_BASE_RE.test(state?.baseUrl) || !state?.credential) throw new SafeError("base_url_rejected")
  // 调用方已经取消：不连代理，原样传播取消原因。
  if (signal?.aborted) throw signal.reason
  const ctrl = new AbortController()
  let timedOut = false
  const onAbort = () => ctrl.abort(signal.reason)
  signal?.addEventListener?.("abort", onAbort, { once: true })
  const timer = setTimeout(() => { timedOut = true; ctrl.abort() }, timeoutMs)
  const finish = () => { clearTimeout(timer); signal?.removeEventListener?.("abort", onAbort) }
  const fail = (code, detail = "") => {
    finish()
    if (signal?.aborted && !timedOut) throw signal.reason
    throw new SafeError(code, detail)
  }

  let res
  try {
    res = await fetchImpl(state.baseUrl + "/v1/models", { headers: modelHeaders(state), signal: ctrl.signal, redirect: "error", proxy: false })
  } catch (e) {
    fail(isRedirectError(e) ? "redirect_refused" : "proxy_unreachable", timedOut ? "（超时）" : "")
  }
  if (signal?.aborted) {
    finish()
    void cancelBody(res)
    throw signal.reason
  }
  if (res.status >= 300 && res.status < 400) { await cancelBody(res); return fail("redirect_refused") }
  if (!res.ok) { await cancelBody(res); return fail("models_failed", `（HTTP ${res.status}）`) }

  let reader
  try { reader = res.body?.getReader() } catch { reader = undefined }
  if (!reader) { finish(); throw new SafeError("models_invalid") }

  const decoder = new TextDecoder()
  const parts = []
  let received = 0
  let failure
  const stop = async (code, detail) => { await reader.cancel().catch(() => {}); failure = [code, detail] }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > MAX_MODELS_BODY) { await stop("models_invalid", "（超过 1 MiB）"); break }
      parts.push(value)
    }
  } catch {
    // 期限到了、调用方取消，或连接中断。
    await reader.cancel().catch(() => {})
    failure = [timedOut ? "models_failed" : "proxy_unreachable", timedOut ? "（超时）" : ""]
  }
  // 在 try 之外抛出，免得自己抛出的错误被上面的 catch 接住换成别的错误码。
  if (failure) return fail(...failure)
  finish()
  let text
  try { text = decoder.decode(concat(parts, received)) } catch { throw new SafeError("models_invalid") }
  let json
  try { json = JSON.parse(text) } catch { throw new SafeError("models_invalid") }
  return parseModels(json)
}

function concat(parts, length) {
  if (parts.length === 1) return parts[0]
  const out = new Uint8Array(length)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.byteLength }
  return out
}
