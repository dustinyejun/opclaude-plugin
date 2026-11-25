// opclaude provider：Magpie / OpenCode v1 插件钩子。
import { SafeError } from "./errors.mjs"
import { discoverHost, findLauncher, readHostVersion } from "./host.mjs"
import path from "node:path"
import { runLaunch, validateSettings } from "./launch.mjs"
import { PLACEHOLDER_BASE, assertDirectFetch, effectiveRequest, errorResponse, forward, listModels } from "./transport.mjs"
export const PROVIDER = "opclaude"
// 登录只是一个本地标记：保存到 Magpie 的 key 是这个常量，不是任何真实票据。
export const LOCAL_MARKER = "opclaude-local-proxy"
// 旧的显式配置：两个路径必须成对出现。
const LEGACY_KEYS = ["opclauded", "opusHome"]

const given = (v) => typeof v === "string" && v.trim() !== ""

// 配置来源的优先级：
//   1. 登录时填写的元数据里的 opclauded / opusHome（已部署用户的旧数据）
//   2. 插件选项里的 opclauded / opusHome（旧数据）
//   3. 两者都没有：自动发现官方 opclaude 启动器（默认）
// 显式路径成对出现时只按显式值执行，不与启动器选定的程序或指纹混用；只给一半、或在自动发现时
// 给 opclaudedSha256，都算配置不完整并拒绝。
// 代理状态目录（OPCLAUDE_PROXY_HOME）的优先级：旧的显式插件选项 proxyHome > 宿主环境的 OPCLAUDE_PROXY_HOME >
// 不传（opclauded 用它自己的默认值）。只把校验过的绝对路径交给 launch 子进程。
// 设置来源只有这几处：插件 options（plugins.json）、登录时留下的元数据、宿主进程环境里的两个官方变量。请求方给不了。
export function resolvePlan(options, auth, env = process.env) {
  const opts = options && typeof options === "object" ? options : {}
  const meta = auth?.metadata && typeof auth?.metadata === "object" ? auth.metadata : {}
  if ([opts.proxyHome, opts.opclaudedSha256].some((v) => v !== undefined && v !== "" && typeof v !== "string")) throw new SafeError("option_invalid")
  const hostProxyHome = env?.OPCLAUDE_PROXY_HOME
  const proxyHome = given(opts.proxyHome) ? opts.proxyHome : hostProxyHome === undefined || hostProxyHome === "" ? undefined : hostProxyHome
  // 来自宿主环境的值不归 Magpie 的选项校验管，格式不对时在这里拒绝，不原样交给 opclauded。
  if (proxyHome !== undefined && !given(opts.proxyHome) && (typeof proxyHome !== "string" || !path.isAbsolute(proxyHome) || proxyHome.includes("\0"))) throw new SafeError("proxy_home_invalid")
  const merged = { proxyHome, opclaudedSha256: opts.opclaudedSha256 }
  for (const k of LEGACY_KEYS) {
    const v = given(meta[k]) ? meta[k] : opts[k]
    if (v !== undefined && v !== "" && typeof v !== "string") throw new SafeError("option_invalid")
    merged[k] = v
  }
  const bin = given(merged.opclauded)
  const home = given(merged.opusHome)
  if (bin !== home || given(merged.opclaudedSha256) && !bin) throw new SafeError("legacy_incomplete")
  if (bin) return { mode: "explicit", settings: validateSettings(merged) }
  return { mode: "auto", proxyHome: typeof merged.proxyHome === "string" ? merged.proxyHome : "" }
}

// 调用方的取消信号中继给 version 子进程；launch 自己直接用调用方的信号。
function follow(signal) {
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort(signal.reason)
  signal?.addEventListener?.("abort", onAbort, { once: true })
  if (signal?.aborted) onAbort()
  return { ctrl, done: () => signal?.removeEventListener?.("abort", onAbort) }
}

// 每次请求都重新解析：启动器、它选定的 opclauded 与指纹、宿主机 Claude Code 版本。
// 版本与 launch 并行读取；launch 失败时结束 version 子进程并报告 launch 的错误。
async function currentState(plan, { signal, env, bunVersion, dirs, systemClaudes }) {
  assertDirectFetch(bunVersion)
  // 宿主进程明确关闭了官方代理时，官方启动器会选择直连；插件同样不走代理，也不改用别的运行态。
  if (env?.OPUSCLAUDE_PROXY === "0") throw new SafeError("proxy_disabled")
  let settings, launcher, opusHome, executable
  if (plan.mode === "auto") {
    const host = await discoverHost(env, { dirs })
    launcher = host
    opusHome = host.opusHome
    executable = host.executable
    settings = { opclauded: host.bin, opusHome: host.opusHome, opclaudedSha256: host.sha256, proxyHome: plan.proxyHome }
  } else {
    // 旧的显式路径照原样执行；启动器只用来读宿主机版本。启动器要属于的安装就是显式给出的那一个：
    // 它的 config 记着启动器的摘要，宿主环境里默认的 ~/.opusclaude 与此无关。
    launcher = await findLauncher(env, { dirs, home: plan.settings.opusHome, verifyBin: false })
    opusHome = launcher.opusHome
    settings = { ...plan.settings, opusHome }
  }
  const v = follow(signal)
  // 自动发现时，宿主进程另设了 OPUSCLAUDE_HOME 才把它告诉启动器（默认安装不带这个变量）；
  // 旧的显式路径总是把选定的 home 交给启动器。
  const version = readHostVersion({ script: launcher.bytes, opusHome: plan.mode === "explicit" || given(env?.OPUSCLAUDE_HOME) ? opusHome : "", signal: v.ctrl.signal, source: env, systemClaudes })
  version.catch(() => {}) // launch 失败时它的结果不再有人接
  try {
    const state = await runLaunch(settings, { signal, source: env, executable })
    // 票据只留在本次运行态里；版本读不到就不发请求。
    return { ...state, cliVersion: await version }
  } catch (e) {
    v.ctrl.abort()
    throw e
  } finally {
    v.done()
    await executable?.close().catch(() => {})
  }
}

// 登录时留下的元数据：只在显式给出成对路径时保留，其余为空（自动发现不需要保存任何路径）。
function metadataFrom(inputs) {
  const clean = (v) => (typeof v === "string" && v.trim() !== "" ? v : undefined)
  const opclauded = clean(inputs?.opclauded)
  const opusHome = clean(inputs?.opusHome)
  return opclauded && opusHome ? { opclauded, opusHome } : {}
}

// bunVersion / env 只供测试注入：实际运行取当前进程的 Bun.version 与环境。
// launcherDirs 与 systemClaudes 同样只供测试注入（替换启动器与固定系统 Claude 的查找位置），实际运行用官方安装约定的位置。
export function createPlugin(options, { bunVersion = Bun.version, env = process.env, launcherDirs, systemClaudes } = {}) {
  const opts = options && typeof options === "object" ? options : {}
  const runtime = (extra) => ({ env, bunVersion, dirs: launcherDirs && [...launcherDirs], systemClaudes: systemClaudes && [...systemClaudes], ...extra })
  const failed = (e) => ({ type: "failed", error: e?.name === "OpclaudeError" ? e.message : new SafeError("launch_failed").message })

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: "OpusClaude（本机代理）",
        npm: "@ai-sdk/anthropic",
        api: PLACEHOLDER_BASE,
        // 模型清单来自本机代理 /v1/models，每次发现时按当前账号解析，这里不写死。
        models: {},
      }
    },

    auth: {
      provider: PROVIDER,
      methods: [{
        type: "api",
        label: "本机标记（任意文字，只保存在本地，不会发送）",
        placeholder: "本机 OpusClaude",
        // 不询问任何 OpusClaude 信息：路径、指纹和版本都从宿主机的官方安装里发现。
        prompts: [],
        // 登录即验证：真实发现一次并跑一次 launch，代理模式 + 回环地址 + 有效票据 + 宿主机版本都满足才通过。
        async authorize(inputs) {
          // Magpie 把各提示项平铺在 inputs 里；旧的部署若把它包在 metadata 下也接受。
          const meta = inputs?.metadata && typeof inputs.metadata === "object" ? inputs.metadata : inputs ?? {}
          try {
            await currentState(resolvePlan(opts, { metadata: meta }, env), runtime({}))
            return { type: "success", key: LOCAL_MARKER, accountId: "host-proxy", metadata: metadataFrom(meta) }
          } catch (e) {
            return failed(e)
          }
        },
      }],
      // 每个 Magpie 请求都经这里的 fetch：每次重新解析运行态，线路 / 账号 / 代理重启 / 宿主升级都不用重新登录。
      // 已确定的失败在这里就变成 Anthropic 错误响应交还网关，网关能直接交付给调用方。
      async loader(getAuth) {
        return {
          baseURL: PLACEHOLDER_BASE,
          async fetch(input, init) {
            // 先按 Fetch 语义合并 Request 与 init：方法、头、正文和信号以合并结果为准。
            const req = effectiveRequest(input, init)
            try {
              // 调用方已经取消：不启动 launch，不连代理。
              if (req.signal?.aborted) throw req.signal.reason
              const plan = resolvePlan(opts, await getAuth(), env)
              const state = await currentState(plan, runtime({ signal: req.signal }))
              return await forward({ input: req, state })
            } catch (e) {
              // 调用方取消：保持取消语义，原样上抛。
              if (req.signal?.aborted) throw req.signal.reason
              if (e?.name === "OpclaudeError") return errorResponse(e.code)
              throw e
            }
          },
        }
      },
    },

    provider: {
      id: PROVIDER,
      async models(provider, { auth, signal } = {}) {
        // 还没登录、也没有旧的显式路径：保持已有清单（空），不去探测宿主机，也不算错误。
        if (!auth && resolvePlan(opts, undefined, env).mode !== "explicit") return provider.models ?? {}
        // 调用方已经取消：不启动 launch，原样传播取消原因。
        if (signal?.aborted) throw signal.reason
        let state
        try {
          state = await currentState(resolvePlan(opts, auth, env), runtime({ signal }))
        } catch (error) {
          if (signal?.aborted) throw signal.reason
          throw error
        }
        const models = await listModels({ state, signal })
        return Object.fromEntries(Object.values(models).map((m) => [m.id, { ...(provider.models?.[m.id] ?? {}), ...m }]))
      },
    },
  }
}
