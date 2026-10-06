// 平台里有哪些规则包、现成 bot，当前目录是不是 bot 目录。命令行和播放器服务共用
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { Ruleset } from "../core/types.ts"
import { CODE_EXT, CODE_ROOT, PKG_ROOT } from "../paths.ts"

export function listRulesets(): string[] {
  const dir = join(PKG_ROOT, "rulesets")
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "RULES.md")))
    .map((d) => d.name)
}

/** 按 id 加载规则包；没有这个规则包时抛错 */
export async function importRuleset(id: string): Promise<Ruleset> {
  if (!listRulesets().includes(id)) throw new Error(`没有规则包 "${id}"。可用的：${listRulesets().join("、")}`)
  const file = join(CODE_ROOT, "rulesets", id, `index${CODE_EXT}`)
  const mod = (await import(pathToFileURL(file).href)) as { default: Ruleset }
  return mod.default
}

/** 规则包能用的现成 bot：bots/<规则包>/*.ts 和通用的 bots/*.ts */
export function knownBots(id: string): string[] {
  const list = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => f.slice(0, -3)) : [])
  return [...new Set([...list(join(PKG_ROOT, "bots", id)), ...list(join(PKG_ROOT, "bots"))])]
}

/** 现成 bot 的文件路径；不是现成 bot 返回 null */
export function knownBotFile(id: string, name: string): string | null {
  if (!/^[\w-]+$/.test(name)) return null
  for (const f of [join(PKG_ROOT, "bots", id, `${name}.ts`), join(PKG_ROOT, "bots", `${name}.ts`)]) if (existsSync(f)) return f
  return null
}

/** bot 目录里的 arena.json */
export interface Workspace {
  ruleset: string
  bot: string
}

export const WORKSPACE_FILE = "arena.json"

/** 读 dir 下的 arena.json；没有返回 null，格式不对抛错 */
export function readWorkspaceIn(dir: string): Workspace | null {
  const file = join(dir, WORKSPACE_FILE)
  if (!existsSync(file)) return null
  const w = JSON.parse(readFileSync(file, "utf8")) as Partial<Workspace>
  if (typeof w.ruleset !== "string" || typeof w.bot !== "string") throw new Error(`${WORKSPACE_FILE} 里要有 ruleset 和 bot 两个字符串字段`)
  return w as Workspace
}

/** dir 下自己写的 bot 文件（.ts，不含 .d.ts） */
export function localBots(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
    .sort()
}
