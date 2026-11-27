// 按 Magpie 的方式从目录加载本包，检查入口形状与各钩子。请求只发到测试台自己起的回环 mock 代理。
// 用法（需要 Bun >= 1.4.3）："$MAGPIE_BUN" scripts/check.mjs [包目录]
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
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

// 整个检查在隔离的进程环境里做：HOME 指向一个空目录，不带 OPUSCLAUDE_HOME，
// 不会去看运行检查的用户自己机器上的 opclaude 安装，也不读任何真实配置。
const realHome = process.env.HOME
const emptyHome = await mkdtemp(path.join(tmpdir(), "opclaude-check-empty-"))
const { createPlugin } = await import(pathToFileURL(path.join(dir, "lib/plugin.mjs")).href)
const { makeRig } = await import(pathToFileURL(new URL("../test/rig.mjs", import.meta.url).pathname).href)
try {
  process.env.HOME = emptyHome
  delete process.env.OPUSCLAUDE_HOME

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
  const isRefusal = async (res, code) => res.status === 400 && (await res.text()).includes(`[opclaude:${code}]`)

  if (pkg.name !== "opclaude-plugin") fail(`package.json name 应为 opclaude-plugin，实际 ${pkg.name}`)
  else ok(`包名 ${pkg.name}@${pkg.version}，入口 ${pkg.main}`)
  if (found.length !== 1) fail(`应当只导出一个插件函数，实际 ${found.length} 个：${found.map((f) => f[0]).join(", ")}`)
  const [label, fn] = found[0] ?? []
  if (typeof fn !== "function") process.exit(1)
  // Magpie 以 server(input, options) 调用：选项在第二参数。
  const hooks = await fn({ client: {} }, undefined)
  ok(`作为插件加载：${label} -> hooks ${Object.keys(hooks).join(", ")}`)

  if (hooks.auth?.provider !== "opclaude") fail("auth.provider 应为 opclaude")
  else ok("auth.provider = opclaude")
  if (hooks.provider?.id !== "opclaude") fail("provider.id 应为 opclaude")
  if (typeof hooks.auth?.loader !== "function") fail("缺少 auth.loader")
  if (typeof hooks.auth?.usage !== "function") fail("缺少 auth.usage")
  if (typeof hooks.provider?.models !== "function") fail("缺少 provider.models")
  const method = hooks.auth?.methods?.[0]
  if (!method) fail("缺少登录方式")
  else if (method.prompts.length !== 0) fail(`登录不应询问任何 OpusClaude 信息，实际询问 ${method.prompts.length} 项`)
  else ok(`登录方式 ${hooks.auth.methods.length} 个：${method.type}，不询问路径 / 密钥 / 版本（提示 0 项）`)

  const cfg = {}
  await hooks.config(cfg)
  const p = cfg.provider?.opclaude
  if (p?.npm !== "@ai-sdk/anthropic") fail("config 应声明 npm @ai-sdk/anthropic（原生 Anthropic 协议）")
  else ok(`config 声明 provider opclaude：npm ${p.npm}，api ${p.api}`)

  const l = await hooks.auth.loader(async () => undefined)
  if (l.baseURL !== p.api || typeof l.fetch !== "function") fail("loader 应返回占位 baseURL 与 fetch")
  else ok(`loader 返回 baseURL ${l.baseURL} 与 fetch`)

  // 没有安装：失败应当是可交付的 Anthropic 错误，状态码 + 固定错误码。
  // 这里用注入的空查找位置：入口函数默认还会去看 /usr/local/bin/opclaude，那是运行检查的机器上真实的安装。
  const post = (extra = {}) => ({ method: "POST", headers: { "content-type": "application/json", "user-agent": "claude-cli/0.0.1 (external, cli)", "x-app": "caller" }, body: JSON.stringify({ model: "claude-fable-5-2", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }), ...extra })
  const bare = await createPlugin({}, { launcherDirs: [] }).auth.loader(async () => undefined)
  if (await isRefusal(await bare.fetch(p.api + "/messages", post()), "launcher_not_found")) ok("没有安装时返回 400 Anthropic 错误：launcher_not_found")
  else fail("没有安装时应返回 400 与 launcher_not_found")

  // 模拟安装：默认流程不需要任何选项或登录输入。
  const rig = await makeRig()
  try {
    const loaded = createPlugin(undefined, { env: rig.env, launcherDirs: rig.dirs, systemClaudes: rig.claudes })
    if (loaded.auth.methods[0].prompts.length !== 0) fail("登录不应有提示项")
    const signedIn = await loaded.auth.methods[0].authorize(undefined)
    if (signedIn.type === "success" && Object.keys(signedIn.metadata).length === 0) ok(`登录不询问、不保存路径：key=${signedIn.key}，metadata={}`)
    else fail(`登录应当成功且不保存元数据，实际 ${JSON.stringify(signedIn)}`)
    const fetch = (await loaded.auth.loader(async () => signedIn)).fetch
    const res = await fetch(p.api + "/messages", post())
    const ua = rig.seen.proxy.at(-1)?.ua
    if (res.status === 200 && ua === "claude-cli/2.1.284 (external, cli)" && rig.seen.proxy.at(-1)?.app === "cli") ok("请求经本机代理：入站 UA / x-app 被换成宿主机版本 claude-cli/2.1.284 (external, cli) 与 cli")
    else fail(`经模拟安装的请求应成功并带宿主机版本头，实际 ${res.status} ua=${ua}`)

    // 旧的显式配置：成对时照旧；只给一半时拒绝，不与自动发现的结果拼在一起。
    const half = await createPlugin({}, { env: rig.env, launcherDirs: rig.dirs, systemClaudes: rig.claudes }).auth.methods[0].authorize({ opclauded: rig.bin })
    if (half.type === "failed" && String(half.error).includes("[opclaude:legacy_incomplete")) ok("半缺的旧设置被拒绝：legacy_incomplete")
    else fail(`只给 opclauded 时应返回 legacy_incomplete，实际 ${JSON.stringify(half)}`)
    // 成对时照旧按显式路径执行（不换成启动器选定的程序），启动器须属于显式给出的那个安装；程序不在就照实报 binary_missing。
    const legacyFetch = await createPlugin({ opclauded: rig.bin, opusHome: rig.opusHome }, { env: rig.env, launcherDirs: rig.dirs, systemClaudes: rig.claudes }).auth.loader(async () => ({ type: "api", key: signedIn.key }))
    const legacyRes = await legacyFetch.fetch(p.api + "/messages", post())
    if (legacyRes.status === 200 && rig.seen.proxy.at(-1)?.ua === ua) ok("成对的旧设置照旧按显式路径执行，同样带宿主机版本头")
    else fail(`成对的旧设置应按显式路径执行，实际 ${legacyRes.status}`)
    const gone = await createPlugin({ opclauded: path.join(rig.opusHome, "opclauded", "0.0.1-missing", "opclauded"), opusHome: rig.opusHome }, { env: rig.env, launcherDirs: rig.dirs, systemClaudes: rig.claudes }).auth.methods[0].authorize(undefined)
    if (gone.type === "failed" && String(gone.error).includes("[opclaude:binary_missing]")) ok("显式路径的程序不在：binary_missing")
    else fail(`显式路径的程序不在时应返回 binary_missing，实际 ${JSON.stringify(gone)}`)
    // 三个出站路径（请求、count_tokens、GET /v1/models）带同一套宿主机标识。
    const countTokens = await fetch(p.api + "/messages/count_tokens", { ...post(), body: JSON.stringify({ model: "claude-sonnet-5-5", messages: [{ role: "user", content: "hi" }] }) })
    const catalog = await createPlugin(undefined, { env: rig.env, launcherDirs: rig.dirs, systemClaudes: rig.claudes }).provider.models({ models: {} }, { auth: { type: "api", key: signedIn.key } })
    const tail = rig.seen.proxy.slice(-2)
    if (countTokens.status === 200 && Object.keys(catalog).length > 0 && tail.every((r) => r.ua === ua && r.app === "cli" && r.authed) && tail.at(-1).path === "/v1/models") ok("count_tokens 与 GET /v1/models 也带宿主机版本头与 cli")
    else fail(`count_tokens / 模型发现应带宿主机版本头，实际 ${JSON.stringify(tail)}`)

    // 周额度（auth.usage）：来自模拟 opclauded account 的只读 JSON，窗口只用于展示（aside）。
    const usageOf = (p) => p.auth.usage(async () => ({ type: "api", key: signedIn.key }))
    const quota = await usageOf(loaded)
    if (JSON.stringify(quota) === JSON.stringify({ plan: "Pro 周卡", windows: [{ name: "本周额度", used: 42.5, aside: true }] })) ok("auth.usage：套餐 Pro 周卡，本周额度已用 42.5（aside，不参与路由）")
    else fail(`auth.usage 应给出套餐与周已用，实际 ${JSON.stringify(quota)}`)
    rig.st.account = '{"ok":true,"plan_name":"Max","weekly_unlimited":true}'
    await rig.sync()
    const unlimited = await usageOf(loaded)
    if (unlimited.windows?.[0]?.display === "本周额度不限" && unlimited.windows[0].aside === true && unlimited.windows[0].used === undefined) ok("auth.usage：不限套餐用 display 明示，没有百分比")
    else fail(`不限套餐应显示本周额度不限，实际 ${JSON.stringify(unlimited)}`)
    rig.st.account = '{"ok":true,"plan_name":"Zero","weekly_pct":"0"}'
    await rig.sync()
    const zero = await usageOf(loaded)
    if (zero.windows?.[0]?.used === 0) ok("auth.usage：零用量有效（数字字符串 0）")
    else fail(`零用量应显示 used 0，实际 ${JSON.stringify(zero)}`)
    rig.st.account = "fail"
    await rig.sync()
    const broken = await usageOf(loaded)
    if (broken.error?.includes("套餐状态查询失败") && broken.signIn === "kept" && broken.windows.length === 0 && !JSON.stringify(broken).includes(rig.state)) ok("auth.usage：查询失败时返回固定文案，signIn 保持 kept")
    else fail(`查询失败应返回固定文案，实际 ${JSON.stringify(broken)}`)
    rig.st.account = '{"ok":true,"plan_name":"Pro 周卡","weekly_pct":42.5}'
    await rig.sync()
    const legacyUsage = await createPlugin({ opclauded: rig.bin, opusHome: rig.opusHome }, { env: rig.env, launcherDirs: rig.dirs, systemClaudes: rig.claudes }).auth.usage(async () => undefined)
    if (legacyUsage.windows?.[0]?.used === 42.5 && (await Bun.file(path.join(rig.state, "account-bin")).text()).trim() === rig.bin) ok("auth.usage：旧的显式配置按显式路径查询")
    else fail(`旧的显式配置应按显式路径查询，实际 ${JSON.stringify(legacyUsage)}`)
    const off = await createPlugin({}, { env: { ...rig.env, OPUSCLAUDE_PROXY: "0" }, launcherDirs: rig.dirs, systemClaudes: rig.claudes }).auth.usage(async () => signedIn)
    if (off.error?.includes("本机代理未启用") && off.signIn === "kept") ok("auth.usage：代理禁用时返回 proxy_disabled 的固定文案")
    else fail(`代理禁用时应返回固定文案，实际 ${JSON.stringify(off)}`)
  } finally {
    await rig.close()
  }
} finally {
  process.env.HOME = realHome
  await rm(emptyHome, { recursive: true, force: true })
}
console.log(process.exitCode ? "检查未通过" : "全部通过")
