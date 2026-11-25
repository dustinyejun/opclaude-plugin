// 第四轮及后续复审的关键语义离线回归：每一条都从复审描述的现场直接复现，并与等尺寸离线启动器夹具的实际结果对照。
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { discoverHost, groupProbe, readHostVersion, trustedPath } from "../lib/host.mjs"
import { runLaunch } from "../lib/launch.mjs"
import { LOCAL_MARKER, createPlugin } from "../lib/plugin.mjs"
import { PLACEHOLDER_BASE } from "../lib/transport.mjs"
import { OPCLOUDED_VERSION, makeRig, sharedTmp } from "./rig.mjs"

// 自有等尺寸（157426 字节）离线夹具：复现官方启动器在 version 分支之前及之内的两阶段 PATH、工具调用、
// 候选顺序、CONFIG 读取与输出格式，不含第三方脚本全文。
function buildOfflineLauncherTemplate(targetBytes = 157426) {
  const head = `#!/bin/sh
set -eu
case "$(printf '%s' "\${1:-}" | LC_ALL=C tr '[:upper:]' '[:lower:]')" in
  version)
    _oc_word="$(printf '%s' "$1" | LC_ALL=C tr '[:upper:]' '[:lower:]')"
    shift
    set -- "$_oc_word" "$@"
    unset _oc_word
    ;;
esac
OPUS_DIR="\${OPUSCLAUDE_HOME:-$HOME/.opusclaude}"
CONFIG="$OPUS_DIR/config"
OPCLAUDED_BIN="__OPUSCLAUDE_PROXY_BIN__"
OPCLAUDED_SHA256="__OPUSCLAUDE_PROXY_SHA__"
CLAUDE_ENV_DIR="$OPUS_DIR/claude-env"
mkdir -p "$CLAUDE_ENV_DIR" 2>/dev/null || true
export PATH="$HOME/.local/bin:\${PATH:-}"
CLAUDE_PIN="__OPUSCLAUDE_CLAUDE_PIN__"
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
  _v_pkg=$(sed -n "s/^CLI_PKG_VERSION='\\([0-9.]*\\)'\\$/\\1/p" "$CONFIG" 2>/dev/null | head -1 || true)
  _v_cc=$(claude_version "$(resolve_claude_bin || true)")
  printf 'OpusClaude 接入包：%s\\n' "\${_v_pkg:-未知}"
  printf 'Claude Code：%s（推荐 %s）\\n' "\${_v_cc:-未找到}" "$CLAUDE_PIN"
  if [ -n "$OPCLAUDED_BIN" ]; then
    printf '本地代理：opclauded %s\\n' "$(basename "$(dirname "$OPCLAUDED_BIN")")"
  else
    printf '本地代理：未启用（直连）\\n'
  fi
  exit 0
fi
exit 1
`
  const baseBytes = Buffer.byteLength(head, "utf8")
  const need = Math.max(0, targetBytes - baseBytes)
  const line = "# " + "0123456789abcdef".repeat(6) + "\n"
  const pad = line.repeat(Math.ceil(need / line.length)).slice(0, need)
  const out = head + (pad.endsWith("\n") ? pad : pad.slice(0, -1) + "\n")
  if (Buffer.byteLength(out, "utf8") !== targetBytes) throw new Error(`unexpected fixture size ${Buffer.byteLength(out, "utf8")}`)
  return out
}

const INBOUND = { "user-agent": "claude-cli/2.1.100 (external, cli)", "x-app": "cli", "anthropic-version": "2023-06-01", "content-type": "application/json" }
const post = (body) => ({ method: "POST", headers: INBOUND, body: JSON.stringify(body) })
const msg = () => ({ model: "claude-fable-5-2", max_tokens: 64, stream: false, messages: [{ role: "user", content: "hi" }] })
const exists = (file) => Bun.file(file).exists()
const codeOf = (fn) => fn().then(() => "", (e) => e.code)
const sha256 = async (file) => new Bun.CryptoHasher("sha256").update(new Uint8Array(await Bun.file(file).arrayBuffer())).digest("hex")
const put = async (file, text, mode = 0o755) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); await chmod(file, mode); return file }
const claudeAt = (file, version) => put(file, `#!/bin/sh
case "$*" in --version) printf '%s (Claude Code)\\n' '${version}' ; exit 0 ;; esac
printf ran > '${file}.ran'
exit 1
`)
const SYSTEM = "/usr/bin:/bin"
// macOS 与 Debian 上这几个工具所在的系统目录不完全相同（cat 在 /bin）。
const systemTool = async (name) => (await exists("/usr/bin/" + name) ? "/usr/bin/" : "/bin/") + name
// 官方启动器到 version 分支为止的输出里取 Claude Code 的版本；官方没找到时是“未找到”。
const officialVersion = (script, source) => {
  const r = Bun.spawnSync(["/bin/sh", script, "version"], { env: source, cwd: "/" })
  return { code: r.exitCode, version: (/^Claude Code：([^（]*)/m.exec(r.stdout.toString()) ?? [])[1]?.trim(), stderr: r.stderr.toString().slice(0, 200) }
}

let rig, realHome, template
beforeAll(async () => {
  realHome = process.env.HOME
  rig = await makeRig()
  process.env.HOME = rig.dir
  template = buildOfflineLauncherTemplate()
})
afterAll(async () => { process.env.HOME = realHome; await rig.close() })
beforeEach(async () => {
  Object.assign(rig.st, { mode: "proxy", ccVersion: "2.1.284", status: 200 })
  await rig.sync()
  for (const name of await readdir(rig.dir)) {
    if (![".local", ".opusclaude", "state"].includes(name)) await rm(path.join(rig.dir, name), { recursive: true, force: true })
  }
  await rm(path.join(rig.dir, ".local", "share"), { recursive: true, force: true })
  await rig.restore()
  // restore 会把假的 claude 装回 ~/.local/bin：这里的用例自己决定 claude 放在哪。
  await rm(path.join(rig.dir, ".local", "bin", "claude"), { force: true })
})

// 把官方模板按安装器的规则填好，装成当前的启动器。
const installOfficial = async () => {
  const script = Buffer.from(
    template
      .replaceAll("__OPUSCLAUDE_PROXY_BIN__", rig.bin)
      .replaceAll("__OPUSCLAUDE_PROXY_SHA__", await sha256(rig.bin))
      .replaceAll("__OPUSCLAUDE_CLAUDE_PIN__", "2.1.284")
      .replaceAll("__OPUSCLAUDE_SYS_CLAUDE_1__", rig.claudes[0])
      .replaceAll("__OPUSCLAUDE_SYS_CLAUDE_2__", rig.claudes[1])
  )
  await Bun.write(rig.launcher, script)
  await chmod(rig.launcher, 0o755)
  await rig.writeConfig(await sha256(rig.launcher))
  return script
}
// 宿主 PATH 上的一组工具：tr、mkdir 记下调用后转给系统的那一份；其余工具链到系统的。
const serviceTools = async (trace) => {
  const dir = path.join(rig.dir, "service-bin")
  for (const name of ["tr", "mkdir"]) await put(path.join(dir, name), `#!/bin/sh\nprintf 'service-${name}\\n' >> '${trace}'\nexec /usr/bin/${name} "$@"\n`)
  // 其余工具链到系统的：启动器用到的，加上测试台的假 opclauded 自己用到的几个。
  for (const name of ["sed", "head", "grep", "basename", "dirname", "cat", "cut", "sort", "env", "rm"]) await symlink(await systemTool(name), path.join(dir, name))
  return dir
}
const fetchOf = async (env) => (await createPlugin({}, { env, launcherDirs: rig.dirs, systemClaudes: rig.claudes }).auth.loader(async () => ({ type: "api", key: LOCAL_MARKER }))).fetch
const readVer = (opts = {}) => readHostVersion({ systemClaudes: rig.claudes, ...opts })
const viaPlugin = async (env) => {
  const res = await (await fetchOf(env))(PLACEHOLDER_BASE + "/messages", post(msg()))
  return res.status === 200 ? "ok" : (await res.text()).match(/\[opclaude:[a-z_]+\]/)?.[0]
}

describe("1. 选哪一份 Claude：与官方启动器实际选出的那一份相同", () => {
  const cases = [
    ["PATH 上的 claude（宿主 PATH 里没有系统目录）", "2.1.300", async (tools) => { await claudeAt(path.join(tools, "claude"), "2.1.300") }],
    ["钉死的版本文件 versions/<CLAUDE_PIN>", "2.1.284", async () => { await claudeAt(path.join(rig.dir, ".local", "share", "claude", "versions", "2.1.284"), "2.1.284") }],
    ["npm 所在目录的 claude", "2.1.310", async (tools) => { await put(path.join(tools, "npm"), "#!/bin/sh\nexit 0\n"); await claudeAt(path.join(tools, "claude"), "2.1.310") }],
    ["两份受信任的 CLI 并存：~/.local/bin 的 2.1.100 排在 PATH 上的 2.1.300 前面", "2.1.100", async (tools) => { await claudeAt(path.join(tools, "claude"), "2.1.300"); await claudeAt(path.join(rig.dir, ".local", "bin", "claude"), "2.1.100") }],
  ]
  for (const [label, want, arrange] of cases) {
    test(`完整官方启动器（157 KB）：${label} —— 官方与插件结果一致`, async () => {
      const script = await installOfficial()
      expect(script.length).toBeGreaterThan(131072)
      const trace = path.join(rig.dir, "trace")
      const tools = await serviceTools(trace)
      await arrange(tools)
      const source = { HOME: rig.dir, PATH: tools, LANG: "C" }
      // 官方：直接用 sh 运行同一份启动器
      await put(path.join(rig.dir, "copy-of-launcher"), script)
      const direct = officialVersion(path.join(rig.dir, "copy-of-launcher"), { ...source, PATH: tools })
      expect(direct.code).toBe(0)
      expect(direct.version, direct.stderr).toBe(want)
      await writeFile(trace, "")
      // 插件：同一份启动器、同一个安装、同一个宿主 PATH
      expect(await readVer({ script, source })).toBe(direct.version)
      // 工具调用与官方逐个相同：前置 ~/.local/bin 之前的 tr、mkdir 用的都是宿主 PATH 上的那两份
      expect((await readFile(trace, "utf8")).trim().split("\n").filter(Boolean)).toEqual(["service-tr", "service-tr", "service-mkdir"])
      expect(await viaPlugin({ ...source, OPUSCLAUDE_HOME: rig.opusHome })).toBe("ok")
    })
  }
  test("预检看的是官方实际会执行的那一份工具：~/.local/bin 里的 mkdir 不参与，宿主 PATH 上的 mkdir 才要核对", async () => {
    const script = await installOfficial()
    const trace = path.join(rig.dir, "trace")
    const tools = await serviceTools(trace)
    await claudeAt(path.join(tools, "claude"), "2.1.300")
    // 前置之前调用的是宿主 PATH 的 mkdir；~/.local/bin 里那份所有人可写，但官方根本不会运行它。
    await put(path.join(rig.dir, ".local", "bin", "mkdir"), "#!/bin/sh\nexit 0\n", 0o777)
    const source = { HOME: rig.dir, PATH: tools, LANG: "C" }
    expect(await readVer({ script, source })).toBe("2.1.300")
    expect((await readFile(trace, "utf8")).trim().split("\n").filter(Boolean)).toEqual(["service-tr", "service-tr", "service-mkdir"])
    // 前置之后的 sed：~/.local/bin 里有一份所有人可写的，官方会用它，所以拒绝。
    await put(path.join(rig.dir, ".local", "bin", "sed"), `#!/bin/sh\nexec ${await systemTool("sed")} "$@"\n`, 0o777)
    expect(await codeOf(() => readVer({ script, source }))).toBe("host_path_untrusted")
    await rm(path.join(rig.dir, ".local", "bin", "sed"))
    // 前置之前的 tr、mkdir 来自宿主 PATH：那里的一份能被别人改动就拒绝，启动器不运行。
    for (const name of ["tr", "mkdir"]) {
      await writeFile(trace, "")
      await chmod(path.join(tools, name), 0o777)
      expect(await codeOf(() => readVer({ script, source })), name).toBe("host_path_untrusted")
      expect(await exists(trace) ? (await readFile(trace, "utf8")).trim() : "").toBe("")
      await chmod(path.join(tools, name), 0o755)
    }
  })
  test("宿主 PATH 只有系统目录：/usr/bin:/bin:/usr/sbin:/sbin 照常可用", async () => {
    await claudeAt(path.join(rig.dir, ".local", "bin", "claude"), "2.1.284")
    for (const p of [SYSTEM, "/usr/bin:/bin:/usr/sbin:/sbin", process.env.PATH]) {
      expect(await readVer({ launcher: rig.launcher, source: { ...rig.env, PATH: p } }), p).toBe("2.1.284")
    }
  })
})

describe("4. 路径解析：逐个分量消费，与系统 realpath 一致", () => {
  test("符号链接之后再跟 ..：解析到链接目标里那一级的上级", async () => {
    const temp = await mkdtemp(path.join(await sharedTmp(), "opclaude-walk-"))
    try {
      await chmod(temp, 0o755)
      await mkdir(path.join(temp, "one", "data"), { recursive: true })
      await mkdir(path.join(temp, "two", "data"), { recursive: true })
      await mkdir(path.join(temp, "two", "nested"))
      await symlink(path.join(temp, "one"), path.join(temp, "link"))
      await symlink(path.join(temp, "two", "nested"), path.join(temp, "one", "nested"))
      // 不能用 path.join：它会先把 ".." 折叠掉
      const input = temp + "/link/nested/../data"
      expect((await trustedPath(input)).real).toBe(await realpath(input))
      expect((await trustedPath(input)).real).toBe(await realpath(path.join(temp, "two", "data")))
      // 归属检查用的就是解析后的位置：这一项下面的文件按 two/data 里那一份核对，不是 one/data 里同名的那个。
      const file = input + "/opclauded"
      await copyFile(rig.bin, file)
      expect((await trustedPath(file)).real).toBe(await realpath(file))
      expect((await trustedPath(file)).real.startsWith(path.join(temp, "one", "data") + path.sep)).toBe(false)
    } finally { await rm(temp, { recursive: true, force: true }) }
  })
  test("末尾斜杠：OPUSCLAUDE_HOME 与 PATH 目录带了斜杠，结果不变", async () => {
    const bin = path.join(rig.dir, "trusted-bin")
    await rename(path.join(rig.dir, ".local", "bin", "claude"), path.join(bin, "claude")).catch(() => {})
    if (!(await exists(path.join(bin, "claude")))) await claudeAt(path.join(bin, "claude"), "2.1.284")
    for (const suffix of ["", "/"]) {
      const env = { ...rig.env, PATH: bin + suffix + ":" + SYSTEM, OPUSCLAUDE_HOME: rig.opusHome + suffix }
      expect(await readVer({ launcher: rig.launcher, source: env }).catch((e) => e.code), suffix).toBe("2.1.284")
      const found = await discoverHost(env, { dirs: rig.dirs })
      expect(found.opusHome, suffix).toBe(rig.realOpusHome)
      await found.executable.close()
      expect(await viaPlugin(env), suffix).toBe("ok")
    }
    // 以斜杠结尾的普通文件不是目录；以 ".." 结尾的路径是目录本身
    const file = await trustedPath(rig.launcher + "/")
    expect(file.ok).toBe(false)
    expect((await trustedPath(rig.dir + "/.local/bin/..")).real).toBe(await realpath(path.join(rig.dir, ".local")))
    expect((await trustedPath(rig.dir + "/.local/bin/../bin/./")).real).toBe(await realpath(path.join(rig.dir, ".local", "bin")))
  })
})

describe("5. 私有目录的保护不跨符号链接", () => {
  test("同一个共享组可写的 0775 目录：直接访问与经 0700 目录里的链接访问结论相同", async () => {
    // 说的是“共享组”：Linux 上测试用户的私有组不算，统一按共享组判断。
    groupProbe.isPrivate = async () => false
    const temp = await mkdtemp(path.join(await sharedTmp(), "opclaude-prot-"))
    try {
      await chmod(temp, 0o755)
      const own = path.join(temp, "private")
      const shared = path.join(temp, "shared")
      await mkdir(own, { mode: 0o700 })
      await mkdir(shared)
      await chmod(shared, 0o775)
      await symlink(shared, path.join(own, "alias"))
      expect(await realpath(path.join(own, "alias"))).toBe(await realpath(shared))
      expect((await trustedPath(shared)).ok).toBe(false)
      expect((await trustedPath(path.join(own, "alias"))).ok).toBe(false)
      expect((await trustedPath(path.join(own, "alias", "x", ".."))).ok).toBe(false)
      // 真正在私有目录之下的目录：组可写可以接受
      const under = path.join(own, "under")
      await mkdir(under)
      await chmod(under, 0o775)
      expect((await trustedPath(under)).ok).toBe(true)
      await chmod(shared, 0o755)
      expect((await trustedPath(path.join(own, "alias"))).ok).toBe(true)
    } finally { groupProbe.isPrivate = null; await rm(temp, { recursive: true, force: true }) }
  })
})

describe("2. opclauded：执行的是核对过内容的绑定副本", () => {
  const settings = () => ({ opclauded: rig.bin, opusHome: rig.opusHome })
  const evil = async (marker) => `#!/bin/sh\nprintf ran > '${marker}'\nexit 0\n`
  test("定位之后安装里的文件被换成别的程序：运行的仍是核对过的那份内容，换上的程序没有启动", async () => {
    const found = await discoverHost(rig.env, { dirs: rig.dirs })
    const again = await discoverHost(rig.env, { dirs: rig.dirs })
    const marker = path.join(rig.state, "replaced-ran")
    await rename(await put(path.join(path.dirname(rig.bin), "opclauded.new"), await evil(marker)), rig.bin)
    try {
      const state = await runLaunch(settings(), { source: rig.env, executable: found.executable })
      expect(state.baseUrl).toBe(`http://127.0.0.1:${rig.port}`)
      expect(state.credential).toBe("ticket-A-fake")
      expect(await exists(marker)).toBe(false)
      const launched = (await readFile(path.join(rig.state, "launched-bin"), "utf8")).trim()
      expect(launched.endsWith(`/opclauded/${OPCLOUDED_VERSION}/opclauded`)).toBe(true)
      expect(await sha256(launched)).toBe(found.sha256)
      expect(launched).not.toBe(await realpath(rig.bin))
      // 自定位：--home 照常交给程序；从自己的位置往上两级的层次与安装里相同，那一级以内容摘要命名，路径稳定可复用
      expect(await readFile(path.join(rig.state, "last-args"), "utf8")).toBe(`--home|${rig.opusHome}|--min-protocol|1\n`)
      expect((await readFile(path.join(rig.state, "launched-layout"), "utf8")).trim()).toBe(found.sha256)
      expect((await runLaunch({ opclauded: again.bin, opusHome: again.opusHome }, { source: rig.env, executable: again.executable })).baseUrl).toBe(state.baseUrl)
      expect((await readFile(path.join(rig.state, "launched-bin"), "utf8")).trim()).toBe(launched)
    } finally { await found.executable.close(); await again.executable.close() }
  })
  test("启动前检查已过的窗口：副本就绪之后、spawn 之前安装文件再被替换，未核对的程序同样没有启动", async () => {
    const found = await discoverHost(rig.env, { dirs: rig.dirs })
    const marker = path.join(rig.state, "window-ran")
    const materialize = found.executable.materialize
    found.executable.materialize = async () => {
      const copy = await materialize()
      // 副本已经就绪（“启动前检查”到此已完成），此刻安装器把文件换掉
      await rename(await put(path.join(path.dirname(rig.bin), "opclauded.new"), await evil(marker)), rig.bin)
      return copy
    }
    try {
      expect((await runLaunch(settings(), { source: rig.env, executable: found.executable })).mode).toBe("proxy")
      expect(await exists(marker)).toBe(false)
    } finally { await found.executable.close() }
  })
  test("就地改写安装文件（inode 不变）：同样只运行核对过的字节", async () => {
    const found = await discoverHost(rig.env, { dirs: rig.dirs })
    const marker = path.join(rig.state, "rewritten-ran")
    const before = await stat(rig.bin)
    await writeFile(rig.bin, await evil(marker))
    await chmod(rig.bin, 0o755)
    expect((await stat(rig.bin)).ino).toBe(before.ino)
    try {
      expect((await runLaunch(settings(), { source: rig.env, executable: found.executable })).mode).toBe("proxy")
      expect(await exists(marker)).toBe(false)
    } finally { await found.executable.close() }
  })
  test("已有的副本被改动：重新从核对过的描述符复制，改动过的那份不运行；目录名被别人占了就换私有目录", async () => {
    const isolated = await makeRig()
    const isoTmp = await mkdtemp(path.join(await sharedTmp(), "opclaude-iso-tmp-"))
    const isoEnv = { ...isolated.env, TMPDIR: isoTmp }
    try {
      const isoSettings = { opclauded: isolated.bin, opusHome: isolated.opusHome }
      const first = await discoverHost(isoEnv, { dirs: isolated.dirs })
      const copy = await first.executable.materialize()
      await first.executable.close()
      const marker = path.join(isolated.state, "tampered-ran")
      await writeFile(copy, await evil(marker))
      await chmod(copy, 0o755)
      const found = await discoverHost(isoEnv, { dirs: isolated.dirs })
      try {
        expect((await runLaunch(isoSettings, { source: isoEnv, executable: found.executable })).mode).toBe("proxy")
        expect(await exists(marker)).toBe(false)
        expect(await sha256(copy)).toBe(found.sha256)
        await found.executable.close()
        // 主缓存根不再只有本用户能进（仅改动这个独立夹具自己的私有根）：不往里放，改用另一个可信私有目录
        const store = path.dirname(path.dirname(path.dirname(path.dirname(copy))))
        await chmod(store, 0o777)
        try {
          const other = await discoverHost(isoEnv, { dirs: isolated.dirs })
          const file = await other.executable.materialize()
          await other.executable.close()
          expect(file.startsWith(store + path.sep)).toBe(false)
          expect(await sha256(file)).toBe(found.sha256)
        } finally { await chmod(store, 0o700) }
      } finally { await found.executable.close() }
    } finally {
      await rm(isoTmp, { recursive: true, force: true })
      await isolated.close()
    }
  })
  test("旧的显式路径：语义不变，仍然是用户给出的那个路径，按指纹核对后运行", async () => {
    expect(await runLaunch({ opclauded: rig.realBin, opusHome: rig.opusHome }, { source: rig.env })).toMatchObject({ mode: "proxy" })
    expect((await readFile(path.join(rig.state, "launched-bin"), "utf8")).trim()).toBe(rig.realBin)
    expect(await codeOf(() => runLaunch({ opclauded: rig.bin, opusHome: rig.opusHome, opclaudedSha256: "0".repeat(64) }, { source: rig.env }))).toBe("sha256_mismatch")
  })
})
