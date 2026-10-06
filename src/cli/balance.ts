// 单位数值实验：拿歼灭的基准 bot 派生出几种编队，在不同弓手数值下互打（doc/设计.md「单位数值」）。
// 用法：node src/cli/balance.ts '{"名字": {"maxHp": 60, "attack": {...}}}' [每组局数]
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { runMatch } from "../core/match.ts"
import type { Ruleset, TypeSpec } from "../core/types.ts"
import { compileBot, createBot } from "../sandbox/quickjs.ts"
import annihilation from "../../rulesets/annihilation/index.ts"

const base = readFileSync(join(import.meta.dirname, "..", "..", "rulesets", "annihilation", "bots", "baseline.ts"), "utf8")
const PLAN_RE = /const PLAN: TypeName\[\] = \[[^\]]*\]/
if (!PLAN_RE.test(base)) throw new Error("基准 bot 里找不到 PLAN 那一行")
const plan = (p: string[]) => base.replace(PLAN_RE, `const PLAN: TypeName[] = ${JSON.stringify(p)}`)
const BOTS: Record<string, string> = {
  纯战士: plan(["soldier"]),
  "2战1弓": plan(["soldier", "soldier", "archer"]),
  "1战1弓": plan(["soldier", "archer"]),
  纯弓手: plan(["archer"]),
}

type Archer = Partial<TypeSpec>
const arg = process.argv[2]
const VARIANTS: Record<string, Archer> = JSON.parse(arg)
const GAMES = Number(process.argv[3] ?? 20)
const MATCHUPS: [string, string][] = [
  ["2战1弓", "纯战士"],
  ["1战1弓", "纯战士"],
  ["纯弓手", "纯战士"],
  ["2战1弓", "纯弓手"],
  ["1战1弓", "2战1弓"],
]

for (const [vname, archer] of Object.entries(VARIANTS)) {
  const types = { ...annihilation.types, archer: { ...annihilation.types.archer, ...archer } }
  const rules: Ruleset = { ...annihilation, types }
  const row: string[] = []
  for (const [a, b] of MATCHUPS) {
    let wa = 0
    let wb = 0
    for (let g = 0; g < GAMES; g++) {
      const seed = 1000 + Math.floor(g / 2)
      const order = g % 2 === 0 ? [a, b] : [b, a]
      const bots = []
      for (const [p, name] of order.entries()) {
        const c = compileBot(BOTS[name])
        if ("error" in c) throw new Error(c.error)
        bots.push({ name, file: name, runner: await createBot(c.code, seed * 7 + p, { fuel: rules.fuel }) })
      }
      const r = runMatch({ ruleset: rules, bots, seed })
      const w = r.result.winner
      if (w !== null) (order[w] === a ? wa++ : wb++)
    }
    row.push(`${a} vs ${b} ${wa}:${wb}`)
  }
  console.log(`${vname} ${JSON.stringify(archer)}\n  ${row.join("  |  ")}`)
}
