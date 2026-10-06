// 对战页的 bot 下拉框：在 bot 目录（含子文件夹）、旁边的其他 bot 目录、上传目录里找 bot 文件，不用手填路径。
// 每个 bot 记下它所在 bot 目录用的规则包，页面按当前选的规则包筛。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { PKG_ROOT } from "../paths.ts"
import { findRuleset, readWorkspaceIn, WORKSPACE_FILE, type RulesetRef } from "./catalog.ts"

export interface FoundBot {
  /** 相对跑比赛的目录的路径（正斜杠），直接交给 rts-arena run */
  path: string
  /** 下拉框里的分组 */
  group: string
  /** 所在 bot 目录用的规则包（和 /api/arena 里规则包的 id 一样）；不在任何 bot 目录里为 null，任何规则包都列出 */
  ruleset: string | null
}

/** 导出了 onTick 的才算 bot */
export const BOT_EXPORT = /export\s+(async\s+)?function\s+onTick\b|export\s+(const|let|var)\s+onTick\b|export\s*\{[^}]*\bonTick\b/
const SKIP = new Set(["node_modules", "replays", "dist", "out"])
/** 平台仓库里这些目录不是给对战页选的（现成 bot 另有一组） */
const PKG_SKIP = ["src", "test", "viewer", "bots", "rulesets", "bin"].map((d) => join(PKG_ROOT, d))
const MAX_FILES = 300
const MAX_DEPTH = 3

const posix = (p: string) => p.split(sep).join("/")

/** 相对 cwd 的路径；不在 cwd 下的带 ../ */
function rel(cwd: string, file: string): string {
  const r = posix(relative(cwd, file))
  return r === "" ? "." : r
}

function isRulesetDir(dir: string): boolean {
  return existsSync(join(dir, "index.ts")) && existsSync(join(dir, "RULES.md"))
}

/** 在 dir 下找 bot 文件和 bot 目录（有 arena.json 的目录） */
function walk(dir: string, depth: number, files: string[], workspaces: Set<string>): void {
  if (files.length >= MAX_FILES || PKG_SKIP.includes(dir) || isRulesetDir(dir)) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  if (entries.some((e) => e.isFile() && e.name === WORKSPACE_FILE)) workspaces.add(dir)
  for (const e of entries) {
    if (e.name.startsWith(".")) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (depth < MAX_DEPTH && !SKIP.has(e.name)) walk(p, depth + 1, files, workspaces)
    } else if (e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".d.ts") && files.length < MAX_FILES) {
      try {
        if (statSync(p).size < 1_000_000 && BOT_EXPORT.test(readFileSync(p, "utf8"))) files.push(p)
      } catch {
        // 读不了就跳过
      }
    }
  }
}

/**
 * 找 bot。cwd 是跑比赛的目录（一般是 bot 目录）。cwd 本身是 bot 目录时，上一层里的其他 bot 目录也算（start.bat
 * 的布局：平台文件夹下的 my-bot、my-bot2……）。返回找到的 bot，以及这些 bot 目录用到的、平台自带以外的规则包
 * （ref 改成相对 cwd 的路径，对战页可以直接选它开比赛）。
 */
export function discoverBots(cwd: string, uploadsDir: string): { bots: FoundBot[]; rulesets: RulesetRef[]; here: string | null } {
  const root = resolve(cwd)
  const files: string[] = []
  const workspaces = new Set<string>()
  walk(root, 0, files, workspaces)
  if (workspaces.has(root)) {
    const parent = dirname(root)
    try {
      for (const e of readdirSync(parent, { withFileTypes: true })) {
        const d = join(parent, e.name)
        if (e.isDirectory() && d !== root && !e.name.startsWith(".") && existsSync(join(d, WORKSPACE_FILE))) walk(d, 1, files, workspaces)
      }
    } catch {
      // 上一层读不了就算了
    }
  }

  // 每个 bot 目录用的规则包
  const external = new Map<string, RulesetRef>()
  const rulesetOf = new Map<string, string | null>()
  for (const ws of workspaces) {
    let id: string | null = null
    try {
      const w = readWorkspaceIn(ws)
      const src = w ? findRuleset(w.ruleset, ws) : null
      if (src?.builtin) id = src.ref
      else if (src) {
        const ref = rel(root, src.dir)
        id = ref.startsWith(".") ? ref : `./${ref}`
        external.set(src.dir, { ref: id, dir: src.dir, builtin: false })
      }
    } catch {
      // arena.json 坏了：这个目录里的 bot 当成不属于任何规则包
    }
    rulesetOf.set(ws, id)
  }
  // 文件归属最近的 bot 目录
  const owner = (file: string): string | null => {
    let best: string | null = null
    for (const ws of workspaces) if (file.startsWith(ws + sep) && (!best || ws.length > best.length)) best = ws
    return best
  }
  const bots: FoundBot[] = files.map((f) => {
    const ws = owner(f)
    return {
      path: rel(root, f),
      group: !ws ? "其他文件" : ws === root ? "这个 bot 目录" : `bot 目录 ${rel(root, ws)}`,
      ruleset: ws ? (rulesetOf.get(ws) ?? null) : null,
    }
  })
  // 页面上传的副本
  if (existsSync(uploadsDir))
    for (const name of readdirSync(uploadsDir).sort())
      if (name.endsWith(".ts")) bots.push({ path: rel(root, join(uploadsDir, name)), group: "从电脑选的（副本）", ruleset: null })
  // 这个 bot 目录排最前，其余按分组、路径排
  const rank = (b: FoundBot) => (b.group === "这个 bot 目录" ? 0 : b.group.startsWith("bot 目录") ? 1 : b.group === "其他文件" ? 2 : 3)
  bots.sort((a, b) => rank(a) - rank(b) || a.group.localeCompare(b.group) || a.path.localeCompare(b.path))
  return { bots, rulesets: [...external.values()], here: rulesetOf.get(root) ?? null }
}
