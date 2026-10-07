// 规则包「烽火台」：工人在地图上的台址里建烽火台，独占台址的一方定期得分，先到目标分的赢。
// 两侧台址被中立野怪占着，中央台址有守卫，要先清掉才能建。主基地被摧毁直接输。
import type { RuleContext, Ruleset, TypeSpec } from "../../src/core/types.ts"
import {
  randomSymmetricMap,
  spawnMirrored,
  STANDARD_OBSTACLE_CHARS,
  STANDARD_SHAPES,
  STANDARD_TERRAIN,
  standardTypes,
  symmetricTerrain,
} from "../common/standard.ts"
import type { Objectives, Site } from "./objectives.ts"

const W = 36
const H = 26
const TARGET = 400
const SCORE_EVERY = 10
const BOUNTY: Record<string, number> = { beast: 40, guardian: 100 }

const std = standardTypes()
const types: Record<string, TypeSpec> = {
  ...std,
  worker: { ...std.worker, builds: ["beacon", "barracks"] },
  barracks: { ...std.barracks, cost: { gold: 150 }, buildTicks: 120 },
  beacon: {
    kind: "building",
    w: 2,
    h: 2,
    maxHp: 400,
    cost: { gold: 75 },
    buildTicks: 60,
    sight: 6,
    look: { shape: "hex", label: "烽" },
  },
  beast: {
    kind: "unit",
    maxHp: 150,
    moveTicks: 0,
    sight: 3,
    attack: { damage: 6, range: 1, cooldown: 10 },
    look: { shape: "triangle", label: "兽", color: "#6b8e23" },
  },
  guardian: {
    kind: "unit",
    maxHp: 300,
    moveTicks: 0,
    sight: 3,
    attack: { damage: 12, range: 1, cooldown: 10 },
    look: { shape: "triangle", label: "守", color: "#8b4513" },
  },
}

/** 中心对称：w×h 的东西左上角 (x, y) 的对称位置 */
function mirrorRect(x: number, y: number, w: number, h: number) {
  return { x: W - x - w, y: H - y - h }
}

interface SiteDef {
  name: string
  x: number
  y: number
  w: number
  h: number
  value: number
}

const home0: SiteDef = { name: "home0", x: 11, y: 1, w: 4, h: 4, value: 1 }
const flank0: SiteDef = { name: "flank0", x: 1, y: 19, w: 4, h: 4, value: 2 }
const SITES: SiteDef[] = [
  home0,
  { ...home0, name: "home1", ...mirrorRect(home0.x, home0.y, 4, 4) },
  flank0,
  { ...flank0, name: "flank1", ...mirrorRect(flank0.x, flank0.y, 4, 4) },
  { name: "center", x: 16, y: 11, w: 4, h: 4, value: 3 },
]

const BASE0 = { x: 2, y: 2 }
const BASES = [BASE0, mirrorRect(BASE0.x, BASE0.y, 3, 3)]

function inside(e: { x: number; y: number; w: number; h: number }, s: SiteDef): boolean {
  return e.x >= s.x && e.y >= s.y && e.x + e.w <= s.x + s.w && e.y + e.h <= s.y + s.h
}

// 每个台址的当前占领者（-1 没人，-2 争夺中）和野怪数，onTick 里更新
let holders: number[] = SITES.map(() => -1)
let monsters: number[] = SITES.map(() => 0)

function refresh(ctx: RuleContext): void {
  const beacons = ctx.entities({ type: "beacon" }).filter((b) => !b.construction)
  const mons = [...ctx.entities({ type: "beast" }), ...ctx.entities({ type: "guardian" })]
  holders = SITES.map((s) => {
    const owners = new Set<number>()
    for (const b of beacons) if (inside(b, s)) owners.add(b.owner)
    if (owners.size === 0) return -1
    if (owners.size > 1) return -2
    return [...owners][0]
  })
  monsters = SITES.map((s) => mons.filter((m) => inside(m, s)).length)
}

function updateMarkers(ctx: RuleContext): void {
  ctx.setMarkers(
    SITES.map((s, i) => ({
      kind: "zone" as const,
      x: s.x,
      y: s.y,
      w: s.w,
      h: s.h,
      owner: holders[i] >= 0 ? holders[i] : null,
      label: `${s.name} ×${s.value}${holders[i] === -2 ? " 争夺中" : ""}`,
    })),
  )
}

function hasBase(ctx: RuleContext, player: number): boolean {
  return ctx.entities({ owner: player, type: "base" }).length > 0
}

const ruleset: Ruleset = {
  id: "beacons",
  name: "烽火台",
  summary: "清掉台址里的野怪和守卫，建烽火台独占台址计分，先到 400 分",
  players: { min: 2, max: 2 },
  teams: false,
  maxTicks: 4000,
  tickRate: 10,
  decisionInterval: 5,
  fuel: 100,
  unitCap: 30,
  fog: true,
  resources: ["gold"],
  terrain: STANDARD_TERRAIN,
  types,

  setup(ctx) {
    holders = SITES.map(() => -1)
    monsters = SITES.map(() => 0)
    // 地图按种子随机生成（中心对称，两边一样）：家、5 个台址、矿和野怪的位置固定，石墙和水每局不同；
    // 中央台址两边那两道横墙也固定：它们把两家之间的近路收到中央、从守卫身边过，速攻要先挨守卫的打。
    // 参考 bot 联赛（D-141）：不固定时随机地图上 rush 的得分率 69%；固定后 56%，和经典图同样种子的 44% 差在误差内
    // 生成不出合格的地图时用经典布局（D-141 之前的固定地图）
    const FUNNEL = { ch: "#", x: 8, y: 12, w: 6, h: 2 }
    const map = randomSymmetricMap(ctx.rng, {
      width: W,
      height: H,
      symmetry: "point",
      base: symmetricTerrain(W, H, ".", [FUNNEL]),
      terrain: STANDARD_TERRAIN,
      solid: [
        { x: 12, y: 8, w: 1, h: 1 },
        { x: 3, y: 15, w: 1, h: 1 },
      ],
      keepClear: [{ x: 0, y: 0, w: 10, h: 10 }, ...SITES.map((s) => ({ x: s.x, y: s.y, w: s.w, h: s.h }))],
      obstacles: { count: [2, 4], shapes: STANDARD_SHAPES, chars: STANDARD_OBSTACLE_CHARS },
      connect: [
        { x: 6, y: 6 },
        { x: home0.x + 1, y: home0.y + 1 },
        { x: flank0.x + 3, y: flank0.y + 1 },
        { x: 17, y: 11 },
        { x: 13, y: 8 },
        { x: 4, y: 15 },
      ],
    })
    ctx.setTerrain(
      map?.terrain ??
        symmetricTerrain(W, H, ".", [
          FUNNEL,
          { ch: "~", x: 16, y: 4, w: 4, h: 3 },
          { ch: "#", x: 6, y: 16, w: 2, h: 5 },
        ]),
    )
    spawnMirrored(ctx, W, H, types, [
      { type: "base", owner: 0, x: BASE0.x, y: BASE0.y },
      { type: "barracks", owner: 0, x: 7, y: 6 },
      { type: "worker", owner: 0, x: 6, y: 2 },
      { type: "worker", owner: 0, x: 6, y: 3 },
      { type: "worker", owner: 0, x: 6, y: 4 },
      { type: "goldmine", owner: -1, x: 1, y: 7 },
      { type: "goldmine", owner: -1, x: 3, y: 7 },
      { type: "goldmine", owner: -1, x: 12, y: 8, amount: 600 },
      { type: "goldmine", owner: -1, x: 3, y: 15, amount: 600 },
      // 两侧台址的野怪
      { type: "beast", owner: -1, x: 2, y: 20 },
      { type: "beast", owner: -1, x: 3, y: 21 },
    ])
    // 中央台址的两个守卫（自己就是中心对称的，直接放）
    ctx.spawn("guardian", -1, 17, 12)
    ctx.spawn("guardian", -1, 18, 13)
    for (let p = 0; p < ctx.playerCount; p++) ctx.setResources(p, { gold: 150 })
  },

  onTick(ctx) {
    // 打死野怪的赏金
    for (const ev of ctx.events) {
      if (ev.kind === "died" && ev.killer >= 0 && BOUNTY[ev.type]) ctx.addResource(ev.killer, "gold", BOUNTY[ev.type])
    }
    const before = holders.join(",")
    refresh(ctx)
    if (ctx.tick % SCORE_EVERY === 0) {
      SITES.forEach((s, i) => {
        if (holders[i] >= 0) ctx.addScore(holders[i], s.value)
      })
    }
    if (ctx.tick === 1 || holders.join(",") !== before) updateMarkers(ctx)
    ctx.setStatus(`得分 ${ctx.players.map((p) => p.score).join(" : ")}（先到 ${TARGET}）  台址 ${holders.map((h) => (h === -1 ? "空" : h === -2 ? "争" : `P${h}`)).join(" ")}`)
  },

  objectives(ctx, player): Objectives {
    const sites: Site[] = SITES.map((s, i) => ({ id: i, ...s, holder: holders[i], monsters: monsters[i] }))
    return {
      target: TARGET,
      scores: ctx.players.map((p) => p.score),
      scoreInterval: SCORE_EVERY,
      nextScoreIn: SCORE_EVERY - (ctx.tick % SCORE_EVERY),
      sites,
      enemyBase: BASES[1 - player],
    }
  },

  result(ctx) {
    const lost = ctx.players.filter((p) => !hasBase(ctx, p.id))
    if (lost.length === 2) return { winner: null, reason: "双方主基地同时被摧毁" }
    if (lost.length === 1) return { winner: 1 - lost[0].id, reason: "摧毁了对方的主基地" }
    const [a, b] = ctx.players
    if (a.score >= TARGET || b.score >= TARGET) {
      if (a.score === b.score) return { winner: null, reason: `同时到 ${TARGET} 分` }
      return { winner: a.score > b.score ? 0 : 1, reason: `先到 ${TARGET} 分（${a.score} : ${b.score}）` }
    }
    return null
  },

  timeUp(ctx) {
    const [a, b] = ctx.players
    if (a.score === b.score) return { winner: null, reason: `时间到，分数一样（${a.score}）` }
    return { winner: a.score > b.score ? 0 : 1, reason: `时间到，得分 ${a.score} : ${b.score}` }
  },
}

export default ruleset
