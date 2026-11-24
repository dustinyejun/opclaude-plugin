// 独立运行的模拟宿主机：假的 opclauded + 本机回环 mock 代理（只用模拟票据）。
// 供真实 Magpie 的沙箱验证使用：需要 Bun >= 1.4.3，例如 "$MAGPIE_BUN" scripts/mock-host.mjs [目录]
// 目录下：bin/opclauded（假 opclauded）、state/（运行态，改 mode/ticket/port 后下一次 launch 生效）、host.json
import path from "node:path"
import { makeRig } from "../test/rig.mjs"

const dir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(process.env.TMPDIR ?? "/tmp", "opclaude-mock-host")
const rig = await makeRig({ dir })
await Bun.write(path.join(dir, "host.json"), JSON.stringify({ opclauded: rig.bin, opusHome: rig.opusHome, port: rig.port, state: rig.state, ctlPort: rig.ctlPort }, null, 2))
console.log(`mock host ready: opclauded=${rig.bin} opusHome=${rig.opusHome} proxy=http://127.0.0.1:${rig.port}`)
console.log(`state changes: GET http://127.0.0.1:${rig.ctlPort}/__ctl?mode=direct · generation requests counted in ${path.join(dir, "hits")}`)
process.on("SIGINT", () => process.exit(0))
process.on("SIGTERM", () => process.exit(0))
setInterval(() => {}, 1 << 30)
