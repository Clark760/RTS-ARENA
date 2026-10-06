// 平台自己的文件在哪：开发时直接跑仓库里的 .ts，装成命令后跑 dist/ 里编译好的 .js。
// - PKG_ROOT：平台包的根目录（有 package.json 的那一层），文本资源（接口定义、规则说明、示例 bot）都从这里读
// - CODE_ROOT / CODE_EXT：可执行代码（规则包）在哪、后缀是什么
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

function findPackageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const pkg = join(dir, "package.json")
    if (existsSync(pkg) && (JSON.parse(readFileSync(pkg, "utf8")) as { name?: string }).name === "rts-arena") return dir
    const up = dirname(dir)
    if (up === dir) throw new Error("找不到 rts-arena 的 package.json")
    dir = up
  }
}

export const PKG_ROOT = findPackageRoot()
const built = import.meta.url.endsWith(".js")
export const CODE_ROOT = built ? join(PKG_ROOT, "dist") : PKG_ROOT
export const CODE_EXT = built ? ".js" : ".ts"
