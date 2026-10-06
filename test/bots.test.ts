import assert from "node:assert/strict"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { typecheck } from "../src/cli/docgen.ts"
import type { Ruleset } from "../src/core/types.ts"
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
}

test("类型不对的 bot 过不了检查", () => {
  const bad = join(ROOT, "test", "fixtures", "bad-bot.ts")
  const out = typecheck(harvest, [bad])
  assert.match(out, /enemyBases/)
})
