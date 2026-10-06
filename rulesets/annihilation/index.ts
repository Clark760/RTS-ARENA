// 歼灭：摧毁对方全部主基地获胜；到时间上限比击杀价值
import type { RuleContext, Ruleset } from "../../src/core/types.ts"
import { baseStarts, standardStart, STANDARD_TERRAIN, standardTypes, symmetricTerrain, spawnMirrored } from "../common/standard.ts"
import type { Objectives } from "./objectives.ts"

const W = 48
const H = 32
const types = standardTypes()

/** 击杀价值：单位按造价，建筑另定 */
const BUILDING_VALUE: Record<string, number> = { base: 1000, barracks: 400 }

function valueOf(type: string): number {
  return BUILDING_VALUE[type] ?? types[type].cost?.gold ?? 0
}

function baseHp(ctx: RuleContext, p: number): number {
  let hp = 0
  for (const e of ctx.entities({ owner: p, type: "base" })) hp += e.hp
  return hp
}

const ruleset: Ruleset = {
  id: "annihilation",
  name: "歼灭",
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
    ctx.setTerrain(
      symmetricTerrain(W, H, ".", [
        { ch: "#", x: 14, y: 0, w: 2, h: 7 },
        { ch: "#", x: 0, y: 14, w: 7, h: 2 },
        { ch: "#", x: 20, y: 4, w: 4, h: 3 },
        { ch: "#", x: 8, y: 20, w: 3, h: 4 },
        { ch: "#", x: 22, y: 15, w: 4, h: 2 },
        { ch: "~", x: 26, y: 8, w: 4, h: 3 },
      ]),
    )
    standardStart(ctx, W, H, types)
    spawnMirrored(ctx, W, H, types, [
      { type: "goldmine", owner: -1, x: 18, y: 12, amount: 600 },
      { type: "goldmine", owner: -1, x: 20, y: 12, amount: 600 },
      { type: "goldmine", owner: -1, x: 19, y: 14, amount: 600 },
    ])
    for (let p = 0; p < ctx.playerCount; p++) ctx.setResources(p, { gold: 200 })
  },

  onTick(ctx) {
    for (const ev of ctx.events) {
      if (ev.kind === "died" && ev.killer >= 0 && ev.owner >= 0 && ev.killer !== ev.owner) ctx.addScore(ev.killer, valueOf(ev.type))
    }
    ctx.setStatus(`击杀价值 ${ctx.players.map((p) => p.score).join(" : ")}`)
  },

  objectives(ctx, player): Objectives {
    return {
      enemyBases: baseStarts(W, H).filter((b) => b.owner !== player),
      killValue: ctx.players.map((p) => p.score),
    }
  },

  result(ctx) {
    for (const p of ctx.players) if (p.alive && baseHp(ctx, p.id) === 0) ctx.eliminate(p.id)
    const alive = ctx.players.filter((p) => p.alive)
    if (alive.length === 1) return { winner: alive[0].id, reason: "摧毁了对方全部主基地" }
    if (alive.length === 0) return { winner: null, reason: "双方主基地同时被摧毁" }
    return null
  },

  timeUp(ctx) {
    const [a, b] = ctx.players
    if (a.score !== b.score) return { winner: a.score > b.score ? 0 : 1, reason: `时间到，击杀价值 ${a.score} : ${b.score}` }
    const ha = baseHp(ctx, 0)
    const hb = baseHp(ctx, 1)
    if (ha !== hb) return { winner: ha > hb ? 0 : 1, reason: `时间到，击杀价值相同，主基地剩余生命 ${ha} : ${hb}` }
    return { winner: null, reason: "时间到，击杀价值和主基地生命都相同，平局" }
  },
}

export default ruleset
