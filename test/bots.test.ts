import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { typecheck } from "../src/cli/docgen.ts"
import { runMatch } from "../src/core/match.ts"
import type { Ruleset } from "../src/core/types.ts"
import { compileBot, createBot } from "../src/sandbox/quickjs.ts"
import annihilation from "../rulesets/annihilation/index.ts"
import harvest from "../rulesets/harvest/index.ts"
import koth from "../rulesets/koth/index.ts"

const ROOT = join(import.meta.dirname, "..")

for (const rules of [annihilation, koth, harvest] as Ruleset[]) {
  test(`示例 bot 能通过「${rules.name}」生成的 arena.d.ts 类型检查`, () => {
    const dir = join(ROOT, "bots", rules.id)
    const files = [join(ROOT, "bots", "idle.ts"), ...readdirSync(dir).map((f) => join(dir, f))]
    assert.equal(typecheck(rules, files), "")
  })

  test(`「${rules.name}」的基准 bot 在沙箱里能打赢不动的对手`, async () => {
    const load = async (file: string, p: number) => {
      const c = compileBot(readFileSync(file, "utf8"))
      if ("error" in c) throw new Error(c.error)
      return { name: file, file, runner: await createBot(c.code, p, { fuel: rules.fuel }) }
    }
    const replay = runMatch({
      ruleset: rules,
      seed: 1,
      bots: [await load(join(ROOT, "bots", rules.id, "baseline.ts"), 0), await load(join(ROOT, "bots", "idle.ts"), 1)],
    })
    assert.equal(replay.result.winner, 0, replay.result.reason)
    assert.equal(replay.bots[0].errors + replay.bots[0].fuelOuts + replay.bots[0].rejected, 0)
  })
}

test("类型不对的 bot 过不了检查", () => {
  const bad = join(ROOT, "test", "fixtures", "bad-bot.ts")
  const out = typecheck(harvest, [bad])
  assert.match(out, /enemyBases/)
})
