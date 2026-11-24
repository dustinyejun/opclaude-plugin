// opclaude provider：Magpie / OpenCode v1 插件钩子。
import { SafeError } from "./errors.mjs"
import { runLaunch, validateSettings } from "./launch.mjs"
import { PLACEHOLDER_BASE, assertDirectFetch, effectiveRequest, errorResponse, forward, listModels } from "./transport.mjs"

export const PROVIDER = "opclaude"
// 登录只是一个本地标记：保存到 Magpie 的 key 是这个常量，不是任何真实票据。
export const LOCAL_MARKER = "opclaude-local-proxy"
const SETTING_KEYS = ["opclauded", "opusHome", "proxyHome", "opclaudedSha256"]

const abs = (v) => typeof v === "string" && v.length > 0 && v.length <= 4096 && !v.includes("\0") && v.startsWith("/")

// 设置来源只有两处：插件 options（plugins.json）和登录时提示输入的元数据。请求方给不了。
export function resolveSettings(options, auth) {
  const meta = auth?.metadata && typeof auth?.metadata === "object" ? auth.metadata : {}
  const merged = {}
  for (const k of SETTING_KEYS) {
    const fromMeta = k === "opclauded" || k === "opusHome" ? meta[k] : undefined
    merged[k] = typeof fromMeta === "string" && fromMeta.trim() !== "" ? fromMeta : options?.[k]
  }
  return validateSettings(merged)
}

async function currentState(settings, signal, bunVersion) {
  // 运行时不满足要求时，登录和每次请求都在启动 opclauded 之前拒绝。
  assertDirectFetch(bunVersion)
  return runLaunch(settings, { signal })
}

function settingsFromInputs(inputs) {
  const clean = (v) => (abs(String(v ?? "").trim()) ? String(v).trim() : "")
  return { opclauded: clean(inputs?.opclauded), opusHome: clean(inputs?.opusHome) }
}

// bunVersion 只供测试注入：实际运行取当前进程的 Bun.version。
export function createPlugin(options, { bunVersion = Bun.version } = {}) {
  const opts = options && typeof options === "object" ? options : {}
  // 插件选项里已经给出的路径不再在登录时询问。
  const prompts = [
    { key: "opclauded", message: "宿主机 opclauded 可执行文件的绝对路径", placeholder: "/Users/<用户>/.opusclaude/opclauded/<版本>/opclauded" },
    { key: "opusHome", message: "OpusClaude home 目录的绝对路径", placeholder: "/Users/<用户>/.opusclaude" },
  ]
    .filter((p) => !opts[p.key])
    .map((p) => ({ ...p, type: "text", validate: (v) => (abs(String(v ?? "").trim()) ? undefined : "请填写绝对路径") }))

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
        prompts,
        // 登录即验证：真实跑一次 launch，只有代理模式 + 回环地址 + 有效票据才通过。
        async authorize(inputs) {
          try {
            await currentState(resolveSettings(opts, { metadata: settingsFromInputs(inputs) }), undefined, bunVersion)
            return { type: "success", key: LOCAL_MARKER, accountId: "host-proxy", metadata: settingsFromInputs(inputs) }
          } catch (e) {
            const error = e?.name === "OpclaudeError" ? e.message : new SafeError("launch_failed").message
            return { type: "failed", error }
          }
        },
      }],
      // 每个 Magpie 请求都经这里的 fetch：每次重新解析运行态，线路 / 账号 / 代理重启都不用重新登录。
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
              const settings = resolveSettings(opts, await getAuth())
              const state = await currentState(settings, req.signal, bunVersion)
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
        // 还没登录、也没给 opclauded 路径：保持已有清单（空），不算错误。
        if (!auth && !(opts.opclauded && opts.opusHome)) return provider.models ?? {}
        // 调用方已经取消：不启动 launch，原样传播取消原因。
        if (signal?.aborted) throw signal.reason
        const settings = resolveSettings(opts, auth)
        let state
        try {
          state = await currentState(settings, signal, bunVersion)
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
