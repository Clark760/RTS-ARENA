// 沙箱规则包：自带规则包放进沙箱结果完全一样；写错的、恶意的规则包被拦住并说清原因
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { importRuleset } from "../src/cli/catalog.ts"
import { writeRulesTemplate } from "../src/cli/rules-template.ts"
import { runMatch, type MatchBot } from "../src/core/match.ts"
import type { Replay, Ruleset } from "../src/core/types.ts"
import { compileBot, createBot } from "../src/sandbox/quickjs.ts"
import { checkRulesetData } from "../src/sandbox/rules-check.ts"
import { loadSandboxedRuleset } from "../src/sandbox/ruleset.ts"
import { fnBot, idle } from "./helpers.ts"

const ROOT = join(import.meta.dirname, "..")
const TMP = mkdtempSync(join(tmpdir(), "rts-arena-rules-"))
after(() => rmSync(TMP, { recursive: true, force: true }))

async function sandboxBot(file: string, seed: number, rules: Ruleset): Promise<MatchBot> {
  const c = compileBot(readFileSync(file, "utf8"))
  if ("error" in c) throw new Error(c.error)
  return { name: `b${seed}`, file, runner: await createBot(c.code, seed, { fuel: rules.fuel }) }
}

/** 回放里和耗时有关的字段去掉，其余必须一模一样 */
function stable(r: Replay): string {
  return JSON.stringify({ ...r, perf: null, bots: r.bots.map((b) => ({ ...b, ms: 0 })) })
}

for (const id of ["annihilation", "koth", "harvest", "melee", "frontier"]) {
  test(`自带规则包「${id}」放进沙箱，回放和直接跑完全一样`, async () => {
    const native = await importRuleset(id)
    const boxed = await loadSandboxedRuleset(join(ROOT, "rulesets", id))
    const play = async (rules: Ruleset) => {
      const bots = [await sandboxBot(join(ROOT, "bots", id, "baseline.ts"), 0, rules), await sandboxBot(join(ROOT, "bots", id, "baseline.ts"), 1, rules)]
      return runMatch({ ruleset: { ...rules, maxTicks: 1200 }, seed: 7, bots })
    }
    assert.equal(stable(await play(boxed)), stable(await play(native)))
  })
}

test("混战三家放进沙箱：出局、清掉出局者的实体、名次都和直接跑一样", async () => {
  const native = await importRuleset("melee")
  const boxed = await loadSandboxedRuleset(join(ROOT, "rulesets", "melee"))
  const play = async (rules: Ruleset) =>
    runMatch({
      ruleset: rules,
      seed: 2,
      bots: [{ name: "a", file: "", runner: idle() }, await sandboxBot(join(ROOT, "bots", "melee", "baseline.ts"), 1, rules), { name: "c", file: "", runner: idle() }],
    })
  const a = await play(native)
  assert.equal(a.result.winner, 1)
  assert.equal(stable(await play(boxed)), stable(a))
})

test("自带规则包的定义都能通过沙箱规则包的格式检查", async () => {
  for (const id of ["annihilation", "koth", "harvest", "melee", "frontier"]) {
    const r = await importRuleset(id)
    const fns = ["setup", "onTick", "objectives", "result", "timeUp"].filter((f) => typeof (r as unknown as Record<string, unknown>)[f] === "function")
    assert.deepEqual(checkRulesetData(JSON.parse(JSON.stringify(r)), fns), [], id)
  }
})

test("new-rules 的模板：加载通过，基准 bot 打赢不动的对手", async () => {
  const dir = join(TMP, "gold-rush")
  writeRulesTemplate(dir, ["koth"])
  const rules = await loadSandboxedRuleset(dir)
  assert.equal(rules.id, "gold-rush")
  const replay = runMatch({ ruleset: rules, seed: 1, bots: [await sandboxBot(join(dir, "bots", "baseline.ts"), 0, rules), { name: "idle", file: "", runner: idle() }] })
  assert.equal(replay.result.winner, 0, replay.result.reason)
  assert.equal(replay.bots[0].rejected + replay.bots[0].errors, 0)
})

// ---------- 写错的、恶意的规则包 ----------

let n = 0
/** 写一个最小的规则包，parts 替换其中的片段 */
function rules(parts: { top?: string; setup?: string; onTick?: string; result?: string; types?: string; players?: string; map?: string } = {}): string {
  const dir = join(TMP, `r${n++}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, "index.ts"),
    `${parts.top ?? ""}
const look = { shape: "circle" }
let made = 0
export default {
  id: "t-rules", name: "测试", players: ${parts.players ?? "{ min: 2, max: 2 }"}, maxTicks: 30, tickRate: 10, decisionInterval: 5, fuel: 50, unitCap: 0, fog: false,
  resources: ["gold"], terrain: { ".": { walkable: true, color: "#223322" } },
  types: ${parts.types ?? `{ hq: { kind: "building", maxHp: 100, look } }`},
  setup(ctx) { made++; ctx.setTerrain(${parts.map ?? `Array(10).fill("..........")`}); ctx.spawn("hq", 0, 1, 1); ctx.spawn("hq", 1, 8, 8); ctx.setStatus("第 " + made + " 次 setup"); ${parts.setup ?? ""} },
  onTick(ctx) { ${parts.onTick ?? ""} },
  objectives() { return {} },
  result(ctx) { ${parts.result ?? "return null"} },
  timeUp() { return { winner: null, reason: "到时间" } },
}
`,
  )
  writeFileSync(join(dir, "objectives.ts"), "export interface Objectives {}\n")
  writeFileSync(join(dir, "RULES.md"), "测试\n")
  return dir
}

const quiet = { onLog: () => {} }
const idleBots = (): MatchBot[] => [
  { name: "a", file: "", runner: idle() },
  { name: "b", file: "", runner: idle() },
]
async function play(dir: string): Promise<Replay> {
  return runMatch({ ruleset: await loadSandboxedRuleset(dir, quiet), seed: 1, bots: idleBots() })
}

test("沙箱规则包：正常的最小规则包能打完；每局重新加载，顶层变量不会带到下一局", async () => {
  const r = await loadSandboxedRuleset(rules(), quiet)
  for (let i = 0; i < 2; i++) {
    const replay = runMatch({ ruleset: r, seed: i, bots: idleBots() })
    assert.equal(replay.result.reason, "到时间")
    assert.equal(replay.initial.status, "第 1 次 setup")
  }
})

test("沙箱规则包：只能 import 自己目录里的文件和 rts-arena/standard", async () => {
  await assert.rejects(play(rules({ top: `import { readFileSync } from "node:fs"` })), /不能 import "node:fs"/)
  await assert.rejects(play(rules({ top: `import x from "../../../package.json"` })), /目录以外|找不到/)
  // 自己目录里的文件和平台共用代码可以
  const dir = rules({ top: `import { K } from "./lib.ts"\nimport { mirror } from "rts-arena/standard"`, setup: `ctx.setStatus(K + mirror(10, 10, 1, 1).x)` })
  writeFileSync(join(dir, "lib.ts"), `export const K: string = "ok"\n`)
  assert.equal((await play(dir)).initial.status, "ok8")
})

test("沙箱规则包：死循环燃料耗尽，说清是哪个回调、第几 tick", async () => {
  await assert.rejects(play(rules({ onTick: `if (ctx.tick === 7) for (;;) {}` })), /出错（onTick，第 7 tick）：燃料耗尽/)
  await assert.rejects(play(rules({ top: `for (;;) {}` })), /出错（加载）：燃料耗尽/)
})

test("沙箱规则包：内存超限", async () => {
  await assert.rejects(play(rules({ setup: `const a = []; for (;;) a.push(new Array(1e6).fill(1.5))` })), /内存超限/)
})

test("沙箱规则包：setup 以外不能改地形、放实体；参数不对的调用被拒", async () => {
  await assert.rejects(play(rules({ onTick: `ctx.setTerrain(["."])` })), /setTerrain 只能在 setup 里用/)
  await assert.rejects(play(rules({ onTick: `ctx.spawn("hq", 0, 3, 3)` })), /spawnNear/)
  await assert.rejects(play(rules({ onTick: `ctx.addScore(9, 1)` })), /玩家编号 9 不存在/)
  await assert.rejects(play(rules({ onTick: `ctx.addScore(0, "很多")` })), /分数 要是数字/)
  await assert.rejects(play(rules({ onTick: `ctx.setMarkers([{ kind: "zone", x: "a" }])` })), /叠加层格式不对/)
  await assert.rejects(play(rules({ setup: `ctx.setTerrain(["."])` })), /只能调一次/)
  // 规则包自己接住错误就没事
  const ok = await play(rules({ onTick: `try { ctx.addScore(9, 1) } catch (e) { ctx.setStatus("接住了") }` }))
  assert.equal(ok.frames.at(-1)?.status ?? ok.frames.find((f) => f.status)?.status, "接住了")
})

test("沙箱规则包：实体数有硬上限", async () => {
  const dir = rules({
    map: `Array(100).fill(".".repeat(100))`,
    types: `{ hq: { kind: "building", maxHp: 100, look }, u: { kind: "unit", maxHp: 1, look } }`,
    setup: `for (let i = 0; i < 8000; i++) ctx.spawn("u", -1, i % 100, 20 + Math.floor(i / 100))`,
  })
  await assert.rejects(play(dir), /上限 5000/)
})

test("沙箱规则包：定义不对在加载时列出所有问题", async () => {
  const dir = rules({ players: "{ min: 2, max: 20 }", types: `{ hq: { kind: "building", maxHp: -1, look }, u: { kind: "unit", w: 2, look: { shape: "star" } } }` })
  await assert.rejects(loadSandboxedRuleset(dir, quiet), (e: Error) => {
    assert.match(e.message, /players/)
    assert.match(e.message, /maxHp/)
    assert.match(e.message, /单位只能是 1×1/)
    assert.match(e.message, /look\.shape/)
    return true
  })
})

test("沙箱规则包：result 返回值不对、用 Date，都算规则包出错", async () => {
  await assert.rejects(play(rules({ result: `return { winner: 5, reason: "我说的" }` })), /result 返回值不对/)
  await assert.rejects(play(rules({ onTick: `Date.now()` })), /不能用 Date/)
})

test("沙箱规则包：console.log 交给 onLog，带 tick", async () => {
  const lines: string[] = []
  const r = await loadSandboxedRuleset(rules({ onTick: `if (ctx.tick === 3) console.log("hello", { a: 1 })` }), { onLog: (t, l) => lines.push(`${t}:${l.join("|")}`) })
  runMatch({ ruleset: r, seed: 1, bots: [{ name: "a", file: "", runner: fnBot(() => {}) }, { name: "b", file: "", runner: idle() }] })
  assert.deepEqual(lines, ['3:hello {"a":1}'])
})
