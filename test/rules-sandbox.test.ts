// 沙箱规则包：自带规则包放进沙箱结果完全一样；写错的、恶意的规则包被拦住并说清原因
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { findRuleset, importRuleset, loadRulesetRef } from "../src/cli/catalog.ts"
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

test("命令行和对战页加载规则包（自带的也一样）走的是沙箱", async () => {
  const r = await loadRulesetRef(findRuleset("koth")!)
  assert.equal(typeof r.release, "function", "沙箱规则包才有 release")
  assert.equal(r.id, "koth")
})

test("ctx.entities 的筛选：沙箱里不管有没有全量快照，结果都和直接跑一样", async () => {
  const dir = rules({
    onTick: `if (ctx.tick === 3) {
      const a = ctx.entities({ owner: 0 }).map((e) => e.id).join()
      const b = ctx.entities({ type: "hq", kind: "building" }).length
      const c = ctx.entitiesIn(0, 0, 5, 5).map((e) => e.type).join()
      ctx.entities()
      const d = ctx.entities({ owner: 0 }).map((e) => e.id).join()
      const e2 = ctx.entitiesIn(0, 0, 5, 5).map((e) => e.type).join()
      ctx.setStatus([a === d, b, c, c === e2].join("|"))
    }`,
  })
  const replay = await play(dir)
  assert.equal(replay.frames.find((f) => f.status?.includes("|"))?.status, "true|2|hq|true")
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
  await writeRulesTemplate(dir, ["koth"])
  const rules = await loadSandboxedRuleset(dir)
  assert.equal(rules.id, "gold-rush")
  const replay = runMatch({ ruleset: rules, seed: 1, bots: [await sandboxBot(join(dir, "bots", "baseline.ts"), 0, rules), { name: "idle", file: "", runner: idle() }] })
  assert.equal(replay.result.winner, 0, replay.result.reason)
  assert.equal(replay.bots[0].rejected + replay.bots[0].errors, 0)
})

// ---------- 写错的、恶意的规则包 ----------

let n = 0
/** 写一个最小的规则包，parts 替换其中的片段 */
function rules(parts: { top?: string; setup?: string; onTick?: string; result?: string; types?: string; players?: string; map?: string; extra?: string } = {}): string {
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
  ${parts.extra ?? ""}
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

// ---------- 规则包的新接口：指挥中立实体、改血、改归属、放置限制、区域颜色 ----------

const CREEP_TYPES = `{
  hq: { kind: "building", maxHp: 100, look },
  creep: { kind: "unit", maxHp: 30, moveTicks: 1, sight: 3, attack: { damage: 5, range: 1, cooldown: 1 }, look },
  peon: { kind: "unit", maxHp: 20, moveTicks: 1, sight: 4, builds: ["hut"], look },
  hut: { kind: "building", maxHp: 50, cost: { gold: 10 }, buildTicks: 3, look },
}`

test("规则包指挥中立实体：野怪按命令走过去打玩家的主基地", async () => {
  const dir = rules({
    types: CREEP_TYPES,
    setup: `ctx.spawn("creep", -1, 9, 0)`,
    onTick: `if (ctx.tick === 1) { const c = ctx.entities({ type: "creep" })[0]; const hq = ctx.entities({ owner: 0, type: "hq" })[0]; ctx.orderNeutral(c.id, { kind: "attack", target: hq.id }) }
      const hq = ctx.entities({ owner: 0, type: "hq" })[0]; if (hq) ctx.setStatus("hq " + hq.hp)`,
  })
  const replay = await play(dir)
  const last = [...replay.frames].reverse().find((f) => f.status)?.status ?? ""
  assert.ok(Number(last.split(" ")[1]) < 100, last)
  // 不能指挥玩家的实体、命令不对
  await assert.rejects(play(rules({ types: CREEP_TYPES, onTick: `ctx.orderNeutral(ctx.entities({ owner: 0 })[0].id, { kind: "stop" })` })), /只能指挥中立实体/)
  await assert.rejects(play(rules({ types: CREEP_TYPES, setup: `ctx.spawn("creep", -1, 9, 0)`, onTick: `ctx.orderNeutral(ctx.entities({ type: "creep" })[0].id, { kind: "fly" })` })), /不认识的命令/)
})

test("规则包改血、改归属：bot 看到实体换了主人；生命改到 0 就死", async () => {
  const dir = rules({
    types: CREEP_TYPES,
    setup: `ctx.spawn("creep", -1, 5, 5)`,
    onTick: `if (ctx.tick === 2) { const c = ctx.entities({ type: "creep" })[0]; ctx.setOwner(c.id, 1); ctx.setHp(c.id, 7) }
      if (ctx.tick === 6) ctx.setHp(ctx.entities({ owner: 0, type: "hq" })[0].id, 0)`,
  })
  let seen: { owner: number; hp: number } | undefined
  const r = await loadSandboxedRuleset(dir, quiet)
  const replay = runMatch({
    ruleset: r,
    seed: 1,
    bots: [
      { name: "a", file: "", runner: idle() },
      { name: "b", file: "", runner: fnBot((v) => void (seen = v.entities.find((e) => e.type === "creep") ?? seen)) },
    ],
  })
  assert.deepEqual(seen && { owner: seen.owner, hp: seen.hp }, { owner: 1, hp: 7 })
  assert.ok(replay.frames.some((f) => f.t === 6 && (f.die?.length ?? 0) > 0), "主基地被改到 0 血死了")
})

test("规则包的 buildCheck：拒绝原因原样告诉 bot，允许的照常建", async () => {
  const dir = rules({
    types: CREEP_TYPES,
    setup: `ctx.spawn("peon", 0, 3, 3); ctx.setResources(0, { gold: 100 })`,
    extra: `buildCheck(ctx, player, type, x, y) { return x >= 5 ? "这里是禁建区（x 要小于 5）" : null },`,
  })
  const reasons: string[] = []
  let huts = 0
  const r = await loadSandboxedRuleset(dir, quiet)
  runMatch({
    ruleset: r,
    seed: 1,
    bots: [
      {
        name: "a",
        file: "",
        runner: fnBot((v, cmd) => {
          for (const e of v.events) if (e.kind === "rejected") reasons.push(e.reason)
          huts = v.entities.filter((e) => e.type === "hut").length
          const peon = v.entities.find((e) => e.type === "peon")!
          if (v.tick === 0) cmd.build(peon, "hut", 6, 3)
          if (v.tick === 5) cmd.build(peon, "hut", 3, 5)
        }),
      },
      { name: "b", file: "", runner: idle() },
    ],
  })
  assert.deepEqual(reasons, ["这里是禁建区（x 要小于 5）"])
  assert.equal(huts, 1)
})

test("区域叠加层可以自定颜色；颜色格式不对被拒", async () => {
  const ok = await play(rules({ setup: `ctx.setMarkers([{ kind: "zone", x: 1, y: 1, w: 2, h: 2, owner: null, color: "#ff8800", label: "争夺中" }])` }))
  assert.equal((ok.initial.markers[0] as { color?: string }).color, "#ff8800")
  await assert.rejects(play(rules({ setup: `ctx.setMarkers([{ kind: "zone", x: 1, y: 1, w: 2, h: 2, owner: null, color: "red" }])` })), /叠加层格式不对/)
})
