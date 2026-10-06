import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { referenceBots } from "../src/cli/catalog.ts"
import { buildDts, buildPrompt, rulesetDir, typecheck } from "../src/cli/docgen.ts"
import { runMatch } from "../src/core/match.ts"
import type { Ruleset } from "../src/core/types.ts"
import { compileBot, createBot } from "../src/sandbox/quickjs.ts"
import annihilation from "../rulesets/annihilation/index.ts"
import frontier from "../rulesets/frontier/index.ts"
import harvest from "../rulesets/harvest/index.ts"
import koth from "../rulesets/koth/index.ts"
import melee from "../rulesets/melee/index.ts"

const ROOT = join(import.meta.dirname, "..")

const load = async (rules: Ruleset, file: string, p: number) => {
  const c = compileBot(readFileSync(file, "utf8"))
  if ("error" in c) throw new Error(c.error)
  return { name: file, file, runner: await createBot(c.code, p, { fuel: rules.fuel }) }
}

for (const rules of [annihilation, koth, harvest, melee, frontier] as Ruleset[]) {
  test(`示例 bot 能通过「${rules.name}」生成的 arena.d.ts 类型检查`, () => {
    const dir = join(ROOT, "rulesets", rules.id, "bots")
    const files = [join(ROOT, "bots", "idle.ts"), ...readdirSync(dir).map((f) => join(dir, f))]
    assert.equal(typecheck(rules, rulesetDir(rules.id), files), "")
  })

  test(`「${rules.name}」的参考 bot 和规则包放在一起，每个都写了打法、列进 PROMPT.md，至少有 3 种打法`, () => {
    const bots = referenceBots(rulesetDir(rules.id))
    const own = bots.filter((b) => b.name !== "idle")
    assert.ok(own.length >= 3, own.map((b) => b.name).join("、"))
    assert.equal(own[0].name, "baseline")
    const prompt = buildPrompt(rules, rulesetDir(rules.id), buildDts(rules, rulesetDir(rules.id)))
    for (const b of bots) {
      assert.ok(b.file.startsWith(b.name === "idle" ? join(ROOT, "bots") : join(ROOT, "rulesets", rules.id, "bots")), b.file)
      assert.ok(b.about.length >= 10, `${b.name} 第一行没写打法`)
      assert.ok(prompt.includes(`| \`${b.name}\` | ${b.about} |`), `PROMPT.md 里没有 ${b.name}`)
    }
  })

  for (const b of referenceBots(rulesetDir(rules.id)).filter((x) => x.name !== "idle" && x.name !== "baseline"))
    test(`「${rules.name}」的参考 bot ${b.name} 打不动的对手：能赢，不报错、不被拒命令`, async () => {
      const replay = runMatch({ ruleset: rules, seed: 2, bots: [await load(rules, join(ROOT, "bots", "idle.ts"), 0), await load(rules, b.file, 1)] })
      assert.equal(replay.result.winner, 1, replay.result.reason)
      assert.equal(replay.bots[1].errors + replay.bots[1].fuelOuts + replay.bots[1].rejected, 0)
    })

  test(`「${rules.name}」的基准 bot 在沙箱里能打赢不动的对手`, async () => {
    const replay = runMatch({
      ruleset: rules,
      seed: 1,
      bots: [await load(rules, join(ROOT, "rulesets", rules.id, "bots", "baseline.ts"), 0), await load(rules, join(ROOT, "bots", "idle.ts"), 1)],
    })
    assert.equal(replay.result.winner, 0, replay.result.reason)
    assert.equal(replay.bots[0].errors + replay.bots[0].fuelOuts + replay.bots[0].rejected, 0)
  })
}

test("拓荒：基准 bot 自己建兵营、箭塔、仓库，打赢速攻", async () => {
  const replay = runMatch({
    ruleset: frontier,
    seed: 1,
    bots: [await load(frontier, join(ROOT, "rulesets", "frontier", "bots", "baseline.ts"), 0), await load(frontier, join(ROOT, "rulesets", "frontier", "bots", "rush.ts"), 1)],
  })
  assert.equal(replay.result.winner, 0, replay.result.reason)
  assert.equal(replay.bots[0].errors + replay.bots[0].fuelOuts + replay.bots[0].rejected, 0)
  const built = new Set<string>()
  const owner = new Map(replay.initial.entities.map((e) => [e.id, e]))
  for (const f of replay.frames) {
    for (const e of f.spawn ?? []) owner.set(e.id, e)
    const bp = f.bp ?? []
    for (let i = 0; i < bp.length; i += 2) {
      const e = owner.get(bp[i])!
      if (bp[i + 1] === 100 && e.owner === 0) built.add(e.type)
    }
  }
  assert.deepEqual([...built].sort(), ["barracks", "depot", "tower"])
})

test("类型不对的 bot 过不了检查", () => {
  const bad = join(ROOT, "test", "fixtures", "bad-bot.ts")
  const out = typecheck(harvest, rulesetDir("harvest"), [bad])
  assert.match(out, /enemyBases/)
})

test("混战：三家里基准 bot 把两个不动的对手打出局，名次按出局先后", async () => {
  const idle = join(ROOT, "bots", "idle.ts")
  const replay = runMatch({
    ruleset: melee,
    seed: 2,
    bots: [await load(melee, idle, 0), await load(melee, join(ROOT, "rulesets", "melee", "bots", "baseline.ts"), 1), await load(melee, idle, 2)],
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

test("混战 2v2：按队伍判胜负，什么都不做的队友也算赢", async () => {
  const idle = join(ROOT, "bots", "idle.ts")
  const base = join(ROOT, "rulesets", "melee", "bots", "baseline.ts")
  const replay = runMatch({
    ruleset: melee,
    seed: 3,
    teams: [0, 0, 1, 1],
    bots: [await load(melee, base, 0), await load(melee, idle, 1), await load(melee, idle, 2), await load(melee, idle, 3)],
  })
  const r = replay.result
  assert.deepEqual(r.winners, [0, 1], r.reason)
  assert.deepEqual(r.ranking, [
    [0, 1],
    [2, 3],
  ])
  assert.deepEqual(
    replay.players.map((p) => p.team),
    [0, 0, 1, 1],
  )
})
