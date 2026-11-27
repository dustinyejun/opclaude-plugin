// 周额度（auth.usage）：以宿主机 opclauded account 的只读 JSON 为来源，映射成 Magpie 的额度窗口。
//   1. 输出解析：数字 / 数字字符串 / 0 / 不限 / 缺失 / 非数字 / ok:false / 非法 JSON
//   2. auth.usage：自动发现与旧的显式路径、代理状态目录的选择、代理禁用、不可安装、失败路径的固定文案
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { parseAccountOutput, parsePercent, usageFailure } from "../lib/account.mjs"
import { TEXT } from "../lib/errors.mjs"
import { LOCAL_MARKER, createPlugin } from "../lib/plugin.mjs"
import { makeRig, sharedTmp } from "./rig.mjs"

const read = (name) => readFile(path.join(rig.state, name), "utf8")
let rig, realHome
beforeAll(async () => {
  realHome = process.env.HOME
  rig = await makeRig()
  process.env.HOME = rig.dir
})
afterAll(async () => { process.env.HOME = realHome; await rig.close() })
beforeEach(async () => {
  Object.assign(rig.st, { mode: "proxy", ccVersion: "2.1.284", account: '{"ok":true,"plan_name":"Pro 周卡","weekly_pct":42.5}' })
  await rig.sync()
  await rig.restore()
})
const usage = (plugin, auth = { type: "api", key: LOCAL_MARKER }) => plugin.auth.usage(async () => auth)
const loaded = (options, env = rig.env) => createPlugin(options, { env, launcherDirs: rig.dirs, systemClaudes: rig.claudes })
const setAccount = async (v) => { rig.st.account = v; await rig.sync() }

describe("1. account-status JSON 的解析", () => {
  test("已用百分比：数字、数字字符串与 0 都有效", () => {
    expect(parsePercent(42.5)).toBe(42.5)
    expect(parsePercent(0)).toBe(0)
    expect(parsePercent("57.25")).toBe(57.25)
    expect(parsePercent(" 0 ")).toBe(0)
    expect(parsePercent("1e2")).toBe(100)
  })
  test("缺失、非数字、负数、无穷与对象都不是 0，而是没有值", () => {
    for (const v of [undefined, null, "", "  ", "42%", "abc", true, false, {}, [], "-1", "-0.5", NaN, Infinity, "Infinity", "1,5", "0x10", "1".repeat(40)]) expect(parsePercent(v)).toBeNull()
  })
  test("合法输出给出套餐、已用与不限", () => {
    expect(parseAccountOutput('{"ok":true,"plan_name":" Pro 周卡 ","weekly_pct":42.5}')).toEqual({ plan: "Pro 周卡", unlimited: false, used: 42.5 })
    expect(parseAccountOutput('{"plan_name":"Free","weekly_pct":"0"}')).toEqual({ plan: "Free", unlimited: false, used: 0 })
    expect(parseAccountOutput('{"plan_name":"Max","weekly_pct":100}')).toEqual({ plan: "Max", unlimited: false, used: 100 })
    expect(parseAccountOutput('{"weekly_pct":12}')).toEqual({ plan: "", unlimited: false, used: 12 })
  })
  test("不限套餐不看 weekly_pct，也不产生百分比", () => {
    expect(parseAccountOutput('{"plan_name":"Max","weekly_unlimited":true,"weekly_pct":88}')).toEqual({ plan: "Max", unlimited: true, used: null })
    expect(parseAccountOutput('{"plan_name":"Max","weekly_unlimited":1}').unlimited).toBe(true)
    expect(parseAccountOutput('{"plan_name":"Max","weekly_unlimited":"false","weekly_pct":88}')).toEqual({ plan: "Max", unlimited: false, used: 88 })
  })
  test("套餐名缺失或不可显示时不给出；一个可用字段都没有、非 JSON 按 account_output_invalid 拒绝", () => {
    expect(parseAccountOutput('{"weekly_pct":7}').plan).toBe("")
    expect(parseAccountOutput('{"plan_name":"a\\u0000b","weekly_pct":7}').plan).toBe("")
    expect(parseAccountOutput('{"plan_name":123,"weekly_pct":7}').plan).toBe("")
    for (const t of ['{"weekly_pct":"abc"}', "not json /private/secret", "", "[]", "null", '"x"', '{"weekly_pct":null}', '{"weekly_pct":-1}', '{"weekly_pct":"-2.5"}']) {
      let code = "none"
      try { parseAccountOutput(t) } catch (e) { code = e.code }
      expect(code).toBe("account_output_invalid")
    }
  })
  test("ok:false 是 account_unavailable，message 不进入结果", () => {
    let code = "none"
    try { parseAccountOutput('{"ok":false,"message":"sk-abc123456 /private/secret"}') } catch (e) { code = e.code }
    expect(code).toBe("account_unavailable")
  })
})

describe("2. auth.usage：自动发现（默认流程）", () => {
  test("合法输出：套餐、本周已用与 Magpie 推得的剩余，窗口 aside 且不带重置时间", async () => {
    const u = await usage(loaded(undefined))
    expect(u).toEqual({ plan: "Pro 周卡", windows: [{ name: "本周额度", used: 42.5, aside: true }] })
    expect(JSON.stringify(u)).not.toMatch(/resets|balance|until/)
  })
  test("调用的是已核对的执行副本、无参数，代理状态目录是确认过的 home 下的 proxy，环境最小", async () => {
    const env = { ...rig.env, LC_ALL: "C.UTF-8", ANTHROPIC_AUTH_TOKEN: "must-not-leak", ANTHROPIC_BASE_URL: "https://evil.example", OC_TEST_ONLY: "1" }
    await usage(loaded({}, env))
    const bin = (await read("account-bin")).trim()
    // 插件执行的是物理路径（macOS 的 /tmp 是 /private/tmp 的符号链接）
    expect(bin.startsWith(path.join(rig.realOpusHome, ".plugin-bin-")) || bin.includes("opclaude-plugin-bin-")).toBe(true)
    expect(bin).not.toBe(rig.realBin)
    expect(path.basename(bin)).toBe("opclauded")
    expect((await read("account-proxy-home")).trim()).toBe(path.join(rig.realOpusHome, "proxy"))
    expect((await read("account-args")).trim()).toBe("account")
    // 交给子进程的只有固定白名单里在宿主环境中有值的项（显式给了 LC_ALL=C.UTF-8，必须原样带到），
    // 再加上插件自己设的 OPCLAUDE_PROXY_HOME；bash 自己加的 _、PWD、SHLVL 除外。
    const names = (await read("account-env")).split("\n").filter((k) => k && !["_", "PWD", "SHLVL"].includes(k))
    expect(names).toEqual(["HOME", "LANG", "LC_ALL", "OPCLAUDE_PROXY_HOME", "PATH", "TMPDIR"].filter((k) => env[k] || k === "OPCLAUDE_PROXY_HOME").sort())
    expect(names).not.toContain("OC_TEST_ONLY")
    expect(names.some((k) => k.startsWith("ANTHROPIC_") || (k.startsWith("OPUSCLAUDE_")))).toBe(false)
  })
  test("宿主环境没有 LC_ALL 时不凭空补上", async () => {
    const env = { ...rig.env }
    delete env.LC_ALL
    await usage(loaded({}, env))
    const names = (await read("account-env")).split("\n").filter((k) => k && !["_", "PWD", "SHLVL"].includes(k))
    expect(names).toEqual(["HOME", "LANG", "OPCLAUDE_PROXY_HOME", "PATH", "TMPDIR"].filter((k) => env[k] || k === "OPCLAUDE_PROXY_HOME").sort())
    expect(names).not.toContain("LC_ALL")
  })
  test("零用量有效，不限套餐用 display 明示且没有百分比", async () => {
    await setAccount('{"ok":true,"plan_name":"Zero","weekly_pct":0}')
    expect((await usage(loaded(undefined))).windows).toEqual([{ name: "本周额度", used: 0, aside: true }])
    await setAccount('{"ok":true,"plan_name":"Max","weekly_unlimited":true}')
    expect(await usage(loaded(undefined))).toEqual({ plan: "Max", windows: [{ name: "本周额度", aside: true, display: "本周额度不限" }] })
  })
  test("已用缺失或非数字：只显示套餐，绝不填 0", async () => {
    await setAccount('{"ok":true,"plan_name":"Pro","weekly_pct":"n/a"}')
    expect(await usage(loaded(undefined))).toEqual({ plan: "Pro" })
  })
  test("ok:false、非零退出、非法输出、空输出：固定文案，不含原始文本与路径，signIn 保持 kept", async () => {
    for (const [v, want] of [["fail", TEXT.account_failed], ["invalid", TEXT.account_output_invalid], ["none", TEXT.account_output_invalid], ['{"ok":false,"message":"quota gone sk-abc123456"}', TEXT.account_unavailable]]) {
      await setAccount(v)
      const u = await usage(loaded(undefined))
      expect(u).toEqual({ error: want, windows: [], signIn: "kept" })
      expect(JSON.stringify(u)).not.toMatch(/SECRET|secret|sk-|opusclaude-rig/)
    }
  })
  test("查询挂起：有界超时后给出固定文案", async () => {
    await setAccount("hang")
    const t = Date.now()
    const u = await loaded(undefined).auth.usage
    const res = await u(async () => ({ type: "api", key: LOCAL_MARKER }))
    expect(res).toEqual({ error: TEXT.account_timeout, windows: [], signIn: "kept" })
    expect(Date.now() - t).toBeGreaterThan(1000)
  }, 30000)
  test("查询失败不影响请求：之后的生成请求照常成功", async () => {
    await setAccount("fail")
    await usage(loaded(undefined))
    const fetch = (await loaded(undefined).auth.loader(async () => ({ type: "api", key: LOCAL_MARKER }))).fetch
    const res = await fetch("http://127.0.0.1:18827/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }) })
    expect([200, 400]).toContain(res.status)
  })
})

describe("3. auth.usage：配置来源与代理状态目录", () => {
  test("宿主环境的 OPCLAUDE_PROXY_HOME 与旧的显式选项 proxyHome 都原样交给 account", async () => {
    await usage(loaded({}, { ...rig.env, OPCLAUDE_PROXY_HOME: "/tmp/opclaude-state-a" }))
    expect((await read("account-proxy-home")).trim()).toBe("/tmp/opclaude-state-a")
    await usage(loaded({ proxyHome: "/tmp/opclaude-state-b" }, { ...rig.env, OPCLAUDE_PROXY_HOME: "/tmp/opclaude-state-a" }))
    expect((await read("account-proxy-home")).trim()).toBe("/tmp/opclaude-state-b")
  })
  test("旧的显式配置：执行的就是给出的那一个 opclauded，home 用显式给出的 home", async () => {
    const plugin = loaded({ opclauded: rig.bin, opusHome: rig.opusHome })
    const auth = { type: "api", key: LOCAL_MARKER, metadata: { opclauded: rig.bin, opusHome: rig.opusHome } }
    expect(await usage(plugin, undefined)).toEqual({ plan: "Pro 周卡", windows: [{ name: "本周额度", used: 42.5, aside: true }] })
    expect((await read("account-bin")).trim()).toBe(rig.bin)
    expect((await read("account-proxy-home")).trim()).toBe(path.join(rig.realOpusHome, "proxy"))
    // 以前登录时保存的一对路径同样有效
    expect(await usage(loaded({}), auth)).toEqual({ plan: "Pro 周卡", windows: [{ name: "本周额度", used: 42.5, aside: true }] })
  })
  test("旧的显式配置：程序不在、指纹不符、只填一半时给出对应错误码的固定文案", async () => {
    const home = rig.opusHome
    expect(await usage(loaded({ opclauded: path.join(home, "opclauded", "0.0.0/opclauded"), opusHome: home }), undefined)).toEqual({ error: TEXT.binary_missing, windows: [], signIn: "kept" })
    expect(await usage(loaded({ opclauded: rig.bin, opusHome: home, opclaudedSha256: "0".repeat(64) }), undefined)).toEqual({ error: TEXT.sha256_mismatch, windows: [], signIn: "kept" })
    expect(await usage(loaded({ opclauded: rig.bin }), undefined)).toEqual({ error: TEXT.legacy_incomplete, windows: [], signIn: "kept" })
  })
  test("旧的显式 home 写成 shortcut/..（符号链接后接 ..）：请求与额度都按文件系统解析到同一个安装 A，不串到另一个账号 B", async () => {
    // 两个独立安装：A（Pro 周卡 42.5%）与 B（B 套餐 95%），各自有 <安装>/.opusclaude 与 <安装>/state。
    //   <B>/.opusclaude/shortcut -> <A>/.opusclaude/anchor；显式 opusHome 写作 <B>/.opusclaude/shortcut/..
    //   文件系统解析：anchor 的上一级 = A 的 OpusClaude home
    //   字符串折叠：  <B>/.opusclaude（账号 B 的安装）
    const root = await mkdtemp(path.join(await sharedTmp(), "opclaude-two-"))
    const a = await makeRig({ dir: path.join(root, "A") })
    const b = await makeRig({ dir: path.join(root, "B") })
    try {
      await mkdir(path.join(a.opusHome, "anchor"))
      await symlink(path.join(a.opusHome, "anchor"), path.join(b.opusHome, "shortcut"))
      await writeFile(path.join(b.state, "account"), '{"ok":true,"plan_name":"B 套餐","weekly_pct":95}')
      // 保留用户原来的写法：这里不能 path.join / path.resolve，否则字符串先被折叠成 B
      const explicit = b.opusHome + path.sep + "shortcut" + path.sep + ".."
      const bProxy = path.join(b.opusHome, "proxy")
      expect(path.resolve(path.join(explicit, "proxy"))).toBe(bProxy) // 旧算法按字符串折叠后算出的目录
      const options = { opclauded: a.bin, opusHome: explicit }
      const runtime = (env = a.env) => ({ env, launcherDirs: a.dirs, systemClaudes: a.claudes })
    const auth = { type: "api", key: LOCAL_MARKER }
      const body = JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 8, messages: [{ role: "user", content: "hi" }] })
      const request = async (plugin) => (await plugin.auth.loader(async () => auth)).fetch(`http://127.0.0.1:${a.port}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body })
      const rec = (dir, name) => readFile(path.join(dir, name), "utf8").then((t) => t.trim())
      const A_QUOTA = { plan: "Pro 周卡", windows: [{ name: "本周额度", used: 42.5, aside: true }] }
      const B_QUOTA = { plan: "B 套餐", windows: [{ name: "本周额度", used: 95, aside: true }] }

      // 对照：同一个显式程序，让它直接去找字符串折叠出的那个目录 B/.opusclaude/proxy，确实读到 B 的 95%。
      // 这样下面“读到 A”不是模拟程序读错目录后的回退。
      const control = createPlugin(options, runtime({ ...a.env, OPCLAUDE_PROXY_HOME: bProxy }))
      expect([200, 400]).toContain((await request(control)).status)
      expect(await rec(a.state, "proxy-home")).toBe(bProxy)
      expect(await control.auth.usage(async () => auth)).toEqual(B_QUOTA)
      expect(await rec(b.state, "account-proxy-home")).toBe(bProxy)

      // 正式查询：没有任何代理目录设置时，launch 不传（交给 opclauded 自己的默认值），
      // account 按官方规则用确认后的 <A 物理目录>/proxy。请求与额度都是 A。
      const plugin = createPlugin(options, runtime())
      expect([200, 400]).toContain((await request(plugin)).status)
      expect(await rec(a.state, "launch-home")).toBe(`--home ${a.realOpusHome}`)
      expect(await rec(a.state, "proxy-home")).toBe("")
      expect(await plugin.auth.usage(async () => auth)).toEqual(A_QUOTA)
      expect(await rec(a.state, "account-proxy-home")).toBe(path.join(a.realOpusHome, "proxy"))
      expect(await rec(a.state, "account-bin")).toBe(a.bin)

      // 宿主环境的 OPCLAUDE_PROXY_HOME 指向 B：请求与额度一起改读 B（同一个优先级，两条路径一致）。
      const withEnv = createPlugin(options, runtime({ ...a.env, OPCLAUDE_PROXY_HOME: bProxy }))
      expect([200, 400]).toContain((await request(withEnv)).status)
      expect(await rec(a.state, "proxy-home")).toBe(bProxy)
      expect(await withEnv.auth.usage(async () => auth)).toEqual(B_QUOTA)
      expect(await rec(b.state, "account-proxy-home")).toBe(bProxy)
      expect(await rec(a.state, "launch-home")).toBe(`--home ${a.realOpusHome}`)

      // 选项 proxyHome 优先于宿主环境：指回 A 的代理目录后，请求与额度都回到 A。
      const withOption = createPlugin({ ...options, proxyHome: path.join(a.opusHome, "proxy") }, runtime({ ...a.env, OPCLAUDE_PROXY_HOME: bProxy }))
      expect([200, 400]).toContain((await request(withOption)).status)
      expect(await rec(a.state, "proxy-home")).toBe(path.join(a.opusHome, "proxy"))
      expect(await withOption.auth.usage(async () => auth)).toEqual(A_QUOTA)
      expect(await rec(a.state, "account-proxy-home")).toBe(path.join(a.opusHome, "proxy"))
    } finally {
      await a.close()
      await b.close()
      await rm(root, { recursive: true, force: true })
    }
  })
  test("显式选项 proxyHome：显式路径下也交给 account", async () => {
    await usage(loaded({ opclauded: rig.bin, opusHome: rig.opusHome, proxyHome: "/tmp/opclaude-state-c" }), undefined)
    expect((await read("account-proxy-home")).trim()).toBe("/tmp/opclaude-state-c")
  })
  test("宿主环境 OPUSCLAUDE_PROXY=0：proxy_disabled，opclauded 不被运行", async () => {
    const before = (await read("account-bin").catch(() => "")).trim()
    expect(await usage(loaded({}, { ...rig.env, OPUSCLAUDE_PROXY: "0" }))).toEqual({ error: TEXT.proxy_disabled, windows: [], signIn: "kept" })
    expect((await read("account-bin").catch(() => before)).trim()).toBe(before)
  })
  test("没有安装、程序指纹不符：固定文案，不带安装路径", async () => {
    const none = await createPlugin({}, { env: rig.env, launcherDirs: [] }).auth.usage(async () => ({ type: "api", key: LOCAL_MARKER }))
    expect(none).toEqual({ error: TEXT.launcher_not_found, windows: [], signIn: "kept" })
    await Bun.write(rig.bin, "#!/bin/sh\nexit 1\n")
    const tampered = await usage(loaded(undefined))
    expect(tampered.error).toBe(TEXT.sha256_mismatch)
    expect(JSON.stringify(tampered)).not.toContain(rig.dir)
  })
  test("还没登录也没有显式路径：不探测宿主机，返回空对象", async () => {
    let asked = 0
    const u = await createPlugin({}, { env: rig.env, launcherDirs: [] }).auth.usage(async () => { asked++; return undefined })
    expect(u).toEqual({})
    expect(asked).toBe(1)
  })
})

test("usageFailure 对未知错误也只给固定文案", () => {
  expect(usageFailure(undefined)).toEqual({ error: TEXT.account_failed, windows: [], signIn: "kept" })
  expect(Object.values(TEXT).every((t) => !/sk-|secret/i.test(t))).toBe(true)
})
