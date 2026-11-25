// 由 plugin.test.mjs 在设了 HTTP_PROXY 的子进程里运行：证明插件的请求不经过环境代理。
// 参数：<环境代理端口>。先发一个不带 proxy: false 的裸请求作对照，再走插件的转发与模型发现。
import { createPlugin } from "../lib/plugin.mjs"
import { makeRig } from "./rig.mjs"

const [proxyPort] = process.argv.slice(2)
const rig = await makeRig()
const out = { bun: Bun.version, port: rig.port }
try {
  const control = await fetch(`http://127.0.0.1:${rig.port}/v1/models`)
  out.control = control.status
  await control.text()
  const l = await createPlugin({}, { env: rig.env, launcherDirs: rig.dirs }).auth.loader(async () => ({ type: "api", key: "local" }))
  const r = await l.fetch("http://127.0.0.1:1/v1/messages", { method: "POST", body: JSON.stringify({ model: "claude-sonnet-5-5", stream: false, messages: [] }) })
  out.forward = r.status
  out.proxyRequests = rig.seen.proxy.length
  const hooks = createPlugin({}, { env: rig.env, launcherDirs: rig.dirs })
  out.models = Object.keys(await hooks.provider.models({ models: {} }, { auth: { type: "api", key: "local" } })).length
} catch (e) {
  out.error = String(e?.message ?? e)
} finally {
  await rig.close()
}
console.log("RESULT " + JSON.stringify(out))
