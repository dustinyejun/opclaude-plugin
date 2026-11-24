import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmod, rm, symlink } from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { PROXY_BASE_RE, parseLaunchOutput, runLaunch, validateSettings } from "../lib/launch.mjs"
import { makeRig } from "./rig.mjs"

let rig
beforeAll(async () => { rig = await makeRig() })
afterAll(async () => { await rig.close() })

const good = (p = "18827") => `OC_RUN_MODE='proxy'\nOC_BASE_URL='http://127.0.0.1:${p}'\nOC_CREDENTIAL='ticket'\nOC_DEVICE_ID='dev'\n`
const code = (p) => p.then(() => "", (e) => e.code)
const codeOf = (fn) => { try { fn(); return "" } catch (e) { return e.code } }

describe("parseLaunchOutput：有界静态解析", () => {
  test("接受标准输出并解出配套地址与票据", () => {
    const s = parseLaunchOutput(good("18836"))
    expect(s).toMatchObject({ mode: "proxy", baseUrl: "http://127.0.0.1:18836", credential: "ticket", deviceId: "dev" })
  })
  test("按安装脚本同一条规则解单引号转义", () => {
    expect(parseLaunchOutput(good().replace("'ticket'", "'a'\\''b'")).credential).toBe("a'b")
  })
  test("端口白名单与脚本 oc_proxy_url_ok 一致", () => {
    for (let p = 18827; p <= 18836; p++) expect(PROXY_BASE_RE.test(`http://127.0.0.1:${p}`)).toBe(true)
    for (const u of ["http://127.0.0.1:18826", "http://127.0.0.1:18837", "http://localhost:18827", "https://127.0.0.1:18827", "http://[::1]:18827", "http://127.0.0.1:18827/", "http://127.0.0.1:18827@evil.example"]) {
      expect(PROXY_BASE_RE.test(u)).toBe(false)
    }
  })
  test("direct 模式明确失败", () => {
    expect(codeOf(() => parseLaunchOutput(good().replace("'proxy'", "'direct'")))).toBe("mode_direct")
  })
  test("拒绝非回环地址、未知模式、缺票据、控制字符、重复键、多余行、CRLF", () => {
    const bad = [
      ["base_url_rejected", good().replace("http://127.0.0.1:18827", "https://api.opusapi.xyz")],
      ["base_url_rejected", good().replace("http://127.0.0.1:18827", "http://localhost:18827")],
      ["base_url_rejected", good().replace("http://127.0.0.1:18827", "http://127.0.0.1:18826")],
      ["mode_unsupported", good().replace("'proxy'", "'tunnel'")],
      ["launch_output_invalid", good().replace("OC_CREDENTIAL='ticket'\n", "")],
      ["launch_output_invalid", good().replace("OC_BASE_URL=", "OC_BASE_URL2=")],
      ["credential_invalid", good().replace("'ticket'", "''")],
      ["launch_output_invalid", good().replace("'ticket'", "'a\tb'")],
      ["launch_output_invalid", good().replace("'dev'", "'d\u007fv'")],
      ["launch_output_invalid", "OC_RUN_MODE='proxy'\nrm -rf /\n"],
      ["launch_output_invalid", "OC_RUN_MODE='direct'\nOC_RUN_MODE='proxy'\n"],
      ["launch_output_invalid", "OC_RUN_MODE='proxy'\r\n"],
      ["launch_output_invalid", "OC_X='a'\\n'\\nX=$(id)\n"],
      ["launch_output_invalid", "OC_X='unterminated\n"],
      ["launch_output_invalid", "OC_X='a\\'b'\n"],
      ["launch_output_invalid", "x='a'\n"],
      ["launch_output_invalid", "OC_X='" + "a".repeat(9000) + "'\n"],
      ["launch_output_invalid", Array.from({ length: 40 }, (_, i) => `OC_K${i}='a'`).join("\n") + "\n"],
      ["launch_output_invalid", ""],
      ["launch_output_invalid", "a".repeat(70000)],
    ]
    for (const [c, text] of bad) expect(codeOf(() => parseLaunchOutput(text)), text.slice(0, 40)).toBe(c)
  })
})

describe("设置与可执行文件校验", () => {
  const ok = { opclauded: "/x/opclauded", opusHome: "/x/home" }
  test("只接受绝对路径", () => {
    expect(() => validateSettings(ok)).not.toThrow()
    for (const s of [{}, { ...ok, opclauded: "opclauded" }, { ...ok, opusHome: "~/.opusclaude" }, { ...ok, opusHome: 1 }, { ...ok, opclaudedSha256: "abc" }]) {
      expect(() => validateSettings(s)).toThrow()
    }
  })
  test("不执行：缺失、符号链接、不可执行、指纹不符", async () => {
    const s = { opclauded: rig.bin, opusHome: rig.opusHome }
    expect((await runLaunch(s, { timeoutMs: 5000 })).baseUrl).toBe(`http://127.0.0.1:${rig.port}`)
    const hash = createHash("sha256").update(new Uint8Array(await Bun.file(rig.bin).arrayBuffer())).digest("hex")
    expect((await runLaunch({ ...s, opclaudedSha256: hash })).mode).toBe("proxy")
    expect(await code(runLaunch({ ...s, opclaudedSha256: "0".repeat(64) }))).toBe("sha256_mismatch")
    expect(await code(runLaunch({ ...s, opclauded: path.join(rig.dir, "nope") }))).toBe("binary_missing")
    expect(await code(runLaunch({ ...s, opclauded: rig.dir }))).toBe("binary_not_regular")
    const linkPath = path.join(rig.dir, "link")
    await rm(linkPath, { force: true })
    await symlink(rig.bin, linkPath)
    expect(await code(runLaunch({ ...s, opclauded: linkPath }))).toBe("binary_not_regular")
    await rm(linkPath, { force: true })
    const copy = path.join(rig.dir, "noexec")
    await Bun.write(copy, await Bun.file(rig.bin).text())
    await chmod(copy, 0o644)
    expect(await code(runLaunch({ ...s, opclauded: copy }))).toBe("binary_not_executable")
  })
  test("参数固定为 launch --home <home> --min-protocol 1，环境里没有任何继承的凭据", async () => {
    process.env.ANTHROPIC_AUTH_TOKEN = "inherited-fake"
    await runLaunch({ opclauded: rig.bin, opusHome: rig.opusHome, proxyHome: "/tmp/oc-proxy-home" })
    delete process.env.ANTHROPIC_AUTH_TOKEN
    expect(await Bun.file(path.join(rig.state, "last-args")).text()).toBe(`--home|${rig.opusHome}|--min-protocol|1\n`)
    const env = (await Bun.file(path.join(rig.state, "last-env")).text()).split("\n")
    expect(env).toContain("OPCLAUDE_PROXY_HOME=/tmp/oc-proxy-home".split("=")[0])
    expect(env.some((k) => /ANTHROPIC|OPUSCLAUDE|CLAUDE|OC_/.test(k) && k !== "OPCLAUDE_PROXY_HOME")).toBe(false)
  })
  test("opclauded 的各类失败都给出安全错误码，stderr 原文不外传", async () => {
    for (const [mode, c] of [["direct", "mode_direct"], ["badport", "base_url_rejected"], ["localhost", "base_url_rejected"], ["public", "base_url_rejected"], ["garbage", "launch_output_invalid"], ["inject", "launch_output_invalid"], ["dup", "launch_output_invalid"], ["crlf", "launch_output_invalid"], ["nocred", "launch_output_invalid"], ["credctl", "launch_output_invalid"], ["other", "mode_unsupported"], ["huge", "launch_output_invalid"], ["busy", "install_busy"], ["txn", "txn_recovery_failed"], ["proto", "launch_failed"], ["zzz", "launch_failed"]]) {
      rig.st.mode = mode
      await rig.sync()
      const p = runLaunch({ opclauded: rig.bin, opusHome: rig.opusHome }, { timeoutMs: 8000 })
      expect(await code(p), mode).toBe(c)
      try { await p } catch (e) {
        expect(e.message).not.toContain("SECRET-STDERR-TICKET")
        expect(e.message).not.toContain("sk-upstream-fake")
        expect(e.message).not.toContain("evil.example")
      }
    }
    rig.st.mode = "proxy"
    await rig.sync()
  })
  test("挂起的 launch 超时即失败；调用方取消会结束子进程", async () => {
    rig.st.mode = "hang"
    await rig.sync()
    expect(await code(runLaunch({ opclauded: rig.bin, opusHome: rig.opusHome }, { timeoutMs: 400 }))).toBe("launch_timeout")
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 100)
    expect(await code(runLaunch({ opclauded: rig.bin, opusHome: rig.opusHome }, { signal: ctrl.signal }))).toBe("launch_aborted")
    rig.st.mode = "proxy"
    await rig.sync()
  })
})
