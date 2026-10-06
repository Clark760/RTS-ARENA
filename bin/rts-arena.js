#!/usr/bin/env node
// rts-arena 命令入口：装成依赖（在 node_modules 里）时跑编译好的 dist/；
// 在平台仓库里开发（或 npm link）时直接跑 src/ 的 .ts（Node 不给 node_modules 里的 .ts 擦类型）
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

const inNodeModules = /[\\/]node_modules[\\/]/.test(fileURLToPath(import.meta.url))
const src = new URL("../src/cli/arena.ts", import.meta.url)
const dist = new URL("../dist/src/cli/arena.js", import.meta.url)
if (!inNodeModules && existsSync(src)) await import(src.href)
else if (existsSync(dist)) await import(dist.href)
else {
  console.error("rts-arena 还没构建：在平台目录里跑 npm run build")
  process.exit(1)
}
