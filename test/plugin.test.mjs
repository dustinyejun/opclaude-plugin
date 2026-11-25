import { spawn } from "node:child_process"
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import entry from "../index.mjs"
import { createPlugin, LOCAL_MARKER, PROVIDER } from "../lib/plugin.mjs"
import { FAILURE_STATUS, MIN_BUN, PLACEHOLDER_BASE, assertDirectFetch, bunSupportsProxyFalse, errorBody, forward, parseModels } from "../lib/transport.mjs"
import { runLaunch } from "../lib/launch.mjs"
import { PROXY_PORTS, makeRig } from "./rig.mjs"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

let rig, hooks, realHome, realOpusclaudeHome
// 进程的 HOME 指向测试台：插件的子进程环境从 process.env 取 HOME / PATH，这样任何用例都碰不到当前用户的真实安装。
beforeAll(async () => {
  realHome = process.env.HOME
  realOpusclaudeHome = process.env.OPUSCLAUDE_HOME
  delete process.env.OPUSCLAUDE_HOME
  rig = await makeRig()
  process.env.HOME = rig.dir
})
afterAll(async () => {
  process.env.HOME = realHome
  if (realOpusclaudeHome !== undefined) process.env.OPUSCLAUDE_HOME = realOpusclaudeHome
  await rig.close()
})
beforeEach(async () => {
  delete rig.st.proxyTicket
  Object.assign(rig.st, { mode: "proxy", ticket: "ticket-A-fake", device: "device-fake", delayMs: 0, status: 200, redirect: 0, hang: 0, echoError: 0, bodyDelayMs: 0, bigBody: 0, batchDelay: 0, statusText: "", openError: 0, jsonEsc: 0, echoSuccess: 0 })
  await rig.sync()
  rig.seen.proxy.length = 0
  rig.seen.elsewhere.length = 0
})
const settings = () => ({ opclauded: rig.bin, opusHome: rig.opusHome })
// auth 省略时用默认的本地标记；env 省略时用测试台的进程环境（HOME 指向测试台）。
const loader = async (opts, auth = { type: "api", key: LOCAL_MARKER }, env = process.env) => {
  hooks = createPlugin(opts, { env, launcherDirs: rig.dirs })
  return await hooks.auth.loader(async () => auth)
}
const msg = (extra = {}) => ({ model: "claude-fable-5-2", max_tokens: 64, stream: true, messages: [{ role: "user", content: "hi" }], tools: [{ name: "get_time", description: "t", input_schema: { type: "object", properties: {} } }], ...extra })
const URL_ = (p = "/messages") => PLACEHOLDER_BASE + p
const init = (body, extra = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "anthropic-beta": "fine-grained-tool-streaming-2025-05-14", "x-api-key": LOCAL_MARKER, "x-magpie-caller-agent": "claude", "x-magpie-caller-via": "MacBook-Pro", accept: "text/event-stream" },
  body: JSON.stringify(body),
  ...extra,
})
const attempt = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }))
const SECRETS = ["ticket-A-fake", "ticket-B-fake", "sk-upstream-fake", "device-fake", "SECRET-STDERR-TICKET"]
const EXTRA_HEADERS = ["user-agent", "x-app", "accept-encoding", "accept-language", "sec-fetch-mode", "content-length", "connection", "host"]

// 统计真实发往网络的请求。
function watchFetch() {
  const orig = globalThis.fetch
  const calls = []
  globalThis.fetch = (input, i) => { calls.push({ url: String(input), redirect: i?.redirect }); return orig(input, i) }
  return { calls, restore: () => { globalThis.fetch = orig } }
}

// 按完整事件边界（空行）增量解析 SSE。同一个读取器可以分几次读，直到满足条件为止。
function sseReader(res) {
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const events = []
  let buffer = ""
  let ended = false
  return {
    events,
    get ended() { return ended },
    async read(until) {
      for (;;) {
        let at
        while ((at = buffer.indexOf("\n\n")) >= 0) {
          const raw = buffer.slice(0, at)
          buffer = buffer.slice(at + 2)
          const event = /^event: (.+)$/m.exec(raw)?.[1]
          const data = /^data: (.+)$/m.exec(raw)?.[1]
          if (!event || !data) throw new Error("incomplete SSE frame: " + JSON.stringify(raw))
          events.push({ event, data: JSON.parse(data) })
        }
        if (until(events)) return
        const { done, value } = await reader.read()
        if (done) { ended = true; return }
        buffer += decoder.decode(value, { stream: true })
      }
    },
  }
}

describe("插件注册与发现", () => {
  test("入口以 server(input, options) 加载：选项来自第二参数，包名与入口符合约定", async () => {
    const pkg = await Bun.file("package.json").json()
    expect(pkg.name).toBe("opclaude-plugin")
    expect(pkg.main).toBe("./index.mjs")
    expect(entry.id).toBe(PROVIDER)
    expect(typeof entry.server).toBe("function")
    expect(Object.keys(entry).sort()).toEqual(["id", "server"])
    const h = await entry.server({ client: {} }, undefined)
    expect(h.auth.provider).toBe(PROVIDER)
    expect(h.provider.id).toBe(PROVIDER)
    expect(h.auth.methods[0].prompts.length).toBe(0)
    // 选项写在第二参数：旧的显式路径照常可用，两个钩子照常可用
    const configured = await entry.server({ client: {}, directory: "/not/options" }, { ...settings(), proxyHome: "/tmp/oc-proxy-home" })
    expect(configured.auth.methods[0].prompts.map((p) => p.key)).toEqual([])
    const ok = await configured.auth.methods[0].authorize(undefined)
    expect(ok).toMatchObject({ type: "success", key: LOCAL_MARKER })
    // 第一参数是运行环境，不会被当成选项
    const wrong = await entry.server({ opclauded: rig.bin, opusHome: rig.opusHome }, undefined)
    expect(wrong.auth.methods[0].prompts.length).toBe(0)
  })
  test("config 声明原生 Anthropic 协议，不覆盖用户已有配置", async () => {
    const h = await entry.server({})
    const cfg = {}
    await h.config(cfg)
    expect(cfg.provider[PROVIDER]).toMatchObject({ npm: "@ai-sdk/anthropic", api: PLACEHOLDER_BASE })
    const mine = { name: "mine" }
    await h.config({ provider: { [PROVIDER]: mine } })
    expect(mine.name).toBe("mine")
  })
  test("登录保存的是固定本地标记：票据不进日志、返回或保存的 key", async () => {
    const h = await entry.server({})
    const method = h.auth.methods[0]
    expect(method.type).toBe("api")
    const logs = []
    const spies = [spyOn(console, "log"), spyOn(console, "error"), spyOn(console, "info"), spyOn(console, "warn"), spyOn(process.stderr, "write"), spyOn(process.stdout, "write")]
    spies.forEach((s) => s.mockImplementation((...a) => { logs.push(a.map(String).join(" ")); return true }))
    try {
      const ok = await method.authorize({ opclauded: rig.bin, opusHome: rig.opusHome })
      expect(ok).toEqual({ type: "success", key: LOCAL_MARKER, accountId: "host-proxy", metadata: { opclauded: rig.bin, opusHome: rig.opusHome } })
      expect(ok.key).not.toContain("ticket")
      rig.st.mode = "direct"; await rig.sync()
      const bad = await method.authorize({ opclauded: rig.bin, opusHome: rig.opusHome })
      expect(bad.type).toBe("failed")
      expect(bad.error).toContain("mode_direct")
      expect(await method.authorize({ opclauded: "relative/path", opusHome: rig.opusHome })).toMatchObject({ type: "failed" })
    } finally { spies.forEach((s) => s.mockRestore()) }
    expect(SECRETS.some((s) => logs.join("\n").includes(s))).toBe(false)
  })
  test("已配置路径时登录直接验证：指纹不符会阻止执行，票据无效时登录失败", async () => {
    const good = await entry.server({}, { ...settings(), opclaudedSha256: "0".repeat(64) })
    const refused = await good.auth.methods[0].authorize(undefined)
    expect(refused).toMatchObject({ type: "failed", error: expect.stringContaining("sha256_mismatch") })
    rig.st.mode = "direct"; await rig.sync()
    expect(await (await entry.server({}, settings())).auth.methods[0].authorize(undefined)).toMatchObject({ type: "failed", error: expect.stringContaining("mode_direct") })
    rig.st.mode = "proxy"; await rig.sync()
    expect(await (await entry.server({}, settings())).auth.methods[0].authorize(undefined)).toMatchObject({ type: "success" })
  })
  test("模型目录来自本机代理 /v1/models", async () => {
    hooks = createPlugin(settings())
    const list = await hooks.provider.models({ models: { "claude-sonnet-5-5": { limit: { context: 1 } } } }, {})
    expect(list).toEqual({
      "claude-fable-5-2": { id: "claude-fable-5-2", name: "Fable 5.2" },
      "claude-sonnet-5-5": { limit: { context: 1 }, id: "claude-sonnet-5-5", name: "claude-sonnet-5-5" },
    })
    expect(rig.seen.proxy.at(-1)).toMatchObject({ method: "GET", path: "/v1/models", authed: true })
    rig.st.ticket = "ticket-B-fake"; await rig.sync()
    expect(Object.keys(await hooks.provider.models({ models: {} }, {})).length).toBe(2)
    expect(rig.seen.proxy.every((r) => r.authed)).toBe(true)
  })
  test("/v1/models 规范化：id 必填，显示名是兼容读取的可选字段，拒绝畸形清单", () => {
    expect(parseModels({ data: [{ id: "a", display_name: "A" }, { id: "b", name: "B" }, { id: "c" }] })).toEqual({ a: { id: "a", name: "A" }, b: { id: "b", name: "B" }, c: { id: "c", name: "c" } })
    for (const j of [{}, { data: {} }, { data: [{ id: "" }] }, { data: [{ id: "a b" }] }, { data: [{ id: "a" }, { id: "a" }] }, { data: [{ id: 1 }] }]) {
      expect(() => parseModels(j)).toThrow()
    }
  })
})

describe("模型发现的期限与体积上限", () => {
  test("期限覆盖正文读取：慢正文超时失败，流被取消，零重试", async () => {
    const { listModels } = await import("../lib/transport.mjs")
    const state = { baseUrl: `http://127.0.0.1:${rig.port}`, credential: "ticket-A-fake", deviceId: "device-fake", cliVersion: "2.1.284" }
    let stopped = false
    // 模拟的真实 fetch：尊重传入的 signal，中止时让正文流出错。
    const fetchImpl = async (u, i) => new Response(new ReadableStream({
      async start(c) {
        i.signal.addEventListener("abort", () => { stopped = true; c.error(i.signal.reason) }, { once: true })
        c.enqueue(new TextEncoder().encode('{"data":['))
        await Bun.sleep(5000)
        c.enqueue(new TextEncoder().encode("]}"))
        c.close()
      },
      cancel() { stopped = true },
    }), { headers: { "content-type": "application/json" } })
    const t0 = Date.now()
    const { e } = await attempt(listModels({ state, fetchImpl, timeoutMs: 200 }))
    expect(e.code).toBe("models_failed")
    expect(e.message).toContain("超时")
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(stopped).toBe(true)
  })
  test("慢正文在期限之内正常完成", async () => {
    hooks = createPlugin(settings())
    rig.st.bodyDelayMs = 30; await rig.sync()
    expect(Object.keys(await hooks.provider.models({ models: {} }, {})).length).toBe(2)
  })
  test("没有 Content-Length 的超大正文按实际字节累计，超限立刻取消", async () => {
    hooks = createPlugin(settings())
    rig.st.bigBody = 1200024; rig.st.bodyDelayMs = 5; await rig.sync()
    const t0 = Date.now()
    const { e } = await attempt(hooks.provider.models({ models: {} }, {}))
    expect(e.code).toBe("models_invalid")
    expect(e.message).toContain("1 MiB")
    expect(Date.now() - t0).toBeLessThan(8000)
  })
  test("多字节正文按字节而不是字符计数", async () => {
    const { listModels } = await import("../lib/transport.mjs")
    // 3 字节一个汉字：按字符数只有上限的三分之一，按字节刚好超限。
    const state = { baseUrl: `http://127.0.0.1:${rig.port}`, credential: "ticket-A-fake", deviceId: "device-fake", cliVersion: "2.1.284" }
    let cancelled = false
    const fetchImpl = async (u, i) => new Response(new ReadableStream({
      pull(c) { c.enqueue(new TextEncoder().encode("汉".repeat(20000))) },
      cancel() { cancelled = true },
    }))
    const { e } = await attempt(listModels({ state, fetchImpl }))
    expect(e.code).toBe("models_invalid")
    expect(cancelled).toBe(true)
  })
  test("调用方取消：发现任务立刻结束并保持取消语义", async () => {
    hooks = createPlugin(settings())
    rig.st.bodyDelayMs = 5000; await rig.sync()
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 150)
    const { e } = await attempt(hooks.provider.models({ models: {} }, { signal: ctrl.signal }))
    expect(ctrl.signal.aborted).toBe(true)
    expect(e.name === "AbortError" || /abort/i.test(e.message)).toBe(true)
  })
})

describe("转发", () => {
  test("流式 SSE 分批到达：响应结束前已读到完整事件，工具参数拼得出来，最后一条是 message_stop", async () => {
    const l = await loader(settings())
    rig.st.batchDelay = 80; await rig.sync()
    const res = await l.fetch(URL_(), init(msg()))
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("text/event-stream")
    const sse = sseReader(res)
    await sse.read((ev) => ev.some((x) => x.event === "content_block_start"))
    expect(sse.ended).toBe(false)
    expect(sse.events.map((x) => x.event)).toEqual(["message_start", "content_block_start"])
    await sse.read(() => false)
    expect(sse.ended).toBe(true)
    const all = sse.events
    const tool = all.find((x) => x.event === "content_block_start").data.content_block
    expect(tool).toMatchObject({ type: "tool_use", id: "toolu_1", name: "get_time" })
    const args = all.filter((x) => x.event === "content_block_delta").map((x) => x.data.delta.partial_json).join("")
    expect(JSON.parse(args)).toEqual({ tz: "Asia/Shanghai" })
    expect(all.find((x) => x.event === "message_delta").data.delta.stop_reason).toBe("tool_use")
    // 协议头与设备头的断言看模拟代理的收包记录，不看响应里的回显
    const sent = rig.seen.proxy[0].headers.filter((h) => !EXTRA_HEADERS.includes(h))
    expect(sent).toEqual(["accept", "anthropic-beta", "anthropic-version", "authorization", "content-type", "x-opusclaude-device"])
    expect(rig.seen.proxy[0].model).toBe("claude-fable-5-2")
  })
  test("非流式与 /messages/count_tokens 按协议转发", async () => {
    const l = await loader(settings())
    const r = await l.fetch(URL_(), init(msg({ stream: false }), { headers: { "content-type": "application/json" } }))
    expect(await r.json()).toMatchObject({ role: "assistant", stop_reason: "end_turn" })
    const c = await l.fetch(URL_("/messages/count_tokens?beta=true"), init({ model: "claude-fable-5-2", messages: [] }))
    expect(c.status).toBe(200)
    expect((await c.json()).input_tokens).toBeGreaterThan(0)
    expect(rig.seen.proxy.at(-1).path).toBe("/v1/messages/count_tokens?beta=true")
  })
  test("生成请求没有首包超时：响应头晚到也照常成功", async () => {
    const l = await loader(settings())
    rig.st.delayMs = 1300; await rig.sync()
    const r = await l.fetch(URL_(), init(msg({ stream: false })))
    expect(r.status).toBe(200)
    expect((await r.json()).stop_reason).toBe("end_turn")
  })
  test("票据 / 设备 / 线路（代理端口）切换与代理重启：每次请求重新解析，无需重新登录", async () => {
    const l = await loader(settings())
    const old = rig.port
    expect((await l.fetch(URL_(), init(msg({ stream: false })))).status).toBe(200)
    rig.st.ticket = "ticket-B-fake"; rig.st.device = "device-B"
    await rig.sync()
    const r2 = await l.fetch(URL_(), init(msg({ stream: false })))
    expect(r2.status).toBe(200)
    expect(rig.seen.proxy.at(-1).device).toBe("device-B")
    // 代理重启到白名单内另一个能绑定的端口
    const next = await rig.rebindFree()
    expect(next).toBeGreaterThan(0)
    expect(next).not.toBe(old)
    const r3 = await l.fetch(URL_(), init(msg({ stream: false })))
    expect(r3.status).toBe(200)
    expect(rig.seen.proxy.map((r) => [r.port, r.authed])).toEqual([[old, true], [old, true], [next, true]])
  })
  test("设备头始终来自当次运行态：请求方自带的设备头被替换", async () => {
    const l = await loader(settings())
    const r = await l.fetch(URL_(), init(msg({ stream: false }), { headers: { "content-type": "application/json", "X-OpusClaude-Device": "spoofed-by-caller" } }))
    expect(rig.seen.proxy.at(-1).device).toBe("device-fake")
    rig.st.device = "device-B"; await rig.sync()
    const swapped = await l.fetch(URL_(), init(msg({ stream: false }), { headers: { "content-type": "application/json", "X-OpusClaude-Device": "spoofed-by-caller" } }))
    expect(swapped.status).toBe(200)
    expect(rig.seen.proxy.at(-1).device).toBe("device-B")
    // 运行态没有设备 ID：请求方的设备头不会透传
    rig.st.mode = "nodevice"; await rig.sync()
    const none = await l.fetch(URL_(), init(msg({ stream: false }), { headers: { "content-type": "application/json", "X-OpusClaude-Device": "spoofed-by-caller" } }))
    expect(none.status).toBe(200)
    expect(rig.seen.proxy.at(-1).device).toBeNull()
    // 模型发现同样不带请求方的设备头，也不会带上一个与生成不一致的身份
    await hooks.provider.models({ models: {} }, {})
    expect(rig.seen.proxy.at(-1).device).toBeNull()
  })
  test("代理不可用（未运行）：返回带固定错误码的 Anthropic 错误，只尝试一次，恢复后下一条请求正常", async () => {
    const w = watchFetch()
    try {
      const l = await loader(settings())
      rig.stop()
      const res = await l.fetch(URL_(), init(msg()))
      expect(res.status).toBe(FAILURE_STATUS)
      expect(res.headers.get("content-type")).toBe("application/json")
      const body = await res.json()
      expect(body).toMatchObject({ type: "error", error: { type: "invalid_request_error", message: expect.stringContaining("[opclaude:proxy_unreachable]") } })
      expect(w.calls.length).toBe(1)
      expect(w.calls[0].redirect).toBe("error")
      expect(await attempt(hooks.provider.models({ models: {} }, {}))).toMatchObject({ ok: false, e: { code: "proxy_unreachable" } })
      expect(w.calls.length).toBe(2)
      rig.rebind(Number(rig.st.port))
      expect((await l.fetch(URL_(), init(msg({ stream: false })))).status).toBe(200)
    } finally { w.restore(); if (!rig.port) await rig.rebindFree() }
  })
  test("direct、非法地址、输出无法识别、协议不兼容：及时返回固定错误码，模拟代理零次请求", async () => {
    const w = watchFetch()
    try {
      const l = await loader(settings())
      for (const [mode, c] of [["direct", "mode_direct"], ["badport", "base_url_rejected"], ["public", "base_url_rejected"], ["garbage", "launch_output_invalid"], ["proto0", "protocol_mismatch"], ["proto2x", "protocol_mismatch"], ["singlequote", "launch_output_invalid"]]) {
        rig.st.mode = mode; await rig.sync()
        const t0 = Date.now()
        const res = await l.fetch(URL_(), init(msg()))
        expect(res.status).toBe(FAILURE_STATUS)
        const body = await res.text()
        expect(body).toContain(`[opclaude:${c}]`)
        expect(body).toContain('"type":"error"')
        expect(SECRETS.some((s) => body.includes(s)), mode).toBe(false)
        expect(body).not.toMatch(/https?:\/\//)
        expect(Date.now() - t0, mode).toBeLessThan(5000)
        expect((await attempt(hooks.provider.models({ models: {} }, {}))).e.code, mode).toBe(c)
      }
    } finally { w.restore(); rig.st.mode = "proxy"; await rig.sync() }
    expect(w.calls.length).toBe(0)
    expect(rig.seen.proxy.length).toBe(0)
  })
  test("没有安装（空的 HOME）：请求方给不了目标，也没有任何请求发出", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "opclaude-empty-"))
    try {
      const hooks = createPlugin({}, { env: { ...process.env, HOME: empty }, launcherDirs: [] })
      const l = await hooks.auth.loader(async () => ({ type: "api", key: LOCAL_MARKER }))
      const res = await l.fetch(URL_(), init(msg()))
      expect(res.status).toBe(FAILURE_STATUS)
      expect(await res.text()).toContain("[opclaude:launcher_not_found]")
    } finally { await rm(empty, { recursive: true, force: true }) }
    const l3 = await loader({ opclauded: "opclauded; id", opusHome: rig.opusHome })
    expect(await (await l3.fetch(URL_(), init(msg()))).text()).toContain("[opclaude:path_invalid]")
    expect(rig.seen.proxy.length).toBe(0)
  })
  test("插件选项与登录元数据都能提供设置，元数据优先", async () => {
    const l = await loader({}, { type: "api", key: LOCAL_MARKER, metadata: { opclauded: rig.bin, opusHome: rig.opusHome } })
    expect((await l.fetch(URL_(), init(msg({ stream: false })))).status).toBe(200)
    const l2 = await loader(settings(), { type: "api", key: LOCAL_MARKER, metadata: { opclauded: "/nonexistent/opclauded" } })
    expect(await (await l2.fetch(URL_(), init(msg()))).text()).toContain("[opclaude:binary_missing]")
  })
  test("请求取消原样传给本机代理（流式正文进行中），已取消的请求不会发出", async () => {
    const l = await loader(settings())
    rig.st.hang = 1; await rig.sync()
    const ctrl = new AbortController()
    const t0 = Date.now()
    const r = await l.fetch(URL_(), init(msg(), { signal: ctrl.signal }))
    ctrl.abort()
    const { ok, e } = await attempt(r.text())
    expect(ok).toBe(false)
    expect(e.name === "AbortError" || /abort/i.test(e.message)).toBe(true)
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(rig.seen.proxy.length).toBe(1)
    const dead = new AbortController()
    dead.abort()
    const pre = await attempt(l.fetch(URL_(), init(msg(), { signal: dead.signal })))
    expect(pre.ok).toBe(false)
    expect(rig.seen.proxy.length).toBe(1)
  })
  test("端点边界：非占位地址、其它路径、非 POST 一律拒绝", async () => {
    const l = await loader(settings())
    const cases = [
      ["https://api.opusapi.xyz/v1/messages", {}],
      [`http://127.0.0.1:${rig.port}/v1/messages`, {}],
      ["http://127.0.0.1:1/api/auth", {}],
      ["http://127.0.0.1:1/v1/models", {}],
      ["http://127.0.0.1:1/v1/messages/../models", {}],
      ["http://user:pw@127.0.0.1:1/v1/messages", {}],
      ["http://127.1.1.1:1/v1/messages", {}],
      ["http://localhost:1/v1/messages", {}],
      ["http://127.0.0.1:1/v1/messages", { method: "GET" }],
      ["not a url", {}],
    ]
    for (const [url, extra] of cases) {
      const res = await l.fetch(url, init(msg(), extra))
      expect(res.status, url).toBe(FAILURE_STATUS)
      expect(await res.text(), url).toContain("[opclaude:target_rejected]")
    }
    expect(rig.seen.proxy.length).toBe(0)
  })
  test("HTTP 跳转：拒绝跟随，被指向的别处收不到任何东西", async () => {
    const l = await loader(settings())
    rig.st.redirect = 1; await rig.sync()
    for (const path of ["/messages", "/messages/count_tokens"]) {
      expect(await (await l.fetch(URL_(path), init(msg()))).text()).toContain("[opclaude:redirect_refused]")
    }
    expect((await attempt(hooks.provider.models({ models: {} }, {}))).e.code).toBe("redirect_refused")
    expect(rig.seen.proxy.length).toBe(3)
    expect(rig.seen.elsewhere.length).toBe(0)
  })
  test("上游错误正文与头部回显票据时：换成固定 Anthropic 错误，敏感头被去掉，状态码与重试信息保留", async () => {
    const l = await loader(settings())
    rig.st.ticket = "rotated-fake"; rig.st.proxyTicket = "ticket-A-fake"; await rig.sync()
    for (const path of ["/messages", "/messages/count_tokens"]) {
      const r = await l.fetch(URL_(path), init({ model: "m", messages: [] }))
      expect(r.status).toBe(401)
      const text = await r.text()
      expect(text).toContain(`[opclaude:upstream_error]`)
      expect(text).toContain("HTTP 401")
      expect(SECRETS.concat(["rotated-fake"]).some((s) => text.includes(s) || [...r.headers.values()].some((v) => v.includes(s)))).toBe(false)
      expect(r.headers.get("x-echo-ticket")).toBeNull()
      expect(r.headers.get("x-magpie-sign-in")).toBe("kept")
    }
  })
  test("上游普通错误：保留供应商原话、状态码与 Retry-After，去掉 Cookie 与 WWW-Authenticate", async () => {
    const l = await loader(settings())
    rig.st.status = 429; rig.st.echoError = 0; await rig.sync()
    const r = await l.fetch(URL_(), init(msg({ stream: false })))
    expect(r.status).toBe(429)
    const body = await r.text()
    expect(body).toContain("the model is not available on this plan")
    expect(JSON.parse(body)).toMatchObject({ type: "error", error: { type: "api_error" } })
    expect(r.headers.get("retry-after")).toBe("7")
    expect(r.headers.get("set-cookie")).toBeNull()
    expect(r.headers.get("www-authenticate")).toBeNull()
    expect(SECRETS.some((s) => body.includes(s) || [...r.headers.values()].some((v) => v.includes(s)))).toBe(false)
  })
  test("上游错误回显票据或设备 ID 时换成固定错误", async () => {
    const l = await loader(settings())
    rig.st.status = 503; await rig.sync()
    rig.st.echoError = 1; await rig.sync()
    const r = await l.fetch(URL_(), init(msg({ stream: false })))
    const text = await r.text()
    expect(r.status).toBe(503)
    // 上游的状态文本不交还
    expect(r.statusText).toBe("")
    expect(text).toContain("[opclaude:upstream_error]")
    expect(SECRETS.some((s) => text.includes(s) || [...r.headers.values()].some((v) => v.includes(s)))).toBe(false)
  })
  test("上游错误正文超过上限时换成固定错误", async () => {
    const { forward } = await import("../lib/transport.mjs")
    const state = { baseUrl: `http://127.0.0.1:${rig.port}`, credential: "ticket-A-fake", deviceId: "device-fake", cliVersion: "2.1.284" }
    const fetchImpl = async () => new Response("x".repeat(70000), { status: 500 })
    const r = await forward({ input: URL_(), init: init(msg()), state, fetchImpl })
    expect(await r.text()).toContain("[opclaude:upstream_error]")
  })
  test("上游状态文本回显票据：不交还调用方", async () => {
    const l = await loader(settings())
    rig.st.status = 401; rig.st.statusText = `bad ticket ticket-A-fake`; await rig.sync()
    const r = await l.fetch(URL_(), init(msg({ stream: false })))
    const text = await r.text()
    expect(r.status).toBe(401)
    expect(r.statusText).toBe("")
    expect(text).not.toContain("ticket-A-fake")
  })
  test("上游 JSON 错误的原话里带转义或引号包着的票据：解码后查出，换成固定错误", async () => {
    const l = await loader(settings())
    rig.st.status = 529; rig.st.jsonEsc = 1; await rig.sync()
    const r = await l.fetch(URL_(), init(msg({ stream: false })))
    const text = await r.text()
    expect(r.status).toBe(529)
    const body = JSON.parse(text)
    expect(body.error.message).toBe("[opclaude:upstream_error] 本机代理返回 HTTP 529")
    expect(JSON.stringify(body)).not.toContain("ticket-A-fake")
    expect(JSON.stringify(body)).not.toContain("device-fake")
    expect(body.request_id).toBeUndefined()
    expect(r.headers.get("retry-after")).toBe("7")
  })
  test("上游错误正文到期：切断读取并释放流，及时返回固定错误，保留状态码与 Retry-After", async () => {
    const state = { baseUrl: `http://127.0.0.1:${rig.port}`, credential: "ticket-A-fake", deviceId: "device-fake", cliVersion: "2.1.284" }
    let cancelled = 0
    const encoder = new TextEncoder()
    const stream = new ReadableStream({ start(c) { c.enqueue(encoder.encode('{"type":"error","error":{"type":"rate_limit_error","message":"slow')) }, cancel() { cancelled += 1 } })
    const fetchImpl = async () => new Response(stream, { status: 429, headers: { "content-type": "application/json", "retry-after": "7" } })
    const t0 = Date.now()
    const r = await forward({ input: URL_(), init: init(msg()), state, fetchImpl, errorBodyTimeoutMs: 300 })
    const body = await r.json()
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(r.status).toBe(429)
    expect(r.headers.get("retry-after")).toBe("7")
    expect(body.error.message).toBe("[opclaude:upstream_error] 本机代理返回 HTTP 429")
    expect(cancelled).toBe(1)
    expect(rig.seen.proxy.length).toBe(0)
  })
  test("读上游错误正文时调用方取消：中断读取、释放流，并原样传播取消原因", async () => {
    const state = { baseUrl: `http://127.0.0.1:${rig.port}`, credential: "ticket-A-fake", deviceId: "device-fake", cliVersion: "2.1.284" }
    let cancelled = 0
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"type":"error"')) }, cancel() { cancelled += 1 } })
    const fetchImpl = async () => new Response(stream, { status: 429 })
    const ctrl = new AbortController()
    const reason = new Error("caller went away")
    const p = forward({ input: URL_(), init: init(msg(), { signal: ctrl.signal }), state, fetchImpl })
    await Bun.sleep(50)
    ctrl.abort(reason)
    const t0 = Date.now()
    const r = await attempt(p)
    expect(r.ok).toBe(false)
    expect(r.e).toBe(reason)
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(cancelled).toBe(1)
  })
  test("loader.fetch 收到标准 Request：方法、头、正文与信号合并后用于端点检查和转发", async () => {
    const l = await loader(settings())
    const headers = { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-app": "request-object" }
    const req = new Request(URL_(), { method: "POST", headers, body: JSON.stringify(msg({ stream: false, model: "claude-sonnet-5-5" })) })
    const r = await l.fetch(req)
    expect(r.status).toBe(200)
    expect(rig.seen.proxy.at(-1).headers).toContain("anthropic-version")
    // 请求方自带的 x-app 不外发：统一是 cli
    expect(rig.seen.proxy.at(-1).app).toBe("cli")
    expect(rig.seen.proxy.at(-1).ua).toBe("claude-cli/2.1.284 (external, cli)")
    expect(rig.seen.proxy.at(-1).model).toBe("claude-sonnet-5-5")
    expect(JSON.parse(rig.seen.body).messages[0].content).toBe("hi")
    // init 覆盖 Request 的对应项
    const r2 = await l.fetch(req, { headers: { ...headers, "x-app": "from-init", "x-init-marker": "1" }, body: JSON.stringify(msg({ stream: false, model: "claude-fable-5-2" })) })
    // init 的头确实生效（x-init-marker 到达代理）；x-app 始终是宿主机口径
    expect(rig.seen.proxy.at(-1).app).toBe("cli")
    expect(rig.seen.proxy.at(-1).headers).toContain("x-init-marker")
    expect(rig.seen.proxy.at(-1).model).toBe("claude-fable-5-2")
  })
  test("标准 Request 用原生合并语义：init 的头整体替换，init 的信号替换旧信号", async () => {
    const l = await loader(settings())
    const base = { method: "POST", headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "anthropic-beta": "old-option" } }
    const body = () => JSON.stringify(msg({ stream: false }))
    // 1. init 给了新头：旧请求头整体被替换，与原生 new Request(req, init) 一致
    const req = new Request(URL_(), { ...base, body: body() })
    const native = new Request(req, { headers: { "content-type": "application/json" } })
    const r = await l.fetch(req, { headers: { "content-type": "application/json" }, body: body() })
    expect(r.status).toBe(200)
    expect(rig.seen.proxy.at(-1).headers.filter((h) => h.startsWith("anthropic-"))).toEqual([...native.headers.keys()].filter((h) => h.startsWith("anthropic-")))
    expect(rig.seen.proxy.at(-1).headers).not.toContain("anthropic-beta")
    // 2. 旧 Request 的信号已取消，init 给了新的信号：按原生语义请求照常发出
    const old = new AbortController()
    old.abort(new Error("stale cancel"))
    const stale = new Request(URL_(), { ...base, body: body(), signal: old.signal })
    const fresh = new AbortController()
    expect(new Request(stale, { body: body(), signal: fresh.signal }).signal.aborted).toBe(false)
    expect((await l.fetch(stale, { body: body(), signal: fresh.signal })).status).toBe(200)
    // 3. 旧 Request 未取消，init 给了已取消的信号：不启动 launch，不连代理
    const dead = new AbortController()
    dead.abort(new Error("replaced by a cancelled signal"))
    const stamp = path.join(rig.state, "last-args")
    const before = rig.seen.proxy.length
    const live = new Request(URL_(), { ...base, body: body() })
    const { ok, e } = await attempt(l.fetch(live, { body: body(), signal: dead.signal }))
    expect(ok).toBe(false)
    expect(e.message).toBe("replaced by a cancelled signal")
    expect(rig.seen.proxy.length).toBe(before)
    // 4. init 为空对象：沿用 Request 自带的头、正文和信号
    expect((await l.fetch(new Request(URL_(), { ...base, body: body() }), {})).status).toBe(200)
    expect(rig.seen.proxy.at(-1).headers).toContain("anthropic-beta")
    // 5. Magpie 的入参形式：字符串地址 + init
    expect((await l.fetch(URL_(), init(msg({ stream: false })))).status).toBe(200)
    expect(rig.seen.proxy.at(-1).headers).toContain("anthropic-beta")
  })
  test("标准 Request 接受来自原型与不可枚举属性的 init", async () => {
    const l = await loader(settings())
    const request = () => new Request(URL_(), {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-beta": "old-option" },
      body: JSON.stringify(msg({ stream: false })),
    })
    const inherited = Object.create({ headers: { "content-type": "application/json", "x-app": "inherited" } })
    expect((await l.fetch(request(), inherited)).status).toBe(200)
    // 原型上的头也按 init.headers 读取（content-type 到达代理）；x-app 仍是宿主机口径
    expect(rig.seen.proxy.at(-1).headers).toContain("content-type")
    expect(rig.seen.proxy.at(-1).app).toBe("cli")
    expect(rig.seen.proxy.at(-1).headers).not.toContain("anthropic-beta")

    const reason = new Error("cancelled through non-enumerable init")
    Object.defineProperty(inherited, "signal", { value: AbortSignal.abort(reason) })
    expect(Object.keys(inherited)).toEqual([])
    const stamp = path.join(rig.state, "last-args")
    rmSync(stamp, { force: true })
    const before = rig.seen.proxy.length
    const result = await attempt(l.fetch(request(), inherited))
    expect(result.ok).toBe(false)
    expect(result.e).toBe(reason)
    expect(rig.seen.proxy.length).toBe(before)
    expect(existsSync(stamp)).toBe(false)
  })
  test("成功响应不回显当次票据与设备 ID：响应头和状态文本被清理，SSE 仍逐块到达", async () => {
    const l = await loader(settings())
    rig.st.echoSuccess = 1; rig.st.batchDelay = 80; await rig.sync()
    const res = await l.fetch(URL_(), init(msg()))
    expect(res.status).toBe(200)
    // Bun.serve 发出的原因短语固定是 OK（不带票据），原样保留。带票据的状态文本见本用例末尾。
    expect(res.statusText).not.toContain("ticket-A-fake")
    expect(res.headers.get("x-echo-ticket")).toBeNull()
    expect(res.headers.get("x-echo-device")).toBeNull()
    expect(res.headers.get("x-upstream")).toBe("kept")
    expect(res.headers.get("content-type")).toBe("text/event-stream")
    expect(SECRETS.some((sec) => [...res.headers.values()].some((v) => v.includes(sec)))).toBe(false)
    // 不缓冲：读到第二个事件时响应还没结束
    const sse = sseReader(res)
    await sse.read((ev) => ev.some((x) => x.event === "content_block_start"))
    expect(sse.ended).toBe(false)
    await sse.read(() => false)
    expect(sse.ended).toBe(true)
    expect(sse.events.at(-1).event).toBe("message_stop")
    expect(JSON.parse(sse.events.filter((x) => x.event === "content_block_delta").map((x) => x.data.delta.partial_json).join(""))).toEqual({ tz: "Asia/Shanghai" })
    // 设备头确实按运行态发出
    expect(rig.seen.proxy.at(-1).device).toBe("device-fake")
    // 非流式同样清理
    const r = await l.fetch(URL_(), init(msg({ stream: false })))
    expect(r.status).toBe(200)
    expect(r.headers.get("x-echo-ticket")).toBeNull()
    expect(await r.text()).toContain("end_turn")
    // 状态文本：Bun.serve 发出的原因短语固定是 OK，所以用注入的上游响应验证
    const { forward } = await import("../lib/transport.mjs")
    const state = { baseUrl: `http://127.0.0.1:${rig.port}`, credential: "ticket-A-fake", deviceId: "device-fake", cliVersion: "2.1.284" }
    const fetchImpl = async () => new Response("data: {\"type\":\"message_stop\"}\n\n", { status: 200, statusText: `ok ticket-A-fake`, headers: { "content-type": "text/event-stream", "x-echo-ticket": "Bearer ticket-A-fake", "x-device": "device-fake", "x-keep": "yes" } })
    const direct = await forward({ input: URL_(), init: init(msg()), state, fetchImpl })
    expect(direct.status).toBe(200)
    expect(direct.statusText).toBe("")
    expect(direct.headers.get("x-echo-ticket")).toBeNull()
    expect(direct.headers.get("x-device")).toBeNull()
    expect(direct.headers.get("x-keep")).toBe("yes")
    expect(await direct.text()).toContain("message_stop")
  })
  test("调用方已取消：不启动 launch，不连代理，原样传播取消原因", async () => {
    const l = await loader(settings())
    const stamp = path.join(rig.state, "last-args")
    const dead = new AbortController()
    dead.abort(new Error("gone before launch"))
    const before = rig.seen.proxy.length
    rmSync(stamp, { force: true })
    const { ok, e } = await attempt(l.fetch(new Request(URL_(), { method: "POST", body: JSON.stringify(msg()), signal: dead.signal })))
    expect(ok).toBe(false)
    expect(e.message).toBe("gone before launch")
    const r2 = await attempt(l.fetch(URL_(), init(msg(), { signal: dead.signal })))
    expect(r2.ok).toBe(false)
    expect(rig.seen.proxy.length).toBe(before)
    expect(existsSync(stamp)).toBe(false)
  })
  test("端口并发：两个模拟代理同时启动不会选中同一端口，轮换先绑新再关旧", async () => {
    const [a, b] = await Promise.all([makeRig(), makeRig()])
    try {
      expect(a.port).not.toBe(b.port)
      expect(PROXY_PORTS.includes(a.port) && PROXY_PORTS.includes(b.port)).toBe(true)
      const old = a.listener
      const next = await a.rebindFree()
      expect(next).toBeGreaterThan(0)
      expect(next).not.toBe(b.port)
      expect(a.listener).not.toBe(old)
      expect(a.port).toBe(next)
      expect(old.port).not.toBe(next)
      expect((await fetch(`http://127.0.0.1:${a.port}/v1/models`, { proxy: false })).status).toBe(401)
    } finally {
      await a.close(); await b.close()
    }
  })
  test("环境代理：设了 HTTP_PROXY 且 NO_PROXY 为空时，插件的请求直达回环代理，环境代理零命中", async () => {
    let envProxyHits = 0
    const envProxy = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch() { envProxyHits += 1; return new Response("should not be reached", { status: 502 }) },
    })
    try {
      const out = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(import.meta.dir, "env-proxy-child.mjs"), String(envProxy.port)], {
          env: { ...process.env, HTTP_PROXY: `http://127.0.0.1:${envProxy.port}`, http_proxy: `http://127.0.0.1:${envProxy.port}`, HTTPS_PROXY: `http://127.0.0.1:${envProxy.port}`, NO_PROXY: "", no_proxy: "" },
          stdio: ["ignore", "pipe", "pipe"],
        })
        let text = ""
        child.stdout.on("data", (d) => (text += d))
        child.stderr.on("data", (d) => (text += d))
        child.on("close", (code) => resolve({ code, text }))
        child.on("error", reject)
      })
      const line = out.text.split("\n").find((l) => l.startsWith("RESULT "))?.slice(7)
      expect(line, out.text).toBeDefined()
      const result = JSON.parse(line)
      // 对照：同一个进程里不带 proxy: false 的裸请求确实会被送到环境代理
      expect(result.control).toBe(502)
      expect(envProxyHits).toBe(1)
      expect(result.forward).toBe(200)
      expect(result.models).toBe(2)
      expect(envProxyHits).toBe(1)
    } finally {
      envProxy.stop(true)
    }
  })
  test("Bun 版本守卫：低于 1.4.3 的宿主在发送任何票据前拒绝", () => {
    expect(bunSupportsProxyFalse("1.4.3")).toBe(true)
    expect(bunSupportsProxyFalse("1.4.2")).toBe(false)
    expect(bunSupportsProxyFalse("1.2.19")).toBe(false)
    expect(bunSupportsProxyFalse("1.5.0")).toBe(true)
    expect(bunSupportsProxyFalse("2.0.0")).toBe(true)
    expect(bunSupportsProxyFalse("1.4")).toBe(false)
    // 门槛版本的预发布低于正式版，带构建信息的正式版算兼容，其余解析不了的一律拒绝
    expect(bunSupportsProxyFalse("1.4.3-canary.1")).toBe(false)
    expect(bunSupportsProxyFalse("1.4.3-alpha")).toBe(false)
    // 高于门槛的版本即使带预发布标识也高于门槛（语义版本规则）
    expect(bunSupportsProxyFalse("1.5.0-beta.2")).toBe(true)
    expect(bunSupportsProxyFalse("1.4.3+build.7")).toBe(true)
    expect(bunSupportsProxyFalse("2.0.0-rc.1")).toBe(true)
    expect(bunSupportsProxyFalse("1.4.4-rc.1")).toBe(true)
    expect(bunSupportsProxyFalse("1.4.4+01")).toBe(true)
    for (const bad of ["1.4.3.1", "v1.4.3", "", "bun 1.4.5", "01.4.3", "1.4.3-", "1.4.3-01.a..b", "1.4.3+", "1.4.4-01", "1.4.4-rc.01"]) {
      expect(bunSupportsProxyFalse(bad)).toBe(false)
    }
    for (const bad of ["1.4.2", "1.2.19", "1.4", "1.4.3-canary.1", "", 145, null]) {
      expect(() => assertDirectFetch(bad)).toThrow(`[opclaude:runtime_unsupported]`)
    }
    expect(() => assertDirectFetch("1.4.3")).not.toThrow()
    expect(MIN_BUN).toBe("1.4.3")
    expect(bunSupportsProxyFalse()).toBe(true)
  })
  test("低于门槛的预发布宿主：登录、模型发现和生成都拒绝，模拟启动器零次调用，代理零次请求", async () => {
    const stamp = path.join(rig.state, "last-args")
    rmSync(stamp, { force: true })
    hooks = createPlugin({ ...settings() }, { bunVersion: "1.4.3-canary.1" })
    const seen = rig.seen.proxy.length
    const login = await hooks.auth.methods[0].authorize({})
    expect(login.type).toBe("failed")
    expect(login.error).toContain("[opclaude:runtime_unsupported]")
    expect(login.error).toContain("1.4.3-canary.1")
    const l = await hooks.auth.loader(async () => ({ type: "api", key: LOCAL_MARKER }))
    const r = await l.fetch(URL_(), init(msg()))
    expect(r.status).toBe(FAILURE_STATUS)
    expect(await r.text()).toContain("[opclaude:runtime_unsupported]")
    const m = await attempt(hooks.provider.models({ models: {} }, {}))
    expect(m.ok).toBe(false)
    expect(m.e.code).toBe("runtime_unsupported")
    expect(rig.seen.proxy.length).toBe(seen)
    expect(existsSync(stamp)).toBe(false)
  })
  test("模型发现两阶段都传播调用方的取消原因：启动 launch 之前，以及取得运行态之后、发出模型请求之前", async () => {
    hooks = createPlugin({ ...settings() })
    const stamp = path.join(rig.state, "last-args")
    const reason = new Error("model discovery cancelled")
    const dead = new AbortController()
    dead.abort(reason)
    // 1. 启动前取消：不启动 launch，不连代理
    rmSync(stamp, { force: true })
    const before = rig.seen.proxy.length
    const early = await attempt(hooks.provider.models({ models: {} }, { signal: dead.signal }))
    expect(early.ok).toBe(false)
    expect(early.e).toBe(reason)
    expect(existsSync(stamp)).toBe(false)
    expect(rig.seen.proxy.length).toBe(before)
    // 2. 取得运行态之后、发请求之前取消：launch 已跑，模型请求零次
    const { listModels } = await import("../lib/transport.mjs")
    const state = { baseUrl: `http://127.0.0.1:${rig.port}`, credential: "ticket-A-fake", deviceId: "device-fake", cliVersion: "2.1.284" }
    let asked = 0
    const late = await attempt(listModels({ state, signal: dead.signal, fetchImpl: async () => { asked += 1; return new Response("{}") } }))
    expect(late.ok).toBe(false)
    expect(late.e).toBe(reason)
    expect(asked).toBe(0)
    // 3. listModels 直接收到已取消信号（旧实现在这里抛 ReferenceError）
    const direct = await attempt(listModels({ state, signal: AbortSignal.abort() }))
    expect(direct.ok).toBe(false)
    expect(direct.e?.name).toBe("AbortError")
    expect(rig.seen.proxy.length).toBe(before)
  })
  test("模型发现保留校验期间及启动器运行期间的取消原因", async () => {
    const hooks = createPlugin(settings())
    const stamp = path.join(rig.state, "last-args")
    const before = rig.seen.proxy.length
    rmSync(stamp, { force: true })

    const duringCheck = new AbortController()
    const checkReason = new Error("cancelled while checking the binary")
    const checking = attempt(hooks.provider.models({ models: {} }, { signal: duringCheck.signal }))
    duringCheck.abort(checkReason)
    const checked = await checking
    expect(checked.ok).toBe(false)
    expect(checked.e).toBe(checkReason)
    expect(existsSync(stamp)).toBe(false)

    rig.st.mode = "hang"
    await rig.sync()
    const duringLaunch = new AbortController()
    const launchReason = new Error("cancelled while the launcher was running")
    const running = attempt(hooks.provider.models({ models: {} }, { signal: duringLaunch.signal }))
    for (let i = 0; i < 200 && !existsSync(stamp); i++) await Bun.sleep(10)
    const launched = existsSync(stamp)
    duringLaunch.abort(launchReason)
    const result = await running
    expect(launched).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.e).toBe(launchReason)
    expect(rig.seen.proxy.length).toBe(before)
  })
  test("模型发现将显式 null 原样传播，取消各阶段都不会连接代理", async () => {
    const hooks = createPlugin(settings())
    const stamp = path.join(rig.state, "last-args")
    const before = rig.seen.proxy.length
    rmSync(stamp, { force: true })

    const early = await attempt(hooks.provider.models({ models: {} }, { signal: AbortSignal.abort(null) }))
    expect(early.ok).toBe(false)
    expect(early.e).toBeNull()
    expect(existsSync(stamp)).toBe(false)

    const duringCheck = new AbortController()
    const checking = attempt(hooks.provider.models({ models: {} }, { signal: duringCheck.signal }))
    duringCheck.abort(null)
    const checked = await checking
    expect(checked.ok).toBe(false)
    expect(checked.e).toBeNull()
    expect(existsSync(stamp)).toBe(false)

    rig.st.mode = "hang"
    await rig.sync()
    const duringLaunch = new AbortController()
    const running = attempt(hooks.provider.models({ models: {} }, { signal: duringLaunch.signal }))
    for (let i = 0; i < 200 && !existsSync(stamp); i++) await Bun.sleep(10)
    const launched = existsSync(stamp)
    duringLaunch.abort(null)
    const result = await running
    expect(launched).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.e).toBeNull()
    expect(rig.seen.proxy.length).toBe(before)
  })
  test("代理响应到达时已取消，释放正文并保留显式 null", async () => {
    const { listModels } = await import("../lib/transport.mjs")
    const state = { baseUrl: `http://127.0.0.1:${rig.port}`, credential: "ticket-A-fake", deviceId: "device-fake", cliVersion: "2.1.284" }
    for (const status of [200, 429]) {
      const caller = new AbortController()
      let cancelled = false
      const fetchImpl = async () => {
        caller.abort(null)
        return new Response(new ReadableStream({ cancel() { cancelled = true } }), { status })
      }
      const result = await attempt(forward({ input: URL_(), init: init(msg(), { signal: caller.signal }), state, fetchImpl }))
      expect(result.ok).toBe(false)
      expect(result.e).toBeNull()
      expect(cancelled).toBe(true)
    }

    const caller = new AbortController()
    let cancelled = false
    const fetchImpl = async () => {
      caller.abort(null)
      return new Response(new ReadableStream({ cancel() { cancelled = true } }))
    }
    const result = await attempt(listModels({ state, signal: caller.signal, fetchImpl }))
    expect(result.ok).toBe(false)
    expect(result.e).toBeNull()
    expect(cancelled).toBe(true)
  })
  test("生成和模型请求保留显式 null 的提前取消原因", async () => {
    const { listModels } = await import("../lib/transport.mjs")
    const signal = AbortSignal.abort(null)
    const stamp = path.join(rig.state, "last-args")
    const before = rig.seen.proxy.length
    rmSync(stamp, { force: true })

    const l = await loader(settings())
    const generated = await attempt(l.fetch(URL_(), init(msg({ stream: false }), { signal })))
    expect(generated.ok).toBe(false)
    expect(generated.e).toBeNull()
    expect(existsSync(stamp)).toBe(false)

    const state = { baseUrl: `http://127.0.0.1:${rig.port}`, credential: "ticket-A-fake", deviceId: "device-fake", cliVersion: "2.1.284" }
    const models = await attempt(listModels({ state, signal }))
    expect(models.ok).toBe(false)
    expect(models.e).toBeNull()
    expect(rig.seen.proxy.length).toBe(before)
  })
})

describe("错误响应形状", () => {
  test("固定错误体的类型随状态码变化", () => {
    expect(JSON.parse(errorBody(400, "m"))).toEqual({ type: "error", error: { type: "invalid_request_error", message: "m" } })
    expect(JSON.parse(errorBody(503, "m")).error.type).toBe("api_error")
  })
  test("launch 成功退出但协议或引号不合法时拒绝使用", async () => {
    for (const [mode, c] of [["proto0", "protocol_mismatch"], ["proto2x", "protocol_mismatch"], ["singlequote", "launch_output_invalid"]]) {
      rig.st.mode = mode; await rig.sync()
      const { e } = await attempt(runLaunch(settings()))
      expect(e.code, mode).toBe(c)
    }
    rig.st.mode = "proxy"; await rig.sync()
  })
})
