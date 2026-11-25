// 第五轮/追加复审及第七轮回归测试：
//   1. TMPDIR 不可写/只读（0555）或 noexec 时，版本探测经 /bin/sh -s -- version（stdin）无临时文件依赖正常登录与请求，处理提前退出 EPIPE
//   2. 宿主未设 PATH 与显式设 PATH="" 的区分
//   3. 相对符号链接与 .. 逐分量解析，以及确认物理目录读取 config、定位工具并传给子进程
//   4. prot 随物理目录层级入栈、出栈，退出私有目录后不保留特权
//   5. 固定临时缓存名被占用且安装目录/用户目录不可写时，多路并发（同进程与跨进程）冷启动收敛到同一可信回退根并只保留一份副本
//   6. 并发冷启动原子无覆盖发布（link），不覆盖已在运行的正确副本
//   7. 固定系统 Claude 候选控制：区分固定候选优先与 PATH 回退，覆盖存在与缺失两种情况
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { chmod, copyFile, mkdir, mkdtemp, open, readdir, readFile, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { SYSTEM_CLAUDES, discoverHost, groupProbe, readHostVersion, trustedPath } from "../lib/host.mjs"
import { runLaunch } from "../lib/launch.mjs"
import { LOCAL_MARKER, createPlugin } from "../lib/plugin.mjs"
import { PLACEHOLDER_BASE } from "../lib/transport.mjs"
import { makeRig, sharedTmp } from "./rig.mjs"

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const INBOUND = { "user-agent": "claude-cli/2.1.100 (external, cli)", "x-app": "cli", "anthropic-version": "2023-06-01", "content-type": "application/json" }
const post = (body) => ({ method: "POST", headers: INBOUND, body: JSON.stringify(body) })
const msg = () => ({ model: "claude-fable-5-2", max_tokens: 64, stream: false, messages: [{ role: "user", content: "hi" }] })
const codeOf = (fn) => fn().then(() => "", (e) => e.code)
const exists = (file) => Bun.file(file).exists()
const put = async (file, text, mode = 0o755) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); await chmod(file, mode); return file }
const claudeAt = (file, version) => put(file, `#!/bin/sh
case "$*" in --version) printf '%s (Claude Code)\\n' '${version}' ; exit 0 ;; esac
printf ran > '${file}.ran'
exit 1
`)

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
  for (const name of await readdir(rig.dir)) {
    if (![".local", ".opusclaude", "state"].includes(name)) await rm(path.join(rig.dir, name), { recursive: true, force: true })
  }
  await rig.restore()
  groupProbe.isPrivate = null
})

const readVer = (opts = {}) => readHostVersion({ systemClaudes: rig.claudes, ...opts })
const viaPlugin = async (env, dirs = rig.dirs, claudes = rig.claudes) => {
  const fetch = (await createPlugin({}, { env, launcherDirs: dirs, systemClaudes: claudes }).auth.loader(async () => ({ type: "api", key: LOCAL_MARKER }))).fetch
  const res = await fetch(PLACEHOLDER_BASE + "/messages", post(msg()))
  return res.status === 200 ? "ok" : (await res.text()).match(/\[opclaude:[a-z_]+\]/)?.[0]
}

describe("1. 临时目录只读/不可用/noexec 时经 stdin 正常探测与登录，绝不以未核对路径兜底", () => {
  test("TMPDIR 权限为 0555 只读时，零配置登录与请求照常成功（不再在 TMPDIR 建临时文件）", async () => {
    const roTmp = await mkdtemp(path.join(await sharedTmp(), "opclaude-rotmp-"))
    await chmod(roTmp, 0o555)
    try {
      const env = { ...rig.env, TMPDIR: roTmp }
      expect(await readVer({ launcher: rig.launcher, source: env })).toBe("2.1.284")
      const plugin = createPlugin({}, { env, launcherDirs: rig.dirs, systemClaudes: rig.claudes })
      const auth = await plugin.auth.methods[0].authorize({})
      expect(auth).toMatchObject({ type: "success", key: LOCAL_MARKER })
      expect(await viaPlugin(env)).toBe("ok")
    } finally { await chmod(roTmp, 0o755); await rm(roTmp, { recursive: true, force: true }) }
  })
  test("启动器在前端提前 exit 0 或非零退出导致超过管道缓冲区的剩余正文 EPIPE 时不抛出未处理异常", async () => {
    const pad = ("# " + "x".repeat(98) + "\n").repeat(1600) // ~160 KB > 64 KB pipe buffer
    const earlyOk = Buffer.from(`#!/bin/sh\nif [ "\${1:-}" = version ]; then\n  printf 'OpusClaude 接入包：20261120.1\\nClaude Code：2.1.284（推荐 2.1.284）\\n'\n  exit 0\nfi\n${pad}`)
    const earlyFail = Buffer.from(`#!/bin/sh\nif [ "\${1:-}" = version ]; then\n  exit 3\nfi\n${pad}`)
    expect(await readVer({ script: earlyOk, source: rig.env })).toBe("2.1.284")
    expect(await codeOf(() => readVer({ script: earlyFail, source: rig.env }))).toBe("version_failed")
  })
  test("TMPDIR 为不可写或不可信目录时，绑定副本放在已核对物理 opusHome 下正常启动", async () => {
    const badTmp = await mkdtemp(path.join(await sharedTmp(), "opclaude-badtmp-"))
    await chmod(badTmp, 0o777)
    try {
      const env = { ...rig.env, TMPDIR: badTmp }
      const found = await discoverHost(env, { dirs: rig.dirs })
      try {
        const copy = await found.executable.materialize()
        expect(copy.startsWith(rig.realOpusHome + path.sep)).toBe(true)
        expect(copy.startsWith(badTmp)).toBe(false)
        const state = await runLaunch({ opclauded: rig.bin, opusHome: rig.opusHome }, { source: env, executable: found.executable })
        expect(state.mode).toBe("proxy")
      } finally { await found.executable.close() }
      expect(await viaPlugin(env)).toBe("ok")
      expect(await readdir(badTmp)).toEqual([])
    } finally { await rm(badTmp, { recursive: true, force: true }) }
  })
  test("所有候选缓存位置都不可信或不可写入时拒绝，绝不退回直接运行原安装路径", async () => {
    const iso = await makeRig()
    const badTmp = await mkdtemp(path.join(await sharedTmp(), "opclaude-untrusted-tmp-"))
    await chmod(badTmp, 0o777)
    const saved = process.env.TMPDIR
    process.env.TMPDIR = badTmp
    try {
      const first = await discoverHost({ ...iso.env, TMPDIR: badTmp }, { dirs: iso.dirs })
      const copy = await first.executable.materialize()
      await first.executable.close()
      const store = path.dirname(path.dirname(path.dirname(path.dirname(copy))))
      // 破坏主缓存根、阻断 userHome/.cache、并把 TMPDIR 设为非 sticky 的 0777 目录
      await chmod(store, 0o777)
      await writeFile(path.join(iso.dir, ".cache"), "block")
      const marker = path.join(iso.state, "direct-ran")
      const found = await discoverHost({ ...iso.env, TMPDIR: badTmp }, { dirs: iso.dirs })
      // 若曾退回直接执行 rig.bin，就会写出标记；实际应当拒绝
      await writeFile(iso.bin, `#!/bin/sh\nprintf ran > '${marker}'\nexit 0\n`)
      await chmod(iso.bin, 0o755)
      try {
        expect(await codeOf(() => runLaunch({ opclauded: iso.bin, opusHome: iso.opusHome }, { source: { ...iso.env, TMPDIR: badTmp }, executable: found.executable }))).toBe("binary_unreadable")
        expect(await exists(marker)).toBe(false)
      } finally {
        await found.executable.close()
        await chmod(store, 0o700)
      }
    } finally {
      if (saved === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = saved
      await rm(badTmp, { recursive: true, force: true })
      await iso.close()
    }
  })
})

describe("2. 宿主 PATH 缺省与显式为空的区分", () => {
  test("PATH 缺省时按 /bin/sh 默认搜索路径信任检查，显式 PATH='' 返回 version_unknown，显式非空保留顺序", async () => {
    const unsetEnv = { HOME: rig.dir, LANG: "C" }
    const emptyEnv = { HOME: rig.dir, LANG: "C", PATH: "" }
    const sysEnv = { HOME: rig.dir, LANG: "C", PATH: "/usr/bin:/bin" }

    // 分别与直接跑 /bin/sh 得到的官方口径对比
    const directUnset = Bun.spawnSync(["/bin/sh", rig.launcher, "version"], { env: unsetEnv, cwd: "/" })
    const directEmpty = Bun.spawnSync(["/bin/sh", rig.launcher, "version"], { env: emptyEnv, cwd: "/" })
    expect(directUnset.exitCode).toBe(0)
    expect(directUnset.stdout.toString()).toContain("Claude Code：2.1.284（推荐")
    expect(directEmpty.exitCode).toBe(0)
    expect(directEmpty.stdout.toString()).toContain("Claude Code：未找到（推荐")

    expect(await readVer({ launcher: rig.launcher, source: unsetEnv })).toBe("2.1.284")
    expect(await viaPlugin(unsetEnv)).toBe("ok")

    expect(await codeOf(() => readVer({ launcher: rig.launcher, source: emptyEnv }))).toBe("version_unknown")
    expect(await viaPlugin(emptyEnv)).toBe("[opclaude:version_unknown]")

    expect(await readVer({ launcher: rig.launcher, source: sysEnv })).toBe("2.1.284")
    expect(await viaPlugin(sysEnv)).toBe("ok")
  })
})

describe("3. 相对符号链接逐分量解析与确认物理目录", () => {
  test("相对 symlink 含 .. 时不提前 path.join 折叠，与系统 realpath 一致", async () => {
    const d = await mkdtemp(path.join(await sharedTmp(), "opclaude-relsym-"))
    try {
      await chmod(d, 0o755)
      await mkdir(path.join(d, "one", "data"), { recursive: true })
      await mkdir(path.join(d, "two", "data"), { recursive: true })
      await mkdir(path.join(d, "two", "child"))
      await symlink("../two/child", path.join(d, "one", "inner"))
      await symlink("inner/../data", path.join(d, "one", "alias"))
      const input = d + "/one/alias"
      const w = await trustedPath(input)
      expect(w.ok).toBe(true)
      expect(w.real).toBe(await realpath(input))
      expect(w.real).toBe(await realpath(path.join(d, "two", "data")))
      expect(w.real.endsWith("/two/data")).toBe(true)
    } finally { await rm(d, { recursive: true, force: true }) }
  })
  test("OPUSCLAUDE_HOME 含符号链接与 .. 时，从确认物理目录读 config、核对归属并传给子进程", async () => {
    const nested = path.join(rig.opusHome, "nested")
    await mkdir(nested, { recursive: true })
    await symlink(nested, path.join(rig.dir, "custom"))
    const symHome = rig.dir + "/custom/.."
    const env = { ...rig.env, OPUSCLAUDE_HOME: symHome }
    const found = await discoverHost(env, { dirs: rig.dirs })
    try {
      expect(found.opusHome).toBe(rig.realOpusHome)
    } finally { await found.executable.close() }
    expect(await viaPlugin(env)).toBe("ok")
    expect((await readFile(path.join(rig.state, "launch-home"), "utf8")).trim()).toBe(`--home ${rig.realOpusHome}`)
    expect((await readFile(path.join(rig.opusHome, "launcher-home"), "utf8")).trim()).toBe(rig.realOpusHome)
  })
  test("HOME 与 PATH 目录含相对符号链接 + .. 时，与系统解析到同一物理工具与安装", async () => {
    const d = await mkdtemp(path.join(await sharedTmp(), "opclaude-pathsym-"))
    try {
      await chmod(d, 0o755)
      await mkdir(path.join(d, "one"), { recursive: true })
      await mkdir(path.join(d, "two", "bin"), { recursive: true })
      await mkdir(path.join(d, "two", "child"))
      await symlink("../two/child", path.join(d, "one", "inner"))
      await symlink("inner/../bin", path.join(d, "one", "binlink"))
      // 只在 two/bin 放可信 claude（与 one/bin 不同）；且若放不可信 claude 在 two/bin 则必须被拒绝
      await claudeAt(path.join(d, "two", "bin", "claude"), "2.1.321")
      await rm(path.join(rig.dir, ".local", "bin", "claude"), { force: true })
      const pathWithLink = d + "/one/inner/../bin"
      const env = { ...rig.env, PATH: `${pathWithLink}:/usr/bin:/bin` }
      expect(await readVer({ launcher: rig.launcher, source: env })).toBe("2.1.321")
      // 如果 two/bin/claude 变成所有人可写，必须拒绝（不会错误看成 one/bin）
      await chmod(path.join(d, "two", "bin", "claude"), 0o777)
      expect(await codeOf(() => readVer({ launcher: rig.launcher, source: env }))).toBe("host_path_untrusted")
    } finally { await rm(d, { recursive: true, force: true }) }
  })
})

describe("4. prot 随物理目录层级入栈、出栈", () => {
  test("先进入 0700 私有目录再通过 .. 或相对符号链接退出后，对同一共享组可写目录得到与直接访问相同的拒绝结论", async () => {
    groupProbe.isPrivate = async () => false
    const temp = await mkdtemp(path.join(await sharedTmp(), "opclaude-stack-"))
    try {
      await chmod(temp, 0o755)
      const priv1 = path.join(temp, "priv1")
      const priv2 = path.join(priv1, "priv2")
      const inside = path.join(priv1, "inside-0775")
      const shared = path.join(temp, "shared-0775")
      await mkdir(priv2, { recursive: true })
      await mkdir(inside)
      await mkdir(shared)
      await chmod(priv1, 0o700)
      await chmod(priv2, 0o700)
      await chmod(inside, 0o775)
      await chmod(shared, 0o775)
      await symlink("../shared-0775", path.join(priv1, "rel-out"))
      await symlink("inside-0775", path.join(priv1, "rel-in"))

      // 直接访问 shared-0775 应被拒绝
      expect((await trustedPath(shared)).ok).toBe(false)
      // 进入 priv1 再通过 .. 退出：prot 必须出栈，同样拒绝
      expect((await trustedPath(priv1 + "/../shared-0775")).ok).toBe(false)
      // 经过两层私有目录再退出到共享目录：同样拒绝
      expect((await trustedPath(priv2 + "/../../shared-0775")).ok).toBe(false)
      // 从 priv1 里的相对符号链接 ../shared-0775 退出：同样拒绝
      expect((await trustedPath(path.join(priv1, "rel-out"))).ok).toBe(false)
      // 只退出一层（仍在 priv1 私有目录保护之下）：允许
      expect((await trustedPath(priv2 + "/../inside-0775")).ok).toBe(true)
      expect((await trustedPath(path.join(priv1, "rel-in"))).ok).toBe(true)
    } finally { groupProbe.isPrivate = null; await rm(temp, { recursive: true, force: true }) }
  })
})

describe("5. 按系统用户选择稳定缓存根并验证物理祖先、中间目录与并发回退唯一收敛", () => {
  test("同一指纹连续发现六次只保留一份副本，不产生多余回退目录", async () => {
    const copies = []
    for (let i = 0; i < 6; i++) {
      const f = await discoverHost(rig.env, { dirs: rig.dirs })
      try { copies.push(await f.executable.materialize()) } finally { await f.executable.close() }
    }
    expect(new Set(copies).size).toBe(1)
    const parentEntries = await readdir(path.dirname(copies[0]))
    expect(parentEntries).toEqual(["opclauded"])
  })
  test("固定名被占用＋安装及用户缓存不可用＋同进程与跨进程六路并发冷启动：只创建一个可信回退根且所有路径一致", async () => {
    const iso = await makeRig()
    const isoTmp = await mkdtemp(path.join(await sharedTmp(), "opclaude-fb-"))
    const tag = process.getuid?.() ?? "user"
    const mine = `opclaude-plugin-bin-${tag}`
    const isoEnv = { ...iso.env, TMPDIR: isoTmp }
    try {
      await chmod(isoTmp, 0o700)
      await writeFile(path.join(isoTmp, mine), "occupied")
      await chmod(iso.opusHome, 0o555)
      await chmod(iso.dir, 0o555)
      // 1) 同进程 6 路并发冷启动
      const handles = await Promise.all(Array.from({ length: 6 }, () => discoverHost(isoEnv, { dirs: iso.dirs })))
      let paths
      try {
        paths = await Promise.all(handles.map((h) => h.executable.materialize()))
      } finally { await Promise.all(handles.map((h) => h.executable.close())) }
      expect(new Set(paths).size).toBe(1)
      expect(paths[0].startsWith(await realpath(isoTmp) + path.sep)).toBe(true)
      let fbDirs = (await readdir(isoTmp)).filter((n) => n.startsWith(`${mine}-`))
      expect(fbDirs).toHaveLength(1)

      // 2) 清掉首个回退目录，改用 6 个独立子进程并发冷启动（跨进程原子收敛）
      await rm(path.join(isoTmp, fbDirs[0]), { recursive: true, force: true })
      const script = `
        import { discoverHost } from ${JSON.stringify(path.join(ROOT_DIR, "lib/host.mjs"))};
        const h = await discoverHost(${JSON.stringify(isoEnv)}, { dirs: ${JSON.stringify(iso.dirs)} });
        try { console.log(await h.executable.materialize()); } finally { await h.executable.close(); }
      `
      const procs = Array.from({ length: 6 }, () => Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" }))
      const outputs = await Promise.all(procs.map(async (p) => {
        const code = await p.exited
        const out = await new Response(p.stdout).text()
        const err = await new Response(p.stderr).text()
        expect(code, err).toBe(0)
        return out.trim()
      }))
      expect(new Set(outputs).size).toBe(1)
      fbDirs = (await readdir(isoTmp)).filter((n) => n.startsWith(`${mine}-`))
      expect(fbDirs).toHaveLength(1)

      // 3) 再次发现复用同一路径，且中间目录被篡改后拒绝复用
      const f2 = await discoverHost(isoEnv, { dirs: iso.dirs })
      try { expect(await f2.executable.materialize()).toBe(outputs[0]) } finally { await f2.executable.close() }
      const shaDir = path.dirname(path.dirname(path.dirname(outputs[0])))
      await chmod(shaDir, 0o777)
      try {
        const f3 = await discoverHost(isoEnv, { dirs: iso.dirs })
        try {
          const c3 = await f3.executable.materialize()
          expect(c3).not.toBe(outputs[0])
        } finally { await f3.executable.close() }
      } finally { await chmod(shaDir, 0o700).catch(() => {}) }
    } finally {
      await chmod(iso.opusHome, 0o755).catch(() => {})
      await chmod(iso.dir, 0o755).catch(() => {})
      await rm(isoTmp, { recursive: true, force: true })
      await iso.close()
    }
  })
})

describe("6. 并发冷启动原子发布且不覆盖运行中文件", () => {
  test("六次并发冷启动只发布一份物理文件，不覆盖已打开/运行中的文件身份", async () => {
    const iso = await makeRig()
    try {
      const handles = await Promise.all(Array.from({ length: 6 }, () => discoverHost(iso.env, { dirs: iso.dirs })))
      let copies
      try {
        copies = await Promise.all(handles.map((h) => h.executable.materialize()))
      } finally { await Promise.all(handles.map((h) => h.executable.close())) }
      expect(new Set(copies).size).toBe(1)
      const file = copies[0]
      const st1 = await stat(file)
      const entries = await readdir(path.dirname(file))
      expect(entries).toEqual(["opclauded"])

      // 打开代表“运行中进程”的描述符；再次并发发布/运行后，文件 inode 保持不变
      const liveFh = await open(file, "r")
      try {
        const more = await Promise.all(Array.from({ length: 6 }, () => discoverHost(iso.env, { dirs: iso.dirs })))
        try {
          const moreCopies = await Promise.all(more.map((h) => h.executable.materialize()))
          expect(new Set(moreCopies).size).toBe(1)
          expect(moreCopies[0]).toBe(file)
        } finally { await Promise.all(more.map((h) => h.executable.close())) }
        const st2 = await stat(file)
        expect(st2.ino).toBe(st1.ino)
        expect((await liveFh.stat()).ino).toBe(st1.ino)
      } finally { await liveFh.close() }
    } finally { await iso.close() }
  })

  if (process.platform === "linux") {
    test("Linux 运行中 ELF 进程并发冷启动：/proc/<pid>/exe 保持真实路径，不带 (deleted)", async () => {
      const iso = await makeRig()
      try {
        // 复制系统 /bin/sleep 作为可控真实 ELF 夹具（不依赖外部二进制）
        await copyFile("/bin/sleep", iso.bin)
        await chmod(iso.bin, 0o755)
        await iso.install()
        const h0 = await discoverHost(iso.env, { dirs: iso.dirs })
        const binCopy = await h0.executable.materialize()
        await h0.executable.close()
        const child = spawn(binCopy, ["5"], { stdio: "ignore" })
        try {
          await Bun.sleep(100)
          const beforeExe = await readlink(`/proc/${child.pid}/exe`)
          expect(beforeExe).toBe(binCopy)
          expect(beforeExe.endsWith(" (deleted)")).toBe(false)
          const concurrent = await Promise.all(Array.from({ length: 6 }, () => discoverHost(iso.env, { dirs: iso.dirs })))
          try {
            const paths = await Promise.all(concurrent.map((h) => h.executable.materialize()))
            expect(new Set(paths).size).toBe(1)
            expect(paths[0]).toBe(binCopy)
          } finally { await Promise.all(concurrent.map((h) => h.executable.close())) }
          const afterExe = await readlink(`/proc/${child.pid}/exe`)
          expect(afterExe).toBe(binCopy)
          expect(afterExe.endsWith(" (deleted)")).toBe(false)
        } finally { child.kill("SIGKILL") }
      } finally { await iso.close() }
    })
  }
})

describe("7. 固定系统 Claude 候选受控回归：区分固定候选优先与 PATH 回退", () => {
  test("生产默认仍检查官方两处固定路径，测试通过沙箱夹具覆盖系统候选存在、缺失、优先级与权限校验", async () => {
    expect(SYSTEM_CLAUDES).toEqual(["/opt/homebrew/bin/claude", "/usr/local/bin/claude"])

    const onPath = path.join(rig.dir, "on-path", "bin")
    await claudeAt(path.join(onPath, "claude"), "2.1.300")
    await rm(path.join(rig.dir, ".local", "bin", "claude"), { force: true })
    const env = { ...rig.env, PATH: `${onPath}:/usr/bin:/bin` }

    // 1) 固定系统路径存在（2.1.100）时优先于 PATH（2.1.300）
    await claudeAt(rig.claudes[1], "2.1.100")
    expect(await readVer({ launcher: rig.launcher, source: env })).toBe("2.1.100")
    expect(await viaPlugin(env)).toBe("ok")
    expect(await exists(path.join(onPath, "claude.ran"))).toBe(false)

    // 2) ~/.claude/local/claude（候选 #2）或 ~/.local/bin/claude（候选 #1）存在时优先于固定系统路径（#3/#4）
    await claudeAt(path.join(rig.dir, ".claude", "local", "claude"), "2.1.290")
    expect(await readVer({ launcher: rig.launcher, source: env })).toBe("2.1.290")
    await claudeAt(path.join(rig.dir, ".local", "bin", "claude"), "2.1.284")
    expect(await readVer({ launcher: rig.launcher, source: env })).toBe("2.1.284")

    // 3) 去掉 #1/#2 后，若被选中的固定系统候选本身权限不安全（0o777），直接拒绝不回退 PATH
    await rm(path.join(rig.dir, ".local", "bin", "claude"), { force: true })
    await rm(path.join(rig.dir, ".claude", "local", "claude"), { force: true })
    await chmod(rig.claudes[1], 0o777)
    expect(await codeOf(() => readVer({ launcher: rig.launcher, source: env }))).toBe("host_path_untrusted")

    // 4) 固定系统候选缺失时，按顺序回退到 PATH 上的 2.1.300
    await rm(rig.claudes[1], { force: true })
    expect(await readVer({ launcher: rig.launcher, source: env })).toBe("2.1.300")
    expect(await viaPlugin(env)).toBe("ok")
  })
})
