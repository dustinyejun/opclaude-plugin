// 宿主机发现与宿主机版本：默认安装、另设 home、配置错误、指纹拒绝、旧配置兼容、宿主升级、
// 远端客户端版本不影响出站、原正文不改、故障后恢复。全部用模拟安装，不读当前用户的真实配置。
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { chmod, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { SafeError, TEXT } from "../lib/errors.mjs"
import { bindBinary, discoverHost, findLauncher, hostHome, parseLauncher, parseVersionOutput, readHostVersion } from "../lib/host.mjs"
import { LOCAL_MARKER, createPlugin, resolvePlan } from "../lib/plugin.mjs"
import { FAILURE_STATUS, PLACEHOLDER_BASE } from "../lib/transport.mjs"
import { makeRig } from "./rig.mjs"

const UA = (v) => `claude-cli/${v} (external, cli)`
const msg = (extra = {}) => ({ model: "claude-fable-5-2", max_tokens: 64, stream: false, system: [{ type: "text", text: "You are Claude Code" }, { type: "text", text: "x-anthropic-billing-header cc_entrypoint=cli" }], metadata: { user_id: "user_abc" }, messages: [{ role: "user", content: "hi" }], ...extra })
const URL_ = (p = "/messages") => PLACEHOLDER_BASE + p
// 两个“客户端”的入站头：版本各不相同，都与宿主机不同。
const INBOUND = { "user-agent": "claude-cli/2.1.100 (external, cli)", "x-app": "cli", "anthropic-version": "2023-06-01", "content-type": "application/json", "x-api-key": LOCAL_MARKER }
const post = (body, headers = INBOUND, extra = {}) => ({ method: "POST", headers, body: JSON.stringify(body), ...extra })
const text = async (res) => await res.text()
const codeOf = (fn) => fn().then(() => "", (e) => e.code)

let rig, realHome, realOpusclaudeHome, other
beforeAll(async () => {
  realHome = process.env.HOME
  realOpusclaudeHome = process.env.OPUSCLAUDE_HOME
  delete process.env.OPUSCLAUDE_HOME
  rig = await makeRig()
  process.env.HOME = rig.dir
  // 另一套 OpusClaude home 与另一个“系统用户”的 home：模拟宿主进程另设 OPUSCLAUDE_HOME（启动器在用户目录，home 不在它之下）。
  other = await makeRig({ dir: await mkdtemp(path.join(tmpdir(), "opclaude-home2-")), launcherHome: await mkdtemp(path.join(tmpdir(), "opclaude-user2-")) })
})
afterAll(async () => {
  process.env.HOME = realHome
  if (realOpusclaudeHome !== undefined) process.env.OPUSCLAUDE_HOME = realOpusclaudeHome
  await rig.close()
  await other.close()
})
beforeEach(async () => {
  Object.assign(rig.st, { mode: "proxy", ccVersion: "2.1.284", ticket: "ticket-A-fake", status: 200 })
  delete rig.st.proxyTicket
  await rig.sync()
  await rig.restore()
  await rm(rig.dirs[1], { force: true })
  await rm(path.join(rig.state, "claude-args"), { force: true })
  other.seen.proxy.length = 0
  rig.seen.proxy.length = 0
  rig.seen.ua.length = 0
  rig.seen.bodies.length = 0
})

const plugin = (opts = {}, env = rig.env) => createPlugin(opts, { env, launcherDirs: rig.dirs, systemClaudes: rig.claudes })
const readVer = (opts = {}) => readHostVersion({ systemClaudes: rig.claudes, ...opts })
// 返回插件的 fetch：就是 Magpie 网关会调用的那个函数。auth 省略时用默认的本地标记；env 省略时用测试台的进程环境。
const fetchOf = async (opts, env = rig.env, auth = { type: "api", key: LOCAL_MARKER }) => (await plugin(opts, env).auth.loader(async () => auth)).fetch
const sent = () => rig.seen.proxy.filter((r) => r.path !== "/v1/models")
// 插件运行的不是安装里的路径，而是核对过内容的绑定副本：<目录>/<启动器记的摘要>/opclauded/<版本>/opclauded。
// launched-bin 是实际被执行的路径，launched-layout 是它往上两级那一级的名字（程序按自己的位置往上找时看到的）。
const launchedCopy = async (r, binFile = r.bin, sha256 = "") => {
  const sum = sha256 || new Bun.CryptoHasher("sha256").update(new Uint8Array(await Bun.file(binFile).arrayBuffer())).digest("hex")
  expect((await Bun.file(path.join(r.state, "launched-bin")).text()).trim().endsWith("/opclauded/" + path.basename(path.dirname(binFile)) + "/opclauded")).toBe(true)
  expect((await Bun.file(path.join(r.state, "launched-layout")).text()).trim()).toBe(sum)
}
const read = async (name, home = rig.dir) => await Bun.file(path.join(home, name)).text()

describe("启动器与版本的静态解析", () => {
  const official = (bin = "/Users/u/.opusclaude/opclauded/0.5.1/opclauded", sha = "ab".repeat(32)) =>
    `#!/bin/sh\n# OpusClaude 启动器\nset -eu\nOPUS_DIR="\${OPUSCLAUDE_HOME:-$HOME/.opusclaude}"\nOPCLAUDED_BIN="${bin}"\nOPCLAUDED_SHA256="${sha}"   # 装机时核对过的代理程序指纹\nCLAUDE_PIN="2.1.284"\n`
  test("按安装器写出的字面量取出选定的 opclauded 与指纹", () => {
    expect(parseLauncher(official())).toEqual({ bin: "/Users/u/.opusclaude/opclauded/0.5.1/opclauded", sha256: "ab".repeat(32) })
    // 直连安装：两个字面量都为空
    expect(parseLauncher(official("", ""))).toEqual({ bin: "", sha256: "" })
    expect(hostHome({ HOME: "/Users/u" })).toBe("/Users/u/.opusclaude")
    expect(hostHome({ HOME: "/Users/u", OPUSCLAUDE_HOME: "/srv/oc" })).toBe("/srv/oc")
    expect(hostHome({ HOME: "/Users/u", OPUSCLAUDE_HOME: "" })).toBe("/Users/u/.opusclaude")
    for (const env of [{}, { HOME: "relative" }, { HOME: "/x", OPUSCLAUDE_HOME: "relative" }, { HOME: "/x", OPUSCLAUDE_HOME: 1 }]) {
      expect(() => hostHome(env)).toThrow("[opclaude:home_invalid]")
    }
  })
  test("拒绝：缺字面量、重复、非双引号、带转义或命令替换、相对路径、目录形状不对、指纹格式不对", () => {
    const bad = [
      "",
      "OPCLAUDED_BIN=\"/a/opclauded/1/opclauded\"\n",
      official().replace("OPCLAUDED_BIN=", "OC_BIN="),
      official() + 'OPCLAUDED_BIN="/b/opclauded/1/opclauded"\n',
      official() + 'OPCLAUDED_SHA256="' + "cd".repeat(32) + '"\n',
      official().replace(`"/Users/u/.opusclaude/opclauded/0.5.1/opclauded"`, "'/Users/u/.opusclaude/opclauded/0.5.1/opclauded'"),
      official("/Users/u/.opusclaude/opclauded/0.5.1/opclauded$(id)"),
      official("/Users/u/.opusclaude/opclauded/0.5.1/opclauded`id`"),
      official("/Users/u/.opusclaude/opclauded/0.5.1/opclauded\\x"),
      official("relative/opclauded/0.5.1/opclauded"),
      official("/Users/u/bin/opclauded"),
      official("/Users/u/.opusclaude/opclauded/0.5.1/other"),
      official("/Users/u/.opusclaude/opclauded/0.5.1/../0.5.1/opclauded"),
      official(undefined, "AB".repeat(32)),
      official(undefined, "ab".repeat(31)),
      official(undefined, "$(sha256sum x)"),
      official("", "ab".repeat(32)),
      "# comment\n" + official().slice(11),
      official() + "\0",
      "#!/bin/sh\n" + "x".repeat(2 * 1024 * 1024),
    ]
    for (const [i, t] of bad.entries()) expect(() => parseLauncher(t), `case ${i}`).toThrow("[opclaude:launcher_invalid]")
  })
  test("版本行只认实际版本：接入包、推荐值、未找到、格式变化都不算", () => {
    const out = (cc) => `OpusClaude 接入包：20261120.1\nClaude Code：${cc}（推荐 2.1.284）\n本地代理：opclauded 0.5.1\n`
    expect(parseVersionOutput(out("2.1.284"))).toBe("2.1.284")
    expect(parseVersionOutput(out("2.1.99"))).toBe("2.1.99")
    expect(parseVersionOutput(out("3.0.10"))).toBe("3.0.10")
    for (const t of [out("未找到"), out("2.1.284.1"), out("v2.1.284"), out("2.1.284 "), out("2.1.284（内测）"), out("2.1.284\u001b[0m"), out("20261120.1"), out("2.1.284") + "Claude Code：2.1.284（推荐 2.1.284）\n", "", "Claude Code：2.1.284\n", "x".repeat(70000)]) {
      expect(() => parseVersionOutput(t), t.slice(0, 50)).toThrow(SafeError)
    }
  })
})

describe("默认安装：不保存任何路径、密钥或版本", () => {
  test("没有任何选项时自动定位启动器、opclauded 与 home，出站头用宿主机版本", async () => {
    const fetch = await fetchOf()
    const res = await fetch(URL_(), post(msg()))
    expect(res.status).toBe(200)
    expect(JSON.parse(await text(res)).role).toBe("assistant")
    expect(sent()).toHaveLength(1)
    expect(sent()[0]).toMatchObject({ method: "POST", path: "/v1/messages", authed: true, ua: UA("2.1.284"), app: "cli", device: "device-fake" })
    // launch 的参数就是启动器字面量里的程序与确认物理 home
    expect(await read("state/launch-home")).toBe(`--home ${rig.realOpusHome}\n`)
    await launchedCopy(rig)
  })
  test("登录不询问任何信息，也不保存路径：保存的只有本地标记与空元数据", async () => {
    const h = plugin()
    expect(h.auth.methods[0].prompts).toEqual([])
    expect(await h.auth.methods[0].authorize(undefined)).toEqual({ type: "success", key: LOCAL_MARKER, accountId: "host-proxy", metadata: {} })
    expect(sent()).toHaveLength(0)
  })
  test("按启动器的实际配置选程序：目录里有更高版本也不选它", async () => {
    const higher = path.join(rig.opusHome, "opclauded", "9.9.9")
    await mkdir(higher, { recursive: true })
    const decoy = path.join(higher, "opclauded")
    await writeFile(decoy, '#!/bin/sh\ntouch "' + path.join(rig.dir, "decoy-ran") + '"\nprintf "OC_RUN_MODE=\'proxy\'\\nOC_BASE_URL=\'http://127.0.0.1:18827\'\\nOC_CREDENTIAL=\'decoy\'\\n"\n')
    await chmod(decoy, 0o755)
    const fetch = await fetchOf()
    expect((await fetch(URL_(), post(msg()))).status).toBe(200)
    expect(sent()[0].authed).toBe(true)
    await launchedCopy(rig)
    expect(await Bun.file(path.join(rig.dir, "decoy-ran")).exists()).toBe(false)
  })
  test("version 子进程：只带最小环境，只运行 claude --version，不读密钥", async () => {
    process.env.ANTHROPIC_AUTH_TOKEN = "inherited-fake"
    process.env.OPCLAUDE_API_KEY = "inherited-fake"
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "inherited-fake"
    try {
      const fetch = await fetchOf()
      expect((await fetch(URL_(), post(msg()))).status).toBe(200)
    } finally {
      for (const k of ["ANTHROPIC_AUTH_TOKEN", "OPCLAUDE_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) delete process.env[k]
    }
    const keys = (await read("launcher-env", rig.opusHome)).split("\n").filter(Boolean)
    // sh 自己会导出 _、PWD、SHLVL；除此之外只能有最小环境里的这几项
    expect(keys.filter((k) => !["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "_", "PWD", "SHLVL"].includes(k)), keys.join(",")).toEqual([])
    expect((await read("state/claude-args")).trim().split("\n")).toEqual(["--version"])
    // 没有另设 home 时不向启动器传 OPUSCLAUDE_HOME
    expect(await read("launcher-home", rig.opusHome)).toBe("\n")
  })
})

describe("宿主环境另设 home", () => {
  test("OPUSCLAUDE_HOME 指向另一套安装：用它选定的程序与 home，票据和地址来自那一套", async () => {
    other.st.port = String(other.port)
    await other.sync()
    const env = { ...other.env, OPUSCLAUDE_HOME: other.opusHome }
    expect(hostHome(env)).toBe(other.opusHome)
    const h = createPlugin({}, { env, launcherDirs: [other.launcher], systemClaudes: other.claudes })
    const otherFetch = await h.auth.loader(async () => ({ type: "api", key: LOCAL_MARKER }))
    const res = await otherFetch.fetch(URL_(), post(msg()))
    expect(res.status).toBe(200)
    expect(sent()).toHaveLength(0)
    expect(other.seen.proxy.at(-1)).toMatchObject({ authed: true, ua: UA("2.1.284") })
    expect(await read("state/launch-home", other.dir)).toBe(`--home ${other.realOpusHome}\n`)
    expect(await read("launcher-home", other.opusHome)).toBe(`${other.realOpusHome}\n`)
    // 同一个启动器、不设 OPUSCLAUDE_HOME：启动器选定的程序不在默认的 ~/.opusclaude 之下，拒绝
    const plain = await (await createPlugin({}, { env: other.env, launcherDirs: [other.launcher], systemClaudes: other.claudes }).auth.loader(async () => ({ type: "api", key: LOCAL_MARKER }))).fetch
    expect(await text(await plain(URL_(), post(msg())))).toContain("[opclaude:launcher_home_mismatch]")
  })
  test("旧的显式路径指向非默认的 home：用用户目录里的启动器，不需要 OPUSCLAUDE_HOME", async () => {
    other.st.port = String(other.port)
    await other.sync()
    expect(other.opusHome).not.toBe(path.join(other.launcher, "..", "..", ".opusclaude"))
    expect(other.env.OPUSCLAUDE_HOME).toBeUndefined()
    const legacy = { opclauded: other.bin, opusHome: other.opusHome }
    const fetch = await (await createPlugin(legacy, { env: other.env, launcherDirs: [other.launcher], systemClaudes: other.claudes }).auth.loader(async () => ({ type: "api", key: LOCAL_MARKER }))).fetch
    const res = await fetch(URL_(), post(msg()))
    expect(res.status).toBe(200)
    expect(sent()).toHaveLength(0)
    expect(other.seen.proxy.at(-1)).toMatchObject({ authed: true, ua: UA("2.1.284"), app: "cli" })
    // 旧的显式路径照原样执行（用户给的路径，不换成启动器选定的程序）
    expect(await read("state/launched-bin", other.dir)).toBe(`${other.bin}\n`)
    expect(await read("state/launch-home", other.dir)).toBe(`--home ${other.realOpusHome}\n`)
    expect(await read("launcher-home", other.opusHome)).toBe(`${other.realOpusHome}\n`)
    // 另一套安装里的启动器被改动：显式路径照旧不用它
    const source = await Bun.file(other.launcher).text()
    await Bun.write(other.launcher, source + "# appended by someone\n")
    try {
      const denied = await (await createPlugin(legacy, { env: other.env, launcherDirs: [other.launcher], systemClaudes: other.claudes }).auth.loader(async () => ({ type: "api", key: LOCAL_MARKER }))).fetch
      expect(await text(await denied(URL_(), post(msg())))).toContain("[opclaude:launcher_untrusted]")
    } finally { await Bun.write(other.launcher, source); await chmod(other.launcher, 0o755) }
  })
  test("启动器选定的程序不在另设的 home 之下：拒绝，零请求", async () => {
    // 先核对启动器是否属于另设的那套安装（它 config 里记的摘要）：不属于就拒绝，还轮不到看程序在哪
    const res = await (await fetchOf({}, { ...rig.env, OPUSCLAUDE_HOME: other.opusHome }))(URL_(), post(msg()))
    expect(res.status).toBe(FAILURE_STATUS)
    expect(await text(res)).toContain("[opclaude:launcher_untrusted]")
    // 属于另设的安装、但它选定的程序不在那个 home 之下：对定位函数本身核对这一条
    const bytes = new Uint8Array(await Bun.file(other.launcher).arrayBuffer())
    expect(await codeOf(() => bindBinary({ launcher: other.launcher, bytes, bin: rig.bin, sha256: rig.sum }, other.opusHome))).toBe("launcher_home_mismatch")
    expect(sent()).toHaveLength(0)
    expect(other.seen.proxy.length).toBe(0)
  })
  test("另设的 home 不是绝对路径：拒绝", async () => {
    for (const v of ["relative", "/x/\0"]) {
      const res = await (await fetchOf({}, { ...rig.env, OPUSCLAUDE_HOME: v }))(URL_(), post(msg()))
      expect(res.status).toBe(FAILURE_STATUS)
      expect(await text(res)).toContain("[opclaude:home_invalid]")
    }
    expect(sent()).toHaveLength(0)
  })
})

describe("安装损坏、配置错误与指纹拒绝", () => {
  const refuse = async (expected, prepare) => {
    await prepare()
    const before = rig.seen.proxy.length
    const res = await (await fetchOf())(URL_(), post(msg()))
    expect(res.status).toBe(FAILURE_STATUS)
    const body = await text(res)
    expect(body).toContain(`[opclaude:${expected}]`)
    expect(body).toContain('"type":"error"')
    expect(rig.seen.proxy.length).toBe(before)
    const login = await plugin().auth.methods[0].authorize(undefined)
    expect(login).toMatchObject({ type: "failed", error: expect.stringContaining(`[opclaude:${expected}]`) })
  }
  test("启动器里的指纹与实际程序不符：不执行", async () => {
    await refuse("sha256_mismatch", () => rig.install({ sha256: "0".repeat(64) }))
  })
  test("程序被替换（指纹随之变化）：不执行", async () => {
    await refuse("sha256_mismatch", async () => { await writeFile(rig.bin, "#!/bin/sh\necho pwned\n"); await chmod(rig.bin, 0o755) })
    await writeFile(rig.bin, rig.fakeSource); await chmod(rig.bin, 0o755)
  })
  test("程序缺失、变成目录或符号链接、不可执行", async () => {
    const keep = path.join(rig.dir, "keep")
    await copyFile(rig.bin, keep)
    await refuse("binary_missing", () => rm(rig.bin))
    await refuse("binary_not_regular", async () => { await mkdir(rig.bin) })
    await rm(rig.bin, { recursive: true, force: true })
    // 末级文件是符号链接、指向安装之外：按物理位置判断，不在当前安装里
    await rm(rig.bin, { force: true })
    await refuse("launcher_home_mismatch", () => symlink(keep, rig.bin))
    await rm(rig.bin, { force: true })
    await copyFile(keep, rig.bin)
    await refuse("binary_not_executable", () => chmod(rig.bin, 0o644))
    await chmod(rig.bin, 0o755)
    expect((await (await fetchOf())(URL_(), post(msg()))).status).toBe(200)
  })
  test("启动器损坏：字面量缺失、重复、带变量、不是脚本、格式不可识别", async () => {
    const good = await Bun.file(rig.launcher).text()
    const broken = [
      (t) => t.replace(/^OPCLAUDED_BIN=.*$/m, ""),
      (t) => t.replace(/^OPCLAUDED_SHA256=.*$/m, ""),
      (t) => t + 'OPCLAUDED_BIN="' + rig.bin + '"\n',
      (t) => t + 'OPCLAUDED_SHA256="' + "cd".repeat(32) + '"\n',
      (t) => t.replace(/^OPCLAUDED_SHA256=.*$/m, "OPCLAUDED_SHA256='nope'"),
      (t) => t.replace(/^OPCLAUDED_BIN=(.*)$/m, "OPCLAUDED_BIN=$HOME/.opusclaude/opclauded/0.5.1-test/opclauded"),
      (t) => t.replace(/^OPCLAUDED_BIN=(.*)$/m, "OPCLAUDED_BIN=" + rig.dir + "/opclauded/*/opclauded"),
      (t) => t.slice(1),
      () => "#!/bin/sh\nexit 0\n",
      () => "",
    ]
    for (const mutate of broken) await refuse("launcher_invalid", async () => { await Bun.write(rig.launcher, mutate(good)); await chmod(rig.launcher, 0o755) })
  })
  test("用户目录的启动器坏了、/usr/local/bin 那份完好：用后一份", async () => {
    const good = await Bun.file(rig.launcher).text()
    await mkdir(path.dirname(rig.dirs[1]), { recursive: true })
    await Bun.write(rig.dirs[1], good)
    await chmod(rig.dirs[1], 0o755)
    await Bun.write(rig.launcher, "#!/bin/sh\nexit 0\n")
    try {
      expect((await (await fetchOf())(URL_(), post(msg()))).status).toBe(200)
      // 两份都坏了才是错误
      await Bun.write(rig.dirs[1], "OPCLAUDED_BIN='/x'\n")
      expect(await text(await (await fetchOf())(URL_(), post(msg())))).toContain("[opclaude:launcher_invalid]")
      // 用户目录那份是直连安装时，不拿 /usr/local/bin 那份顶替
      await Bun.write(rig.dirs[1], good)
      // 直连安装的那份启动器，摘要仍然要与同一安装的 config 相符（安装器写出的就是它）
      await rig.install({ text: good.replace(/^OPCLAUDED_BIN=.*$/m, 'OPCLAUDED_BIN=""').replace(/^OPCLAUDED_SHA256=.*$/m, 'OPCLAUDED_SHA256=""') })
      expect(await text(await (await fetchOf())(URL_(), post(msg())))).toContain("[opclaude:proxy_disabled]")
    } finally { await rm(rig.dirs[1], { force: true }) }
  })
  test("启动器是符号链接：不用它；没有执行位：照样用（执行的是核对过摘要的字节）", async () => {
    // beforeEach 已移除另一处安装位置（/usr/local/bin）的那份：没有可顶替的，才把这个错误报出来
    await refuse("launcher_invalid", async () => { await rm(rig.launcher); await symlink(path.join(rig.dir, "opclauded", "0.5.1-test", "opclauded"), rig.launcher) })
    await rig.restore()
    await chmod(rig.launcher, 0o644)
    expect((await (await fetchOf())(URL_(), post(msg()))).status).toBe(200)
    await rig.install()
  })
  test("直连安装（启动器没有启用代理）：明确报错，不回退公网，不重启登录", async () => {
    await refuse("proxy_disabled", async () => {
      const t = await Bun.file(rig.launcher).text()
      await rig.install({ text: t.replace(/^OPCLAUDED_BIN=.*$/m, 'OPCLAUDED_BIN=""').replace(/^OPCLAUDED_SHA256=.*$/m, 'OPCLAUDED_SHA256=""') })
    })
  })
  test("没有安装：找不到启动器", async () => {
    await refuse("launcher_not_found", () => rm(rig.launcher))
    await rig.install()
  })
  test("opclauded 的配置错误类错误照旧透出，不落到别处", async () => {
    for (const [mode, c] of [["direct", "mode_direct"], ["busy", "install_busy"], ["txn", "txn_recovery_failed"]]) {
      rig.st.mode = mode; await rig.sync()
      const res = await (await fetchOf())(URL_(), post(msg()))
      expect(await text(res)).toContain(`[opclaude:${c}]`)
    }
  })
})

describe("宿主机版本", () => {
  test("读不到实际版本：拒绝发送，零请求；版本恢复后下一条请求照常", async () => {
    rig.st.ccVersion = "broken"; await rig.sync()
    const before = rig.seen.proxy.length
    const res = await (await fetchOf())(URL_(), post(msg()))
    expect(res.status).toBe(FAILURE_STATUS)
    expect(await text(res)).toContain("[opclaude:version_unknown]")
    expect(rig.seen.proxy.length).toBe(before)
    expect(await plugin().auth.methods[0].authorize(undefined)).toMatchObject({ type: "failed", error: expect.stringContaining("version_unknown") })
    rig.st.ccVersion = "2.1.284"; await rig.sync()
    expect((await (await fetchOf())(URL_(), post(msg()))).status).toBe(200)
  })
  test("宿主升级后自动读到新版本，不用重新登录", async () => {
    const fetch = await fetchOf()
    expect((await fetch(URL_(), post(msg()))).status).toBe(200)
    rig.st.ccVersion = "2.1.300"; await rig.sync()
    expect((await fetch(URL_(), post(msg()))).status).toBe(200)
    expect(sent().map((r) => r.ua)).toEqual([UA("2.1.284"), UA("2.1.300")])
  })
  test("claude 跑不起来、读不出版本：版本不明，拒绝发送", async () => {
    rig.st.ccVersion = "missing"; await rig.sync()
    expect(await text(await (await fetchOf())(URL_(), post(msg())))).toContain("[opclaude:version_unknown]")
    expect(sent()).toHaveLength(0)
  })
  test("version 子命令超时与取消：结束子进程", async () => {
    rig.st.ccVersion = "hang"; await rig.sync()
    expect(await codeOf(() => readVer({ launcher: rig.launcher, timeoutMs: 400 }))).toBe("version_timeout")
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(new Error("caller stopped")), 100)
    expect(await codeOf(() => readVer({ launcher: rig.launcher, timeoutMs: 5000, signal: ctrl.signal }))).toBe("version_aborted")
    // 已经取消的信号：不再启动子进程
    await expect(readVer({ launcher: rig.launcher, signal: ctrl.signal })).rejects.toThrow("caller stopped")
    rig.st.ccVersion = "2.1.284"; await rig.sync()
    expect(await readVer({ launcher: rig.launcher })).toBe("2.1.284")
    // 启动器自己失败：version_failed
    await rig.install({ text: (await Bun.file(rig.launcher).text()).replace("set -eu", "set -eu\nexit 3") })
    expect(await codeOf(() => readVer({ launcher: rig.launcher }))).toBe("version_failed")
    await rig.install()
  })
})

describe("出站标识", () => {
  test("入站 UA、x-app 与版本各不相同：/v1/messages 与 count_tokens 都只用宿主机版本，正文一字不改", async () => {
    const fetch = await fetchOf()
    const bodies = [msg(), msg({ stream: true }), { model: "claude-fable-5-2", messages: [{ role: "user", content: "count me" }] }]
    const clients = [INBOUND, { ...INBOUND, "user-agent": "claude-cli/9.9.9 (external, cli)" }, { ...INBOUND, "user-agent": "python-requests/2.31", "x-app": "other" }]
    for (const [i, headers] of clients.entries()) {
      const res = await fetch(URL_(i === 2 ? "/messages/count_tokens" : "/messages"), post(bodies[i], headers))
      expect(res.status).toBe(200)
      await text(res)
      expect(rig.seen.proxy.at(-1)).toMatchObject({ ua: UA("2.1.284"), app: "cli" })
    }
    // 原正文：字节级一致，计费归属等 system 段照旧
    expect(rig.seen.bodies.map((b) => b.path)).toEqual(["/v1/messages", "/v1/messages", "/v1/messages/count_tokens"])
    for (const i of [0, 1, 2]) expect(rig.seen.bodies[i].body, `body ${i}`).toBe(JSON.stringify(bodies[i]))
    const names = rig.seen.proxy[0].headers
    expect(names.some((h) => h.startsWith("x-magpie-") || h === "x-api-key")).toBe(false)
  })
  test("Magpie 的内部头与入站 UA 被去掉；没有宿主机版本时不发送", async () => {
    const fetch = await fetchOf()
    await fetch(URL_(), post(msg(), { ...INBOUND, "x-magpie-caller-agent": "claude", "X-Magpie-Sign-In": "kept" }))
    expect(rig.seen.proxy[0].headers.some((h) => h.startsWith("x-magpie-"))).toBe(false)
    const { forward } = await import("../lib/transport.mjs")
    await expect(forward({ input: URL_(), init: post(msg()), state: { baseUrl: `http://127.0.0.1:${rig.port}`, credential: "ticket-A-fake", deviceId: "device-fake" } })).rejects.toMatchObject({ code: "version_unknown" })
  })
})

describe("旧配置兼容与优先级", () => {
  test("成对的显式路径照旧执行：不与启动器选定的程序或指纹混用", async () => {
    const legacy = { opclauded: rig.bin, opusHome: rig.opusHome }
    expect(resolvePlan({ ...legacy })).toEqual({ mode: "explicit", settings: { ...legacy, proxyHome: "", opclaudedSha256: "" } })
    expect(resolvePlan({ ...legacy, opclaudedSha256: "0".repeat(64) })).toMatchObject({ mode: "explicit", settings: { opclaudedSha256: "0".repeat(64) } })
    const fetch = await fetchOf(legacy)
    expect((await fetch(URL_(), post(msg()))).status).toBe(200)
    // 启动器里记的指纹不参与显式模式的校验
    await rig.install({ sha256: "0".repeat(64) })
    expect((await fetch(URL_(), post(msg()))).status).toBe(200)
    expect(await text(await (await fetchOf({ ...legacy, opclaudedSha256: "0".repeat(64) }))(URL_(), post(msg())))).toContain("sha256_mismatch")
  })
  test("半缺的旧设置、自动发现时带指纹：拒绝，不与自动发现的结果拼在一起", async () => {
    const refuse = async (opts, meta) => {
      const res = await (await fetchOf(opts, rig.env, { type: "api", key: LOCAL_MARKER, metadata: meta }))(URL_(), post(msg()))
      expect(await text(res)).toContain("legacy_incomplete")
    }
    await refuse({ opclauded: rig.bin })
    await refuse({ opusHome: rig.opusHome })
    await refuse({ opclaudedSha256: "0".repeat(64) })
    await refuse({}, { opclauded: rig.bin })
    // 元数据与选项合成完整的一对时按旧的显式模式执行（这里是程序不存在），不会转去自动发现
    expect(await text(await (await fetchOf({ opusHome: rig.opusHome }, rig.env, { type: "api", key: LOCAL_MARKER, metadata: { opclauded: "/nonexistent/opclauded" } }))(URL_(), post(msg())))).toContain("[opclaude:binary_missing]")
    expect(rig.seen.proxy.length).toBe(0)
  })
  test("登录元数据优先于插件选项；proxyHome 单独给出时照常透传", async () => {
    expect(resolvePlan({ opclauded: "/a", opusHome: "/h" }, { metadata: { opclauded: "/b" } })).toMatchObject({ mode: "explicit", settings: { opclauded: "/b", opusHome: "/h" } })
    expect(resolvePlan({ opclauded: "/a", opusHome: "/h" }, { metadata: { opclauded: "/b", opusHome: "/h2" } })).toMatchObject({ settings: { opclauded: "/b", opusHome: "/h2" } })
    // 代理状态目录：显式 proxyHome > 宿主环境 OPCLAUDE_PROXY_HOME > 不传
    expect(resolvePlan({}, undefined, { OPCLAUDE_PROXY_HOME: "/srv/oc-proxy" })).toEqual({ mode: "auto", proxyHome: "/srv/oc-proxy" })
    expect(resolvePlan({}, undefined, { OPCLAUDE_PROXY_HOME: "" })).toEqual({ mode: "auto", proxyHome: "" })
    expect(resolvePlan({ proxyHome: "/opt/p" }, undefined, { OPCLAUDE_PROXY_HOME: "/srv/oc-proxy" })).toEqual({ mode: "auto", proxyHome: "/opt/p" })
    expect(resolvePlan({ opclauded: "/a", opusHome: "/h" }, undefined, { OPCLAUDE_PROXY_HOME: "/srv/oc-proxy" })).toMatchObject({ mode: "explicit", settings: { proxyHome: "/srv/oc-proxy" } })
    for (const bad of ["relative", 42]) expect(() => resolvePlan({}, undefined, { OPCLAUDE_PROXY_HOME: bad })).toThrow("[opclaude:proxy_home_invalid]")
  })
  test("proxyHome 只透传给 opclauded；启动器与 version 子进程拿不到它", async () => {
    expect(resolvePlan({ proxyHome: "/tmp/oc-proxy-home" })).toEqual({ mode: "auto", proxyHome: "/tmp/oc-proxy-home" })
    expect(await text(await (await fetchOf({ proxyHome: "/tmp/oc-proxy-home" }))(URL_(), post(msg())))).toContain('"role":"assistant"')
    expect((await read("state/last-env")).split("\n").includes("OPCLAUDE_PROXY_HOME")).toBe(true)
    expect((await read("launcher-env", rig.opusHome)).split("\n")).not.toContain("OPCLAUDE_PROXY_HOME")
  })
  test("选项类型不对：拒绝", async () => {
    for (const opts of [{ proxyHome: 1 }, { opclaudedSha256: 1 }, { opclauded: 1, opusHome: "/h" }, { opclauded: "/x", opusHome: true }]) {
      expect(await text(await (await fetchOf(opts))(URL_(), post(msg())))).toContain("[opclaude:option_invalid]")
    }
    expect(rig.seen.proxy.length).toBe(0)
  })
})

describe("模型发现与取消", () => {
  test("模型发现仍走宿主机代理，不读入站请求头", async () => {
    const h = plugin()
    const list = await h.provider.models({ models: {} }, { auth: { type: "api", key: LOCAL_MARKER } })
    expect(Object.keys(list)).toEqual(["claude-fable-5-2", "claude-sonnet-5-5"])
    expect(rig.seen.proxy.at(-1)).toMatchObject({ method: "GET", path: "/v1/models", authed: true })
  })
  test("版本读取期间调用方取消：不连代理，保持取消原因", async () => {
    rig.st.ccVersion = "hang"; await rig.sync()
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(new Error("gone")), 150)
    const fetch = await fetchOf()
    await expect(fetch(URL_(), post(msg(), INBOUND, { signal: ctrl.signal }))).rejects.toThrow("gone")
    expect(sent()).toHaveLength(0)
  })
  test("launch 先失败时报告 launch 的错误，并结束 version 子进程", async () => {
    rig.st.mode = "direct"; await rig.sync()
    rig.st.ccVersion = "hang"; await rig.sync()
    const res = await (await fetchOf())(URL_(), post(msg()))
    expect(await text(res)).toContain("[opclaude:mode_direct]")
    rig.st.mode = "proxy"; rig.st.ccVersion = "2.1.284"; await rig.sync()
  })
  test("错误信息稳定且不含任何敏感内容", async () => {
    const spies = [spyOn(console, "log"), spyOn(console, "error"), spyOn(console, "warn")]
    const logs = []
    spies.forEach((s) => s.mockImplementation((...a) => { logs.push(a.map(String).join(" ")); return true }))
    try {
      await rm(rig.launcher)
      const res = await (await fetchOf())(URL_(), post(msg()))
      expect(await text(res)).toContain(TEXT.launcher_not_found)
    } finally { spies.forEach((s) => s.mockRestore()) }
    await rig.install()
    expect(logs.join("\n")).not.toContain("ticket-A-fake")
    expect(logs.join("\n")).not.toContain("device-fake")
  })
})
