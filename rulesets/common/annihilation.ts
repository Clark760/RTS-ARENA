// 歼灭（annihilation）和克制歼灭（counter-annihilation）共用：地图、开局、击杀价值、胜负判定。
// 克制歼灭只换了兵营出的兵（D-166），这里的东西两边一模一样
import type { MatchResult, RuleContext, SetupContext, TypeSpec } from "../../src/core/types.ts"
import {
  baseStarts,
  randomSymmetricMap,
  spawnMirrored,
  STANDARD_HOME,
  STANDARD_OBSTACLE_CHARS,
  STANDARD_SHAPES,
  standardStart,
  STANDARD_TERRAIN,
  symmetricTerrain,
} from "./standard.ts"

export const ANNIHILATION_W = 48
export const ANNIHILATION_H = 32
const W = ANNIHILATION_W
const H = ANNIHILATION_H

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

/** 歼灭的开局：随机地图、主基地、兵营、4 个工人、金矿、200 金 */
export function annihilationSetup(ctx: SetupContext, types: Record<string, TypeSpec>): void {
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
}

/** 击杀价值：单位按造价，建筑另定 */
const BUILDING_VALUE: Record<string, number> = { base: 1000, barracks: 400 }

/** 打死对方的东西得击杀价值，状态栏显示比分 */
/** 打死对方的东西加击杀价值；ignore 里的类型打死的不算（D-203：弑君歼灭的主基地会开火，它打死的不算，免得守家白拿分） */
export function scoreAnnihilationKills(ctx: RuleContext, types: Record<string, TypeSpec>, ignore: string[] = []): void {
  for (const ev of ctx.events) {
    if (ev.kind === "died" && ev.killer >= 0 && ev.owner >= 0 && ev.killer !== ev.owner && !(ev.killerType && ignore.includes(ev.killerType))) ctx.addScore(ev.killer, BUILDING_VALUE[ev.type] ?? types[ev.type].cost?.gold ?? 0)
  }
  ctx.setStatus(`击杀价值 ${ctx.players.map((p) => p.score).join(" : ")}`)
}

/** 对手主基地开局时的位置（给 bot 的目标信息） */
export function annihilationEnemyBases(player: number): { owner: number; x: number; y: number }[] {
  return baseStarts(W, H).filter((b) => b.owner !== player)
}

function baseHp(ctx: RuleContext, p: number): number {
  let hp = 0
  for (const e of ctx.entities({ owner: p, type: "base" })) hp += e.hp
  return hp
}

export function annihilationResult(ctx: RuleContext): MatchResult | null {
  for (const p of ctx.players) if (p.alive && baseHp(ctx, p.id) === 0) ctx.eliminate(p.id)
  const alive = ctx.players.filter((p) => p.alive)
  if (alive.length === 1) return { winner: alive[0].id, reason: "摧毁了对方全部主基地" }
  if (alive.length === 0) return { winner: null, reason: "双方主基地同时被摧毁" }
  return null
}

export function annihilationTimeUp(ctx: RuleContext): MatchResult {
  const [a, b] = ctx.players
  if (a.score !== b.score) return { winner: a.score > b.score ? 0 : 1, reason: `时间到，击杀价值 ${a.score} : ${b.score}` }
  const ha = baseHp(ctx, 0)
  const hb = baseHp(ctx, 1)
  if (ha !== hb) return { winner: ha > hb ? 0 : 1, reason: `时间到，击杀价值相同，主基地剩余生命 ${ha} : ${hb}` }
  return { winner: null, reason: "时间到，击杀价值和主基地生命都相同，平局" }
}
