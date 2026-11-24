// 按 Magpie 的方式从目录加载本包，检查入口形状与各钩子（不发任何网络请求）。
// 用法（需要 Bun >= 1.4.3）："$MAGPIE_BUN" scripts/check.mjs [包目录]
import path from "node:path"
import { pathToFileURL } from "node:url"

const dir = path.resolve(process.argv[2] ?? new URL("..", import.meta.url).pathname)
const pkg = JSON.parse(await Bun.file(path.join(dir, "package.json")).text())
// 插件要求 Bun >= 1.4.3，旧版本下直接说明，不继续检查。
const { MIN_BUN, bunSupportsProxyFalse } = await import(pathToFileURL(path.join(dir, "lib/transport.mjs")).href)
if (!bunSupportsProxyFalse()) {
  console.error(`需要 Bun >= ${MIN_BUN}，当前 ${Bun.version}。请用兼容的 Bun 运行，例如 "$MAGPIE_BUN" scripts/check.mjs`)
  process.exit(2)
}

const entry = await import(pathToFileURL(path.join(dir, pkg.main)).href)

// 与 Magpie 宿主一致：default.server，或导出的函数，或带 server 的对象。
const found = []
if (entry.default && typeof entry.default.server === "function") found.push(["default.server", entry.default.server])
for (const [name, v] of Object.entries(entry)) {
  if (name === "default") continue // 上面已按 default.server 处理
  if (typeof v === "function") found.push([name, v])
  else if (v && typeof v === "object" && typeof v.server === "function") found.push([name, v.server])
}

const fail = (m) => { console.error("✗ " + m); process.exitCode = 1 }
const ok = (m) => console.log("✓ " + m)

if (pkg.name !== "opclaude-plugin") fail(`package.json name 应为 opclaude-plugin，实际 ${pkg.name}`)
else ok(`包名 ${pkg.name}@${pkg.version}，入口 ${pkg.main}`)
if (found.length !== 1) fail(`应当只导出一个插件函数，实际 ${found.length} 个：${found.map((f) => f[0])}`)
const [label, fn] = found[0] ?? []
if (typeof fn !== "function") process.exit(1)
// Magpie 以 server(input, options) 调用：选项在第二参数。
const hooks = await fn({ client: {} }, undefined)
ok(`作为插件加载：${label} -> hooks ${Object.keys(hooks).join(", ")}`)

if (hooks.auth?.provider !== "opclaude") fail("auth.provider 应为 opclaude")
else ok("auth.provider = opclaude")
if (hooks.provider?.id !== "opclaude") fail("provider.id 应为 opclaude")
if (typeof hooks.auth?.loader !== "function") fail("缺少 auth.loader")
if (typeof hooks.provider?.models !== "function") fail("缺少 provider.models")
const method = hooks.auth?.methods?.[0]
if (!method) fail("缺少登录方式")
else ok(`登录方式 ${hooks.auth.methods.length} 个：${method.type}，未配置路径时询问 ${method.prompts.length} 项`)

const cfg = {}
await hooks.config(cfg)
const p = cfg.provider?.opclaude
if (p?.npm !== "@ai-sdk/anthropic") fail("config 应声明 npm @ai-sdk/anthropic（原生 Anthropic Messages）")
else ok(`config 声明 provider opclaude：npm ${p.npm}，api ${p.api}`)

const l = await hooks.auth.loader(async () => undefined)
if (l.baseURL !== p.api || typeof l.fetch !== "function") fail("loader 应返回占位 baseURL 与 fetch")
else ok(`loader 返回 baseURL ${l.baseURL} 与 fetch`)

// 未配置时的失败应当是可交付的 Anthropic 错误：状态码 + 固定错误码，不含任何敏感内容。
const res = await l.fetch(p.api + "/messages", { method: "POST", headers: {}, body: "{}" })
const body = await res.text()
if (res.status !== 400 || !body.includes("[opclaude:not_configured]")) fail(`未配置时应返回 400 与 not_configured，实际 ${res.status} ${body.slice(0, 120)}`)
else ok("未配置时返回 400 Anthropic 错误：not_configured")

// 选项写在第二参数时，登录不再询问路径。
const tmp = await makeTmp()
const configured = await fn({ client: {} }, { opclauded: path.join(tmp, "missing"), opusHome: tmp })
if (configured.auth.methods[0].prompts.length !== 0) fail("已配置路径时登录不应再询问")
else ok("选项已给出路径时，登录不再询问（提示 0 项）")
const refused = await configured.auth.methods[0].authorize(undefined)
if (refused.type !== "failed" || !String(refused.error).includes("opclauded")) fail("登录应真实校验并给出失败原因")
else ok(`登录校验生效：${refused.error}`)

async function makeTmp() {
  const d = await Bun.$`mktemp -d`.text()
  return d.trim()
}
console.log(process.exitCode ? "检查未通过" : "全部通过")
