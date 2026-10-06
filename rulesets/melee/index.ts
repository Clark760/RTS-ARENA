// 混战：2～4 人各占地图一角，主基地被摧毁就出局（剩下的单位和建筑一起清掉），最后剩下的赢。
// 名次按出局先后排：越晚出局名次越好；到时间上限时，还在场的按击杀价值排在所有出局者前面。
import type { RuleContext, Ruleset } from "../../src/core/types.ts"
import { cornersFor, rotateK, rotationalTerrain, STANDARD_TERRAIN, standardTypes } from "../common/standard.ts"
import type { Objectives } from "./objectives.ts"

const SIZE = 64
const types = standardTypes()
const BUILDING_VALUE: Record<string, number> = { base: 1000, barracks: 400 }

function valueOf(type: string): number {
  return BUILDING_VALUE[type] ?? types[type].cost?.gold ?? 0
}

/** 左上角那一家的开局摆法，其他角转过去 */
const HOME: { type: string; x: number; y: number; amount?: number }[] = [
  { type: "base", x: 3, y: 3 },
  { type: "barracks", x: 9, y: 6 },
  { type: "worker", x: 6, y: 3 },
  { type: "worker", x: 6, y: 4 },
  { type: "worker", x: 6, y: 5 },
  { type: "worker", x: 3, y: 6 },
]
/** 每个角都有的金矿（没人坐的角也有，谁去采都行） */
const MINES: { x: number; y: number; amount: number }[] = [
  { x: 1, y: 9, amount: 400 },
  { x: 3, y: 9, amount: 400 },
  { x: 5, y: 9, amount: 400 },
  { x: 8, y: 1, amount: 400 },
  // 两家之间的中立矿
  { x: 18, y: 14, amount: 500 },
  { x: 20, y: 14, amount: 500 },
  // 地图正中，转四次正好是一个 2×2 的矿群
  { x: 31, y: 31, amount: 800 },
]

function size(type: string) {
  return { w: types[type].w ?? 1, h: types[type].h ?? 1 }
}

function baseStart(corner: number): { x: number; y: number } {
  const r = rotateK(SIZE, { x: 3, y: 3, w: 3, h: 3 }, corner)
  return { x: r.x, y: r.y }
}

/** 每局的出局顺序（规则包对象被多局共用，状态挂在这一局的 ctx 上） */
const eliminatedOf = new WeakMap<RuleContext, number[]>()

function eliminated(ctx: RuleContext): number[] {
  let list = eliminatedOf.get(ctx)
  if (!list) eliminatedOf.set(ctx, (list = []))
  return list
}

function baseHp(ctx: RuleContext, p: number): number {
  let hp = 0
  for (const e of ctx.entities()) if (e.owner === p && e.type === "base") hp += e.hp
  return hp
}

/** 名次：还在场的（按击杀价值、主基地生命排）在前，出局的越晚越靠前，同一 tick 出局的并列 */
function ranking(ctx: RuleContext, outOrder: number[], outTick: Map<number, number>): number[][] {
  const alive = ctx.players.filter((p) => p.alive).map((p) => p.id)
  alive.sort((a, b) => ctx.players[b].score - ctx.players[a].score || baseHp(ctx, b) - baseHp(ctx, a))
  const groups: number[][] = []
  for (const p of alive) {
    const last = groups[groups.length - 1]
    const same = last && ctx.players[last[0]].score === ctx.players[p].score && baseHp(ctx, last[0]) === baseHp(ctx, p)
    if (same) last.push(p)
    else groups.push([p])
  }
  for (const p of [...outOrder].reverse()) {
    const last = groups[groups.length - 1]
    if (last && outTick.has(last[0]) && outTick.get(last[0]) === outTick.get(p)) last.push(p)
    else groups.push([p])
  }
  return groups
}

const outTicks = new WeakMap<RuleContext, Map<number, number>>()

const ruleset: Ruleset = {
  id: "melee",
  name: "混战",
  players: { min: 2, max: 4 },
  maxTicks: 8000,
  tickRate: 10,
  decisionInterval: 5,
  fuel: 100,
  unitCap: 60,
  fog: true,
  resources: ["gold"],
  terrain: STANDARD_TERRAIN,
  types,

  setup(ctx) {
    ctx.setTerrain(
      rotationalTerrain(SIZE, ".", [
        { ch: "#", x: 14, y: 0, w: 2, h: 8 },
        { ch: "#", x: 22, y: 6, w: 4, h: 3 },
        { ch: "#", x: 8, y: 20, w: 3, h: 4 },
        { ch: "~", x: 24, y: 24, w: 4, h: 3 },
      ]),
    )
    for (const m of MINES)
      for (let k = 0; k < 4; k++) {
        const r = rotateK(SIZE, { x: m.x, y: m.y, w: 1, h: 1 }, k)
        ctx.spawn("goldmine", -1, r.x, r.y, { amount: m.amount })
      }
    cornersFor(ctx.playerCount).forEach((corner, p) => {
      for (const it of HOME) {
        const r = rotateK(SIZE, { x: it.x, y: it.y, ...size(it.type) }, corner)
        ctx.spawn(it.type, p, r.x, r.y)
      }
      ctx.setResources(p, { gold: 200 })
    })
  },

  onTick(ctx) {
    for (const ev of ctx.events) {
      if (ev.kind === "died" && ev.killer >= 0 && ev.owner >= 0 && ev.killer !== ev.owner) ctx.addScore(ev.killer, valueOf(ev.type))
    }
    const alive = ctx.players.filter((p) => p.alive).length
    ctx.setStatus(`剩 ${alive} 家｜击杀价值 ${ctx.players.map((p) => (p.alive ? p.score : `(${p.score})`)).join(" : ")}`)
  },

  objectives(ctx, player): Objectives {
    const corners = cornersFor(ctx.playerCount)
    return {
      enemyBases: corners
        .map((c, owner) => ({ owner, ...baseStart(c) }))
        .filter((b) => b.owner !== player && ctx.players[b.owner].alive),
      killValue: ctx.players.map((p) => p.score),
      eliminated: [...eliminated(ctx)],
    }
  },

  result(ctx) {
    const out = eliminated(ctx)
    let ticks = outTicks.get(ctx)
    if (!ticks) outTicks.set(ctx, (ticks = new Map()))
    for (const p of ctx.players) {
      if (!p.alive || baseHp(ctx, p.id) > 0) continue
      // 出局：剩下的单位和建筑一起清掉，免得变成没人管的残兵
      ctx.eliminate(p.id)
      for (const e of ctx.entities()) if (e.owner === p.id) ctx.remove(e.id)
      out.push(p.id)
      ticks.set(p.id, ctx.tick)
    }
    const alive = ctx.players.filter((p) => p.alive)
    if (alive.length > 1) return null
    const rank = ranking(ctx, out, ticks)
    if (alive.length === 1) return { winner: alive[0].id, reason: "其他玩家的主基地都被摧毁了", ranking: rank }
    return { winner: null, reason: "最后几家的主基地同时被摧毁", ranking: rank }
  },

  timeUp(ctx) {
    const rank = ranking(ctx, eliminated(ctx), outTicks.get(ctx) ?? new Map())
    const top = rank[0]
    const scores = ctx.players.map((p) => p.score).join(" : ")
    if (top.length === 1) return { winner: top[0], reason: `时间到，还在场的玩家里击杀价值最高（${scores}）`, ranking: rank }
    return { winner: null, reason: `时间到，击杀价值和主基地生命都相同（${scores}）`, ranking: rank }
  },
}

export default ruleset
