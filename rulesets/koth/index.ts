// 夺点：地图中央有一块控制点，只有一方的单位在里面时，这一方每 tick 得 1 分，先到 600 分赢；
// 摧毁对方主基地也直接赢
import type { RuleContext, Ruleset } from "../../src/core/types.ts"
import { baseStarts, standardStart, STANDARD_TERRAIN, standardTypes, symmetricTerrain, spawnMirrored } from "../common/standard.ts"
import type { Objectives } from "./objectives.ts"

const W = 48
const H = 32
const ZONE = { x: 22, y: 14, w: 4, h: 4 }
const TARGET = 600
const types = standardTypes()

function zoneController(ctx: RuleContext): number | null {
  const owners = new Set<number>()
  for (const e of ctx.entitiesIn(ZONE.x, ZONE.y, ZONE.w, ZONE.h)) if (e.def.kind === "unit" && e.owner >= 0) owners.add(e.owner)
  return owners.size === 1 ? [...owners][0] : null
}

// 每局状态（沙箱里每局重新加载；平台测试里直接跑时靠 setup 开头的 resetState）
/** 上一个独占控制点的玩家（中间争夺、没人的那些 tick 不算），从哪个 tick 开始控制的 */
let holder: number | null = null
let holderSince = 0
/** 每人夺下控制点的次数；双方都在点里（争夺中）的 tick 数 */
const taken = [0, 0]
let contested = 0

function resetState(): void {
  holder = null
  holderSince = 0
  taken.fill(0)
  contested = 0
}

function stats(ctx: RuleContext): Record<string, number[]> {
  return { 夺下控制点: ctx.players.map((p) => taken[p.id] ?? 0), 争夺中的tick: ctx.players.map(() => contested) }
}

function hasBase(ctx: RuleContext, p: number): boolean {
  return ctx.entities({ owner: p, type: "base" }).length > 0
}

const ruleset: Ruleset = {
  id: "koth",
  name: "夺点",
  summary: "独占地图正中的控制点计分，先到 600 分赢，也可以拆掉对方主基地",
  players: { min: 2, max: 2 },
  maxTicks: 6000,
  tickRate: 10,
  decisionInterval: 5,
  fuel: 100,
  unitCap: 60,
  fog: true,
  resources: ["gold"],
  terrain: STANDARD_TERRAIN,
  types,

  setup(ctx) {
    resetState()
    ctx.setTerrain(
      symmetricTerrain(W, H, ".", [
        { ch: "#", x: 14, y: 0, w: 2, h: 7 },
        { ch: "#", x: 0, y: 14, w: 7, h: 2 },
        { ch: "#", x: 19, y: 11, w: 3, h: 2 },
        { ch: "#", x: 26, y: 11, w: 3, h: 2 },
        { ch: "~", x: 8, y: 20, w: 4, h: 3 },
        { ch: "#", x: 30, y: 4, w: 2, h: 6 },
      ]),
    )
    standardStart(ctx, W, H, types)
    spawnMirrored(ctx, W, H, types, [
      { type: "goldmine", owner: -1, x: 17, y: 6, amount: 600 },
      { type: "goldmine", owner: -1, x: 18, y: 8, amount: 600 },
    ])
    for (let p = 0; p < ctx.playerCount; p++) ctx.setResources(p, { gold: 200 })
    ctx.setMarkers([{ kind: "zone", ...ZONE, owner: null, label: "控制点" }])
  },

  onTick(ctx) {
    const controller = zoneController(ctx)
    if (controller !== null) ctx.addScore(controller, 1)
    if (controller === null && ctx.entitiesIn(ZONE.x, ZONE.y, ZONE.w, ZONE.h).some((e) => e.def.kind === "unit" && e.owner >= 0)) contested++
    // 控制点换了人：写进回放和战报的关键事件
    if (controller !== null && controller !== holder) {
      taken[controller]++
      const before = holder === null ? "开局第一次" : `P${holder} 从 t${holderSince} 起控制，比分 ${ctx.players.map((p) => p.score).join(" : ")}`
      ctx.note(`P${controller} 夺下控制点（${before}）`, controller)
      holder = controller
      holderSince = ctx.tick
    }
    ctx.setMarkers([{ kind: "zone", ...ZONE, owner: controller, label: "控制点" }])
    const who = controller === null ? "无人控制" : `P${controller} 控制中`
    ctx.setStatus(`${who}｜${ctx.players.map((p) => p.score).join(" : ")} / ${TARGET}`)
  },

  objectives(ctx, player): Objectives {
    return {
      zone: { ...ZONE },
      controller: zoneController(ctx),
      points: ctx.players.map((p) => p.score),
      target: TARGET,
      enemyBases: baseStarts(W, H).filter((b) => b.owner !== player),
    }
  },

  result(ctx) {
    const reached = ctx.players.filter((p) => p.score >= TARGET)
    if (reached.length === 1) return { winner: reached[0].id, reason: `控制分先到 ${TARGET}` }
    for (const p of ctx.players) if (p.alive && !hasBase(ctx, p.id)) ctx.eliminate(p.id)
    const alive = ctx.players.filter((p) => p.alive)
    if (alive.length === 1) return { winner: alive[0].id, reason: "摧毁了对方主基地" }
    if (alive.length === 0) return { winner: null, reason: "双方主基地同时被摧毁" }
    return null
  },

  timeUp(ctx) {
    const [a, b] = ctx.players
    if (a.score === b.score) return { winner: null, reason: `时间到，控制分相同 ${a.score} : ${b.score}` }
    return { winner: a.score > b.score ? 0 : 1, reason: `时间到，控制分 ${a.score} : ${b.score}` }
  },
}

// 结果里带上统计：夺下控制点几次、争夺中的 tick 数（联赛和战报会列出来）
const judge = ruleset.result
const judgeTimeUp = ruleset.timeUp
ruleset.result = (ctx) => {
  const r = judge(ctx)
  return r && { ...r, stats: stats(ctx) }
}
ruleset.timeUp = (ctx) => ({ ...judgeTimeUp(ctx), stats: stats(ctx) })

export default ruleset
