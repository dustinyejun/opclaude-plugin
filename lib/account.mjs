// OpusClaude 周额度：把宿主机 opclauded account 的只读 JSON 映射成 Magpie 的 auth.usage 返回值。
//
// 契约来自 OpusClaude 官方安装脚本的 oc_plan_json / oc_plan_print：代理模式下运行 `opclauded account`（无参数），
// OPCLAUDE_PROXY_HOME 默认为 <OpusClaude home>/proxy，标准输出是 account-status 的 JSON；只消费
// plan_name、weekly_pct（数字或数字字符串，0 有效）、weekly_unlimited、ok。其余字段不读、不推断。
// 周额度只用于展示：窗口固定 aside:true，路由不读它，额度与余额续用由 OpusClaude 自己决定。
import path from "node:path"
import { SafeError, TEXT } from "./errors.mjs"
import { runAccount } from "./launch.mjs"

const MAX_PLAN = 64
const WINDOW = "本周额度"
const NUMERIC = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/
const TEXT_OF = (code) => TEXT[code] ?? TEXT.account_failed

// 返回 null 表示“没有给出合法的已用百分比”，绝不填 0 顶替。
export function parsePercent(v) {
  let n
  if (typeof v === "number") n = v
  else if (typeof v === "string" && v.length <= 32) {
    const s = v.trim()
    if (!NUMERIC.test(s)) return null
    n = Number(s)
  } else return null
  if (!Number.isFinite(n) || n < 0 || n > 100000) return null
  return n
}

// 与官方 oc_plan_print 一致：weekly_unlimited 为真时不看 weekly_pct。
const truthy = (v) => v === true || v === 1 || v === "1" || v === "true"

function planName(v) {
  if (typeof v !== "string") return ""
  const s = v.trim()
  if (s === "" || s.length > MAX_PLAN || /[\x00-\x1f\x7f]/.test(s)) return ""
  return s
}

// 文本 -> { plan, unlimited, used }；不是 JSON 对象、ok 为 false、weekly_pct 为负数，或一个可用字段都没有时抛固定错误码。
// 有套餐名但 weekly_pct 缺失或非数字：只给套餐，used 为 null（由调用方不给出窗口）。
export function parseAccountOutput(text) {
  const bad = () => new SafeError("account_output_invalid")
  let d
  try { d = JSON.parse(text) } catch { throw bad() }
  if (!d || typeof d !== "object" || Array.isArray(d)) throw bad()
  if (d.ok === false) throw new SafeError("account_unavailable")
  const plan = planName(d.plan_name)
  const unlimited = truthy(d.weekly_unlimited)
  if (unlimited) return { plan, unlimited, used: null }
  const used = parsePercent(d.weekly_pct)
  // 已用百分比是合法数字却为负：不合理，按输出不合法处理。
  const numeric = typeof d.weekly_pct === "number" || (typeof d.weekly_pct === "string" && NUMERIC.test(d.weekly_pct.trim()) && Number.isFinite(Number(d.weekly_pct)))
  if (used === null && numeric && Number(d.weekly_pct) < 0) throw bad()
  if (!plan && !unlimited && used === null) throw bad()
  return { plan, unlimited, used }
}

export function usageFromAccount({ plan, unlimited, used }) {
  const out = {}
  if (plan) out.plan = plan
  if (unlimited) out.windows = [{ name: WINDOW, aside: true, display: "本周额度不限" }]
  else if (used !== null) out.windows = [{ name: WINDOW, used, aside: true }]
  return out
}

// 查询失败或输出不合法：固定文案，不带原始输出、路径或凭据；signIn: kept，不误标账号需要重新登录。
export function usageFailure(code) {
  return { error: TEXT_OF(code), windows: [], signIn: "kept" }
}

// 周额度必须来自现有宿主代理所用的那一份状态：与官方一致，account 的代理状态目录是
// 显式 proxyHome（插件选项 > 宿主环境的 OPCLAUDE_PROXY_HOME），没有时是确认过的 OpusClaude home 下的 proxy。
export function accountProxyHome(settings) {
  return settings.proxyHome || path.join(settings.opusHome, "proxy")
}

export async function accountUsage(settings, options = {}) {
  const { code, out } = await runAccount(settings, { ...options, proxyHome: accountProxyHome(settings) })
  if (code !== 0) throw new SafeError("account_failed")
  return usageFromAccount(parseAccountOutput(out))
}
