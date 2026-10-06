// 混战：2～4 人各占地图一角，可以分队（如 2v2）。
// - 主基地被摧毁的玩家出局（剩下的单位和建筑一起清掉）；一队的人全部出局，这队就输了。
// - 最后剩下的一队赢，赢家是这队的所有人（包括已经出局的队友）。
// - 名次按队伍排：越晚全队出局越好；到时间上限时，还有人在场的队按全队击杀价值、再按主基地剩余生命排。
// - 不分队时每人一队，就是各自为战。
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
const HOME: { type: string; x: number; y: number }[] = [
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

/**
 * 每个玩家坐哪个角（转几次 90°）。不分队：两人对角、三人空一角、四人坐满。
 * 分队：按队伍排好后沿 左上→左下→右下→右上 依次就座，队友坐相邻的角（2v2 就是左边一队、右边一队）。
 */
function seatCorners(teams: readonly number[]): number[] {
  const n = teams.length
  if (new Set(teams).size === n) return cornersFor(n)
  const order = [...teams.keys()].sort((a, b) => teams[a] - teams[b] || a - b)
  const corners = new Array<number>(n)
  order.forEach((p, i) => (corners[p] = [0, 3, 2, 1][i]))
  return corners
}

function baseStart(corner: number): { x: number; y: number } {
  const r = rotateK(SIZE, { x: 3, y: 3, w: 3, h: 3 }, corner)
  return { x: r.x, y: r.y }
}

/** 每局的出局记录（规则包对象被多局共用，状态挂在这一局的 ctx 上） */
interface MatchState {
  /** 出局的玩家，按先后 */
  out: number[]
  /** 玩家出局的 tick */
  outTick: Map<number, number>
}
const states = new WeakMap<RuleContext, MatchState>()

function state(ctx: RuleContext): MatchState {
  let s = states.get(ctx)
  if (!s) states.set(ctx, (s = { out: [], outTick: new Map() }))
  return s
}

function baseHp(ctx: RuleContext, p: number): number {
  let hp = 0
  for (const e of ctx.entities({ owner: p, type: "base" })) hp += e.hp
  return hp
}

function teamList(ctx: RuleContext): number[] {
  return [...new Set(ctx.teams)]
}

function members(ctx: RuleContext, team: number): number[] {
  return ctx.players.filter((p) => ctx.teams[p.id] === team).map((p) => p.id)
}

/** 名次：还有人在场的队（按全队击杀价值、主基地生命）在前；全队出局的越晚越靠前，同一 tick 全队出局的并列 */
function ranking(ctx: RuleContext): number[][] {
  const s = state(ctx)
  const sum = (team: number, f: (p: number) => number) => members(ctx, team).reduce((a, p) => a + f(p), 0)
  const score = (t: number) => sum(t, (p) => ctx.players[p].score)
  const hp = (t: number) => sum(t, (p) => baseHp(ctx, p))
  const aliveTeam = (t: number) => members(ctx, t).some((p) => ctx.players[p].alive)
  const lastOut = (t: number) => Math.max(...members(ctx, t).map((p) => s.outTick.get(p) ?? -1))
  const teams = teamList(ctx).sort((a, b) => {
    const aa = aliveTeam(a)
    const ab = aliveTeam(b)
    if (aa !== ab) return aa ? -1 : 1
    if (aa) return score(b) - score(a) || hp(b) - hp(a)
    return lastOut(b) - lastOut(a)
  })
  const groups: number[][] = []
  let prev: number | null = null
  for (const t of teams) {
    const tie =
      prev !== null &&
      aliveTeam(prev) === aliveTeam(t) &&
      (aliveTeam(t) ? score(prev) === score(t) && hp(prev) === hp(t) : lastOut(prev) === lastOut(t))
    if (tie) groups[groups.length - 1].push(...members(ctx, t))
    else groups.push(members(ctx, t))
    prev = t
  }
  return groups
}

function teamName(ctx: RuleContext, team: number): string {
  return members(ctx, team)
    .map((p) => `P${p}`)
    .join("、")
}

const ruleset: Ruleset = {
  id: "melee",
  name: "混战",
  summary: "2～4 人各占一角混战，主基地被拆就出局，最后剩下的一队赢",
  players: { min: 2, max: 4 },
  teams: true,
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
    seatCorners(ctx.teams).forEach((corner, p) => {
      for (const it of HOME) {
        const r = rotateK(SIZE, { x: it.x, y: it.y, ...size(it.type) }, corner)
        ctx.spawn(it.type, p, r.x, r.y)
      }
      ctx.setResources(p, { gold: 200 })
    })
  },

  onTick(ctx) {
    for (const ev of ctx.events) {
      if (ev.kind === "died" && ev.killer >= 0 && ev.owner >= 0 && !ctx.isAlly(ev.killer, ev.owner)) ctx.addScore(ev.killer, valueOf(ev.type))
    }
    const teams = teamList(ctx)
    const fmt = (p: { id: number; alive: boolean; score: number }) => (p.alive ? `${p.score}` : `(${p.score})`)
    if (teams.length === ctx.playerCount) {
      const alive = ctx.players.filter((p) => p.alive).length
      ctx.setStatus(`剩 ${alive} 家｜击杀价值 ${ctx.players.map(fmt).join(" : ")}`)
    } else {
      const alive = teams.filter((t) => members(ctx, t).some((p) => ctx.players[p].alive)).length
      const parts = teams.map((t) => `${teamName(ctx, t)}：${members(ctx, t).map((p) => fmt(ctx.players[p])).join("+")}`)
      ctx.setStatus(`剩 ${alive} 队｜击杀价值 ${parts.join("  ")}`)
    }
  },

  objectives(ctx, player): Objectives {
    const corners = seatCorners(ctx.teams)
    const bases = corners.map((c, owner) => ({ owner, ...baseStart(c) })).filter((b) => b.owner !== player && ctx.players[b.owner].alive)
    return {
      enemyBases: bases.filter((b) => !ctx.isAlly(player, b.owner)),
      allyBases: bases.filter((b) => ctx.isAlly(player, b.owner)),
      killValue: ctx.players.map((p) => p.score),
      eliminated: [...state(ctx).out],
    }
  },

  result(ctx) {
    const s = state(ctx)
    for (const p of ctx.players) {
      if (!p.alive || baseHp(ctx, p.id) > 0) continue
      // 出局：剩下的单位和建筑一起清掉，免得变成没人管的残兵
      ctx.eliminate(p.id)
      for (const e of ctx.entities({ owner: p.id })) ctx.remove(e.id)
      s.out.push(p.id)
      s.outTick.set(p.id, ctx.tick)
    }
    const aliveTeams = teamList(ctx).filter((t) => members(ctx, t).some((p) => ctx.players[p].alive))
    if (aliveTeams.length > 1) return null
    const rank = ranking(ctx)
    if (aliveTeams.length === 0) return { winner: null, winners: [], reason: "最后几队的主基地同时被摧毁", ranking: rank }
    const winners = members(ctx, aliveTeams[0])
    const solo = teamList(ctx).length === ctx.playerCount
    return {
      winner: winners[0],
      winners,
      reason: solo ? "其他玩家的主基地都被摧毁了" : `其他队伍都出局了（获胜队伍：${teamName(ctx, aliveTeams[0])}）`,
      ranking: rank,
    }
  },

  timeUp(ctx) {
    const rank = ranking(ctx)
    const scores = ctx.players.map((p) => p.score).join(" : ")
    const top = rank[0]
    const topTeams = new Set(top.map((p) => ctx.teams[p]))
    if (topTeams.size === 1)
      return { winner: top[0], winners: top, reason: `时间到，还在场的队伍里击杀价值最高（${scores}）`, ranking: rank }
    return { winner: null, winners: [], reason: `时间到，击杀价值和主基地生命都相同（${scores}）`, ranking: rank }
  },
}

export default ruleset
