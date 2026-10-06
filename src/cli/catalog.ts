// 平台里有哪些规则包、现成 bot，当前目录是不是 bot 目录。命令行和播放器服务共用
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { Ruleset } from "../core/types.ts"
import { CODE_EXT, CODE_ROOT, PKG_ROOT } from "../paths.ts"
import { loadSandboxedRuleset } from "../sandbox/ruleset.ts"

/** 平台自带的规则包 */
export function listRulesets(): string[] {
  const dir = join(PKG_ROOT, "rulesets")
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "RULES.md")))
    .map((d) => d.name)
}

/**
 * 一个规则包在哪：平台自带的（按名字引用，在仓库的 rulesets/<id>/），或者某个目录（按路径引用）。
 * 两种都在沙箱里跑（D-123）。
 */
export interface RulesetRef {
  /** 用户写的名字或路径（原样，传给子进程时用） */
  ref: string
  /** 规则包目录（index.ts、objectives.ts、RULES.md 所在） */
  dir: string
  builtin: boolean
}

/** 写的是路径（带斜杠、以 . 开头或者是绝对路径），不是规则包名 */
export function looksLikePath(ref: string): boolean {
  return ref.includes("/") || ref.includes("\\") || ref.startsWith(".") || isAbsolute(ref)
}

/** 认出一个规则包；base 是相对路径的起点（bot 目录的 arena.json 里的路径相对 bot 目录）。认不出返回 null */
export function findRuleset(ref: string, base = "."): RulesetRef | null {
  if (!looksLikePath(ref)) return listRulesets().includes(ref) ? { ref, dir: join(PKG_ROOT, "rulesets", ref), builtin: true } : null
  const dir = resolve(base, ref)
  return existsSync(join(dir, "index.ts")) && statSync(dir).isDirectory() ? { ref, dir, builtin: false } : null
}

/** 认不出时的说明 */
export function rulesetHint(ref: string): string {
  if (looksLikePath(ref)) return `${ref} 不是规则包目录（里面要有 index.ts、objectives.ts、RULES.md；可以用 rts-arena new-rules <目录> 建一个）`
  return `没有规则包 "${ref}"。平台自带的：${listRulesets().join("、")}；自己写的规则包写目录路径（如 ./my-rules）`
}

/**
 * 不经过沙箱、直接导入平台自带的规则包。命令行和对战页都不用它（规则包一律进沙箱），
 * 只给测试（比较两种跑法结果一样）和调数值的开发脚本用
 */
export async function importRuleset(id: string): Promise<Ruleset> {
  if (!listRulesets().includes(id)) throw new Error(rulesetHint(id))
  const file = join(CODE_ROOT, "rulesets", id, `index${CODE_EXT}`)
  const mod = (await import(pathToFileURL(file).href)) as { default: Ruleset }
  return mod.default
}

/** 加载规则包：自带的和目录里的都在沙箱里加载 */
export async function loadRulesetRef(r: RulesetRef): Promise<Ruleset> {
  for (const f of ["objectives.ts", "RULES.md"]) if (!existsSync(join(r.dir, f))) throw new Error(`规则包目录 ${r.ref} 里缺少 ${f}`)
  const rules = await loadSandboxedRuleset(r.dir)
  if (r.builtin && rules.id !== r.ref) throw new Error(`平台自带的规则包 ${r.ref} 的 id 写成了 "${rules.id}"，要和目录名一样`)
  if (!r.builtin && listRulesets().includes(rules.id)) throw new Error(`规则包 ${r.ref} 的 id "${rules.id}" 和平台自带的规则包重名，换一个 id`)
  return rules
}

/** 现成 bot 所在的目录：规则包自己的 bots/，再加平台通用的 bots/（idle 等） */
function botDirs(r: RulesetRef): string[] {
  return [r.builtin ? join(PKG_ROOT, "bots", r.ref) : join(r.dir, "bots"), join(PKG_ROOT, "bots")]
}

/** 规则包能用的现成 bot 的名字 */
export function knownBots(r: RulesetRef): string[] {
  const list = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts")).map((f) => f.slice(0, -3)) : [])
  return [...new Set(botDirs(r).flatMap(list))]
}

/** 现成 bot 的文件路径；不是现成 bot 返回 null */
export function knownBotFile(r: RulesetRef, name: string): string | null {
  if (!/^[\w-]+$/.test(name)) return null
  for (const dir of botDirs(r)) {
    const f = join(dir, `${name}.ts`)
    if (existsSync(f)) return f
  }
  return null
}

/** bot 目录里的 arena.json。ruleset 是平台自带规则包的名字，或者规则包目录（相对这个 bot 目录） */
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
