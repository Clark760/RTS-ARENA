// 拓荒：开局只有主基地和工人，工人自己建兵营、箭塔、仓库；摧毁对方主基地获胜，到时间上限比击杀价值
import type { RuleContext, Ruleset, TypeSpec } from "../../src/core/types.ts"
import {
  baseStarts,
  randomSymmetricMap,
  spawnMirrored,
  STANDARD_HOME,
  STANDARD_OBSTACLE_CHARS,
  STANDARD_SHAPES,
  STANDARD_TERRAIN,
  standardTypes,
  symmetricTerrain,
} from "../common/standard.ts"
import type { Objectives } from "./objectives.ts"

const W = 56
const H = 40

function frontierTypes(): Record<string, TypeSpec> {
  const t = standardTypes()
  t.worker.builds = ["barracks", "tower", "depot"]
  t.barracks.cost = { gold: 150 }
  t.barracks.buildTicks = 240
  // 箭塔射程 5，比弓手远 1 格；三个战士大约 120 tick 拆掉一座，期间它能打死其中一个
  t.tower = {
    kind: "building",
    maxHp: 450,
    cost: { gold: 100 },
    buildTicks: 200,
    sight: 7,
    attack: { damage: 12, range: 5, cooldown: 10 },
    look: { shape: "square", label: "塔" },
  }
  // 仓库：开分矿用的交货点
  t.depot = {
    kind: "building",
    w: 2,
    h: 2,
    maxHp: 400,
    cost: { gold: 100 },
    buildTicks: 150,
    sight: 4,
    dropOff: true,
    look: { shape: "square", label: "仓" },
  }
  return t
}

const types = frontierTypes()

/** 建好的建筑击杀价值是造价的 2 倍，没建好的按造价算；主基地 1000；单位按造价 */
function valueOf(type: string, finished: boolean): number {
  if (type === "base") return 1000
  const cost = types[type].cost?.gold ?? 0
  return types[type].kind === "building" && finished ? cost * 2 : cost
}

function baseHp(ctx: RuleContext, p: number): number {
  let hp = 0
  for (const e of ctx.entities({ owner: p, type: "base" })) hp += e.hp
  return hp
}

const ruleset: Ruleset = {
  id: "frontier",
  name: "拓荒",
  summary: "开局没有兵营，工人自己建兵营、箭塔、仓库，摧毁对方主基地获胜",
  players: { min: 2, max: 2 },
  maxTicks: 9000,
  tickRate: 10,
  decisionInterval: 5,
  fuel: 130,
  unitCap: 60,
  fog: true,
  resources: ["gold"],
  terrain: STANDARD_TERRAIN,
  types,

  setup(ctx) {
    // 地图按种子随机生成（中心对称，两边一样）：家、分矿和把分矿隔开的那道墙固定，别的石墙、水和地图中间的两个矿每局不同；
    // 生成不出合格的地图时用经典布局（D-141 之前的固定地图）
    const FIXED_WALL = { ch: "#", x: 0, y: 16, w: 7, h: 2 }
    const map = randomSymmetricMap(ctx.rng, {
      width: W,
      height: H,
      symmetry: "point",
      base: symmetricTerrain(W, H, ".", [FIXED_WALL]),
      terrain: STANDARD_TERRAIN,
      solid: [
        { x: 2, y: 27, w: 1, h: 1 },
        { x: 4, y: 28, w: 1, h: 1 },
        { x: 2, y: 30, w: 1, h: 1 },
      ],
      // 家；分矿旁边留出建仓库的地方
      keepClear: [STANDARD_HOME, { x: 0, y: 24, w: 9, h: 10 }],
      obstacles: { count: [7, 10], shapes: STANDARD_SHAPES, chars: STANDARD_OBSTACLE_CHARS },
      mines: [{ region: { x: 19, y: 12, w: 10, h: 9 }, offsets: [{ x: 0, y: 0 }, { x: 2, y: -2 }] }],
      connect: [{ x: 7, y: 7 }, { x: 6, y: 28 }],
    })
    ctx.setTerrain(
      map?.terrain ??
        symmetricTerrain(W, H, ".", [
          { ch: "#", x: 15, y: 0, w: 2, h: 8 },
          FIXED_WALL,
          { ch: "#", x: 21, y: 5, w: 4, h: 3 },
          { ch: "#", x: 11, y: 29, w: 3, h: 5 },
          { ch: "#", x: 17, y: 20, w: 4, h: 2 },
          { ch: "~", x: 26, y: 9, w: 4, h: 3 },
        ]),
    )
    spawnMirrored(ctx, W, H, types, [
      { type: "base", owner: 0, x: 3, y: 3 },
      { type: "worker", owner: 0, x: 6, y: 3 },
      { type: "worker", owner: 0, x: 6, y: 4 },
      { type: "worker", owner: 0, x: 6, y: 5 },
      { type: "worker", owner: 0, x: 3, y: 6 },
      { type: "worker", owner: 0, x: 4, y: 6 },
      // 家门口
      { type: "goldmine", owner: -1, x: 1, y: 9 },
      { type: "goldmine", owner: -1, x: 3, y: 9 },
      { type: "goldmine", owner: -1, x: 5, y: 9 },
      { type: "goldmine", owner: -1, x: 9, y: 1 },
      // 分矿：主基地往下绕过石墙，离家远，适合在旁边建仓库
      { type: "goldmine", owner: -1, x: 2, y: 27, amount: 600 },
      { type: "goldmine", owner: -1, x: 4, y: 28, amount: 600 },
      { type: "goldmine", owner: -1, x: 2, y: 30, amount: 600 },
      // 地图中间（随机地图里位置每局不同，见下面）
      ...(map
        ? []
        : [
            { type: "goldmine", owner: -1 as const, x: 25, y: 17, amount: 700 },
            { type: "goldmine", owner: -1 as const, x: 27, y: 15, amount: 700 },
          ]),
    ])
    if (map) for (const m of map.mines) ctx.spawn("goldmine", -1, m.x, m.y, { amount: 700 })
    for (let p = 0; p < ctx.playerCount; p++) ctx.setResources(p, { gold: 300 })
  },

  onTick(ctx) {
    for (const ev of ctx.events) {
      if (ev.kind === "died" && ev.killer >= 0 && ev.owner >= 0 && ev.killer !== ev.owner) ctx.addScore(ev.killer, valueOf(ev.type, !ev.unfinished))
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
    if (alive.length === 1) return { winner: alive[0].id, reason: "摧毁了对方的主基地" }
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
