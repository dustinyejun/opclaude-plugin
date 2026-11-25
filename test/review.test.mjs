// 第一轮独立复审的返修：启动器绑定到所属安装、程序物理位置、宿主代理设置、版本探测的隔离与整组清理、
// 文件系统错误不外传、官方转义。全部用模拟安装，不读当前用户的真实配置。
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rename, rmdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { findLauncher, groupProbe, parseLauncher, readHostVersion } from "../lib/host.mjs"
import { LOCAL_MARKER, createPlugin } from "../lib/plugin.mjs"
import { FAILURE_STATUS, PLACEHOLDER_BASE, modelHeaders } from "../lib/transport.mjs"
import { makeRig, sharedTmp } from "./rig.mjs"

const UA = (v) => `claude-cli/${v} (external, cli)`
const msg = (extra = {}) => ({ model: "claude-fable-5-2", max_tokens: 64, stream: false, messages: [{ role: "user", content: "hi" }], ...extra })
const URL_ = (p = "/messages") => PLACEHOLDER_BASE + p
const INBOUND = { "user-agent": "claude-cli/2.1.100 (external, cli)", "x-app": "cli", "anthropic-version": "2023-06-01", "content-type": "application/json", "x-api-key": LOCAL_MARKER }
const post = (body, headers = INBOUND, extra = {}) => ({ method: "POST", headers, body: JSON.stringify(body), ...extra })
const text = async (res) => await res.text()
const sha = (data) => new Bun.CryptoHasher("sha256").update(data).digest("hex")
const exists = (file) => Bun.file(file).exists()
const AUTH = { type: "api", key: LOCAL_MARKER }

let rig, cwd, realHome
beforeAll(async () => {
  cwd = process.cwd()
  realHome = process.env.HOME
  rig = await makeRig()
  process.env.HOME = rig.dir
  delete process.env.OPUSCLAUDE_HOME
  delete process.env.OPUSCLAUDE_PROXY
  delete process.env.OPCLAUDE_PROXY_HOME
})
afterAll(async () => {
  process.chdir(cwd)
  process.env.HOME = realHome
  await rig.close()
})
beforeEach(async () => {
  process.chdir(cwd)
  Object.assign(rig.st, { mode: "proxy", ccVersion: "2.1.284", status: 200 })
  await rig.sync()
  await rig.restore()
  await rm(rig.dirs[1], { force: true })
  for (const f of ["claude-args", "claude-late", "claude-cwd", "launched-bin"]) await rm(path.join(rig.state, f), { force: true })
  rig.seen.proxy.length = 0
})

const plugin = (opts = {}, env = rig.env) => createPlugin(opts, { env, launcherDirs: rig.dirs, systemClaudes: rig.claudes })
const readVer = (opts = {}) => readHostVersion({ systemClaudes: rig.claudes, ...opts })
const fetchOf = async (opts, env = rig.env) => (await plugin(opts, env).auth.loader(async () => AUTH)).fetch
const sent = () => rig.seen.proxy.filter((r) => r.path !== "/v1/models")
// 插件运行的不是安装里的路径，而是核对过内容的绑定副本：<目录>/<启动器记的摘要>/opclauded/<版本>/opclauded。
// launched-bin 是实际被执行的路径，launched-layout 是它往上两级那一级的名字（程序按自己的位置往上找时看到的）。
const launchedCopy = async (r, binFile = r.bin, sha256 = "") => {
  const sum = sha256 || new Bun.CryptoHasher("sha256").update(new Uint8Array(await Bun.file(binFile).arrayBuffer())).digest("hex")
  expect((await Bun.file(path.join(r.state, "launched-bin")).text()).trim().endsWith("/opclauded/" + path.basename(path.dirname(binFile)) + "/opclauded")).toBe(true)
  expect((await Bun.file(path.join(r.state, "launched-layout")).text()).trim()).toBe(sum)
}
const read = (name, home = rig.dir) => Bun.file(path.join(home, name)).text()
const versionDir = () => path.dirname(rig.bin)
const share = async (content) => {
  await mkdir(path.dirname(rig.dirs[1]), { recursive: true })
  await Bun.write(rig.dirs[1], content)
  await chmod(rig.dirs[1], 0o755)
}

// 三条路径（请求、登录、模型发现）都只给出固定错误码，不带任何原始异常、安装路径或 config 里的内容，且零次代理请求。
async function refuse(expected, { env = rig.env, opts = {} } = {}) {
  const before = rig.seen.proxy.length
  const res = await (await fetchOf(opts, env))(URL_(), post(msg()))
  expect(res.status).toBe(FAILURE_STATUS)
  const body = await text(res)
  expect(body).toContain(`[opclaude:${expected}]`)
  expect(body).toContain('"type":"error"')
  const h = plugin(opts, env)
  const login = await h.auth.methods[0].authorize(undefined)
  expect(login).toMatchObject({ type: "failed", error: expect.stringContaining(`[opclaude:${expected}]`) })
  const models = await h.provider.models({ models: {} }, { auth: AUTH }).then(() => "", (e) => `${e.name} ${e.code} ${e.message}`)
  expect(models).toContain(`OpclaudeError ${expected}`)
  for (const out of [body, login.error, models].map(String)) {
    for (const leak of [rig.dir, rig.launcher, rig.config, "ENOTDIR", "ELOOP", "EACCES", "ENOENT", "ticket-config-fake", "ticket-A-fake", "at "]) expect(out.includes(leak), `leak ${leak}`).toBe(false)
  }
  expect(rig.seen.proxy.length).toBe(before)
  return body
}

describe("官方转义", () => {
  const esc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`")
  const launcher = (value) => `#!/bin/sh\nOPUS_DIR="\${OPUSCLAUDE_HOME:-$HOME/.opusclaude}"\nOPCLAUDED_BIN="${value}"\nOPCLAUDED_SHA256="${"ab".repeat(32)}"   # 装机时核对过的代理程序指纹\n`
  test("安装器写出的四种转义按字面解码：反斜杠、双引号、美元符、反引号", () => {
    const homes = ["/Users/a$b/.opusclaude", "/Users/a`b/.opusclaude", '/Users/a"b/.opusclaude', "/Users/a\\b/.opusclaude", "/Users/\\$`\"x/.opusclaude"]
    for (const home of homes) {
      const bin = `${home}/opclauded/0.5.1/opclauded`
      expect(parseLauncher(launcher(esc(bin)))).toEqual({ bin, sha256: "ab".repeat(32) })
    }
  })
  test("没转义的展开与命令替换、未知转义、引号外拼接照旧拒绝", () => {
    const plain = "/Users/u/.opusclaude/opclauded/0.5.1/opclauded"
    for (const value of [
      "/Users/a$b/.opusclaude/opclauded/0.5.1/opclauded",
      "/Users/a`id`/.opusclaude/opclauded/0.5.1/opclauded",
      '/Users/a"b/.opusclaude/opclauded/0.5.1/opclauded',
      "/Users/a\\\\$HOME/.opusclaude/opclauded/0.5.1/opclauded",
      "/Users/a\\n/.opusclaude/opclauded/0.5.1/opclauded",
      "/Users/a\\x/.opusclaude/opclauded/0.5.1/opclauded",
      plain + '$(id)',
      plain + '"$(id)',
      plain + '\\',
      plain.slice(0, -1) + '\\"',
    ]) {
      expect(() => parseLauncher(launcher(value)), value).toThrow("[opclaude:launcher_invalid]")
    }
  })
})

describe("启动器绑定到所属安装", () => {
  const good = async () => await Bun.file(rig.launcher).text()
  test("启动器被改动过（摘要与 config 的 LAUNCHER_SHA 不符）：不运行它", async () => {
    await rm(path.join(rig.state, "claude-args"), { force: true })
    await Bun.write(rig.launcher, (await good()) + "# appended by someone\n")
    try {
      await refuse("launcher_untrusted")
      // 在执行之前就拒绝：宿主机的 claude 没有被问到版本，opclauded 也没有运行
      expect(await exists(path.join(rig.state, "claude-args"))).toBe(false)
    } finally { await rig.restore() }
  })
  test("用户目录那份被改动时用 /usr/local/bin 那份；两份都要过同一校验", async () => {
    const content = await good()
    await share(content)
    await Bun.write(rig.launcher, content + "# appended by someone\n")
    try {
      expect((await (await fetchOf())(URL_(), post(msg()))).status).toBe(200)
      await launchedCopy(rig)
      // 共享目录那份也被改动：没有可用的启动器
      await share(content + "# appended by someone else\n")
      await refuse("launcher_untrusted")
    } finally { await rm(rig.dirs[1], { force: true }); await rig.restore() }
  })
  test("config 记的是另一套安装的启动器摘要：两份副本都不用", async () => {
    await share(await good())
    try {
      await rig.writeConfig(sha(await good() + "# another install\n"))
      await refuse("launcher_untrusted")
      // 没有记录、记录了两次、格式不对：同样拒绝
      await Bun.write(rig.config, "ANTHROPIC_AUTH_TOKEN='ticket-config-fake'\n")
      await chmod(rig.config, 0o600)
      await refuse("launcher_untrusted")
      await Bun.write(rig.config, "LAUNCHER_SHA='" + sha(await good()) + "'\nLAUNCHER_SHA='" + sha(await good()) + "'\n")
      await chmod(rig.config, 0o600)
      await refuse("launcher_untrusted")
    } finally { await rm(rig.dirs[1], { force: true }); await rig.restore() }
  })
  test("启动器、它所在的目录、安装目录或 config 能被其他用户改动：拒绝", async () => {
    const binDir = path.dirname(rig.launcher)
    const cases = [
      // 属主或权限不受信任：host_path_untrusted；config 没了、无从比对摘要：launcher_untrusted
      ["config 组可写", () => chmod(rig.config, 0o660), () => chmod(rig.config, 0o600), "host_path_untrusted"],
      ["config 所有人可写", () => chmod(rig.config, 0o646), () => chmod(rig.config, 0o600), "host_path_untrusted"],
      ["启动器组可写", () => chmod(rig.launcher, 0o775), () => chmod(rig.launcher, 0o755), "host_path_untrusted"],
      ["启动器所有人可写", () => chmod(rig.launcher, 0o777), () => chmod(rig.launcher, 0o755), "host_path_untrusted"],
      ["启动器目录所有人可写", () => chmod(binDir, 0o777), () => chmod(binDir, 0o755), "host_path_untrusted"],
      ["启动器目录组可写（非 wheel 组）", () => chmod(binDir, 0o775), () => chmod(binDir, 0o755), "host_path_untrusted"],
      ["安装目录所有人可写", () => chmod(rig.opusHome, 0o777), () => chmod(rig.opusHome, 0o700), "host_path_untrusted"],
      ["安装目录的上级（~/.local）组可写", () => chmod(path.join(rig.dir, ".local"), 0o775), () => chmod(path.join(rig.dir, ".local"), 0o755), "host_path_untrusted"],
      ["config 是符号链接", async () => { await rename(rig.config, rig.config + ".real"); await symlink(rig.config + ".real", rig.config) }, async () => { await rm(rig.config, { force: true }); await rename(rig.config + ".real", rig.config) }, "host_path_untrusted"],
      ["config 不存在", () => rm(rig.config), async () => {}, "launcher_untrusted"],
    ]
    // 这些用例说的是“组是共享的”：Linux 上测试用户的私有组不算，统一按共享组判断（私有组的接受见 host.test.mjs）。
    groupProbe.isPrivate = async () => false
    try {
    for (const [label, breakIt, repair, code] of cases) {
      await breakIt()
      try { await refuse(code) } finally { await repair(); await rig.install() }
      expect((await (await fetchOf())(URL_(), post(msg()))).status, label).toBe(200)
    }
    } finally { groupProbe.isPrivate = null }
  })
  test("旧的显式路径同样只运行与所属安装对得上的启动器", async () => {
    const legacy = { opclauded: rig.bin, opusHome: rig.opusHome }
    await Bun.write(rig.launcher, (await good()) + "# appended by someone\n")
    try { await refuse("launcher_untrusted", { opts: legacy }) } finally { await rig.restore() }
    expect((await (await fetchOf(legacy))(URL_(), post(msg()))).status).toBe(200)
  })
})

describe("程序必须在当前安装之内", () => {
  test("版本目录是符号链接、指向安装之外：拒绝，零请求", async () => {
    // 安装之外的另一份同名程序（内容相同，所以指纹也相同），把安装里的 opclauded 目录换成指向它的符号链接。
    const elsewhere = path.join(rig.dir, "elsewhere", "opclauded", "0.5.1-test")
    await mkdir(elsewhere, { recursive: true })
    await copyFile(rig.bin, path.join(elsewhere, "opclauded"))
    await chmod(path.join(elsewhere, "opclauded"), 0o755)
    await rm(path.join(rig.opusHome, "opclauded"), { recursive: true, force: true })
    await symlink(path.join(rig.dir, "elsewhere", "opclauded"), path.join(rig.opusHome, "opclauded"))
    try {
      await refuse("launcher_home_mismatch")
      expect(await exists(path.join(rig.state, "launched-bin"))).toBe(false)
    } finally {
      await rm(path.join(rig.opusHome, "opclauded"), { force: true })
      await rig.restore()
    }
    expect((await (await fetchOf())(URL_(), post(msg()))).status).toBe(200)
  })
  test("版本目录是符号链接、指向安装之内的另一个版本目录：按物理位置接受，执行并核对的就是那一份", async () => {
    const inside = path.join(rig.opusHome, "opclauded", "0.9.9")
    await mkdir(inside, { recursive: true })
    await copyFile(rig.bin, path.join(inside, "opclauded"))
    await chmod(path.join(inside, "opclauded"), 0o755)
    await rm(versionDir(), { recursive: true, force: true })
    await symlink(inside, versionDir())
    try {
      expect((await (await fetchOf())(URL_(), post(msg()))).status).toBe(200)
      const before = sent().length
      // 执行的是那一份文件的内容（摘要与启动器记的一致），位置在绑定副本目录里。
      await launchedCopy(rig, path.join(inside, "opclauded"))
      // 物理目标被改动：指纹对不上，不执行
      await Bun.write(path.join(inside, "opclauded"), "#!/bin/sh\necho pwned\n")
      await chmod(path.join(inside, "opclauded"), 0o755)
      expect(await text(await (await fetchOf())(URL_(), post(msg())))).toContain("[opclaude:sha256_mismatch]")
      expect(sent().length).toBe(before)
    } finally {
      await rm(versionDir(), { force: true })
      await rig.restore()
    }
    expect((await (await fetchOf())(URL_(), post(msg()))).status).toBe(200)
  })
})

describe("定位失败的文件系统错误不外传", () => {
  const repairHome = async () => { await rm(rig.opusHome, { recursive: true, force: true }); await rig.restore() }
  test("版本目录是普通文件（ENOTDIR）：三条路径都是固定错误码", async () => {
    await rm(versionDir(), { recursive: true, force: true })
    await writeFile(versionDir(), "not a directory")
    try { await refuse("binary_missing") } finally { await rm(versionDir(), { force: true }); await rig.restore() }
    expect((await (await fetchOf())(URL_(), post(msg()))).status).toBe(200)
  })
  test("符号链接成环（ELOOP）：固定错误码", async () => {
    await rm(versionDir(), { recursive: true, force: true })
    await symlink(versionDir(), versionDir())
    try { await refuse("binary_unreadable") } finally { await rm(versionDir(), { force: true }); await rig.restore() }
    expect((await (await fetchOf())(URL_(), post(msg()))).status).toBe(200)
  })
  test("OpusClaude home 的位置是一个普通文件：固定错误码", async () => {
    await rm(rig.opusHome, { recursive: true, force: true })
    await writeFile(rig.opusHome, "not a directory")
    try { await refuse("launcher_home_mismatch") } finally { await repairHome() }
    expect((await (await fetchOf())(URL_(), post(msg()))).status).toBe(200)
  })
  test("启动器的路径被普通文件挡住：当作启动器损坏", async () => {
    // usr-local/bin 这一级被普通文件占住：启动器的完整路径解析时报 ENOTDIR。
    await rm(path.join(rig.dir, "usr-local"), { recursive: true, force: true })
    await mkdir(path.join(rig.dir, "usr-local"), { recursive: true })
    await writeFile(path.join(rig.dir, "usr-local", "bin"), "not a directory")
    await rm(rig.launcher)
    try {
      const res = await (await fetchOf())(URL_(), post(msg()))
      expect(await text(res)).toContain("[opclaude:launcher_invalid]")
    } finally { await rm(path.join(rig.dir, "usr-local"), { recursive: true, force: true }); await rig.restore() }
    expect((await (await fetchOf())(URL_(), post(msg()))).status).toBe(200)
  })
})

describe("宿主环境里的官方代理设置", () => {
  test("OPUSCLAUDE_PROXY=0：本机代理视为未启用，登录、模型发现与请求都拒绝，零请求", async () => {
    const env = { ...rig.env, OPUSCLAUDE_PROXY: "0" }
    await refuse("proxy_disabled", { env })
    // 旧的显式路径同样不越过它
    await refuse("proxy_disabled", { env, opts: { opclauded: rig.bin, opusHome: rig.opusHome } })
    expect((await (await fetchOf({}, { ...rig.env, OPUSCLAUDE_PROXY: "1" }))(URL_(), post(msg()))).status).toBe(200)
  })
  test("OPCLAUDE_PROXY_HOME：交给 launch 子进程；显式 proxyHome 优先；相对路径拒绝", async () => {
    expect((await (await fetchOf({}, { ...rig.env, OPCLAUDE_PROXY_HOME: "/srv/oc-proxy-state" }))(URL_(), post(msg()))).status).toBe(200)
    expect((await read("state/last-env")).split("\n").includes("OPCLAUDE_PROXY_HOME")).toBe(true)
    await (await fetchOf({ proxyHome: "/opt/explicit" }, { ...rig.env, OPCLAUDE_PROXY_HOME: "/srv/oc-proxy-state" }))(URL_(), post(msg()))
    expect((await read("state/proxy-home")).trim()).toBe("/opt/explicit")
    // 不传时不设置这个变量；启动器与 version 子进程拿不到它
    expect((await read("launcher-env", rig.opusHome)).split("\n").includes("OPCLAUDE_PROXY_HOME")).toBe(false)
    await refuse("proxy_home_invalid", { env: { ...rig.env, OPCLAUDE_PROXY_HOME: "relative" } })
  })
})

describe("版本探测的隔离与清理", () => {
  test("PATH 里的空项、当前目录与相对项不能用：工具和 claude 都不从当前项目目录解析，工作目录不是项目目录", async () => {
    const project = await mkdtemp(path.join(tmpdir(), "opclaude-project-"))
    try {
      for (const [name, body] of [["sed", "#!/bin/sh\necho pwned > \"" + path.join(project, "sed-ran") + "\"\ncat\n"], ["claude", "#!/bin/sh\necho pwned > \"" + path.join(project, "claude-ran") + "\"\nprintf '9.9.9 (Claude Code)\\n'\n"]]) {
        await Bun.write(path.join(project, name), body)
        await chmod(path.join(project, name), 0o755)
      }
      process.chdir(project)
      // 空项、"."、"relative-dir" 都按当前目录（项目目录）解析；安装目录本身是绝对路径。
      const env = { ...rig.env, PATH: `:.:relative-dir:${process.env.PATH}` }
      expect(await readVer({ launcher: rig.launcher, source: env })).toBe("2.1.284")
      const items = (await read("launcher-path", rig.opusHome)).trim().split(":")
      expect(items[0]).toBe(path.join(rig.dir, ".local", "bin"))
      expect(items.includes(project)).toBe(false)
      expect(items.filter((p) => !p.startsWith("/"))).toEqual([])
      expect((await read("launcher-cwd", rig.opusHome)).trim()).toBe("/")
      expect((await read("state/claude-cwd")).trim()).toBe("/")
      expect(await exists(path.join(project, "sed-ran"))).toBe(false)
      expect(await exists(path.join(project, "claude-ran"))).toBe(false)
      // 经插件：同样成立
      expect((await (await fetchOf({}, env))(URL_(), post(msg()))).status).toBe(200)
      expect(sent()[0].ua).toBe(UA("2.1.284"))
      expect(await exists(path.join(project, "claude-ran"))).toBe(false)
    } finally { process.chdir(cwd); await rm(project, { recursive: true, force: true }) }
  })
  test("取消与超时结束整个进程组：挂起的 claude --version 不会活到之后写出标记，重复调用不累积进程", async () => {
    rig.st.ccVersion = "late"; await rig.sync()
    const marker = path.join(rig.state, "claude-late")
    for (const run of [
      () => readVer({ launcher: rig.launcher, timeoutMs: 8000, signal: AbortSignal.timeout(300) }),
      () => readVer({ launcher: rig.launcher, timeoutMs: 300 }),
    ]) {
      await rm(marker, { force: true })
      const started = Date.now()
      const outcome = await run().then((v) => "resolved " + v, (e) => `${e.code ?? e.name} ${e.message ?? ""}`)
      await Bun.sleep(2600)
      expect(await exists(marker), outcome).toBe(false)
    }
    // 经插件取消：保留调用方自己的取消原因，claude 同样没有留下
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(new Error("caller gone")), 300)
    const outcome3 = await (await fetchOf())(URL_(), post(msg(), INBOUND, { signal: ctrl.signal })).then(async (r) => "resolved " + r.status + " " + (await r.text()).slice(0, 80), (e) => `rejected ${e.message}`)

    await Bun.sleep(2600)
    // 重复调用之后没有任何进程还挂在这次安装上（pgrep 自己不在结果里；它的命令行不含安装目录之外的匹配项）。
    // 没有 pgrep 的精简容器里改查 /proc 里每个进程的命令行。
    let pgrep = null
    try { pgrep = Bun.spawnSync(["pgrep", "-fl", rig.dir]) } catch {}
    let left = pgrep ? pgrep.stdout.toString().trim() : ""
    if (!pgrep) {
      for (const pid of await readdir("/proc").catch(() => [])) {
        if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue
        const cmd = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")
        if (cmd.includes(rig.dir)) left += `${pid} ${cmd.replaceAll("\0", " ")}\n`
      }
    }
    expect(left).toBe("")
  }, 20000)
  test("输出超过上限：明确拒绝，即使启动器自己正常退出", async () => {
    const source = await Bun.file(rig.launcher).text()
    const marker = 'if [ "${1:-}" = version ]; then'
    expect(source.includes(marker)).toBe(true)
    await rig.install({ text: source.replace(marker, marker + "\n  head -c 70000 /dev/zero | tr '\\0' x") })
    try {
      expect(await readVer({ launcher: rig.launcher }).then(() => "", (e) => e.code)).toBe("version_output_invalid")
      await refuse("version_output_invalid")
    } finally { await rig.restore() }
    expect(await readVer({ launcher: rig.launcher })).toBe("2.1.284")
  })
  test("多字节字符被拆在相邻两次写入里：按完整输出解析中文版本行", async () => {
    const source = await Bun.file(rig.launcher).text()
    const marker = 'if [ "${1:-}" = version ]; then'
    await rig.install({ text: source.replace(marker, marker + '\n  printf \'OpusClaude 接入包：20261120.1\\n\' > "$OPUS_DIR/line"\n  n=$(wc -c < "$OPUS_DIR/line"); i=0\n  while [ "$i" -lt "$n" ]; do dd if="$OPUS_DIR/line" bs=1 skip="$i" count=1 2>/dev/null; i=$((i+1)); done') })
    try {
      expect(await readVer({ launcher: rig.launcher })).toBe("2.1.284")
      expect((await (await fetchOf())(URL_(), post(msg()))).status).toBe(200)
    } finally { await rig.restore() }
  })
})

describe("第二轮复审", () => {
  const good = async () => await Bun.file(rig.launcher).text()
  const binLine = (text, bin, digest) => text.replace(/^OPCLAUDED_BIN=.*$/m, `OPCLAUDED_BIN="${bin}"`).replace(/^OPCLAUDED_SHA256=.*$/m, `OPCLAUDED_SHA256="${digest}" # x`)
  const args = () => path.join(rig.state, "claude-args")

  test("用户目录那份是升级前的旧启动器（摘要对不上、选的程序也已不在）：用另一处正确的那份", async () => {
    const current = await good()
    await share(current)
    // 旧启动器：还指着已经删掉的旧版本目录。它不是当前安装写出的那份，所以不被运行，哪怕它选的程序不存在。
    await Bun.write(rig.launcher, binLine(current, path.join(rig.opusHome, "opclauded", "0.4.0-old", "opclauded"), "ab".repeat(32)))
    try {
      expect((await (await fetchOf())(URL_(), post(msg()))).status).toBe(200)
      await launchedCopy(rig)
    } finally { await rm(rig.dirs[1], { force: true }); await rig.restore() }
    // 反过来：过期的那份就是 config 记录的（安装升到一半），另一处那份是新的。程序确实不在是实情，要照实报出来，
    // 不拿另一份启动器顶替，也不去运行任何程序。
    await share(current)
    try {
      await rig.install({ text: binLine(current, path.join(rig.opusHome, "opclauded", "0.4.0-old", "opclauded"), "ab".repeat(32)) })
      await refuse("binary_missing")
    } finally { await rm(rig.dirs[1], { force: true }); await rig.install() }
    expect((await (await fetchOf())(URL_(), post(msg()))).status).toBe(200)
  })

  test("升级或改动发生在定位之后：运行的是核对过摘要的那份字节，启动器文件不再读一次", async () => {
    const marker = path.join(rig.state, "replaced-ran")
    // 内容仍然是一个格式合法的启动器，只是 version 分支里多了一行：跑没跑，看标记文件在不在。
    const branch = 'if [ "${1:-}" = version ]; then'
    const evil = (await good()).replace(branch, branch + "\n  touch " + marker)
    expect(parseLauncher(evil).bin).toBe(rig.bin)
    const found = await findLauncher(rig.env, { dirs: rig.dirs })
    expect(found.bytes.byteLength).toBeGreaterThan(1000)
    // 自动发现同时打开了核对过的程序：这里只用启动器字节，把描述符关掉
    await found.executable.close()
    // 定位之后文件被换掉（比如升级到一半、或被人改动）：版本探测拿的是定位时读出的字节
    await Bun.write(rig.launcher, evil)
    await chmod(rig.launcher, 0o755)
    expect(await readVer({ script: found.bytes, source: rig.env })).toBe("2.1.284")
    expect(await exists(marker)).toBe(false)
    // 文件被删掉也一样
    await rm(rig.launcher)
    expect(await readVer({ script: found.bytes, source: rig.env })).toBe("2.1.284")
    expect(await exists(marker)).toBe(false)
    // 下一次请求重新定位：换上来的那份与 config 记录的摘要不符，不运行
    await Bun.write(rig.launcher, evil)
    await chmod(rig.launcher, 0o755)
    await refuse("launcher_untrusted")
    expect(await exists(marker)).toBe(false)
    await rig.restore()
    expect((await (await fetchOf())(URL_(), post(msg()))).status).toBe(200)
  })

  test("config 只按字节找 LAUNCHER_SHA 那一行：票据再长、含非法 UTF-8 也照常，票据不进任何输出", async () => {
    // 票据一行就超过一个读取块（64 KiB），LAUNCHER_SHA 落在下一块里；票据里带不能解码成 UTF-8 的字节。
    const token = "t".repeat(100000) + Buffer.from([0xff, 0xfe, 0x80, 0xc0, 0xed, 0xa0, 0x80]).toString("latin1") + "u".repeat(1000)
    expect(Buffer.from(token, "latin1").toString("utf8") === token).toBe(false)
    const config = [
      "# OpusClaude 接入配置（自动生成，勿手改；chmod 600；卸载：install.sh --uninstall）",
      `ANTHROPIC_AUTH_TOKEN='${token}'`,
      "GATEWAY='https://api.opusapi.xyz'",
      "DEVICE_ID='device-fake'",
      "LAUNCHER_SHA='" + sha(await good()) + "'",
      "CLI_PKG_VERSION='20261120.1'",
      "OPCLAUDE_PROXY='1'",
    ].join("\n") + "\n"
    await Bun.write(rig.config, Buffer.from(config, "latin1"))
    await chmod(rig.config, 0o600)
    try {
      const res = await (await fetchOf())(URL_(), post(msg()))
      expect(res.status).toBe(200)
      const body = await res.text()
      for (const out of [body, await read("launcher-env", rig.opusHome), await read("state/claude-env")]) {
        expect(out.includes("t".repeat(64))).toBe(false)
        expect(out.includes("ANTHROPIC_AUTH_TOKEN")).toBe(false)
      }
      // 同一份 config 里摘要被改动：照旧拒绝，错误里没有票据
      await Bun.write(rig.config, Buffer.from(config.replace(/\nLAUNCHER_SHA='.*'\n/, "\nLAUNCHER_SHA='" + "cd".repeat(32) + "'\n"), "latin1"))
      await chmod(rig.config, 0o600)
      expect(await text(await (await fetchOf())(URL_(), post(msg())))).not.toContain("t".repeat(64))
    } finally { await rig.install() }
    expect((await (await fetchOf())(URL_(), post(msg()))).status).toBe(200)
  })

  test("三条出站路径（请求、count_tokens、GET /v1/models）带同一套宿主机标识；没有版本时模型发现不发送", async () => {
    const hooks = plugin()
    const models = await hooks.provider.models({ models: {} }, { auth: AUTH })
    expect(Object.keys(models).length).toBeGreaterThan(0)
    expect(rig.seen.proxy.at(-1)).toMatchObject({ method: "GET", path: "/v1/models", authed: true, ua: UA("2.1.284"), app: "cli" })
    expect((await (await fetchOf())(URL_(), post(msg()))).status).toBe(200)
    expect(rig.seen.proxy.at(-1)).toMatchObject({ method: "POST", path: "/v1/messages", authed: true, ua: UA("2.1.284"), app: "cli" })
    expect(rig.seen.proxy.at(-1).headers.filter((h) => h.startsWith("x-magpie") || h.startsWith("x-opencode") || h === "x-api-key")).toEqual([])
    expect(rig.seen.proxy.filter((r) => r.path === "/v1/models").map((r) => r.ua)).toEqual([UA("2.1.284")])
    // 读不出版本：模型发现不带别的 UA 发出去，直接拒绝
    rig.st.ccVersion = "missing"; await rig.sync()
    const before = rig.seen.proxy.length
    await expect(hooks.provider.models({ models: {} }, { auth: AUTH })).rejects.toThrow("[opclaude:version_unknown]")
    expect(rig.seen.proxy.length).toBe(before)
    // 即使带着完整运行态、只是缺版本：也不构造模型发现的请求头
    expect(() => modelHeaders({ baseUrl: "http://127.0.0.1:18827", credential: "ticket-A-fake", deviceId: "device-fake" })).toThrow("[opclaude:version_unknown]")
    expect(Object.fromEntries(modelHeaders({ cliVersion: "2.1.284" }))).toMatchObject({ "user-agent": UA("2.1.284"), "x-app": "cli" })
    rig.st.ccVersion = "2.1.284"; await rig.sync()
  })

  test("运行启动器之前核对 ~/.local/bin、它的上级和里面的 claude：有一处能被别人改动就不运行", async () => {
    const claude = path.join(rig.dir, ".local", "bin", "claude")
    const local = path.join(rig.dir, ".local")
    const scratch = path.join(rig.dir, "scratch")
    const cases = [
      ["~/.local 所有人可写", () => chmod(local, 0o777), () => chmod(local, 0o755)],
      ["~/.local/bin 组可写", () => chmod(path.dirname(claude), 0o775), () => chmod(path.dirname(claude), 0o755)],
      ["~/.local/bin/claude 所有人可写", () => chmod(claude, 0o777), () => chmod(claude, 0o755)],
      // 符号链接本身不设防，看的是它指向的实体：实体在所有人可写的目录里，就等于谁都能换掉它
      ["~/.local/bin/claude 指向所有人可写目录里的文件", async () => { await mkdir(scratch); await chmod(scratch, 0o777); await rename(claude, path.join(scratch, "claude")); await symlink(path.join(scratch, "claude"), claude) }, async () => { await rm(claude, { force: true }); await rename(path.join(scratch, "claude"), claude); await rmdir(scratch) }],
    ]
    groupProbe.isPrivate = async () => false
    try {
    for (const [label, breakIt, repair] of cases) {
      await rm(args(), { force: true })
      await breakIt()
      try {
        expect(await text(await (await fetchOf())(URL_(), post(msg()))), label).toContain("[opclaude:host_path_untrusted]")
        // 在运行启动器之前就拒绝：claude 没有被问到版本
        expect(await exists(args()), label).toBe(false)
      } finally { await repair() }
      // 修好之后照常可用
      expect((await (await fetchOf())(URL_(), post(msg()))).status, label).toBe(200)
    }
    } finally { groupProbe.isPrivate = null }
  })

  test("版本探测的 PATH 与环境：项目目录（绝对路径）不进 PATH，经 stdin 执行时 $0 是 /bin/sh，工作目录是 /", async () => {
    const workspace = await mkdtemp(path.join(await sharedTmp(), "opclaude-ws-"))
    const project = path.join(workspace, "project-a")
    const sibling = path.join(workspace, "project-b")
    let extra = ""
    try {
      await mkdir(path.join(project, "bin"), { recursive: true })
      await mkdir(sibling, { recursive: true })
      await Bun.write(path.join(project, "claude"), "#!/bin/sh\ntouch " + path.join(project, "claude-ran") + "\nprintf '9.9.9 (Claude Code)\\n'\n")
      await chmod(path.join(project, "claude"), 0o755)
      let env
      // 宿主进程的当前目录就是 project
      process.chdir(project)
      // 宿主 PATH 自己给全：项目目录、项目子目录、一个受信任的自定义目录，然后是系统目录。结果不依赖运行测试的机器的 PATH。
      extra = await mkdtemp(path.join(await sharedTmp(), "opclaude-path-extra-"))
      env = { ...rig.env, PATH: `${project}:${path.join(project, "bin")}:${extra}:/usr/bin:/bin` }
      expect(await readVer({ launcher: rig.launcher, source: env })).toBe("2.1.284")
      const items = (await read("launcher-path", rig.opusHome)).trim().split(":")
      // 官方启动器把 ~/.local/bin 放到最前；之后是宿主 PATH 里受信任的绝对路径项，保持宿主原有的先后；不补任何别的目录
      expect(items).toEqual([path.join(rig.dir, ".local", "bin"), extra, "/usr/bin", "/bin"])
      expect(await exists(path.join(project, "claude-ran"))).toBe(false)
      expect(items.filter((p) => p === project || p.startsWith(project + "/"))).toEqual([])
      // 经插件：同样不用。切换到兄弟目录 sibling 后，project 就不再是当前项目目录，成为普通受信任目录可以用
      expect((await (await fetchOf({}, env))(URL_(), post(msg()))).status).toBe(200)
      expect(await exists(path.join(project, "claude-ran"))).toBe(false)
      process.chdir(sibling)
      expect(await readVer({ launcher: rig.launcher, source: env })).toBe("2.1.284")
      expect((await read("launcher-path", rig.opusHome)).trim().split(":").filter((p) => p === project || p.startsWith(project + "/"))).toEqual([project, path.join(project, "bin")])
      expect(await exists(path.join(project, "claude-ran"))).toBe(false)
      process.chdir(project)
      expect((await (await fetchOf({}, env))(URL_(), post(msg()))).status).toBe(200)
      process.chdir(cwd)
      expect((await read("launcher-argv0", rig.opusHome)).trim()).toBe("/bin/sh")
      expect((await read("launcher-cwd", rig.opusHome)).trim()).toBe("/")
      expect((await read("state/claude-cwd")).trim()).toBe("/")
      expect((await read("state/claude-path")).trim().split(":")[0]).toBe(path.join(rig.dir, ".local", "bin"))
      // version 子进程的环境：只有 HOME / LANG / LC_ALL / TMPDIR / PATH（默认安装不带 OPUSCLAUDE_HOME），没有代理设置和票据
      for (const [name, home] of [["launcher-env", rig.opusHome], ["state/claude-env", rig.dir]]) {
        const keys = (await read(name, home)).trim().split("\n").filter(Boolean)
        expect(keys.filter((k) => !["HOME", "LANG", "LC_ALL", "TMPDIR", "PATH", "PWD", "SHLVL", "_", "OC_DEBUG", "OLDPWD"].includes(k))).toEqual([])
        expect(keys).not.toContain("OPUSCLAUDE_HOME")
      }
    } finally { process.chdir(cwd); await rm(workspace, { recursive: true, force: true }); if (extra) await rm(extra, { recursive: true, force: true }) }
    expect((await (await fetchOf())(URL_(), post(msg()))).status).toBe(200)
  })
})
