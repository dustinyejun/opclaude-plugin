// 宿主机发现：定位官方 opclaude 启动器，从它的静态赋值里取出选定的 opclauded 与指纹，
// 再用同一个启动器的 version 子命令读宿主机真实的 Claude Code 版本。
//
// 契约来自官方安装脚本（https://claude.opusapi.xyz/install.sh）写出的启动器：
//   OPUS_DIR="${OPUSCLAUDE_HOME:-$HOME/.opusclaude}"
//   OPCLAUDED_BIN="/abs/.opusclaude/opclauded/<版本>/opclauded"      装机时按指纹表核对过的程序
//   OPCLAUDED_SHA256="<64 位小写十六进制>"                            启动器每次执行前复核
//   opclaude version  ->  "Claude Code：<实际版本>（推荐 <钉死版本>）"
// 安装器把同一份启动器写到 ~/.local/bin/opclaude，并在 /usr/local/bin 可写时也写一份；成品启动器的
// 摘要记在 <home>/config（chmod 600）的 LAUNCHER_SHA 里。启动器自己的 version 分支在这项自校验之前
// 就退出，所以执行启动器之前由插件做绑定：摘要必须等于该安装的 config 所记，且启动器、安装目录、
// config 以及它们路径上的每一级目录都不允许其他用户替换。
//
// 启动器只打开一次（非阻塞、不跟随符号链接）：读出的字节用来解析字段、算摘要，版本探测也执行这同一份字节——
// 经标准输入交给 /bin/sh -s -- version，不写临时文件，也不把脚本作为命令行参数，
// 也不再打开可能正被升级改写的原路径。
//
// 信任的判断只有一个问题：别的用户能不能把这个目录项（或文件）换掉？沿原始路径逐级看，符号链接每跳一次，
// 跳转目标所在的各级目录也要看。目录的属主须是 root 或本用户，且不能被组或其他用户写入；组可写只在两种情况下接受：
// 上级有一级是别的用户进不来的私有目录，或者这个组只有受信任的用户（/etc/group、/etc/passwd 查得到成员）。
// root 所有的 sticky 目录（/tmp）例外：别的用户在那里删不掉、换不了已有的条目。
//
// 这里只做受限的静态解析：不 eval / source，不执行启动器里 OPCLAUDED_BIN 之外的任何内容。
import { createHash } from "node:crypto"
import { closeSync, constants } from "node:fs"
import { access, chmod, link, lstat, mkdtemp, mkdir, open, readFile, readlink, realpath, rename, rm, stat, unlink, rmdir } from "node:fs/promises"
import { tmpdir, userInfo } from "node:os"
import path from "node:path"
import { SafeError } from "./errors.mjs"
import { capture, verifyBinary } from "./launch.mjs"

// 启动器正文经标准输入交给 sh；这个上限只限制读入内存的大小。
const MAX_LAUNCHER = 512 * 1024
const MAX_CONFIG = 256 * 1024
const MAX_BINARY = 1024 * 1024 * 1024
const SHA256 = /^[0-9a-f]{64}$/
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/
// 启动器里由安装器写死的两个字面量：双引号、绝对路径。
// 安装器写入前会把 \ " $ ` 四种字符转义（反斜杠成对），这里只解码这四种；其余转义、没转义的 $ ` "
// 都不接受（它们在 shell 里是展开或命令替换）。解码后的值必须仍是合法路径。
// 值后面允许跟一段空白加 # 注释（官方启动器的 SHA256 行带行尾注释），此外行内不能有别的内容。
const ASSIGN = /^OPCLAUDED_(BIN|SHA256)=(.*)$/
const ESCAPES = { "\\": "\\", '"': '"', "$": "$", "`": "`" }
const QUOTED = /^"((?:[^"\\$`\x00-\x1f\x7f]|\\[\\"$`])*)"[ \t]*(?:#[^\x00-\x1f\x7f]*)?$/
const NAMED = /^\/.*\/opclauded\/[A-Za-z0-9._-]+\/opclauded$/
// 程序相对真实 OpusClaude home 的位置，逐段严格相等：中间目录是符号链接时物理路径会对不上。
const UNDER_HOME = /^opclauded\/[A-Za-z0-9._-]+\/opclauded$/
// 官方启动器到 version 分支为止从 PATH 执行的辅助工具（printf、command 是内建）。分两段：
//   前置 ~/.local/bin 之前：宿主 PATH 上的 tr（命令词转小写）与 mkdir（建 claude-env 目录）；
//   之后：sed（读这个安装的 config）、head、grep、basename、dirname。
// 每个工具核对的是那一段 PATH 上第一个命中的文件，与启动器实际会执行的顺序一致。
const TOOLS_BEFORE_PREPEND = ["tr", "mkdir"]
const TOOLS_AFTER_PREPEND = ["sed", "head", "grep", "basename", "dirname"]
// 官方启动器钉死的 Claude Code 版本；versions/<CLAUDE_PIN> 是它的一个候选位置。
const PIN_LINE = /^CLAUDE_PIN="([^"\x00-\x1f\x7f]*)"$/

// 路径末尾多余的斜杠（不折叠中间的 ".."）。
const stripSlashes = (p) => (p.replace(/\/+$/, "") || path.sep)
const subPath = (base, ...segs) => {
  const b = stripSlashes(base)
  return (b === path.sep ? "" : b) + path.sep + segs.join(path.sep)
}

export function hostHome(env) {
  const custom = env?.OPUSCLAUDE_HOME
  if (custom !== undefined && custom !== "") {
    if (typeof custom !== "string" || !path.isAbsolute(custom) || custom.includes("\0") || custom.length > 4096) throw new SafeError("home_invalid")
    return custom
  }
  const home = env?.HOME
  if (typeof home !== "string" || !path.isAbsolute(home) || home.includes("\0") || home.length > 4096) throw new SafeError("home_invalid")
  return subPath(home, ".opusclaude")
}

// 文本 -> { bin, sha256 }。bin 为空串表示安装时没有启用本机代理。
export function parseLauncher(text) {
  const invalid = () => new SafeError("launcher_invalid")
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_LAUNCHER || text.includes("\0")) throw invalid()
  if (!text.startsWith("#!")) throw invalid()
  const values = { BIN: [], SHA256: [] }
  for (const line of text.split("\n")) {
    const m = ASSIGN.exec(line)
    if (!m) continue
    const q = QUOTED.exec(m[2])
    if (!q) throw invalid()
    // 逐个字符反转义：偶数个反斜杠之后紧跟的 $ 才是没转义的，QUOTED 已按这一规则拒绝了它。
    values[m[1]].push(q[1].replace(/\\(.)/g, (_, c) => ESCAPES[c]))
  }
  if (values.BIN.length !== 1 || values.SHA256.length !== 1) throw invalid()
  const bin = values.BIN[0]
  const sha256 = values.SHA256[0]
  if (bin === "") {
    if (sha256 !== "") throw invalid()
    return { bin: "", sha256: "" }
  }
  if (!NAMED.test(bin) || !SHA256.test(sha256)) throw invalid()
  return { bin, sha256 }
}

export function parseVersionOutput(text) {
  const unknown = () => new SafeError("version_unknown")
  if (typeof text !== "string" || text.includes("\0")) throw unknown()
  const lines = text.split("\n").filter((l) => l.startsWith("Claude Code："))
  if (lines.length !== 1) throw unknown()
  // 只认“实际版本（推荐 x.y.z）”整行：未找到、多出一行、带控制字符的都不算。
  const m = /^Claude Code：([0-9]+\.[0-9]+\.[0-9]+)（推荐 [^（)\x00-\x1f\x7f]*）$/.exec(lines[0])
  if (!m || !VERSION.test(m[1])) throw unknown()
  return m[1]
}

// 定位文件时的文件系统错误（ENOENT / ENOTDIR / EACCES / ELOOP …）：在发现边界换成固定的 SafeError，
// 不把系统调用的原始异常（带安装绝对路径）放出插件。其余异常原样上抛。
const locateFailed = (e) => typeof e?.code === "string" && /^[A-Z]{2,16}$/.test(e.code)
const mapFs = (e, table) => {
  if (e?.name === "OpclaudeError") throw e
  if (!locateFailed(e)) throw e
  throw new SafeError(table[e.code] ?? table.other)
}
const BIN_FS = { ENOENT: "binary_missing", ENOTDIR: "binary_missing", other: "binary_unreadable" }

// ───── 信任判断：别的用户能不能换掉这个目录项 ─────
const uid = () => process.getuid?.()
// 受信任的属主：运行插件的用户自己，或 root。
const ownedByTrusted = (owner) => uid() === undefined || owner === 0 || owner === uid()

// 一个组是否只有受信任的用户（root 与本用户）。只认 Linux 的“用户私有组”约定，并且要查得到才算：
// /etc/group 里这个组的名字与本用户同名、没有并列成员，/etc/passwd 里也没有别的用户以它为主组。
// 仅有“它是本用户的主组”不算证明。查不到（macOS 的本地用户不在这两个文件里）一律当作共享组。
// groupProbe.isPrivate 供测试替换（macOS 上建不出私有组）。
export const groupProbe = { isPrivate: null }
const groupCache = new Map()
async function groupPrivate(gid) {
  if (groupProbe.isPrivate) return await groupProbe.isPrivate(gid)
  if (!groupCache.has(gid)) {
    groupCache.set(gid, (async () => {
      const me = uid()
      if (me === undefined || gid === 0) return false
      const [passwd, group] = await Promise.all([readFile("/etc/passwd", "utf8").catch(() => null), readFile("/etc/group", "utf8").catch(() => null)])
      if (passwd === null || group === null) return false
      const users = passwd.split("\n").map((l) => l.split(":")).filter((f) => f.length >= 4 && /^\d+$/.test(f[2]) && /^\d+$/.test(f[3]))
      const name = users.find((f) => Number(f[2]) === me)?.[0]
      if (!name) return false
      const entry = group.split("\n").map((l) => l.split(":")).find((f) => f.length >= 4 && /^\d+$/.test(f[2]) && Number(f[2]) === gid)
      if (!entry || entry[0] !== name || entry[3].trim() !== "") return false
      return !users.some((f) => Number(f[3]) === gid && Number(f[2]) !== me)
    })())
  }
  return await groupCache.get(gid)
}

// 目录项（目录或文件）别的用户换不掉：属主受信任，且组、其他用户都不能写。例外：
//   - root 所有的 sticky 目录（/tmp 这一类）：别的用户删不掉、换不了里面已有的条目，组可写也无妨；
//   - 组可写，但 prot 为真（上级有一级目录别的用户进不来，这里的东西他们根本够不着），或者这个组只有受信任的用户。
async function entryNotReplaceable(st, prot) {
  if (!ownedByTrusted(st.uid)) return false
  if (st.isDirectory() && st.uid === 0 && (st.mode & 0o1000) !== 0) return true
  const mode = st.mode & 0o777
  if (mode & 0o002) return false
  if (!(mode & 0o020)) return true
  return prot || (await groupPrivate(st.gid))
}
// 私有目录：属主受信任，其他用户没有进入（搜索）权限；组能进入时，组里只能有受信任的用户。
const privateDir = async (st) => {
  if (!ownedByTrusted(st.uid) || (st.mode & 0o007) !== 0) return false
  return (st.mode & 0o010) === 0 || (await groupPrivate(st.gid))
}

// 沿原始路径从根逐级核对到 target，符号链接每跳一次，目标所在的各级目录同样逐级核对，最后核对终点本身。
// 这与内核解析路径的方式一致：校验的就是运行时真正会走到的位置。
// 保护状态 prot 随物理目录层级入栈、出栈：遇到 ".." 退回上一级时同步恢复那一级的保护状态；
// 绝对符号链接从根重新起算，相对符号链接从链接所在的父目录逐分量消费（不预先 path.join 折叠 ".."）。
// 返回 { ok, missing, why, st, real, prot }：
//   ok=false：有一级别的用户能换掉（why="untrusted"）、中间一级不是目录（why="notdir"）、符号链接跳转过多（why="hops"）或其他文件系统错误（why="io"）；
//   missing=true：到某一级为止不存在，之前的每一级都受信任；
//   st / real：终点这一项的 lstat 与它实际所在的物理路径（符号链接已解开）；prot：Directory 时为其本身或物理祖先中是否有私有目录，普通文件时为其物理祖先中是否有私有目录。
export async function trustedPath(target, { hops = 40 } = {}) {
  if (typeof target !== "string" || !path.isAbsolute(target) || target.includes("\0")) return { ok: false, why: "io" }
  let needDir = target.length > 1 && target.endsWith(path.sep)
  let rootSt
  try { rootSt = await lstat(path.sep) } catch { return { ok: false, why: "io", prot: false } }
  if (!(await entryNotReplaceable(rootSt, false))) return { ok: false, why: "untrusted" }
  let frames = [{ path: path.sep, st: rootSt, prot: await privateDir(rootSt) }]
  const rest = target.split(path.sep).filter((p) => p !== "").reverse()
  let hopsLeft = hops
  while (rest.length > 0) {
    const part = rest.pop()
    const last = rest.length === 0
    if (part === ".") continue
    if (part === "..") {
      if (frames.length > 1) frames.pop()
      continue
    }
    const parent = frames[frames.length - 1]
    const nextPath = parent.path === path.sep ? path.sep + part : parent.path + path.sep + part
    let st
    try { st = await lstat(nextPath) } catch (e) {
      return e?.code === "ENOENT" ? { ok: true, missing: true, prot: parent.prot } : { ok: false, why: "io", prot: parent.prot }
    }
    if (st.isSymbolicLink()) {
      if (hopsLeft <= 0) return { ok: false, why: "hops" }
      hopsLeft--
      let dest
      try { dest = await readlink(nextPath) } catch { return { ok: false, why: "io" } }
      if (!dest) return { ok: false, why: "io" }
      if (last && dest.length > 1 && dest.endsWith(path.sep)) needDir = true
      if (path.isAbsolute(dest)) frames = [frames[0]]
      const destParts = dest.split(path.sep).filter((p) => p !== "")
      for (let j = destParts.length - 1; j >= 0; j--) rest.push(destParts[j])
      continue
    }
    if (st.isDirectory()) {
      if (!(await entryNotReplaceable(st, parent.prot))) return { ok: false, why: "untrusted" }
      frames.push({ path: nextPath, st, prot: parent.prot || (await privateDir(st)) })
    } else {
      if (!last || needDir) return { ok: false, why: "notdir" }
      return { ok: true, st, real: nextPath, prot: parent.prot }
    }
  }
  const top = frames[frames.length - 1]
  return { ok: true, st: top.st, real: top.path, prot: top.prot }
}

// 非阻塞打开：候选项是 FIFO 或设备文件时立即拿到描述符，再由同一个描述符上的 fstat 判定不是普通文件。
// 只读阻塞打开一个没有写端的 FIFO 会一直等下去。
const OPEN_REGULAR = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
// 从同一个描述符上读出全部字节；大小以这个描述符的 fstat 为准，读到结尾必须刚好一样多。
async function readAll(fh, max, tooBig) {
  const st = await fh.stat()
  if (!st.isFile()) return { st, bad: "type" }
  if (st.size === 0 || st.size > max) return { st, bad: "size", tooBig }
  const bytes = Buffer.alloc(st.size)
  let done = 0
  while (done < bytes.length) {
    const { bytesRead } = await fh.read(bytes, done, bytes.length - done, null)
    if (bytesRead === 0) break
    done += bytesRead
  }
  return { st, bytes, bad: done === st.size ? "" : "size" }
}

// 只打开一次启动器：不跟随符号链接、非阻塞，再从同一个文件描述符取大小与属主、读出全部字节。
// 返回 null 表示这一处没有安装；内容读不了或不合法是 launcher_invalid，属主或权限不对是 host_path_untrusted。
// prot：启动器所在目录之上有没有私有目录（由调用方先核对那个目录链后给出）。
async function readLauncher(file, prot) {
  const invalid = () => new SafeError("launcher_invalid")
  let target = file
  // 调用方没先核对所在目录时（只供测试与诊断的直读）：组可写是否要紧由这里的逐级核对给出，并定位到物理目录。
  if (typeof prot !== "boolean") {
    const slash = file.lastIndexOf(path.sep)
    const dirPath = slash <= 0 ? path.sep : file.slice(0, slash)
    const dir = await trustedPath(dirPath)
    if (!dir.ok) throw new SafeError("host_path_untrusted")
    if (dir.missing) return null
    if (!dir.st.isDirectory()) throw invalid()
    target = subPath(dir.real, file.slice(slash + 1))
    prot = dir.prot
  }
  let fh
  try { fh = await open(target, OPEN_REGULAR) } catch (e) {
    if (e?.code === "ENOENT") return null
    if (locateFailed(e)) throw invalid()
    throw e
  }
  try {
    const { st, bytes, bad } = await readAll(fh, MAX_LAUNCHER, true)
    // 不是普通文件（FIFO、目录、设备）、空的或超限：当作启动器损坏。
    if (bad) throw invalid()
    if (!(await entryNotReplaceable(st, prot))) throw new SafeError("host_path_untrusted")
    // 正文的 UTF-8 解码必须能原样还原：版本探测执行的就是这份文本，内容要与算过摘要的字节一致。
    const text = bytes.toString("utf8")
    if (!Buffer.from(text, "utf8").equals(bytes)) throw invalid()
    return { launcher: target, bytes, ...parseLauncher(text) }
  } catch (e) {
    if (e?.name === "OpclaudeError") throw e
    if (locateFailed(e)) throw invalid()
    throw e
  } finally { await fh.close() }
}

// config 里记的启动器摘要。config 同时存着真实登录凭据，所以不把整个文件读成字符串：
// 按块读字节，每行只比对开头 13 个字节是不是 LAUNCHER_SHA=，是的话再把这一行的内容收下来（至多 80 字节），
// 全文件里只有这一行的字节会被解码。其余行只留下开头几个字节的比对片段，随即丢弃。
// 返回 null：config 在却不是受信任的普通文件（符号链接、FIFO、权限不对、读不出）；返回 ""：没有 config，或没记下唯一一行合法摘要。
const SHA_PREFIX = Buffer.from("LAUNCHER_SHA=")
const CONFIG_SHA = /^LAUNCHER_SHA='([0-9a-f]{64})'$/
async function launcherShaFromConfig(config, prot = false) {
  let fh
  try { fh = await open(config, OPEN_REGULAR) } catch (e) { return e?.code === "ENOENT" ? "" : null }
  try {
    const st = await fh.stat()
    // config 须是安装器写出的普通文件：受信任的属主、不能被组或其他用户写、大小有界。
    if (!st.isFile() || st.size === 0 || st.size > MAX_CONFIG || !(await entryNotReplaceable(st, prot))) return null
    const chunk = Buffer.alloc(64 * 1024)
    let keep = Buffer.alloc(0)
    let matched = Buffer.alloc(0)
    let skip = false
    let full = false
    let count = 0
    let value = ""
    const lineEnd = () => {
      if (!skip && keep.length === SHA_PREFIX.length && keep.equals(SHA_PREFIX)) {
        count++
        const line = Buffer.concat([keep, matched]).toString("latin1")
        const m = CONFIG_SHA.exec(line)
        value = m ? m[1] : ""
      }
      keep = Buffer.alloc(0)
      matched = Buffer.alloc(0)
      skip = false
      full = false
    }
    for (;;) {
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, null)
      if (bytesRead === 0) break
      let at = 0
      while (at < bytesRead) {
        const nl = chunk.indexOf(10, at)
        let seg = chunk.subarray(at, nl < 0 ? bytesRead : nl)
        if (!skip && !full) {
          if (keep.length < SHA_PREFIX.length) {
            const take = Math.min(SHA_PREFIX.length - keep.length, seg.length)
            keep = Buffer.concat([keep, seg.subarray(0, take)])
            seg = seg.subarray(take)
          }
          if (keep.length === SHA_PREFIX.length) {
            if (!keep.equals(SHA_PREFIX)) skip = true
            else if (seg.length) {
              const take = Math.min(80 - matched.length, seg.length)
              matched = Buffer.concat([matched, seg.subarray(0, take)])
              if (matched.length >= 80) full = true
            }
          }
        }
        if (nl < 0) break
        lineEnd()
        at = nl + 1
      }
    }
    if (keep.length || matched.length) lineEnd()
    return count === 1 ? value : ""
  } catch { return null } finally { await fh.close() }
}

// 把启动器绑定到它所属的安装（home 是这次选定的 OpusClaude home，按它原本的写法逐级核对）：
//   - 安装目录路径上的每一级、config 本身，只允许受信任的用户改动；
//   - 读出来的启动器字节的摘要等于确认物理目录 <homeReal>/config 记的 LAUNCHER_SHA。
// 返回安装目录实际所在的（物理）路径，后面核对程序位置、读配置、定位工具与传给子进程都用它。
export async function trustLauncher(found, home) {
  const pathUntrusted = () => new SafeError("host_path_untrusted")
  const homeWalk = await trustedPath(home)
  if (!homeWalk.ok) throw pathUntrusted()
  // home 不存在，或它的位置不是目录（被普通文件占住）：安装与启动器对不上。
  if (homeWalk.missing || !homeWalk.st.isDirectory()) throw new SafeError("launcher_home_mismatch")
  const homeReal = homeWalk.real
  const digest = createHash("sha256").update(found.bytes).digest("hex")
  const recorded = await launcherShaFromConfig(subPath(homeReal, "config"), homeWalk.prot)
  if (recorded === null) throw pathUntrusted()
  if (!recorded || recorded !== digest) throw new SafeError("launcher_untrusted")
  return homeReal
}

// 启动器选定的程序必须就是当前安装里的那一份：按它原本的写法逐级核对（含符号链接经过的目录），
// 再要求它实际所在的位置相对确认物理安装目录逐段是 opclauded/<版本>/opclauded。指纹与执行都用这个位置。
// 自动发现时在这里就把程序打开：属主、权限、指纹都从同一个文件描述符核对，描述符留给执行用（见 launch.mjs）。
export async function bindBinary(found, home, { userHome = "", tmpRoot = "" } = {}) {
  const homeWalk = await trustedPath(home)
  if (!homeWalk.ok) throw new SafeError("host_path_untrusted")
  if (homeWalk.missing || !homeWalk.st.isDirectory()) throw new SafeError("launcher_home_mismatch")
  const homeReal = homeWalk.real
  const walk = await trustedPath(found.bin)
  if (!walk.ok) throw new SafeError(walk.why === "hops" ? "binary_unreadable" : walk.why === "notdir" ? "binary_missing" : "host_path_untrusted")
  if (walk.missing) throw new SafeError("binary_missing")
  const realBin = walk.real
  // home 之外（含 ../ 形式）或层次不严格相符，都算不在当前安装里。
  if (!UNDER_HOME.test(path.relative(homeReal, realBin))) throw new SafeError("launcher_home_mismatch")
  if (!walk.st.isFile()) throw new SafeError("binary_not_regular")
  return { ...found, bin: realBin, opusHome: homeReal, executable: await openBinary(realBin, walk.prot, found.sha256, { opusHome: homeReal, userHome, tmpRoot }) }
}

// 打开程序并从同一个描述符核对：普通文件、大小有界、受信任的属主、组和其他用户不能写、可执行、指纹相符。
async function openBinary(realBin, prot, sha256, { opusHome = "", userHome = "", tmpRoot = "" } = {}) {
  let fh
  try { fh = await open(realBin, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) } catch (e) { mapFs(e, BIN_FS) }
  let exe
  try {
    const { st, bad } = await readAll(fh, MAX_BINARY, "binary_unreadable")
    if (bad === "type" || st.size === 0) throw new SafeError("binary_not_regular")
    if (bad) throw new SafeError("binary_unreadable")
    if (!(await entryNotReplaceable(st, prot))) throw new SafeError("host_path_untrusted")
    try { await access(realBin, constants.X_OK) } catch { throw new SafeError("binary_not_executable") }
    if (sha256) {
      const h = createHash("sha256")
      const chunk = Buffer.alloc(256 * 1024)
      for (let pos = 0; ; ) {
        const { bytesRead } = await fh.read(chunk, 0, chunk.length, pos)
        if (bytesRead === 0) break
        h.update(chunk.subarray(0, bytesRead))
        pos += bytesRead
      }
      if (h.digest("hex") !== sha256) throw new SafeError("sha256_mismatch")
    }
    let closed = false
    // close 可以重复调用；描述符由调用方在这次运行结束后关（capture 不关带 close 的那一类）。
    exe = {
      fd: fh.fd, path: realBin, sha256, size: st.size, dev: st.dev, opusHome, userHome, tmpRoot,
      close: async () => { if (!closed) { closed = true; await fh.close().catch(() => {}) } },
      // 从这个已核对的描述符按位置读（不依赖、也不改变文件位置）。
      read: (buffer, position) => fh.read(buffer, 0, buffer.length, position),
    }
    // 执行的是内容的绑定副本（见 materializeBinary），不是安装里的那个路径。
    exe.materialize = () => (exe.copying ??= materializeBinary(exe))
    return exe
  } catch (e) {
    await exe?.close().catch(() => {})
    throw e
  } finally {
    if (!exe) await fh.close().catch(() => {})
  }
}

const digestOf = async (fh) => {
  const h = createHash("sha256")
  const chunk = Buffer.alloc(256 * 1024)
  for (let pos = 0; ; ) {
    const { bytesRead } = await fh.read(chunk, 0, chunk.length, pos)
    if (bytesRead === 0) break
    h.update(chunk.subarray(0, bytesRead))
    pos += bytesRead
  }
  return h.digest("hex")
}

// 逐级建并核对可信目录：每级都要求真实目录（非符号链接）与全物理祖先受信任，末级严格 0700 且归属本用户。
async function ensurePrivateDir(baseReal, parentSegs, leafName, me) {
  const baseWalk = await trustedPath(baseReal)
  if (!baseWalk.ok || baseWalk.missing || !baseWalk.st.isDirectory()) return null
  let cur = baseWalk.real
  for (const seg of parentSegs) {
    cur = subPath(cur, seg)
    const pre = await trustedPath(cur)
    if (!pre.ok) return null
    let created = false
    if (pre.missing) {
      try { await mkdir(cur, { mode: 0o700 }); created = true } catch (e) { if (e?.code !== "EEXIST") return null }
      if (created) await chmod(cur, 0o700).catch(() => {})
    }
    const lst = await lstat(cur).catch(() => null)
    if (!lst || !lst.isDirectory()) return null
    const w = await trustedPath(cur)
    if (!w.ok || w.missing || !w.st.isDirectory() || w.real !== cur) return null
  }
  const root = subPath(cur, leafName)
  const pre = await trustedPath(root)
  if (!pre.ok) return null
  let created = false
  if (pre.missing) {
    try { await mkdir(root, { mode: 0o700 }); created = true } catch (e) { if (e?.code !== "EEXIST") return null }
    if (created) await chmod(root, 0o700).catch(() => {})
  }
  const lst = await lstat(root).catch(() => null)
  if (!lst || !lst.isDirectory() || (me !== undefined && lst.uid !== me) || (lst.mode & 0o077) !== 0) return null
  const rw = await trustedPath(root)
  if (!rw.ok || rw.missing || !rw.st.isDirectory() || rw.real !== root) return null
  return root
}

async function verifyPublished(file, exe, me) {
  let fh
  try {
    fh = await open(file, OPEN_REGULAR)
    const st = await fh.stat()
    if (!st.isFile() || st.size !== exe.size) return false
    if (me !== undefined && st.uid !== me) return false
    if ((st.mode & 0o077) !== 0 || (st.mode & 0o100) === 0) return false
    try { await access(file, constants.X_OK) } catch { return false }
    return (await digestOf(fh)) === exe.sha256
  } catch {
    return false
  } finally {
    await fh?.close().catch(() => {})
  }
}

async function publishUnderRoot(root, exe, me) {
  const ver = path.basename(path.dirname(exe.path))
  let cur = root
  for (const seg of [exe.sha256, "opclauded", ver]) {
    cur = subPath(cur, seg)
    let created = false
    try { await mkdir(cur, { mode: 0o700 }); created = true } catch (e) { if (e?.code !== "EEXIST") return { status: "unusable" } }
    if (created) await chmod(cur, 0o700).catch(() => {})
    const lst = await lstat(cur).catch(() => null)
    if (!lst || !lst.isDirectory() || (me !== undefined && lst.uid !== me) || (lst.mode & 0o077) !== 0) return { status: "unusable" }
  }
  const dw = await trustedPath(cur)
  if (!dw.ok || dw.missing || !dw.st.isDirectory() || dw.real !== cur) return { status: "unusable" }

  const file = subPath(cur, "opclauded")
  if (await verifyPublished(file, exe, me)) return { status: "ok", file }

  let stagingDir = ""
  let temp = ""
  let out = null
  const lockDir = subPath(cur, ".publish-lock")
  const withLock = async (fn) => {
    for (let i = 0; i < 100; i++) {
      try {
        await mkdir(lockDir, { mode: 0o700 })
        try { return await fn() } finally { await rmdir(lockDir).catch(() => {}) }
      } catch (e) {
        if (e?.code !== "EEXIST") return { status: "unusable" }
        const st = await lstat(lockDir).catch(() => null)
        if (st && Date.now() - st.mtimeMs > 10000) await rmdir(lockDir).catch(() => {})
        await Bun.sleep(50)
      }
    }
    return { status: "unusable" }
  }
  try {
    stagingDir = await mkdtemp(subPath(cur, ".staging-"))
    temp = subPath(stagingDir, "opclauded")
    out = await open(temp, "wx+", 0o700)
    await out.chmod(0o700)
    const chunk = Buffer.alloc(256 * 1024)
    for (let pos = 0; ; ) {
      const { bytesRead } = await exe.read(chunk, pos)
      if (bytesRead === 0) break
      let written = 0
      while (written < bytesRead) written += (await out.write(chunk, written, bytesRead - written, pos + written)).bytesWritten
      pos += bytesRead
    }
    if ((await out.stat()).size !== exe.size || (await digestOf(out)) !== exe.sha256) return { status: "unusable" }
    await out.close()
    out = null
    // 在所在文件系统实际核验可执行（noexec 挂载会返回 EACCES，立刻转下一候选位置）。
    try { await access(temp, constants.X_OK) } catch { return { status: "noexec" } }
    // 原子无覆盖发布：只有一个并发者能创建最终文件，其余竞争者核验现有成品并直接复用，绝不覆盖在跑进程。
    try {
      await link(temp, file)
      return { status: "ok", file }
    } catch (e) {
      if (e?.code === "EEXIST") {
        if (await verifyPublished(file, exe, me)) return { status: "ok", file }
        return await withLock(async () => {
          if (await verifyPublished(file, exe, me)) return { status: "ok", file }
          const lst = await lstat(file).catch(() => null)
          if (lst?.isDirectory()) await rm(file, { recursive: true, force: true }).catch(() => {})
          else if (lst) await unlink(file).catch(() => {})
          try { await link(temp, file) } catch (le) {
            if (le?.code === "EEXIST" && (await verifyPublished(file, exe, me))) return { status: "ok", file }
            if (le?.code === "EPERM" || le?.code === "ENOTSUP") await rename(temp, file)
            else return { status: "unusable" }
          }
          return { status: "ok", file }
        })
      }
      if (e?.code === "EPERM" || e?.code === "ENOTSUP") {
        return await withLock(async () => {
          if (await verifyPublished(file, exe, me)) return { status: "ok", file }
          await rename(temp, file)
          return { status: "ok", file }
        })
      }
      return { status: "unusable" }
    }
  } catch {
    return { status: "unusable" }
  } finally {
    await out?.close().catch(() => {})
    if (temp) await unlink(temp).catch(() => {})
    if (stagingDir) await rmdir(stagingDir).catch(() => {})
  }
}

// 已核对程序的执行副本。安装里的那个路径在核对之后可能被升级或修复换掉，而 macOS 没有按描述符执行的办法，
// 所以把核对过的字节从同一个描述符复制到该用户已验可信、可执行的稳定私有目录，按内容寻址：
//   <稳定私有根>/<sha256>/opclauded/<版本>/opclauded   （与安装里同样的层级和文件名，程序按相对位置找自己时形状不变）
// 首选放在已确认物理安装目录 <opusHome>/.plugin-bin-<uid>（与安装程序同一可执行文件系统，不依赖 TMPDIR），
// 不可写或不可执行时依次尝试受信任的 ~/.cache 与按用户命名的受信任临时目录。绝不以未核对的安装路径兜底。
async function materializeBinary(exe) {
  const me = uid()
  const tag = me === undefined ? "user" : String(me)
  const leaf = `.plugin-bin-${tag}`
  const tmpLeaf = `opclaude-plugin-bin-${tag}`
  const tryBase = async (base, parentSegs, name) => {
    if (!base || typeof base !== "string" || !path.isAbsolute(base)) return null
    const root = await ensurePrivateDir(base, parentSegs, name, me)
    if (!root) return null
    const res = await publishUnderRoot(root, exe, me)
    return res.status === "ok" ? res.file : res.status === "noexec" ? "noexec" : null
  }
  const tryTmpBase = async (base) => {
    if (!base || typeof base !== "string" || !path.isAbsolute(base)) return null
    const tw = await trustedPath(base)
    if (!tw.ok || tw.missing || !tw.st.isDirectory()) return null
    const direct = await tryBase(tw.real, [], tmpLeaf)
    if (direct === "noexec") return null
    if (direct) return direct
    // 固定按用户命名的位置被占用或权限异常时：改用按用户+安装确定的可信回退目录名，原子 mkdir 收敛到同一个目录，
    // 并发调用不依赖扫描+mkdtemp 竞争，也不会在同一指纹下堆叠多份副本。
    const installTag = createHash("sha256").update(exe.opusHome || exe.path).digest("hex").slice(0, 12)
    const fallbackNames = [`${tmpLeaf}-${installTag}`]
    for (let i = 1; i <= 16; i++) fallbackNames.push(`${tmpLeaf}-${installTag}-${i}`)
    for (const name of fallbackNames) {
      const fb = await tryBase(tw.real, [], name)
      if (fb === "noexec") return null
      if (fb) return fb
    }
    return null
  }

  // 1. 优先放在已核对的物理安装目录下（同文件系统，完全不依赖 TMPDIR 的执行权限）
  if (exe.opusHome) {
    const r = await tryBase(exe.opusHome, [], leaf)
    if (r && r !== "noexec") return r
    // 安装目录本身不可写/noexec、而 opclauded 位于独立可执行挂载点时尝试 opclauded 父目录
    const binBase = path.dirname(path.dirname(exe.path))
    const hst = await stat(exe.opusHome).catch(() => null)
    if (hst && exe.dev !== undefined && hst.dev !== exe.dev) {
      const br = await tryBase(binBase, [], leaf)
      if (br && br !== "noexec") return br
    }
  }
  // 2. 用户主目录受信任缓存目录
  if (exe.userHome) {
    const ur = await tryBase(exe.userHome, [".cache"], tmpLeaf)
    if (ur && ur !== "noexec") return ur
  }
  // 3. 临时目录（先校验物理祖先受信任，绝不在不可信父目录下创建）
  const tmps = []
  for (const t of [exe.tmpRoot, tmpdir()]) {
    if (t && typeof t === "string" && path.isAbsolute(t) && !tmps.includes(t)) tmps.push(t)
  }
  for (const t of tmps) {
    const tr = await tryTmpBase(t)
    if (tr) return tr
  }
  throw new SafeError("binary_unreadable")
}

// 这一处的启动器不能用（坏了、不受信任、与安装对不上）时，接着看下一处安装位置。
const SKIP = new Set(["launcher_invalid", "launcher_untrusted", "host_path_untrusted"])

// 安装器写入启动器的位置，顺序固定：用户的 ~/.local/bin，然后 /usr/local/bin。
export const launcherDirs = (userHome) => [subPath(userHome, ".local", "bin", "opclaude"), "/usr/local/bin/opclaude"]

// 返回第一份属于这次选定安装（home，默认取宿主环境）的启动器。每一份依次过这几道关：
//   1. 所在目录别的用户换不了；2. 内容读得出、格式合法，文件本身别的用户改不了；
//   3. 与安装绑定（安装目录路径、config、摘要）；4. 它选定的 opclauded 在这个安装里、路径与程序都受信任、指纹相符；
//   5. 没有启用本机代理时报 proxy_disabled。
// 第 1–3 道不过时这份启动器不属于当前安装（损坏、被改动、或升级后过期的旧副本），接着看下一处；
// 第 4、5 道说明启动器就是当前安装的那一份，它指出的问题原样报出。
// dirs 只供测试替换（避免碰到运行测试的机器上的真实安装）。verifyBin=false 只用于旧的显式路径
// （那一路执行的是用户给出的 opclauded，启动器只用来读宿主机版本）。
export async function findLauncher(env, { dirs, home, verifyBin = true } = {}) {
  const userHome = env?.HOME
  if (typeof userHome !== "string" || !path.isAbsolute(userHome) || userHome.includes("\0")) throw new SafeError("home_invalid")
  const opusHome = home === undefined ? hostHome(env) : home
  let first
  let installed = false
  for (const file of dirs ?? launcherDirs(userHome)) {
    const slash = file.lastIndexOf(path.sep)
    const dirPath = slash <= 0 ? path.sep : file.slice(0, slash)
    const baseName = file.slice(slash + 1)
    // 启动器所在的目录（按它原本的写法逐级核对）：别的用户能在这里换掉启动器，这一处就不用。
    const dir = await trustedPath(dirPath)
    if (!dir.ok) {
      installed = true
      first ??= new SafeError("host_path_untrusted")
      continue
    }
    if (dir.missing) continue
    if (!dir.st.isDirectory()) {
      installed = true
      first ??= new SafeError("launcher_invalid")
      continue
    }
    let found
    try { found = await readLauncher(subPath(dir.real, baseName), dir.prot) } catch (e) {
      if (!SKIP.has(e?.code)) throw e
      installed = true
      first ??= e
      continue
    }
    if (!found) continue
    installed = true
    let homeReal
    try { homeReal = await trustLauncher(found, opusHome) } catch (e) {
      if (!SKIP.has(e?.code)) throw e
      first ??= e
      continue
    }
    if (verifyBin && found.bin) found = await bindBinary(found, homeReal, { userHome, tmpRoot: env?.TMPDIR })
    // “没有启用本机代理”是这台机器当前的安装状态：启动器已确认属于当前安装，不拿另一份顶替。
    if (found.bin === "") throw new SafeError("proxy_disabled")
    return { ...found, opusHome: homeReal }
  }
  throw installed ? first : new SafeError("launcher_not_found")
}

// 自动发现的完整结果：启动器、它选定的 opclauded（当前安装之内的那一份）、指纹，以及已打开待执行的那个程序。
export async function discoverHost(env, { dirs } = {}) {
  return await findLauncher(env, { dirs })
}

// 官方启动器钉死的系统固定 Claude 位置（测试可通过 systemClaudes 注入沙箱路径，生产环境默认即此两处）。
export const SYSTEM_CLAUDES = ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"]

// 官方启动器钉死的 Claude Code 版本（没有这一行时官方按 none 处理）。
export function launcherPin(text) {
  const m = /^CLAUDE_PIN="([^"\x00-\x1f\x7f]*)"$/m.exec(text)
  return m ? m[1] : ""
}

let cachedDefaultPath
// 宿主进程完全未设置 PATH 时，从最小环境的真实 /bin/sh 读出它的默认搜索路径。
// 显式设置为 "" 时走空搜索路径，不混为缺省。
async function defaultShellPath(signal) {
  if (cachedDefaultPath !== undefined) return cachedDefaultPath
  const { code, out } = await capture({
    bin: "/bin/sh",
    args: ["-c", 'printf \'%s\' "${PATH:-}"'],
    env: {},
    cwd: "/",
    timeoutMs: 5000,
    signal,
    codes: { failed: "version_failed", timeout: "version_timeout", aborted: "version_aborted", overflow: "version_output_invalid" },
  })
  if (code !== 0) throw new SafeError("version_failed")
  cachedDefaultPath = out
  return out
}

// 版本探测用的最小环境。PATH 不重排：官方启动器自己把 ~/.local/bin 放到最前，之后是宿主 PATH 里受信任的
// 绝对路径项（保持原有先后）。空项、相对项、不受信任的目录、Magpie 的当前项目目录都用不上。
// 缺省 PATH 按实际 /bin/sh 默认搜索路径走同一套信任检查，显式设为空串时不补默认路径。
async function versionEnvironment(source, pin = "", signal, systemClaudes = SYSTEM_CLAUDES) {
  const env = {}
  for (const k of ["HOME", "LANG", "LC_ALL", "TMPDIR"]) {
    if (source[k]) env[k] = source[k]
  }
  const home = env.HOME
  if (typeof home !== "string" || !path.isAbsolute(home) || home.includes("\0")) throw new SafeError("home_invalid")
  const untrusted = () => new SafeError("host_path_untrusted")
  const homeWalk = await trustedPath(home)
  if (!homeWalk.ok) throw untrusted()
  const homeReal = !homeWalk.missing && homeWalk.st.isDirectory() ? homeWalk.real : home
  const localBin = subPath(home, ".local", "bin")
  // 官方启动器无条件把 ~/.local/bin 放到 PATH 最前：这个目录本身必须受信任，有没有 claude 都一样。
  const local = await trustedPath(localBin)
  if (!local.ok) throw untrusted()
  const localReal = !local.missing && local.st.isDirectory() ? local.real : ""

  // 宿主进程的当前目录（项目目录）及其子目录不进 PATH：仓库里的文件带着可执行位，克隆下来就能被当成 claude 或系统工具运行。
  // 当前目录就是 HOME 或 HOME 的上级（比如从 HOME 启动、或守护进程的 /）时不排除：那样会把 ~ 下的安装目录一并排除。
  const forms = async (p) => {
    const clean = stripSlashes(p)
    const out = new Set([clean])
    try { out.add(await realpath(p)) } catch {}
    return out
  }
  const homeForms = await forms(home)
  const projects = new Set()
  for (const p of [source.PWD, process.cwd()]) {
    if (typeof p !== "string" || !path.isAbsolute(p)) continue
    for (const form of await forms(p)) {
      if (![...homeForms].some((h) => h === form || h.startsWith(form + path.sep))) projects.add(form)
    }
  }
  const inProject = async (dir) => {
    if (!projects.size) return false
    for (const c of await forms(dir)) if ([...projects].some((p) => c === p || c.startsWith(p + path.sep))) return true
    return false
  }

  const rawPath = source.PATH === undefined ? await defaultShellPath(signal) : String(source.PATH)
  const dirs = []
  const dirPaths = []
  for (const raw of rawPath.split(":")) {
    if (!path.isAbsolute(raw) || dirs.includes(raw) || (await inProject(raw))) continue
    const w = await trustedPath(raw)
    if (!w.ok || w.missing || !w.st.isDirectory()) continue
    dirs.push(raw)
    dirPaths.push(w.real)
  }
  // PATH 交给启动器：宿主 PATH（或缺省时的 /bin/sh 默认 PATH）里受信任的绝对路径项，保持原有先后。
  // 启动器自己把 ~/.local/bin 放到最前，这里不重复带。工具和 claude 查找基于确认物理目录，避免 path.join 提前折叠 ".."。
  env.PATH = dirs.join(":")
  const afterPrepend = localReal ? [localReal, ...dirPaths] : dirPaths
  // 与 shell 的判断一致：对本进程可执行，并且是普通文件或符号链接（失效的链接在这里就被跳过）。
  const runnable = async (file) => {
    try { await access(file, constants.X_OK) } catch { return false }
    try { if ((await stat(file)).isFile()) return true } catch {}
    try { return (await lstat(file)).isSymbolicLink() } catch { return false }
  }
  const firstHit = async (name, search) => {
    for (const d of search) {
      const file = subPath(d, name)
      if (await runnable(file)) return file
    }
    return ""
  }
  const verify = async (file) => {
    const w = await trustedPath(file)
    if (!w.ok || w.missing || !w.st.isFile() || !(await entryNotReplaceable(w.st, w.prot))) throw untrusted()
  }
  // 辅助工具按启动器实际的两段 PATH 核对，每段都是那一段 PATH 上第一个命中的文件。
  for (const [tools, search] of [[TOOLS_BEFORE_PREPEND, dirPaths], [TOOLS_AFTER_PREPEND, afterPrepend]]) {
    for (const tool of tools) {
      const file = await firstHit(tool, search)
      if (file) await verify(file)
    }
  }
  // 官方启动器按固定顺序挑第一份可执行的 claude：先四个固定位置，再 PATH 上第一个 claude（含它自己前置的 ~/.local/bin），
  // 再 versions/<钉死版本>、~/.npm-global/bin、npm 所在目录（npm 只定位、不运行）。
  const npm = await firstHit("npm", afterPrepend)
  const fixed = Array.isArray(systemClaudes) ? systemClaudes : SYSTEM_CLAUDES
  const candidates = [
    localReal ? subPath(localReal, "claude") : "",
    subPath(homeReal, ".claude", "local", "claude"),
    ...fixed,
    await firstHit("claude", afterPrepend),
    subPath(homeReal, ".local", "share", "claude", "versions", pin || "none"),
    subPath(homeReal, ".npm-global", "bin", "claude"),
    npm ? subPath(path.dirname(npm), "claude") : "",
  ]
  const seen = new Set()
  for (const file of candidates) {
    if (!file || file.includes("/Claude.app/") || seen.has(file)) continue
    seen.add(file)
    // 只有官方实际会执行的第一个候选要核对。
    if (await runnable(file)) {
      await verify(file)
      break
    }
  }
  return env
}

// 只执行启动器的 version 子命令（不联网、不读密钥、不启动 Claude Code）。
// 执行的是 script：已经与安装绑定过的那份启动器字节，不再打开原路径。
// 启动器正文直接经 stdin 交给绝对 /bin/sh -s -- version，完全不依赖 TMPDIR 落盘临时文件或描述符。
// script 省略时从 launcher 路径读一份（只供测试与诊断：这一份没有做过绑定）。
export async function readHostVersion({ script, launcher, opusHome = "", timeoutMs = 10000, signal, source = process.env, systemClaudes } = {}) {
  if (signal?.aborted) throw signal.reason
  let bytes = script
  if (!bytes && launcher) bytes = (await readLauncher(launcher))?.bytes
  if (!bytes) throw new SafeError("launcher_invalid")
  const env = await versionEnvironment(source, launcherPin(bytes.toString("utf8")), signal, systemClaudes)
  // 自定义 home 交给启动器：从确认的物理目录启动，避免软链/..。
  if (opusHome) env.OPUSCLAUDE_HOME = stripSlashes(opusHome)
  // 工作目录是根目录；启动器的 version 分支在它的自校验之前就退出，不依赖 $0 的路径，也不走命令行参数。
  const { code, out } = await capture({
    bin: "/bin/sh",
    args: ["-s", "--", "version"],
    stdin: bytes,
    env,
    cwd: "/",
    timeoutMs,
    signal,
    codes: { failed: "version_failed", timeout: "version_timeout", aborted: "version_aborted", overflow: "version_output_invalid" },
  })
  if (code !== 0) throw new SafeError("version_failed", `（exit ${typeof code === "number" ? code : "signal"}）`)
  return parseVersionOutput(out)
}
