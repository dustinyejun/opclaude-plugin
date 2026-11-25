#!/usr/bin/env bun
// 可复现的外部官方启动器模板对照（只使用临时文件与模拟安装，按 SHA-256 核验模板，不将第三方脚本文本存入仓库）。
// 运行方式见 README 的隔离容器命令。固定 Claude 候选只允许文档中的模拟文件。
import { createHash } from "node:crypto"
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { SYSTEM_CLAUDES, discoverHost, readHostVersion } from "../lib/host.mjs"
import { LOCAL_MARKER, createPlugin } from "../lib/plugin.mjs"
import { PLACEHOLDER_BASE } from "../lib/transport.mjs"
import { makeRig } from "../test/rig.mjs"

const EXPECTED_SHA256 = "4371431b202dd47cce643ecade756f3524af55e123e55262431edff3db642be7"
const args = process.argv.slice(2)
const argVal = (flag) => {
  const idx = args.indexOf(flag)
  return idx >= 0 ? args[idx + 1] : ""
}
const allowUpdated = args.includes("--allow-updated-sha")

function extractLauncherHeredoc(installSh) {
  const startMark = "cat > \"$TARGET\" <<'LAUNCHER'\n"
  const start = installSh.indexOf(startMark)
  if (start < 0) throw new Error("missing LAUNCHER heredoc start")
  const bodyStart = start + startMark.length
  const end = installSh.indexOf("\nLAUNCHER\n", bodyStart)
  if (end < 0) throw new Error("missing LAUNCHER heredoc end")
  return installSh.slice(bodyStart, end + 1)
}

let template = ""
const tplPath = argVal("--template") || process.env.OPCLAUDE_OFFICIAL_TEMPLATE || ""
const instPath = argVal("--install-sh") || process.env.OPCLAUDE_INSTALL_SH || ""
if (tplPath) {
  template = await readFile(tplPath, "utf8")
} else if (instPath) {
  template = extractLauncherHeredoc(await readFile(instPath, "utf8"))
} else if (args.includes("--fetch")) {
  const res = await fetch("https://claude.opusapi.xyz/install.sh")
  if (!res.ok) throw new Error(`fetch install.sh failed: ${res.status}`)
  template = extractLauncherHeredoc(await res.text())
} else {
  console.error("Usage: bun scripts/verify-official-template.mjs (--template <path> | --install-sh <path> | --fetch) [--allow-updated-sha]")
  process.exit(2)
}

const actualSha = createHash("sha256").update(template, "utf8").digest("hex")
console.log(`official template bytes=${Buffer.byteLength(template, "utf8")} sha256=${actualSha}`)
if (!allowUpdated && actualSha !== EXPECTED_SHA256) {
  throw new Error(`template sha256 mismatch: expected ${EXPECTED_SHA256}, got ${actualSha}`)
}

const withFixedClaude = process.env.OPCLAUDE_VERIFY_FIXED_CLAUDE === "1"
const fixedPath = "/usr/local/bin/claude"
const fixedFixture = '#!/usr/bin/env sh\n[ "$1" = "--version" ] && echo "2.1.100 (Claude Code)"\n'
for (const file of SYSTEM_CLAUDES) {
  const entry = await lstat(file).catch((err) => {
    if (err.code !== "ENOENT") throw err
    return null
  })
  if (withFixedClaude && file === fixedPath) {
    if (!entry?.isFile() || entry.size !== Buffer.byteLength(fixedFixture) || (entry.mode & 0o111) === 0 || (await readFile(file, "utf8")) !== fixedFixture) {
      throw new Error(`missing or unexpected fixed Claude fixture at ${file}; use the README container command`)
    }
  } else if (entry) {
    throw new Error(`unexpected system Claude at ${file}; use the README container command`)
  }
}

const shaFile = async (file) => createHash("sha256").update(new Uint8Array(await readFile(file))).digest("hex")
const put = async (file, text, mode = 0o755) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); await chmod(file, mode); return file }
const claudeAt = (file, ver) => put(file, `#!/bin/sh\ncase "$*" in --version) printf '%s (Claude Code)\\n' '${ver}'; exit 0 ;; esac\nexit 1\n`)
const systemTool = async (name) => (await Bun.file("/usr/bin/" + name).exists() ? "/usr/bin/" : "/bin/") + name
const officialVersion = (scriptPath, env) => {
  const r = Bun.spawnSync(["/bin/sh", scriptPath, "version"], { env, cwd: "/" })
  return { code: r.exitCode, ver: (/^Claude Code：([^（]*)/m.exec(r.stdout.toString()) ?? [])[1]?.trim() }
}
const assertEq = (label, got, want) => {
  if (got !== want) throw new Error(`${label}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`)
  console.log(`PASS ${label}: ${got}`)
}

const rig = await makeRig()
const tmpVerify = await mkdtemp(path.join(tmpdir(), "opclaude-official-verify-"))
try {
  const filled = Buffer.from(
    template
      .replaceAll("__OPUSCLAUDE_PROXY_BIN__", rig.bin)
      .replaceAll("__OPUSCLAUDE_PROXY_SHA__", await shaFile(rig.bin))
      .replaceAll("__OPUSCLAUDE_CLAUDE_PIN__", "2.1.284"),
    "utf8"
  )
  await writeFile(rig.launcher, filled)
  await chmod(rig.launcher, 0o755)
  await rig.writeConfig(createHash("sha256").update(filled).digest("hex"))
  const officialCopy = await put(path.join(tmpVerify, "official-opclaude"), filled)

  const trace = path.join(tmpVerify, "trace")
  const tools = path.join(tmpVerify, "tools")
  for (const name of ["tr", "mkdir"]) await put(path.join(tools, name), `#!/bin/sh\nprintf 'host-${name}\\n' >> '${trace}'\nexec ${await systemTool(name)} "$@"\n`)
  for (const name of ["sed", "head", "grep", "basename", "dirname", "cat", "sh"]) await symlink(await systemTool(name), path.join(tools, name))

  // 1. 候选优先级与两阶段工具（未修改的完整官方模板使用生产默认 SYSTEM_CLAUDES）
  await rm(path.join(rig.dir, ".local", "bin", "claude"), { force: true })
  await claudeAt(path.join(tools, "claude"), "2.1.300")
  const envTools = { HOME: rig.dir, PATH: tools, LANG: "C" }
  const off1 = officialVersion(officialCopy, envTools)
  assertEq("official fallback/fixed exit", off1.code, 0)
  const expectedVersion = withFixedClaude ? "2.1.100" : "2.1.300"
  const candidate = withFixedClaude ? "fixed /usr/local/bin/claude" : "PATH claude"
  assertEq(`official ${candidate}`, off1.ver, expectedVersion)
  await writeFile(trace, "")
  assertEq(`plugin ${candidate}`, await readHostVersion({ script: filled, source: envTools }), expectedVersion)
  assertEq("two-stage tools before prepend", (await readFile(trace, "utf8")).trim().split("\n").join(","), "host-tr,host-tr,host-mkdir")

  // ~/.claude/local/claude（#2）应始终胜过固定系统路径（#3/#4）与 PATH（#5）
  await claudeAt(path.join(rig.dir, ".claude", "local", "claude"), "2.1.295")
  const off2 = officialVersion(officialCopy, envTools)
  assertEq("official ~/.claude/local/claude wins", off2.ver, "2.1.295")
  assertEq("plugin ~/.claude/local/claude wins", await readHostVersion({ script: filled, source: envTools }), "2.1.295")
  await rm(path.join(rig.dir, ".claude", "local", "claude"), { force: true })

  // 2. PATH 缺省 vs 显式空 vs 只读 /tmp 下 stdin 执行
  await claudeAt(path.join(rig.dir, ".local", "bin", "claude"), "2.1.284")
  const unsetEnv = { HOME: rig.dir, LANG: "C" }
  const emptyEnv = { HOME: rig.dir, LANG: "C", PATH: "" }
  assertEq("official PATH unset", officialVersion(officialCopy, unsetEnv).ver, "2.1.284")
  assertEq("plugin PATH unset", await readHostVersion({ script: filled, source: unsetEnv }), "2.1.284")
  assertEq("official PATH empty", officialVersion(officialCopy, emptyEnv).ver, "未找到")
  assertEq("plugin PATH empty", await readHostVersion({ script: filled, source: emptyEnv }).catch((e) => e.code), "version_unknown")

  // 3. 完整插件链路（含符号链接 + .. OPUSCLAUDE_HOME）
  await mkdir(path.join(rig.opusHome, "nested"), { recursive: true })
  await symlink(path.join(rig.opusHome, "nested"), path.join(rig.dir, "custom"))
  const symEnv = { ...rig.env, OPUSCLAUDE_HOME: path.join(rig.dir, "custom") + "/.." }
  const found = await discoverHost(symEnv, { dirs: rig.dirs })
  try {
    assertEq("physical opusHome", found.opusHome, rig.realOpusHome)
  } finally { await found.executable.close() }
  const fetch = (await createPlugin({}, { env: symEnv, launcherDirs: rig.dirs }).auth.loader(async () => ({ type: "api", key: LOCAL_MARKER }))).fetch
  const res = await fetch(PLACEHOLDER_BASE + "/messages", {
    method: "POST",
    headers: { "user-agent": "claude-cli/2.1.100 (external, cli)", "x-app": "cli", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-fable-5-2", max_tokens: 16, stream: false, messages: [{ role: "user", content: "hi" }] }),
  })
  assertEq("plugin fetch with official 157KB template", res.status, 200)
} finally {
  await rm(tmpVerify, { recursive: true, force: true })
  await rig.close()
}
