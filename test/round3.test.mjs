// 第三轮复审的八个问题：每一条都从复审报告描述的现场直接复现。
// 这些用例同时要在 macOS 与 Linux 容器（4 KiB 页，debian:bookworm-slim）里跑。
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { chmod, lstat, mkdir, readdir, mkdtemp, readFile, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import { findLauncher, groupProbe, launcherPin, readHostVersion, trustedPath } from "../lib/host.mjs"
import { runLaunch } from "../lib/launch.mjs"
import { LOCAL_MARKER, createPlugin } from "../lib/plugin.mjs"
import { PLACEHOLDER_BASE } from "../lib/transport.mjs"
import { sharedTmp, makeRig } from "./rig.mjs"

const UA = (v) => `claude-cli/${v} (external, cli)`
const INBOUND = { "user-agent": "claude-cli/2.1.100 (external, cli)", "x-app": "cli", "anthropic-version": "2023-06-01", "content-type": "application/json" }
const post = (body, extra = {}) => ({ method: "POST", headers: INBOUND, body: JSON.stringify(body), ...extra })
const msg = () => ({ model: "claude-fable-5-2", max_tokens: 64, stream: false, messages: [{ role: "user", content: "hi" }] })
const URL_ = (p = "/messages") => PLACEHOLDER_BASE + p
const text = async (res) => await res.text()
const exists = (file) => Bun.file(file).exists()
const codeOf = (fn) => fn().then(() => "", (e) => e.code)
// 别的用户进得来、可以随手建文件的目录（权限类用例要在这里测）。
const openDir = async (mode = 0o777) => { const d = await mkdtemp(path.join(await sharedTmp(), "opclaude-open-")); await chmod(d, mode); return d }

let rig, realHome
beforeAll(async () => {
  realHome = process.env.HOME
  rig = await makeRig()
  process.env.HOME = rig.dir
})
afterAll(async () => { process.env.HOME = realHome; await rig.close() })
beforeEach(async () => {
  Object.assign(rig.st, { mode: "proxy", ccVersion: "2.1.284", status: 200 })
  await rig.sync()
  // 上个用例可能把 claude 换成了符号链接：先删掉，重装时不会写穿到别处。
  // 上个用例在沙箱里留下的其他候选位置（.claude、.nvm、PATH 上的目录）一并清掉。
  for (const name of await readdir(rig.dir)) {
    if (![".local", ".opusclaude", "state"].includes(name)) await rm(path.join(rig.dir, name), { recursive: true, force: true })
  }
  await rm(path.join(rig.dir, ".local", "bin", "claude"), { force: true })
  await rm(path.join(rig.dir, ".local", "share"), { recursive: true, force: true })
  await rig.restore()
  // 权限类用例留下的组可写也恢复。
  await chmod(localBin(), 0o755)
  await chmod(rig.config, 0o600)
  await chmod(path.join(rig.dir, ".opusclaude", "opclauded"), 0o755)
  groupProbe.isPrivate = null
})

const fetchOf = async (env = rig.env, opts = {}, dirs = rig.dirs, claudes = rig.claudes) => (await createPlugin(opts, { env, launcherDirs: dirs, systemClaudes: claudes }).auth.loader(async () => ({ type: "api", key: LOCAL_MARKER }))).fetch
const readVer = (opts = {}) => readHostVersion({ systemClaudes: rig.claudes, ...opts })
// 一次请求经插件的全链路：出站标识用的宿主机版本，失败时是错误码。
const outcome = async (env = rig.env) => {
  const res = await (await fetchOf(env))(URL_(), post(msg()))
  const body = await res.text()
  return res.status === 200 ? "ok " + rig.seen.ua.at(-1).replace(/^claude-cli\/(\S+) .*$/, "$1") : (body.match(/\[opclaude:[a-z_]+\]/)?.[0] ?? body.slice(0, 80))
}

// 一份假的 claude：--version 输出 <dir>/version 里的版本号；别的参数写下标记后失败。
const claudeAt = async (file, version) => {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `#!/bin/sh
case "$*" in --version) printf '%s (Claude Code)\\n' '${version}' ; exit 0 ;; esac
printf ran > '${file}.ran'
exit 1
`)
  await chmod(file, 0o755)
  return file
}
const localBin = () => path.join(rig.dir, ".local", "bin")
// 去掉默认的 ~/.local/bin/claude，让候选顺序落到后面的位置。
const noLocalClaude = async () => { await rm(path.join(localBin(), "claude"), { force: true }) }

describe("1. 启动器经标准输入交给 sh，不走单个 argv", () => {
  test("完整大小的官方启动器（157479 字节，超过 Linux 单个参数 131072 的上限）：版本照常读到", async () => {
    const target = 157479
    // 启动器正文之后补注释行，按字节凑到官方模板替换后的实际大小（正文里有中文，不能按字符数算）。
    const source = Buffer.from(await Bun.file(rig.launcher).arrayBuffer())
    const line = Buffer.from("#" + "x".repeat(99) + "\n")
    const pad = Buffer.alloc(Math.ceil((target - source.length - 1) / line.length) * line.length)
    for (let i = 0; i < pad.length; i += line.length) line.copy(pad, i)
    const big = Buffer.concat([source, Buffer.from("\n"), pad]).subarray(0, target)
    await Bun.write(rig.launcher, big)
    await chmod(rig.launcher, 0o755)
    await rig.writeConfig(new Bun.CryptoHasher("sha256").update(big).digest("hex"))
    expect((await lstat(rig.launcher)).size).toBe(target)
    expect(big.length).toBeGreaterThan(131072)
    expect(await readVer({ launcher: rig.launcher, source: rig.env })).toBe("2.1.284")
    expect(await outcome()).toBe("ok 2.1.284")
    // 子进程的参数只有 version 一个：启动器正文不在 argv 里。
    const argv = (await readFile(path.join(rig.opusHome, "launcher-argv0"), "utf8").catch(() => "")).trim()
    expect(argv.length).toBeLessThan(200)
  })
})

describe("2. 选哪一份 Claude：官方候选顺序加宿主 PATH 的原有先后", () => {
  test("从 HOME 启动：HOME 之下的 nvm 目录不算项目目录，PATH 上的 claude 照常用", async () => {
    const nvm = path.join(rig.dir, ".nvm", "versions", "node", "v20.0.0", "bin")
    await claudeAt(path.join(nvm, "claude"), "2.1.300")
    await noLocalClaude()
    const cwd = process.cwd()
    process.chdir(rig.dir)
    try {
      const env = { ...rig.env, PWD: rig.dir, PATH: `${nvm}:${process.env.PATH}` }
      expect(await readVer({ launcher: rig.launcher, source: env })).toBe("2.1.300")
      expect(await outcome(env)).toBe("ok 2.1.300")
      expect((await readFile(path.join(rig.opusHome, "launcher-path"), "utf8")).startsWith(localBin())).toBe(true)
    } finally { process.chdir(cwd) }
  })
  test("宿主 PATH 排在前面的目录里的 2.1.300 胜过系统目录里的 2.1.100：系统目录只补在最后", async () => {
    const first = path.join(rig.dir, "first-on-path", "bin")
    await claudeAt(path.join(first, "claude"), "2.1.300")
    await claudeAt(path.join(rig.dir, "system", "bin", "claude"), "2.1.100")
    await noLocalClaude()
    // 宿主 PATH 的第一项是 2.1.300；“系统目录”那一项排在它后面，就像 /usr/bin 在宿主 PATH 的后面。
    const env = { ...rig.env, PATH: `${first}:${path.join(rig.dir, "system", "bin")}:${process.env.PATH}` }
    expect(await readVer({ launcher: rig.launcher, source: env })).toBe("2.1.300")
    expect(await outcome(env)).toBe("ok 2.1.300")
    expect(await exists(path.join(rig.dir, "system", "bin", "claude.ran"))).toBe(false)
  })
  test("固定位置 ~/.claude/local/claude 排在 PATH 上的 claude 前面：执行的是前者", async () => {
    await claudeAt(path.join(rig.dir, ".claude", "local", "claude"), "2.1.300")
    const onPath = path.join(rig.dir, "on-path", "bin")
    await claudeAt(path.join(onPath, "claude"), "2.1.100")
    await noLocalClaude()
    const env = { ...rig.env, PATH: `${onPath}:${process.env.PATH}` }
    expect(await readVer({ launcher: rig.launcher, source: env })).toBe("2.1.300")
    expect(await exists(path.join(onPath, "claude.ran"))).toBe(false)
  })
})

describe("3. 符号链接所在的目录、每一跳经过的目录都要核对", () => {
  test("claude 是符号链接，它本身放在所有人可写的目录里，指向的是受信任的文件：拒绝", async () => {
    const real = await claudeAt(path.join(rig.dir, ".local", "share", "real", "claude"), "2.1.284")
    const open = await openDir()
    const link = path.join(open, "claude")
    await symlink(real, link)
    await rm(path.join(localBin(), "claude"), { force: true })
    await symlink(link, path.join(localBin(), "claude"))
    try {
      expect(await codeOf(() => readVer({ launcher: rig.launcher, source: rig.env }))).toBe("host_path_untrusted")
      expect(await outcome()).toBe("[opclaude:host_path_untrusted]")
      expect(await exists(real + ".ran")).toBe(false)
      // 单看实体文件与它的目录是好的：不可信的是链接所在的那一级。
      expect((await trustedPath(real)).ok).toBe(true)
      expect((await trustedPath(link)).ok).toBe(false)
    } finally { await rm(open, { recursive: true, force: true }) }
  })
  test("链接放在受信任的目录里、实体也在受信任的目录里：照常可用", async () => {
    const real = await claudeAt(path.join(rig.dir, ".local", "share", "real", "claude"), "2.1.284")
    await rm(path.join(localBin(), "claude"), { force: true })
    await symlink(real, path.join(localBin(), "claude"))
    expect(await readVer({ launcher: rig.launcher, source: rig.env })).toBe("2.1.284")
    expect(await outcome()).toBe("ok 2.1.284")
  })
})

describe("4. 核对的是官方实际会执行的那一份，以及它会用到的工具", () => {
  test("PATH 上的 claude：文件所有人可写就拒绝，claude 不运行", async () => {
    const onPath = path.join(rig.dir, "on-path", "bin")
    const file = await claudeAt(path.join(onPath, "claude"), "2.1.300")
    await noLocalClaude()
    const env = { ...rig.env, PATH: `${onPath}:${process.env.PATH}` }
    expect(await readVer({ launcher: rig.launcher, source: env })).toBe("2.1.300")
    await chmod(file, 0o777)
    expect(await codeOf(() => readVer({ launcher: rig.launcher, source: env }))).toBe("host_path_untrusted")
    expect(await exists(file + ".ran")).toBe(false)
  })
  test("钉死的版本文件 versions/<CLAUDE_PIN>：被别人能改的那一份不运行", async () => {
    await noLocalClaude()
    const versions = path.join(rig.dir, ".local", "share", "claude", "versions")
    const file = await claudeAt(path.join(versions, "2.1.284"), "2.1.284")
    await claudeAt(path.join(versions, "2.1.99"), "2.1.99")
    expect(launcherPin(await Bun.file(rig.launcher).text())).toBe("2.1.284")
    // 宿主 PATH 上没有 claude：按官方顺序落到钉死的版本文件。
    const env = { ...rig.env, PATH: "/usr/bin:/bin" }
    expect(await readVer({ launcher: rig.launcher, source: env })).toBe("2.1.284")
    expect(await outcome(env)).toBe("ok 2.1.284")
    expect(await exists(path.join(versions, "2.1.99.ran"))).toBe(false)
    await chmod(file, 0o777)
    expect(await codeOf(() => readVer({ launcher: rig.launcher, source: env }))).toBe("host_path_untrusted")
    expect(await exists(file + ".ran")).toBe(false)
  })
  test("受信任目录里的 sed 是符号链接，指向所有人可写目录里的文件：拒绝，sed 不运行", async () => {
    const binDir = path.join(rig.dir, "tools", "bin")
    await mkdir(binDir, { recursive: true })
    const open = await openDir()
    const target = path.join(open, "sed")
    await writeFile(target, "#!/bin/sh\nprintf ran > '" + target + ".ran'\nexit 0\n")
    await chmod(target, 0o755)
    await symlink(target, path.join(binDir, "sed"))
    try {
      const env = { ...rig.env, PATH: `${binDir}:${process.env.PATH}` }
      expect(await codeOf(() => readVer({ launcher: rig.launcher, source: env }))).toBe("host_path_untrusted")
      expect(await outcome(env)).toBe("[opclaude:host_path_untrusted]")
      expect(await exists(target + ".ran")).toBe(false)
      // 真正的 sed 没被挡住：去掉这一个假的，照常可用。
      await unlink(path.join(binDir, "sed"))
      expect(await readVer({ launcher: rig.launcher, source: env })).toBe("2.1.284")
    } finally { await rm(open, { recursive: true, force: true }) }
  })
})

describe("5. opclauded（绑定副本的用例见 round4.test.mjs）", () => {
  test("旧的显式路径：指纹仍然按路径上的文件核对，对不上就是 sha256_mismatch", async () => {
    const settings = { opclauded: rig.bin, opusHome: rig.opusHome, opclaudedSha256: "0".repeat(64) }
    expect(await codeOf(() => runLaunch(settings, { source: rig.env }))).toBe("sha256_mismatch")
  })
})

describe("6. 没被选中的旧副本不挡路", () => {
  test("~/.claude/local/claude 是失效的符号链接（升级留下的），~/.local/bin 里那份完好：照常可用", async () => {
    await mkdir(path.join(rig.dir, ".claude", "local"), { recursive: true })
    await symlink(path.join(rig.dir, ".claude", "downloads", "2.0.1", "claude"), path.join(rig.dir, ".claude", "local", "claude"))
    expect(await readVer({ launcher: rig.launcher, source: rig.env })).toBe("2.1.284")
    expect(await outcome()).toBe("ok 2.1.284")
  })
})

describe("7. 组可写：看别的用户是不是真的能换掉", () => {
  const groupWritable = async (r) => {
    const binDir = path.join(r.dir, ".local", "bin")
    await chmod(binDir, 0o775)
    await chmod(r.launcher, 0o775)
    await chmod(path.join(binDir, "claude"), 0o775)
    await chmod(r.config, 0o660)
    await chmod(path.join(r.dir, ".opusclaude", "opclauded"), 0o775)
  }
  test("用户目录是 0700 的私有目录：里面组可写的目录与文件照常可用", async () => {
    const r = await makeRig({ private: true })
    process.env.HOME = r.dir
    try {
      expect((await stat(r.dir)).mode & 0o077).toBe(0)
      await groupWritable(r)
      expect(await readHostVersion({ launcher: r.launcher, source: r.env, systemClaudes: r.claudes })).toBe("2.1.284")
      expect(await codeOf(() => findLauncher(r.env, { dirs: r.dirs }).then((f) => f.executable.close()))).toBe("")
      const res = await (await fetchOf(r.env, {}, r.dirs, r.claudes))(URL_(), post(msg()))
      expect(res.status).toBe(200)
    } finally { process.env.HOME = rig.dir; await r.close() }
  })
  test("组只有受信任的用户：组可写可用；组是共享的：拒绝。是不是主组本身不算证明", async () => {
    await groupWritable(rig)
    const plugin = createPlugin({}, { env: rig.env, launcherDirs: rig.dirs, systemClaudes: rig.claudes })
    const fetch = (await plugin.auth.loader(async () => ({ type: "api", key: LOCAL_MARKER }))).fetch
    groupProbe.isPrivate = async (gid) => gid === (await lstat(rig.launcher)).gid
    expect((await fetch(URL_(), post(msg()))).status).toBe(200)
    groupProbe.isPrivate = async () => false
    expect(await text(await fetch(URL_(), post(msg())))).toContain("[opclaude:host_path_untrusted]")
    // 不注入：按这台机器的真实情况查。Linux 上测试用户的主组正好是同名私有组，查得到；macOS 的本地用户不在 /etc/group 里，当作共享组。
    groupProbe.isPrivate = null
    const body = await text(await fetch(URL_(), post(msg())))
    if (process.platform === "linux" && (await readFile("/etc/group", "utf8")).match(new RegExp(`^[^:]*:x:${(await lstat(rig.launcher)).gid}:$`, "m"))) expect(body).toContain('"content"')
    else expect(body).toContain("[opclaude:host_path_untrusted]")
  })
})

describe("8. 启动器或 config 是 FIFO：立刻给出固定错误码，不卡在打开上", () => {
  const within = async (ms, fn) => {
    let timer
    const guard = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), ms) })
    try { return await Promise.race([fn(), guard]) } finally { clearTimeout(timer) }
  }
  test("启动器是 FIFO：launcher_invalid", async () => {
    await rm(rig.launcher)
    execFileSync("mkfifo", ["-m", "600", rig.launcher])
    expect(await within(8000, () => codeOf(() => readVer({ launcher: rig.launcher, source: rig.env })))).toBe("launcher_invalid")
    expect(await within(8000, () => outcome())).toBe("[opclaude:launcher_invalid]")
  })
  test("config 是 FIFO：host_path_untrusted", async () => {
    await rm(rig.config)
    execFileSync("mkfifo", ["-m", "600", rig.config])
    expect(await within(8000, () => outcome())).toBe("[opclaude:host_path_untrusted]")
  })
})
