// opclaude-provider 插件入口。只导出 OpenCode v1 形式的默认对象：
// Magpie 会把入口里每个导出的函数都当作插件调用，所以内部实现都放在 lib/。
import { createPlugin } from "./lib/plugin.mjs"

// Magpie 以 server(input, options) 调用：input 是运行环境，options 才是 plugins.json 里保存的插件选项。
const server = (_input, options) => createPlugin(options)

export default { id: "opclaude", server }
