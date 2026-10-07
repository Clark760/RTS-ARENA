// 歼灭：摧毁对方全部主基地获胜；到时间上限比击杀价值
import type { RuleContext, Ruleset } from "../../src/core/types.ts"
import {
  baseStarts,
  randomSymmetricMap,
  spawnMirrored,
  STANDARD_HOME,
  STANDARD_OBSTACLE_CHARS,
  STANDARD_SHAPES,
  standardStart,
  STANDARD_TERRAIN,
  standardTypes,
  symmetricTerrain,
} from "../common/standard.ts"
import type { Objectives } from "./objectives.ts"

const W = 48
const H = 32
const types = standardTypes()

// 地图按种子随机生成（中心对称，两边一样）：家（主基地、兵营、开局工人、家门口 4 个矿）固定在左上和右下，
// 石墙、水和中间的争夺矿群（3 个，每个 600）每局不同。生成不出合格的地图时用经典布局（D-141 之前的固定地图）
const CLASSIC_WALLS = [
  { ch: "#", x: 14, y: 0, w: 2, h: 7 },
  { ch: "#", x: 0, y: 14, w: 7, h: 2 },
  { ch: "#", x: 20, y: 4, w: 4, h: 3 },
  { ch: "#", x: 8, y: 20, w: 3, h: 4 },
  { ch: "#", x: 22, y: 15, w: 4, h: 2 },
  { ch: "~", x: 26, y: 8, w: 4, h: 3 },
]
/** 争夺矿群的阵型（经典布局里在 (18, 12)） */
const CONTESTED = [
  { x: 0, y: 0 },
  { x: 2, y: 0 },
  { x: 1, y: 2 },
]
const CLASSIC_ANCHOR = { x: 18, y: 12 }

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
  summary: "两人对战，采矿、出兵，摧毁对方主基地获胜",
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
    const map = randomSymmetricMap(ctx.rng, {
      width: W,
      height: H,
      symmetry: "point",
      base: symmetricTerrain(W, H, ".", []),
      terrain: STANDARD_TERRAIN,
      keepClear: [STANDARD_HOME],
      obstacles: { count: [8, 11], shapes: STANDARD_SHAPES, chars: STANDARD_OBSTACLE_CHARS },
      mines: [{ region: { x: 13, y: 6, w: 12, h: 12 }, offsets: CONTESTED }],
      connect: [{ x: 7, y: 7 }],
    })
    ctx.setTerrain(map?.terrain ?? symmetricTerrain(W, H, ".", CLASSIC_WALLS))
    standardStart(ctx, W, H, types)
    if (map) for (const m of map.mines) ctx.spawn("goldmine", -1, m.x, m.y, { amount: 600 })
    else spawnMirrored(ctx, W, H, types, CONTESTED.map((o) => ({ type: "goldmine", owner: -1 as const, x: CLASSIC_ANCHOR.x + o.x, y: CLASSIC_ANCHOR.y + o.y, amount: 600 })))
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
