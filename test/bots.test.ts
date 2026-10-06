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
import melee from "../rulesets/melee/index.ts"

const ROOT = join(import.meta.dirname, "..")

const load = async (rules: Ruleset, file: string, p: number) => {
  const c = compileBot(readFileSync(file, "utf8"))
  if ("error" in c) throw new Error(c.error)
  return { name: file, file, runner: await createBot(c.code, p, { fuel: rules.fuel }) }
}

for (const rules of [annihilation, koth, harvest, melee] as Ruleset[]) {
  test(`示例 bot 能通过「${rules.name}」生成的 arena.d.ts 类型检查`, () => {
    const dir = join(ROOT, "bots", rules.id)
    const files = [join(ROOT, "bots", "idle.ts"), ...readdirSync(dir).map((f) => join(dir, f))]
    assert.equal(typecheck(rules, files), "")
  })

  test(`「${rules.name}」的基准 bot 在沙箱里能打赢不动的对手`, async () => {
    const replay = runMatch({
      ruleset: rules,
      seed: 1,
      bots: [await load(rules, join(ROOT, "bots", rules.id, "baseline.ts"), 0), await load(rules, join(ROOT, "bots", "idle.ts"), 1)],
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

test("混战：三家里基准 bot 把两个不动的对手打出局，名次按出局先后", async () => {
  const idle = join(ROOT, "bots", "idle.ts")
  const replay = runMatch({
    ruleset: melee,
    seed: 2,
    bots: [await load(melee, idle, 0), await load(melee, join(ROOT, "bots", "melee", "baseline.ts"), 1), await load(melee, idle, 2)],
  })
  const r = replay.result
  assert.equal(r.winner, 1, r.reason)
  assert.equal(r.ranking!.length, 3)
  assert.deepEqual(r.ranking![0], [1])
  // 出局的两家：先出局的排最后
  const outOrder = [...r.ranking![2], ...r.ranking![1]]
  assert.deepEqual([...outOrder].sort(), [0, 2])
  // 出局后不再有那两家的实体
  const owners = new Set<number>()
  const ents = new Map(replay.initial.entities.map((e) => [e.id, e.owner]))
  for (const f of replay.frames) {
    for (const s of f.spawn ?? []) ents.set(s.id, s.owner)
    for (const id of f.die ?? []) ents.delete(id)
  }
  for (const owner of ents.values()) owners.add(owner)
  assert.ok(!owners.has(0) && !owners.has(2))
})
