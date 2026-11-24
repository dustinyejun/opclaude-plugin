// 测试台：假的 opclauded（bash 脚本）+ 本机回环 mock 代理。只用模拟票据，不碰任何真实凭据。
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { MIN_BUN, bunSupportsProxyFalse } from "../lib/transport.mjs"

// 插件要求 Bun >= 1.4.3（fetch 的 proxy: false 才生效）。旧版本下不跑用例，直接说明原因。
if (!bunSupportsProxyFalse()) {
  console.error(`需要 Bun >= ${MIN_BUN}，当前 ${Bun.version}。请用兼容的 Bun 运行，例如 MAGPIE_BUN=... && "$MAGPIE_BUN" test`)
  process.exit(2)
}

export const PROXY_PORTS = Array.from({ length: 10 }, (_, i) => 18827 + i)

const FAKE = `#!/bin/bash
d="$(cd "$(dirname "$0")/.." && pwd)/state"
mode="$(cat "$d/mode" 2>/dev/null || echo proxy)"
if [ "$1" != launch ] || [ "$2" != --home ] || [ "$4" != --min-protocol ] || [ "$5" != 1 ]; then
  printf 'usage\\n' >&2; exit 64
fi
printf '%s|%s|%s|%s\\n' "$2" "$3" "$4" "$5" > "$d/last-args"
env | cut -d= -f1 | sort > "$d/last-env"
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
export async function makeRig({ dir = "" } = {}) {
  dir = dir || await mkdtemp(path.join(tmpdir(), "opclaude-rig-"))
  const state = path.join(dir, "state")
  await mkdir(path.join(dir, "bin"), { recursive: true })
  await mkdir(state, { recursive: true })
  const bin = path.join(dir, "bin", "opclauded")
  if (!process.env.OC_RIG_KEEP_BIN) await writeFile(bin, FAKE)
  await chmod(bin, 0o755)

  const st = {
    mode: "proxy",
    port: "",
    ticket: "ticket-A-fake",
    device: "device-fake",
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

  const seen = { proxy: [], elsewhere: [], body: "" }
  let hits = 0
  const names = (req) => [...req.headers.keys()].map((k) => k.toLowerCase()).sort()
  let elsewhere, server
  const handler = async (req) => {
    const url = new URL(req.url)
    const device = req.headers.get("x-opusclaude-device")
    const authed = req.headers.get("authorization") === `Bearer ${st.proxyTicket || st.ticket}`
    seen.proxy.push({ method: req.method, path: url.pathname + url.search, headers: names(req), authed, device, app: req.headers.get("x-app"), model: "", port: server?.port })
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
      const body = await req.text()
      return Response.json({ input_tokens: body.length })
    }
    if (st.hang) return new Response(new ReadableStream({ start(c) { c.enqueue(encoder.encode("event: message_start\ndata: {}\n\n")) } }), { headers: { "content-type": "text/event-stream" } })
    if (url.pathname === "/v1/messages") {
      seen.body = await req.text()
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
      return new Response("nope", { status: 404 })
    },
  })
  server = await listenFree()
  if (!server) throw new Error("no free proxy port in 18827-18836")
  st.port = String(server.port)
  await sync()

  return {
    dir, state, bin, st, seen, sync, fakeSource: FAKE, sse: SSE,
    ctlPort: ctl.port,
    /** 端口监听器：并发测试用它确认两个 rig 不会选中同一个端口。 */
    get listener() { return server },
    get port() { return server?.port ?? 0 },
    opusHome: path.join(dir, "home"),
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
